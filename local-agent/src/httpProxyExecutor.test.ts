/**
 * Plain-script test (repo convention: `tsx`, `node:assert/strict`, no test
 * framework) covering the http-proxy executor against a stubbed `fetchImpl`:
 *   (1) happy path — three SSE-line pieces stream back as `http_proxy_chunk`
 *       frames with seq 0,1,2 and concatenated bodies equal to the input,
 *       then ONE `ok:true` terminal carrying status/contentType/totalBytes;
 *       the fetch call itself got the exact url/method/headers/body plus
 *       `redirect: 'error'` and an AbortSignal.
 *   (2) chunk cap — a body larger than 256 KiB splits into frames that each
 *       respect the cap, with monotonic seq and byte-exact concatenation.
 *   (3) connect error — a rejecting fetchImpl yields a SINGLE terminal
 *       `{ok:false, status:0, error}` and no chunks.
 *   (4) non-loopback destination — refused with
 *       `{ok:false,status:0,error:'non-loopback destination refused'}`
 *       WITHOUT ever calling fetchImpl (defense-in-depth, §6).
 *   (5) cancel mid-stream — aborts the fetch, remaining chunks suppressed,
 *       terminal `{ok:false,status:0,error:'cancelled'}`; unknown ids are
 *       ignored.
 *   (6) handleDisconnect — aborts every in-flight fetch and afterwards sends
 *       NOTHING for those requests; the executor stays usable for the next
 *       connection (executors persist across reconnects in index.ts).
 *   (7) local timeout backstop — a hung fetch aborts at `timeoutMs` and
 *       reports a distinct local-timeout terminal (defense-in-depth parity
 *       with commandExecutor's kill-tree backstop).
 */

import assert from 'node:assert/strict';
import {
  createHttpProxyExecutor,
  MAX_CHUNK_TEXT_BYTES,
  type HttpProxyExecutorOptions,
  type ProxyFetchLike,
} from './httpProxyExecutor.js';
import type { AgentToBackendMessage } from './transport.js';

type ProxyChunk = Extract<AgentToBackendMessage, { type: 'http_proxy_chunk' }>;
type ProxyResponse = Extract<AgentToBackendMessage, { type: 'http_proxy_response' }>;

function isChunk(m: AgentToBackendMessage): m is ProxyChunk {
  return m.type === 'http_proxy_chunk';
}
function isResponse(m: AgentToBackendMessage): m is ProxyResponse {
  return m.type === 'http_proxy_response';
}

function makeExecutor(overrides: Omit<Partial<HttpProxyExecutorOptions>, 'send'> = {}) {
  const sent: AgentToBackendMessage[] = [];
  const executor = createHttpProxyExecutor({ send: (message) => sent.push(message), ...overrides });
  return { executor, sent };
}

