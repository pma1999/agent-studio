/**
 * LM Studio transport service — the single network seam for everything
 * LM Studio-related (global-constraints.md §6/§7/§9).
 *
 * Responsibilities:
 * - per-user settings resolution (setting > env > default);
 * - reachability probe + transport auto-select (direct vs local-agent relay),
 *   cached ~10 s per user unless forced;
 * - `fetch`-compatible lmstudioFetch() returning standard Response objects
 *   over EITHER transport;
 * - JIT/pre-load decisions using the pinned §3 load body (never `ttl`);
 * - capability lookup (60 s cache) and compliance report building.
 *
 * Failure semantics (binding):
 * - Direct transport behaves like plain `fetch`: connection errors REJECT,
 *   and connect-timeouts apply ONLY when `init.timeoutMs` is provided so long
 *   streams are never aborted by us.
 * - Relay transport rejects before headers whenever the relay itself fails
 *   (disconnect / timeout / abort before the terminal frame); once the
 *   terminal frame has been observed the Response mirrors it verbatim
 *   (status 0 maps to 502 + JSON error body). Consumers therefore never hang
 *   on a dead stream and treat failures exactly like failed upstream fetches
 *   (§7: mid-stream relay failure surfaces as a stream error).
 */

import { nanoid } from 'nanoid';
import {
  cancelHttpProxyRequest,
  isAgentConnected,
  sendHttpProxyRequest,
  type HttpProxyResult,
} from '../agentRelay/registry.js';
import { isRelayUrlAllowed, parseProxyAllowlist } from '../agentRelay/httpProxyAllowlist.js';
import { getSettingValue } from '../routes/settings.js';
import {
  DEFAULT_LMSTUDIO_PROFILE_ID,
  LMSTUDIO_PROFILES,
  buildComplianceKnobs,
  normalizeCatalogEntry,
  selectSwapCandidates,
  stripVariantKey,
  type ComplianceKnob,
  type LmStudioCatalogEntry,
  type LmStudioProfileId,
} from './lmstudio.js';

// ---------------------------------------------------------------------------
// Constants (global-constraints §7/§9)
// ---------------------------------------------------------------------------

const DEFAULT_LMSTUDIO_BASE_URL = 'http://127.0.0.1:1234';
const PROBE_TIMEOUT_MS = 1500;
const PROBE_CACHE_TTL_MS = 10_000;
const CAPABILITY_CACHE_TTL_MS = 60_000;
const DEFAULT_LMSTUDIO_LOAD_TIMEOUT_MS = 300_000;
/**
 * Registry timeouts must be finite; this is only a generous ceiling so long
 * SSE streams are not cut off by accident. Callers bound individual requests
 * with `init.timeoutMs` when they can.
 */
const DEFAULT_RELAY_REQUEST_TIMEOUT_MS = 600_000;

// Memory management (global-constraints §11)
const DEFAULT_IDLE_UNLOAD_MINUTES = 45;
const IDLE_SWEEP_INTERVAL_MS = 60_000;
/** The ONLY path that counts as model usage (§11); management traffic never matches. */
const INFERENCE_PATH = '/v1/chat/completions';

export type LmStudioApiSurface = 'native-v1' | 'openai-only';

export interface LmStudioSettings {
  baseUrl: string;
  token: string | null;
  profileId: LmStudioProfileId;
}

export interface LmStudioProbe {
  reachable: boolean;
  transport: 'direct' | 'relay' | null;
  apiSurface: LmStudioApiSurface | null;
  agentConnected: boolean;
  /** Present when a configured base URL was refused by the §6 allowlist before sending. */
  blockedReason?: string;
}

export interface LmStudioFetchInit {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string | null;
  /** Connect/response timeout; NEVER applied unless explicitly passed (protects long streams). */
  timeoutMs?: number;
  signal?: AbortSignal | null;
}

export interface EnsureLoadedResult {
  loaded: boolean;
  mode: 'already' | 'loaded' | 'jit-fallback' | 'unsupported' | 'failed';
  error?: string;
}

export interface LmStudioModelCapabilities {
  trainedForToolUse: boolean | null;
  maxContextLength: number | null;
}

/** The §8 compliance payload minus route plumbing (routes add their own error envelopes). */
export interface LmStudioComplianceReport {
  ok: true;
  profile: { id: LmStudioProfileId; label: string };
  apiSurface: LmStudioApiSurface | null;
  knobs: ComplianceKnob[];
}

// ---------------------------------------------------------------------------
// Settings resolution (§9 precedence: setting > env > default)
// ---------------------------------------------------------------------------

function readSetting(userId: string, key: string): string {
  try {
    return getSettingValue(userId, key).trim();
  } catch {
    return ''; // fail soft to env/default like every other provider read
  }
}

