/**
 * Executes backend-directed HTTP requests against THIS machine's loopback
 * services (LM Studio's local server) and streams each response body back
 * over the relay WebSocket as bounded utf-8 `http_proxy_chunk` frames,
 * followed by exactly one terminal `http_proxy_response`.
 *
 * The wire shapes are hand-mirrored in `transport.ts` from
 * `server/agentRelay/protocol.ts` (global-constraints.md §5); keep both sides
 * in sync when either changes.
 *
 * Security posture (global-constraints.md §6, agent-side defense-in-depth):
 * the destination host must be THIS machine's loopback (`127.0.0.1`, `::1`,
 * `localhost`) regardless of what the backend's allowlist decided — anything
 * else is refused before any socket is opened. Redirects are always hard
 * errors (`redirect: 'error'`) so a loopback URL can never bounce a request
 * off-host. Volume is bounded per request: ≤256 KiB of text per relay frame
 * and ≤64 MiB of body per response.
 */

import type { AgentToBackendMessage, BackendToAgentMessage, HttpProxyRequestMessage } from './transport.js';

/** One relay frame carries at most 256 KiB of utf-8 text (global-constraints §5). */
export const MAX_CHUNK_TEXT_BYTES = 256 * 1024;
/** One proxied response relays at most 64 MiB of body (global-constraints §5). */
export const MAX_TOTAL_RESPONSE_BYTES = 64 * 1024 * 1024;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Shape of `fetch` the executor needs. Injectable (`fetchImpl`) so tests stay
 * hermetic; production passes the Node 20 global, which is assignable to this.
 */
export type ProxyFetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string | null;
    signal: AbortSignal;
    redirect: 'error';
  }
) => Promise<Response>;

export interface HttpProxyExecutorOptions {
  send: (message: AgentToBackendMessage) => void;
  /** Defaults to the Node 20 global `fetch`; overridden only in tests. */
  fetchImpl?: ProxyFetchLike;
  /** Production-safe defaults overridable only to keep boundary tests small. */
  maxChunkTextBytes?: number;
  maxTotalResponseBytes?: number;
}

export interface HttpProxyExecutor {
  handleHttpProxyRequest(message: HttpProxyRequestMessage): void;
  /** Aborts the in-flight fetch for `requestId`; unknown ids are ignored. */
  handleHttpProxyCancel(requestId: string): void;
  /** ARC-04 parity: aborts every in-flight fetch; nothing further is sent. */
  handleDisconnect(): void;
}

interface InFlightProxy {
  requestId: string;
  timeoutMs: number;
  controller: AbortController;
  timer: NodeJS.Timeout;
  settled: boolean;
  cancelRequested: boolean;
  timedOut: boolean;
  /** Set by handleDisconnect — the other end is gone, sending is pointless. */
  silent: boolean;
}

/** Strips the `[...]` bracket notation `new URL().hostname` uses for IPv6 literals. */
function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

/** True only for URLs pointing at THIS machine's loopback interface (§6). */
function isLoopbackDestination(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false; // an unparseable destination is not a loopback destination
  }
  return LOOPBACK_HOSTS.has(normalizeHost(parsed.hostname));
}

/**
 * Largest prefix of `text` whose utf-8 encoding fits within `budgetBytes`,
 * never splitting a surrogate pair across frames. Byte length grows
 * monotonically with prefix length, which makes binary search safe.
 */
function takeUtf8PrefixWithinBudget(text: string, budgetBytes: number): string {
  if (budgetBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= budgetBytes) return text;
  let lo = 1;
  let hi = text.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= budgetBytes) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best > 0) {
    const lastCodeUnit = text.charCodeAt(best - 1);
    if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) best -= 1; // lone high surrogate
  }
  return text.slice(0, best);
}