async function waitFor<T extends AgentToBackendMessage>(
  sent: AgentToBackendMessage[],
  predicate: (m: AgentToBackendMessage) => m is T,
  timeoutMs = 5_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = sent.find(predicate);
    if (found) return found;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for message`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Push-based stub stream: the test delivers pieces explicitly via `emit`,
 * which lets us hold the second piece back until after a cancel/disconnect
 * and prove late data produces no further relay traffic.
 */
function makeDeferredStream(pieces: string[]): { stream: ReadableStream<Uint8Array>; emit: () => void } {
  const encoder = new TextEncoder();
  let next = 0;
  let done = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
    },
    pull() {
      /* data is pushed manually by `emit` */
    },
    cancel() {
      done = true;
    },
  });
  return {
    stream,
    emit: () => {
      if (done || !controllerRef || next >= pieces.length) return;
      controllerRef.enqueue(encoder.encode(pieces[next++]));
      if (next >= pieces.length) {
        try {
          controllerRef.close();
        } catch {
          /* already closed by cancel racing emit */
        }
      }
    },
  };
}

function sseBodyStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const encoded = lines.map((line) => encoder.encode(line));
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < encoded.length) controller.enqueue(encoded[index++]);
      else controller.close();
    },
  });
}

interface RecordedCall {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string | null; signal: AbortSignal; redirect: string };
}

function recordingFetch(respond: (call: RecordedCall) => Promise<Response>): {
  fetchImpl: ProxyFetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: ProxyFetchLike = async (url, init) => {
    const call: RecordedCall = {
      url,
      init: {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: init.signal,
        redirect: init.redirect,
      },
    };
    calls.push(call);
    return respond(call);
  };
  return { fetchImpl, calls };
}

async function main(): Promise<void> {
  // (1) Happy path: three SSE pieces → three chunks (seq 0,1,2) + one terminal.
  {
    const lines = ['data: alpha\n\n', 'data: beta\n\n', 'data: gamma\n\n'];
    const { fetchImpl, calls } = recordingFetch(async () =>
      new Response(sseBodyStream(lines), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    );
    const { executor, sent } = makeExecutor({ fetchImpl });
    executor.handleHttpProxyRequest({
      type: 'http_proxy_request',
      requestId: 'px-1',
      url: 'http://127.0.0.1:1234/v1/models',
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
      body: null,
      timeoutMs: 10_000,
    });

    const chunks = [];
    const deadline = Date.now() + 5_000;
    while (sent.filter(isChunk).length < 3 && Date.now() < deadline) await sleep(10);
    chunks.push(...sent.filter(isChunk));
    assert.equal(chunks.length, 3, 'expected exactly 3 chunk frames');
    assert.deepEqual(
      chunks.map((c) => c.seq),
      [0, 1, 2],
      'seq starts at 0 and increases monotonically'
    );
    assert.equal(chunks.map((c) => c.text).join(''), lines.join(''), 'concatenated chunks must equal the body');

    const terminal = await waitFor(sent, isResponse);
    assert.equal(sent.indexOf(chunks[2]) < sent.indexOf(terminal), true, 'chunks must precede the terminal frame');
    assert.equal(terminal.requestId, 'px-1');
    assert.equal(terminal.ok, true);
    assert.equal(terminal.status, 200);
    assert.equal(terminal.contentType, 'text/event-stream');
    const expectedBytes = lines.reduce((n, l) => n + Buffer.byteLength(l, 'utf8'), 0);
    assert.equal(terminal.totalBytes, expectedBytes);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:1234/v1/models');
    assert.equal(calls[0].init.method, 'GET');
    assert.deepEqual(calls[0].init.headers, { Authorization: 'Bearer token' });
    assert.equal(calls[0].init.body, null);
    assert.equal(calls[0].init.redirect, 'error', 'redirects must always be hard errors');
    assert.ok(calls[0].init.signal, 'an AbortSignal must be handed to fetch');
    console.log('(1) happy path: 3 seq-numbered chunks then one ok:true terminal: OK');
  }

  // (2) Chunk cap: a >256 KiB body splits into frames each within the cap.
  {
    const pieceSizes = [250_000, 250_000, 100_000]; // 600_000 ASCII chars total
    const pieces = pieceSizes.map((n) => 'x'.repeat(n));
    const { fetchImpl, calls } = recordingFetch(async () =>
      new Response(sseBodyStream(pieces), { status: 200 })
    );
    const { executor, sent } = makeExecutor({ fetchImpl });
    executor.handleHttpProxyRequest({
      type: 'http_proxy_request',
      requestId: 'px-2',
      url: 'http://localhost:1234/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"prompt":"hi"}',
      timeoutMs: 10_000,
    });

    const terminal = await waitFor(sent, isResponse);
    const chunks = sent.filter(isChunk);
    assert.ok(chunks.length >= 2, 'a large body must split into multiple frames');
    for (const chunk of chunks) {
      assert.ok(Buffer.byteLength(chunk.text, 'utf8') <= MAX_CHUNK_TEXT_BYTES, 'every frame respects the 256 KiB cap');
    }
    // Each delivered piece becomes its own frame (eager streaming), so the
    // three stub pieces map 1:1 onto frames.
    assert.deepEqual(
      chunks.map((c) => Buffer.byteLength(c.text, 'utf8')),
      pieceSizes
    );
    assert.deepEqual(
      chunks.map((c) => c.seq),
      chunks.map((_, i) => i)
    );
    assert.equal(chunks.map((c) => c.text).join(''), pieces.join(''), 'splitting must be lossless');
    assert.equal(terminal.ok, true);
    assert.equal(terminal.totalBytes, 600_000, 'totalBytes counts raw body bytes');
    assert.equal(terminal.contentType, undefined, 'absent content-type stays absent');
    assert.equal(calls[0].init.body, '{"prompt":"hi"}', 'POST body must pass through verbatim');
    console.log('(2) oversized body splits into capped lossless frames: OK');
  }

  // (3) Connect error: single terminal {ok:false,status:0,error}, no chunks.
  {
    const { fetchImpl } = recordingFetch(async () => {
      throw new TypeError('fetch failed');
    });
    const { executor, sent } = makeExecutor({ fetchImpl });
    executor.handleHttpProxyRequest({
      type: 'http_proxy_request',
      requestId: 'px-3',
      url: 'http://127.0.0.1:9/v1/models',
      method: 'GET',
      headers: {},
      body: null,
      timeoutMs: 1_000,
    });
    const terminal = await waitFor(sent, isResponse);
    assert.equal(sent.filter(isChunk).length, 0, 'connect failures must not emit chunks');
    assert.equal(sent.length, 1, 'exactly one frame total');
    assert.equal(terminal.ok, false);
    assert.equal(terminal.status, 0);
    assert.equal(terminal.error, 'fetch failed');
    console.log('(3) connect error → single {ok:false,status:0,error} terminal: OK');
  }

  // (4) Non-loopback destinations are refused before any fetch happens.
  {
    let fetchCalled = false;
    const { fetchImpl } = recordingFetch(async () => {
      fetchCalled = true;
      throw new Error('executor attempted an off-host fetch');
    });
    const { executor, sent } = makeExecutor({ fetchImpl });
    executor.handleHttpProxyRequest({
      type: 'http_proxy_request',
      requestId: 'px-4',
      url: 'http://example.com/v1/models',
      method: 'GET',
      headers: {},
      body: null,
      timeoutMs: 1_000,
    });
    const refused = await waitFor(sent, (m): m is ProxyResponse => isResponse(m) && m.requestId === 'px-4');
    assert.equal(fetchCalled, false, 'fetchImpl must never run for a non-loopback host');
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 0);
    assert.equal(refused.error, 'non-loopback destination refused');

    executor.handleHttpProxyRequest({
      type: 'http_proxy_request',
      requestId: 'px-4b',
      url: 'http://192.168.1.10:1234/v1/models',
      method: 'GET',
      headers: {},
      body: null,
      timeoutMs: 1_000,
    });
    const refusedLan = await waitFor(sent, (m): m is ProxyResponse => isResponse(m) && m.requestId === 'px-4b');
    assert.equal(refusedLan.error, 'non-loopback destination refused');
    assert.equal(fetchCalled, false);
    console.log('(4) non-loopback destination refused without calling fetch: OK');
  }

  // (5) Cancel mid-stream: abort, suppress remaining chunks, terminal 'cancelled'.
  {
    const { stream, emit } = makeDeferredStream(['data: first\n\n', 'data: second\n\n']);
    const { fetchImpl, calls } = recordingFetch(async () => new Response(stream, { status: 200 }));
    const { executor, sent } = makeExecutor({ fetchImpl });

    executor.handleHttpProxyCancel('never-started'); // unknown ids are ignored
    await sleep(20);
    assert.equal(sent.length, 0, 'cancel for an unknown id must send nothing');

    executor.handleHttpProxyRequest({
      type: 'http_proxy_request',
      requestId: 'px-5',
      url: 'http://127.0.0.1:1234/v1/chat/completions',
      method: 'POST',
      headers: {},
      body: '{}',
      timeoutMs: 10_000,
    });
    emit(); // deliver the first piece
    const first = await waitFor(sent, isChunk);
    assert.equal(first.seq, 0);
    assert.equal(sent.some(isResponse), false, 'no terminal while the body is open');

    executor.handleHttpProxyCancel('px-5');
    const terminal = await waitFor(sent, isResponse);
    assert.equal(terminal.requestId, 'px-5');
    assert.equal(terminal.ok, false);
    assert.equal(terminal.status, 0);
    assert.equal(terminal.error, 'cancelled');
    assert.equal(calls[0].init.signal.aborted, true, 'cancel must abort the underlying fetch');

    emit(); // late data after cancel must not surface
    await sleep(50);
    assert.equal(sent.filter(isChunk).length, 1, 'remaining chunks suppressed after cancel');
    assert.equal(sent.filter(isResponse).length, 1, 'exactly one terminal frame');
    console.log('(5) cancel aborts the fetch and terminates with cancelled: OK');
  }

  // (6) handleDisconnect aborts everything in-flight and goes silent;
  //     the executor instance remains usable for the next connection.
  {
    const { stream, emit } = makeDeferredStream(['data: first\n\n', 'data: second\n\n']);
    let respondWithStream = true;
    const { fetchImpl, calls } = recordingFetch(async () => {
      if (respondWithStream) return new Response(stream, { status: 200 });
      return new Response('ok', { status: 200 });
    });
    const { executor, sent } = makeExecutor({ fetchImpl });
    executor.handleHttpProxyRequest({
      type: 'http_proxy_request',
      requestId: 'px-6',
      url: 'http://[::1]:1234/v1/models',
      method: 'GET',
      headers: {},
      body: null,
      timeoutMs: 10_000,
    });
    emit();
    await waitFor(sent, isChunk);
    assert.equal(calls[0].init.signal.aborted, false, 'precondition: still running');

    executor.handleDisconnect();
    assert.equal(calls[0].init.signal.aborted, true, 'disconnect must abort in-flight fetches');
    const countAtDisconnect = sent.length;
    emit(); // late data after disconnect must produce NOTHING
    await sleep(50);
    assert.equal(sent.length, countAtDisconnect, 'no frames of any kind may follow a disconnect');

    // Executors persist across reconnects (created once in main()), so the
    // same instance must serve a fresh connection.
    respondWithStream = false;
    executor.handleHttpProxyRequest({
      type: 'http_proxy_request',
      requestId: 'px-6b',
      url: 'http://127.0.0.1:1234/v1/models',
      method: 'GET',
      headers: {},
      body: null,
      timeoutMs: 10_000,
    });
    const revived = await waitFor(sent, (m): m is ProxyResponse => isResponse(m) && m.requestId === 'px-6b');
    assert.equal(revived.ok, true, 'executor must accept new work after disconnect (reconnect parity)');
    console.log('(6) handleDisconnect aborts all in-flight and silences them: OK');
  }

  // (7) Local timeout backstop: a hung fetch aborts at timeoutMs.
  {
    const hangFetch: ProxyFetchLike = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    const { executor, sent } = makeExecutor({ fetchImpl: hangFetch });
    executor.handleHttpProxyRequest({
      type: 'http_proxy_request',
      requestId: 'px-7',
      url: 'http://127.0.0.1:1234/v1/models',
      method: 'GET',
      headers: {},
      body: null,
      timeoutMs: 40,
    });
    const terminal = await waitFor(sent, isResponse);
    assert.equal(terminal.ok, false);
    assert.equal(terminal.status, 0);
    assert.match(terminal.error ?? '', /^local proxy timeout after 40ms$/);
    assert.equal(sent.filter(isChunk).length, 0);
    console.log('(7) hung fetch hits the local timeout backstop: OK');
  }

  console.log('\nhttpProxyExecutor: all tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