function envValue(key: string): string | undefined {
  const raw = process.env[key]?.trim();
  return raw ? raw : undefined;
}

export function getLmStudioSettings(userId: string): LmStudioSettings {
  const storedBase = readSetting(userId, 'lmstudio_base_url');
  const baseUrl = storedBase || envValue('LMSTUDIO_BASE_URL') || DEFAULT_LMSTUDIO_BASE_URL;
  const storedToken = readSetting(userId, 'lmstudio_api_token');
  const token = storedToken || envValue('LMSTUDIO_API_TOKEN') || null;
  const storedProfileId = readSetting(userId, 'lmstudio_profile') as LmStudioProfileId;
  // Own-property check (F3-03): inherited keys like 'toString' must NOT resolve.
  const profileId = Object.prototype.hasOwnProperty.call(LMSTUDIO_PROFILES, storedProfileId)
    ? storedProfileId
    : DEFAULT_LMSTUDIO_PROFILE_ID;
  return { baseUrl, token, profileId };
}

function authHeaders(token: string | null, extra?: Record<string, string>): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(extra ?? {}),
  };
}

// ---------------------------------------------------------------------------
// Memory settings (§11: setting > env > default)
// ---------------------------------------------------------------------------

export interface LmStudioMemorySettings {
  /** Idle minutes before auto-unload; `0` disables idle unload for the user. */
  idleUnloadMinutes: number;
  /** Whether loading one model ejects other loaded instances (single-slot swap). */
  autoSwap: boolean;
}

/** §11 memory knobs with the same precedence as every other LM Studio setting. */
export function getLmStudioMemorySettings(userId: string): LmStudioMemorySettings {
  const rawMinutes =
    readSetting(userId, 'lmstudio_idle_unload_minutes') || envValue('LMSTUDIO_IDLE_UNLOAD_MINUTES');
  let idleUnloadMinutes = DEFAULT_IDLE_UNLOAD_MINUTES;
  if (rawMinutes !== undefined) {
    const parsed = Number(rawMinutes);
    if (Number.isFinite(parsed) && parsed >= 0) idleUnloadMinutes = parsed;
  }
  const rawSwap = readSetting(userId, 'lmstudio_auto_swap') || envValue('LMSTUDIO_AUTO_SWAP');
  // Anything but the literal 'false' keeps swapping enabled.
  return { idleUnloadMinutes, autoSwap: rawSwap === undefined ? true : rawSwap !== 'false' };
}

function proxyAllowlist(): string[] {
  return parseProxyAllowlist(process.env.AGENT_HTTP_PROXY_ALLOW_HOSTS);
}

// ---------------------------------------------------------------------------
// Probe + version detection (§7)
// ---------------------------------------------------------------------------

const probeCache = new Map<string, { probe: LmStudioProbe; timestamp: number }>();

export async function probeLmStudio(
  userId: string,
  opts: { force?: boolean } = {},
): Promise<LmStudioProbe> {
  if (!opts.force) {
    const hit = probeCache.get(userId);
    if (hit && Date.now() - hit.timestamp < PROBE_CACHE_TTL_MS) return hit.probe;
  }
  const probe = await computeProbe(userId);
  probeCache.set(userId, { probe, timestamp: Date.now() });
  return probe;
}