export function createHttpProxyExecutor(options: HttpProxyExecutorOptions): HttpProxyExecutor {
  const doFetch: ProxyFetchLike = options.fetchImpl ?? globalThis.fetch;
  const maxChunkTextBytes = options.maxChunkTextBytes ?? MAX_CHUNK_TEXT_BYTES;
  const maxTotalResponseBytes = options.maxTotalResponseBytes ?? MAX_TOTAL_RESPONSE_BYTES;
  const inflight = new Map<string, InFlightProxy>();

  function settle(record: InFlightProxy): void {
    if (record.settled) return;
    record.settled = true;
    clearTimeout(record.timer);
    if (inflight.get(record.requestId) === record) inflight.delete(record.requestId);
  }

  function sendTerminalError(record: InFlightProxy, rawError: string, status = 0): void {
    settle(record);
    if (record.silent) return;
    // §5 pins the cancel frame verbatim ({ok:false,status:0,error:'cancelled'})
    // even when the abort lands mid-body; the local backstop keeps status 0
    // too and gets its own diagnostic so a self-inflicted abort is
    // distinguishable from a backend `http_proxy_cancel`.
    if (record.cancelRequested) {
      options.send({ type: 'http_proxy_response', requestId: record.requestId, ok: false, status: 0, error: 'cancelled' });
      return;
    }
    if (record.timedOut) {
      options.send({
        type: 'http_proxy_response',
        requestId: record.requestId,
        ok: false,
        status: 0,
        error: `local proxy timeout after ${record.timeoutMs}ms`,
      });
      return;
    }
    options.send({ type: 'http_proxy_response', requestId: record.requestId, ok: false, status, error: rawError });
  }

  function sendTerminalOk(
    record: InFlightProxy,
    status: number,
    contentType: string | undefined,
    totalBytes: number
  ): void {
    settle(record);
    if (record.silent) return;
    options.send({
      type: 'http_proxy_response',
      requestId: record.requestId,
      ok: true,
      status,
      ...(contentType !== undefined ? { contentType } : {}),
      totalBytes,
    });
  }

  function handleHttpProxyRequest(message: HttpProxyRequestMessage): void {
    const { requestId, url, method, headers, body, timeoutMs } = message;

    // Defense-in-depth (§6): refuse non-loopback destinations BEFORE any
    // socket exists, no matter what the server-side allowlist concluded.
    if (!isLoopbackDestination(url)) {
      options.send({
        type: 'http_proxy_response',
        requestId,
        ok: false,
        status: 0,
        error: 'non-loopback destination refused',
      });
      return;
    }
    if (inflight.has(requestId)) {
      options.send({
        type: 'http_proxy_response',
        requestId,
        ok: false,
        status: 0,
        error: 'duplicate requestId already in flight',
      });
      return;
    }

    // Local backstop for the backend registry's own timeout (§5): if the
    // best-effort `http_proxy_cancel` is ever lost, this keeps the agent from
    // holding a hung socket forever (commandExecutor uses the same pattern).
    const controller = new AbortController();
    const record: InFlightProxy = {
      requestId,
      timeoutMs,
      controller,
      timer: setTimeout(() => {
        record.timedOut = true;
        controller.abort();
      }, timeoutMs),
      settled: false,
      cancelRequested: false,
      timedOut: false,
      silent: false,
    };
    inflight.set(requestId, record);
    void executeAndStream(record, url, method, headers, body);
  }

  async function executeAndStream(
    record: InFlightProxy,
    url: string,
    method: 'GET' | 'POST',
    headers: Record<string, string>,
    body: string | null
  ): Promise<void> {
    const { requestId, controller } = record;

    let response: Response;
    try {
      response = await doFetch(url, { method, headers, body, signal: controller.signal, redirect: 'error' });
    } catch (error) {
      sendTerminalError(record, error instanceof Error ? error.message : String(error));
      return;
    }

    const contentTypeHeader = response.headers.get('content-type');
    const contentType = contentTypeHeader === null ? undefined : contentTypeHeader;
    const reader = response.body?.getReader() ?? null;
    const decoder = new TextDecoder();
    let seq = 0;
    let totalBytes = 0;
    let pending = '';

    // A pending `reader.read()` is NOT guaranteed to reject when the fetch
    // signal aborts (conformant fetches error the body stream, but depending
    // on every impl doing so would leave hangs on the table): race each read
    // against the abort signal instead.
    let detachAbortListener: (() => void) | undefined;
    const abortDuringStream = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(new Error('This operation was aborted'));
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener('abort', onAbort, { once: true });
      detachAbortListener = () => controller.signal.removeEventListener('abort', onAbort);
    });
    abortDuringStream.catch(() => {}); // rejections are consumed by the races below

    try {
      if (reader === null) {
        // Bodyless response (e.g. 204): chunks would be empty; straight to the
        // single terminal frame.
        sendTerminalOk(record, response.status, contentType, 0);
        return;
      }
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), abortDuringStream]);
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxTotalResponseBytes) {
          void reader.cancel().catch(() => {});
          sendTerminalError(
            record,
            `http proxy response exceeded ${maxTotalResponseBytes}-byte cap`,
            response.status
          );
          return;
        }
        pending += decoder.decode(value, { stream: true });
        // Emit what arrived now (keeps SSE-style bodies flowing frame by
        // frame); the cap splits only oversized arrivals, leaving any
        // remainder to ride along with the next piece or the final flush.
        if (Buffer.byteLength(pending, 'utf8') <= maxChunkTextBytes) {
          options.send({ type: 'http_proxy_chunk', requestId, seq: seq++, text: pending });
          pending = '';
        } else {
          while (Buffer.byteLength(pending, 'utf8') > maxChunkTextBytes) {
            const frame = takeUtf8PrefixWithinBudget(pending, maxChunkTextBytes);
            if (frame.length === 0) break; // unreachable while pending exceeds a positive cap
            pending = pending.slice(frame.length);
            options.send({ type: 'http_proxy_chunk', requestId, seq: seq++, text: frame });
          }
        }
      }
      pending += decoder.decode(); // flush any buffered partial code point
      if (pending.length > 0) {
        options.send({ type: 'http_proxy_chunk', requestId, seq: seq++, text: pending });
        pending = '';
      }
      sendTerminalOk(record, response.status, contentType, totalBytes);
    } catch (error) {
      // Abort (cancel/disconnect/backstop) surfaces here via the abort race;
      // genuine mid-stream network failures carry their own message and the
      // real HTTP status. Either way exactly one terminal frame goes out.
      void reader?.cancel().catch(() => {});
      sendTerminalError(record, error instanceof Error ? error.message : String(error), response.status);
    } finally {
      detachAbortListener?.();
    }
  }

  function handleHttpProxyCancel(requestId: string): void {
    const record = inflight.get(requestId);
    if (!record) return; // unknown ids ignored
    record.cancelRequested = true;
    record.controller.abort();
  }

  function handleDisconnect(): void {
    // Snapshot first: each abort settles its own record, mutating the map.
    for (const record of [...inflight.values()]) {
      record.silent = true;
      record.controller.abort();
    }
    inflight.clear(); // fresh state for the next connection (executors persist across reconnects)
  }

  return { handleHttpProxyRequest, handleHttpProxyCancel, handleDisconnect };
}