async function computeProbe(userId: string): Promise<LmStudioProbe> {
  const settings = getLmStudioSettings(userId);
  const agentConnected = isAgentConnected(userId);

  // 1) Direct OpenAI-compat reachability (≤1.5 s; never proxies through the agent).
  try {
    const direct = await fetch(`${settings.baseUrl}/v1/models`, {
      headers: authHeaders(settings.token),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (direct.ok) {
      return {
        reachable: true,
        transport: 'direct',
        apiSurface: await detectSurfaceDirect(settings),
        agentConnected,
      };
    }
  } catch {
    // fall through to relay probing
  }

  // 2) Relay through the paired local agent — allowlist gate BEFORE any send (§6).
  if (!agentConnected) {
    return { reachable: false, transport: null, apiSurface: null, agentConnected };
  }
  const verdict = isRelayUrlAllowed(`${settings.baseUrl}/v1/models`, proxyAllowlist());
  if (!verdict.allowed) {
    return {
      reachable: false,
      transport: null,
      apiSurface: null,
      agentConnected,
      blockedReason: verdict.reason,
    };
  }

  // Version detection over the relay: /api/v1/models (0.4.x) else /api/v0/models (≤0.3.x).
  // A dead-but-connected agent must degrade to "unreachable", never throw.
  try {
    const v1 = await relayExchange(userId, settings, { path: '/api/v1/models', timeoutMs: PROBE_TIMEOUT_MS });
    if (v1.result.ok && v1.result.status === 200) {
      return { reachable: true, transport: 'relay', apiSurface: 'native-v1', agentConnected };
    }
  } catch {
    return { reachable: false, transport: null, apiSurface: null, agentConnected };
  }
  try {
    const v0 = await relayExchange(userId, settings, { path: '/api/v0/models', timeoutMs: PROBE_TIMEOUT_MS });
    if (v0.result.ok && v0.result.status === 200) {
      return { reachable: true, transport: 'relay', apiSurface: 'openai-only', agentConnected };
    }
  } catch {
    // fall through to unreachable
  }
  return { reachable: false, transport: null, apiSurface: null, agentConnected };
}

async function detectSurfaceDirect(settings: LmStudioSettings): Promise<LmStudioApiSurface | null> {
  try {
    const v1 = await fetch(`${settings.baseUrl}/api/v1/models`, {
      headers: authHeaders(settings.token),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (v1.ok) return 'native-v1';
  } catch {
    return null;
  }
  try {
    const v0 = await fetch(`${settings.baseUrl}/api/v0/models`, {
      headers: authHeaders(settings.token),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (v0.ok) return 'openai-only';
  } catch {
    // ignore
  }
  return null;
}

// ---------------------------------------------------------------------------
// Relay streaming core (rides task-2's registry sender; §5 wire contract)
// ---------------------------------------------------------------------------

interface RelayExchangeInit {
  method?: 'GET' | 'POST';
  body?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal | null;
}

interface RelayStreamHandle {
  requestId: string;
  stream: ReadableStream<Uint8Array>;
  /** Resolves with the terminal frame, or rejects on abort/disconnect/timeout before it. */
  terminal: Promise<HttpProxyResult>;
}

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'error' in error) {
    const message = (error as { error?: unknown }).error;
    if (typeof message === 'string') return message;
  }
  return error instanceof Error ? error.message : String(error);
}

function relayStream(
  userId: string,
  settings: LmStudioSettings,
  path: string,
  init: RelayExchangeInit,
): RelayStreamHandle {
  const url = `${settings.baseUrl}${path}`;
  const requestId = `http_proxy_${nanoid()}`;

  // F3-02 / §6 choke point: EVERY outbound relay request re-checks the
  // allowlist immediately before send — a cached probe verdict may be up to
  // ~10 s stale when user settings change mid-window. Refusal mirrors a
  // status-0 transport failure so every caller maps it to today's explanatory
  // failure shape (502 JSON / degraded payload) with no frame on the wire.
  const sendVerdict = isRelayUrlAllowed(url, proxyAllowlist());
  if (!sendVerdict.allowed) {
    console.warn(`[lmstudioTransport] relay request blocked by allowlist (${url}): ${sendVerdict.reason}`);
    const blocked: HttpProxyResult = {
      ok: false,
      status: 0,
      error: `blocked by relay allowlist: ${sendVerdict.reason}`,
    };
    return {
      requestId,
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error(blocked.error));
        },
      }),
      terminal: Promise.resolve(blocked),
    };
  }

  const method = init.method ?? 'GET';
  const body = init.body ?? null;
  const timeoutMs = init.timeoutMs ?? DEFAULT_RELAY_REQUEST_TIMEOUT_MS;
  const headers = authHeaders(settings.token);
  const external = init.signal ?? null;
  const encoder = new TextEncoder();

  let resolveTerminal!: (result: HttpProxyResult) => void;
  let rejectTerminal!: (error: Error) => void;
  const terminal = new Promise<HttpProxyResult>((resolve, reject) => {
    resolveTerminal = resolve;
    rejectTerminal = reject;
  });

  let settled = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  const detach = () => {
    try {
      external?.removeEventListener('abort', onExternalAbort);
    } catch {
      /* noop */
    }
  };
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    rejectTerminal(error);
    try {
      controllerRef?.error(error);
    } catch {
      /* stream already closed */
    }
    detach();
  };
  const onExternalAbort = () => {
    fail(abortError());
    // Best-effort cancel toward the agent; ignored if the pending already ended.
    cancelHttpProxyRequest(userId, requestId);
  };

  if (external?.aborted) {
    const error = abortError();
    settled = true;
    rejectTerminal(error);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(error);
      },
    });
    return { requestId, terminal, stream };
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controllerRef = controller;
      external?.addEventListener('abort', onExternalAbort, { once: true });
      let result: HttpProxyResult;
      try {
        result = await sendHttpProxyRequest(
          userId,
          requestId,
          { url, method, headers, body, timeoutMs },
          (text) => {
            try {
              controller.enqueue(encoder.encode(text));
            } catch {
              /* stream already closed or errored */
            }
          },
        );
      } catch (err) {
        fail(new Error(errorMessage(err)));
        return;
      }
      if (settled) return; // an abort raced ahead; keep its rejection authoritative
      settled = true;
      resolveTerminal(result);
      detach();
      try {
        controller.close();
      } catch {
        /* already errored */
      }
    },
    cancel() {
      // Consumer tore down the body early: tell the agent to stop fetching.
      cancelHttpProxyRequest(userId, requestId);
    },
  });

  return { requestId, terminal, stream };
}

interface BufferedExchange {
  result: HttpProxyResult;
  text: string;
}

async function relayExchange(
  userId: string,
  settings: LmStudioSettings,
  init: RelayExchangeInit & { path: string },
): Promise<BufferedExchange> {
  const handle = relayStream(userId, settings, init.path, init);
  const decoder = new TextDecoder();
  let text = '';
  const drainStarted = (async () => {
    const reader = handle.stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  })();
  // F3-01: attach the safety catch IMMEDIATELY at creation — when the terminal
  // promise rejects below (disconnect/timeout/abort), a pending reader.read()
  // rejects too, and an orphaned drain promise would be a process-fatal
  // unhandled rejection.
  void drainStarted.catch(() => undefined);
  const result = await handle.terminal;
  await drainStarted.catch(() => undefined);
  return { result, text };
}

// ---------------------------------------------------------------------------
// Usage tracking (global-constraints §11 — ZERO chat.ts edits)
//
// Keyed `(userId, stripVariantKey(model))`. Stamped at exactly two places:
//   1. `ensureModelLoaded` entry (chat.ts's pre-flight at every stream start);
//   2. `lmstudioFetch` when the path is the inference path and OUR OWN outbound
//      `init.body` carries a model id.
// Management traffic rides `bufferedRequest` (which bypasses `lmstudioFetch`)
// and can therefore never stamp usage. An in-flight counter per entry blocks
// idle ejection while a stream is being consumed.
// ---------------------------------------------------------------------------

interface LmStudioUsageEntry {
  lastUsedAt: number;
  /** Live streams consuming this model; > 0 blocks idle ejection. */
  inFlight: number;
}

/** Module-map pattern shared with probeCache/capabilityCache; TTL-free by design. */
const usageTracking = new Map<string, LmStudioUsageEntry>();

function usageTrackingKey(userId: string, upstreamModelKey: string): string {
  return `${userId}\u0000${stripVariantKey(upstreamModelKey)}`;
}

function stampLmStudioUsage(userId: string, upstreamModelKey: string): void {
  const key = usageTrackingKey(userId, upstreamModelKey);
  const entry = usageTracking.get(key);
  if (entry) entry.lastUsedAt = Date.now();
  else usageTracking.set(key, { lastUsedAt: Date.now(), inFlight: 0 });
}

function forgetLmStudioUsage(userId: string, upstreamModelKey: string): void {
  usageTracking.delete(usageTrackingKey(userId, upstreamModelKey));
}

/**
 * Stamps last-use and raises the in-flight counter; returns an idempotent
 * releaser that lowers it exactly once.
 */
function beginLmStudioInference(userId: string, upstreamModelKey: string): () => void {
  const key = usageTrackingKey(userId, upstreamModelKey);
  let entry = usageTracking.get(key);
  if (!entry) {
    entry = { lastUsedAt: Date.now(), inFlight: 0 };
    usageTracking.set(key, entry);
  }
  entry.lastUsedAt = Date.now();
  entry.inFlight += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = usageTracking.get(key);
    if (!current) return;
    current.inFlight = Math.max(0, current.inFlight - 1);
  };
}

/**
 * Model id carried by OUR OWN outbound chat-completions body (chat.ts builds
 * it via JSON.stringify from requestBody.model — never model output or tool
 * arguments). Null for anything that is not a POST with a non-empty model.
 */
function inferenceTargetFromInit(init: LmStudioFetchInit): string | null {
  if ((init.method ?? 'GET') !== 'POST') return null;
  if (typeof init.body !== 'string' || init.body.length === 0) return null;
  try {
    const model = (JSON.parse(init.body) as { model?: unknown } | null)?.model;
    return typeof model === 'string' && model.trim() ? model : null;
  } catch {
    return null;
  }
}

/**
 * Wraps a direct-transport Response body in a passthrough stream that releases
 * the in-flight counter when the body fully closes, errors, or is cancelled —
 * `.getReader()/.text()/.json()` observability is preserved verbatim because
 * the wrapper is an ordinary ReadableStream of the same chunks.
 */
function trackDirectResponseBody(response: Response, release: () => void): Response {
  const body = response.body;
  if (!body) {
    release();
    return response;
  }
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    release();
  };
  const reader = body.getReader();
  const trackedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          releaseOnce(); // body fully closed
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        releaseOnce(); // body errored
        controller.error(err instanceof Error ? err : new Error(String(err)));
      }
    },
    cancel(reason) {
      releaseOnce(); // consumer tore the body down early
      return reader.cancel(reason);
    },
  });
  return new Response(trackedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

// ---------------------------------------------------------------------------
// Public fetch seam (transport auto-select per call, §7)
// ---------------------------------------------------------------------------

function composeSignal(
  timeoutMs: number | undefined,
  external: AbortSignal | null | undefined,
): AbortSignal | undefined {
  const timeout =
    timeoutMs != null && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  if (timeout && external) return AbortSignal.any([timeout, external]);
  return timeout ?? external ?? undefined;
}

function directFetch(
  settings: LmStudioSettings,
  path: string,
  init: LmStudioFetchInit,
): Promise<Response> {
  return fetch(`${settings.baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: authHeaders(settings.token, init.headers),
    body: init.body ?? null,
    signal: composeSignal(init.timeoutMs, init.signal),
  });
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function lmstudioFetch(
  userId: string,
  path: string,
  init: LmStudioFetchInit = {},
): Promise<Response> {
  if (!path.startsWith('/')) {
    throw new Error(`lmstudioFetch path must begin with '/': got "${path}"`);
  }
  const probe = await probeLmStudio(userId);
  const settings = getLmStudioSettings(userId);

  // §11 usage signal: ONLY real inference traffic stamps/counts. Management
  // calls ride bufferedRequest and never reach this seam.
  const inferenceModel = path === INFERENCE_PATH ? inferenceTargetFromInit(init) : null;
  const releaseInFlight =
    inferenceModel !== null ? beginLmStudioInference(userId, inferenceModel) : null;

  if (probe.transport === 'direct') {
    try {
      const response = await directFetch(settings, path, init);
      if (!releaseInFlight) return response;
      return trackDirectResponseBody(response, releaseInFlight);
    } catch (err) {
      releaseInFlight?.(); // fetch-level failure lowers the counter too
      throw err;
    }
  }

  if (probe.transport === 'relay') {
    const url = `${settings.baseUrl}${path}`;
    const verdict = isRelayUrlAllowed(url, proxyAllowlist());
    if (!verdict.allowed) {
      console.warn(`[lmstudioTransport] relay fetch blocked by allowlist (${url}): ${verdict.reason}`);
      releaseInFlight?.();
      return jsonResponse(502, {
        error: 'LM Studio target is not allowed through the local-agent relay.',
        reason: verdict.reason,
      });
    }
    const handle = relayStream(userId, settings, path, init);
    if (releaseInFlight) {
      // §11 relay hook: every chunk precedes the terminal frame, so terminal
      // settlement — resolve OR reject (disconnect/timeout/abort) — IS the
      // body-close event for this transport.
      void handle.terminal.then(
        () => undefined,
        () => undefined,
      ).then(() => releaseInFlight());
    }
    // Rejects here when the relay fails before the terminal frame (disconnect,
    // timeout, abort) — same observable shape as a failed upstream fetch.
    const result = await handle.terminal;
    if (result.status === 0) {
      return jsonResponse(502, {
        error: result.error ?? 'LM Studio request failed through the local-agent relay.',
      });
    }
    return new Response(handle.stream, {
      status: result.status,
      headers: { 'content-type': result.contentType ?? 'application/octet-stream' },
    });
  }

  releaseInFlight?.();
  return jsonResponse(502, {
    error: probe.blockedReason
      ? 'LM Studio target is not allowed through the local-agent relay.'
      : 'LM Studio is not reachable.',
    ...(probe.blockedReason ? { reason: probe.blockedReason } : {}),
  });
}

// ---------------------------------------------------------------------------
// Catalog access shared by load/capabilities/compliance
// ---------------------------------------------------------------------------

interface BufferedResponse {
  status: number;
  ok: boolean;
  text: string;
  contentType: string | null;
  error: string | null;
}

async function bufferedRequest(
  userId: string,
  settings: LmStudioSettings,
  path: string,
  init: LmStudioFetchInit = {},
): Promise<BufferedResponse> {
  const probe = await probeLmStudio(userId);
  if (probe.transport === 'relay') {
    const { result, text } = await relayExchange(userId, settings, { ...init, path });
    return {
      status: result.status,
      ok: result.ok,
      text,
      contentType: result.contentType ?? null,
      error: result.error ?? null,
    };
  }
  if (probe.transport === 'direct') {
    try {
      const res = await directFetch(settings, path, init);
      return {
        status: res.status,
        ok: res.ok,
        text: await res.text(),
        contentType: res.headers.get('content-type'),
        error: null,
      };
    } catch (err) {
      return { status: 0, ok: false, text: '', contentType: null, error: errorMessage(err) };
    }
  }
  return {
    status: 0,
    ok: false,
    text: '',
    contentType: null,
    error: probe.blockedReason ?? 'LM Studio is not reachable.',
  };
}

type CatalogResult = { ok: true; entries: LmStudioCatalogEntry[] } | { ok: false; error: string };

async function fetchCatalog(userId: string, settings: LmStudioSettings): Promise<CatalogResult> {
  const response = await bufferedRequest(userId, settings, '/api/v1/models');
  if (!response.ok) {
    return {
      ok: false,
      error: response.error ?? `catalog request failed with status ${response.status}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    return { ok: false, error: 'catalog endpoint returned invalid JSON' };
  }
  const models = (parsed as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return { ok: false, error: 'catalog response has no models array' };
  const entries = models
    .filter((model): model is Record<string, unknown> => model !== null && typeof model === 'object')
    .map(normalizeCatalogEntry);
  return { ok: true, entries };
}

function loadTimeoutMs(): number {
  const raw = Number(process.env.LMSTUDIO_LOAD_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LMSTUDIO_LOAD_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Model loading (§3 load body — EXACTLY these fields, never ttl)
// ---------------------------------------------------------------------------

export async function ensureModelLoaded(
  userId: string,
  upstreamModelKey: string,
): Promise<EnsureLoadedResult> {
  try {
    const probe = await probeLmStudio(userId);
    if (!probe.reachable || probe.transport === null) {
      return {
        loaded: false,
        mode: 'failed',
        error: probe.blockedReason ?? 'LM Studio is not reachable.',
      };
    }
    if (probe.apiSurface !== 'native-v1') {
      return {
        loaded: false,
        mode: 'unsupported',
        error: 'REST model loading requires the native /api/v1 surface (LM Studio 0.4.x).',
      };
    }

    // §11 usage stamp #1: chat.ts's pre-flight calls this at EVERY stream start.
    // Placed after the reachability/surface early-returns, per §11.
    stampLmStudioUsage(userId, upstreamModelKey);

    const settings = getLmStudioSettings(userId);
    const catalog = await fetchCatalog(userId, settings);
    if (!catalog.ok) return { loaded: false, mode: 'failed', error: catalog.error };

    const entry = catalog.entries.find((candidate) => candidate.key === upstreamModelKey);
    if (!entry) {
      return {
        loaded: false,
        mode: 'jit-fallback',
        error: `Model "${upstreamModelKey}" is absent from the native catalog; relying on JIT loading.`,
      };
    }
    // §11 ordering invariant: a loaded target returns BEFORE any swap
    // consideration — it must never cause ejections (even of foreign models).
    if (entry.loadedConfigs.length > 0) return { loaded: true, mode: 'already' };

    // §11 single-slot swap — AFTER the catalog fetch, BEFORE the profile-load
    // POST. Ejects every loaded instance whose variant-stripped base differs
    // from the target's. Ejection failures are logged and NON-FATAL: the load
    // still proceeds. autoSwap=false skips the block entirely, leaving LM
    // Studio's own Auto-Evict in charge.
    const memory = getLmStudioMemorySettings(userId);
    if (memory.autoSwap) {
      const loadedKeys = catalog.entries
        .filter((candidate) => candidate.loadedConfigs.length > 0)
        .map((candidate) => candidate.key);
      const distinctBases = [
        ...new Set(selectSwapCandidates(upstreamModelKey, loadedKeys).map(stripVariantKey)),
      ];
      for (const ejectedBase of distinctBases) {
        const outcome = await unloadLmStudioModel(userId, ejectedBase);
        if (outcome.ok) {
          console.log(
            `[lmstudioTransport] auto-swap: unloaded "${ejectedBase}"` +
              ` (${outcome.instancesUnloaded ?? 0} instance(s)) before loading "${upstreamModelKey}"`,
          );
        } else {
          console.warn(
            `[lmstudioTransport] auto-swap: failed to eject "${ejectedBase}"` +
              ` (non-fatal, continuing): ${outcome.error ?? outcome.status}`,
          );
        }
      }
    }

    const profile = LMSTUDIO_PROFILES[getLmStudioSettings(userId).profileId];
    // global-constraints §3 verbatim: model + four REST knobs + echo_load_config. NO ttl.
    const loadBody = {
      model: upstreamModelKey,
      context_length: profile.contextLength,
      flash_attention: profile.flashAttention,
      offload_kv_cache_to_gpu: profile.offloadKvCacheToGpu,
      eval_batch_size: profile.evalBatchSize,
      echo_load_config: true,
    };
    const response = await bufferedRequest(userId, settings, '/api/v1/models/load', {
      method: 'POST',
      body: JSON.stringify(loadBody),
      timeoutMs: loadTimeoutMs(),
    });
    if (!response.ok) {
      const detail = response.error || response.text.slice(0, 300);
      return {
        loaded: false,
        mode: 'failed',
        error: `Load request failed with status ${response.status}${detail ? `: ${detail}` : ''}`,
      };
    }
    return { loaded: true, mode: 'loaded' };
  } catch (err) {
    return { loaded: false, mode: 'failed', error: errorMessage(err) };
  }
}

// ---------------------------------------------------------------------------
// Manual/native unload + idle auto-unload (global-constraints §11)
// ---------------------------------------------------------------------------

export type LmStudioUnloadStatus = 'unloaded' | 'not-loaded' | 'unsupported' | 'failed';

export interface LmStudioUnloadResult {
  ok: boolean;
  status: LmStudioUnloadStatus;
  instancesUnloaded?: number;
  error?: string;
}

/**
 * Ejects every live instance whose variant-stripped base matches
 * `upstreamModelKey`, over the native-v1 REST surface only. Frozen §11
 * exchange: POST /api/v1/models/unload `{instance_id}` per id via the existing
 * buffered exchange (which rides the §6 allowlist choke point). Total — never
 * throws; ok:false carries the reason. The usage-tracking entry is dropped on
 * success/'not-loaded' so the idle sweep stops considering the model.
 */
export async function unloadLmStudioModel(
  userId: string,
  upstreamModelKey: string,
): Promise<LmStudioUnloadResult> {
  try {
    const probe = await probeLmStudio(userId);
    if (!probe.reachable || probe.transport === null) {
      return {
        ok: false,
        status: 'failed',
        error: probe.blockedReason ?? 'LM Studio is not reachable.',
      };
    }
    if (probe.apiSurface !== 'native-v1') {
      return {
        ok: false,
        status: 'unsupported',
        error: 'REST unload requires LM Studio 0.4.x.',
      };
    }
    const settings = getLmStudioSettings(userId);
    const catalog = await fetchCatalog(userId, settings);
    if (!catalog.ok) return { ok: false, status: 'failed', error: catalog.error };

    const targetBase = stripVariantKey(upstreamModelKey);
    const instanceIds = catalog.entries
      .filter((candidate) => stripVariantKey(candidate.key) === targetBase)
      .flatMap((candidate) => candidate.loadedInstanceIds)
      .filter((id) => id.length > 0);

    if (instanceIds.length === 0) {
      forgetLmStudioUsage(userId, upstreamModelKey);
      // Fail-soft idempotency: nothing loaded is a SUCCESS outcome.
      return { ok: true, status: 'not-loaded', instancesUnloaded: 0 };
    }

    let unloaded = 0;
    for (const instanceId of instanceIds) {
      const response = await bufferedRequest(userId, settings, '/api/v1/models/unload', {
        method: 'POST',
        body: JSON.stringify({ instance_id: instanceId }),
      });
      if (!response.ok) {
        const detail = response.error || response.text.slice(0, 300);
        return {
          ok: false,
          status: 'failed',
          instancesUnloaded: unloaded,
          error: `Unload request failed with status ${response.status}${detail ? `: ${detail}` : ''}`,
        };
      }
      unloaded += 1;
    }
    forgetLmStudioUsage(userId, upstreamModelKey);
    return { ok: true, status: 'unloaded', instancesUnloaded: unloaded };
  } catch (err) {
    return { ok: false, status: 'failed', error: errorMessage(err) };
  }
}

let idleSweepTimer: ReturnType<typeof setInterval> | null = null;

/** Lazy singleton (§11): ONE interval per process, `.unref()`'d so it can never hold the process open; safe across repeated imports. */
function ensureIdleSweepTimer(): void {
  if (idleSweepTimer !== null) return;
  idleSweepTimer = setInterval(() => {
    void runLmStudioIdleSweep().catch(() => undefined);
  }, IDLE_SWEEP_INTERVAL_MS);
  idleSweepTimer.unref?.();
}
ensureIdleSweepTimer();

/**
 * One idle-sweep tick (§11), exported as a TEST SEAM: pass `nowMs` to make the
 * idle math deterministic. Per tracked user honoring their
 * `idle_unload_minutes` ('0' skips the user entirely), entries idle STRICTLY
 * longer than N minutes are best-effort unloaded, skipping any key with an
 * in-flight counter > 0. Tracking entries are deleted after success/
 * 'not-loaded'; failed entries stay for the next tick. The whole tick is
 * wrapped so it can never throw. Returns the number of entries ejected.
 */
export async function runLmStudioIdleSweep(nowMs: number = Date.now()): Promise<number> {
  let ejected = 0;
  try {
    const snapshot = [...usageTracking.entries()].map(([key, entry]) => ({ key, entry }));
    const userIds = [...new Set(snapshot.map(({ key }) => key.split('\u0000')[0]))];
    for (const userId of userIds) {
      let thresholdMs: number;
      try {
        const minutes = getLmStudioMemorySettings(userId).idleUnloadMinutes;
        if (!(minutes > 0)) continue; // '0' disables per-user idle unload
        thresholdMs = minutes * 60_000;
      } catch {
        continue;
      }
      for (const { key, entry } of snapshot) {
        if (!key.startsWith(`${userId}\u0000`)) continue;
        if (entry.inFlight > 0) continue; // never eject under a live stream
        if (nowMs - entry.lastUsedAt <= thresholdMs) continue; // strictly > N minutes
        const baseKey = key.slice(userId.length + 1);
        let outcome: LmStudioUnloadResult | null = null;
        try {
          outcome = await unloadLmStudioModel(userId, baseKey);
        } catch {
          outcome = null; // unloadLmStudioModel is total, but never let a tick throw
        }
        if (outcome && (outcome.status === 'unloaded' || outcome.status === 'not-loaded')) {
          usageTracking.delete(key); // §11: drop tracking after success/not-loaded
          ejected += 1;
        }
      }
    }
  } catch {
    // whole-tick guard: sweep failures must never crash the process
  }
  return ejected;
}

// ---------------------------------------------------------------------------
// Capabilities (60 s cache per user+model)
// ---------------------------------------------------------------------------

const capabilityCache = new Map<string, { value: LmStudioModelCapabilities; timestamp: number }>();

export async function getModelCapabilities(
  userId: string,
  upstreamModelKey: string,
): Promise<LmStudioModelCapabilities> {
  const cacheKey = `${userId}\u0000${upstreamModelKey}`;
  const hit = capabilityCache.get(cacheKey);
  if (hit && Date.now() - hit.timestamp < CAPABILITY_CACHE_TTL_MS) return hit.value;

  let value: LmStudioModelCapabilities = { trainedForToolUse: null, maxContextLength: null };
  try {
    const probe = await probeLmStudio(userId);
    if (probe.reachable && probe.apiSurface === 'native-v1') {
      const settings = getLmStudioSettings(userId);
      const catalog = await fetchCatalog(userId, settings);
      const entry = catalog.ok
        ? catalog.entries.find((candidate) => candidate.key === upstreamModelKey)
        : undefined;
      if (entry) {
        value = {
          trainedForToolUse: entry.trainedForToolUse,
          maxContextLength: entry.contextLength > 0 ? entry.contextLength : null,
        };
      }
    }
  } catch {
    // keep nulls — capability lookups are advisory and must never throw
  }
  capabilityCache.set(cacheKey, { value, timestamp: Date.now() });
  return value;
}

// ---------------------------------------------------------------------------
// Compliance report (§8 payload minus route plumbing)
// ---------------------------------------------------------------------------

export async function buildComplianceReport(
  userId: string,
  upstreamModelKey: string,
): Promise<LmStudioComplianceReport> {
  const settings = getLmStudioSettings(userId);
  const profile = LMSTUDIO_PROFILES[settings.profileId];

  // Total by contract (F3-04): pre-terminal relay failures and any other
  // exchange error degrade to "nothing observable" — apiSurface null and a
  // liveConfig null knob set (every knob met:null) — instead of throwing.
  let apiSurface: LmStudioApiSurface | null = null;
  let liveConfig: Record<string, unknown> | null = null;
  try {
    const probe = await probeLmStudio(userId);
    if (probe.reachable && probe.apiSurface === 'native-v1') {
      apiSurface = probe.apiSurface;
      const catalog = await fetchCatalog(userId, settings);
      if (catalog.ok) {
        const entry = catalog.entries.find((candidate) => candidate.key === upstreamModelKey);
        const candidate = entry?.loadedConfigs[0];
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
          liveConfig = candidate as Record<string, unknown>;
        }
      }
    }
  } catch {
    apiSurface = null;
    liveConfig = null;
  }
  return {
    ok: true,
    profile: { id: profile.id, label: profile.label },
    apiSurface,
    knobs: buildComplianceKnobs(profile, liveConfig, apiSurface),
  };
}
