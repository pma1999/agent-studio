import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testDbPath = path.join(os.tmpdir(), `lmstudio-relay-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = testDbPath;

const { default: db, migrate } = await import('../server/db.js');
const {
  cancelHttpProxyRequest,
  registerAgentConnection,
  sendHttpProxyRequest,
  unregisterAgentConnection,
} = await import('../server/agentRelay/registry.js');
const {
  AgentToBackendMessageSchema,
  BackendToAgentMessageSchema,
} = await import('../server/agentRelay/protocol.js');
const {
  DEFAULT_PROXY_ALLOWLIST,
  isRelayUrlAllowed,
  parseProxyAllowlist,
} = await import('../server/agentRelay/httpProxyAllowlist.js');
type AgentToBackendMessage = import('../server/agentRelay/protocol.js').AgentToBackendMessage;
type BackendToAgentMessage = import('../server/agentRelay/protocol.js').BackendToAgentMessage;
type AgentConnection = import('../server/agentRelay/registry.js').AgentConnection;
type HttpProxyResult = import('../server/agentRelay/registry.js').HttpProxyResult;

class FakeConnection implements AgentConnection {
  readonly sent: BackendToAgentMessage[] = [];
  private callbacks: Array<(message: AgentToBackendMessage) => void> = [];
  private connected = true;

  isConnected() { return this.connected; }
  send(message: BackendToAgentMessage) { this.sent.push(message); }
  onMessage(callback: (message: AgentToBackendMessage) => void) { this.callbacks.push(callback); }
  close() {
    if (!this.connected) return;
    this.connected = false;
    unregisterAgentConnection(this.userId, this);
  }
  receive(message: AgentToBackendMessage) {
    for (const callback of this.callbacks) callback(message);
  }

  constructor(private readonly userId: string) {}
}

function connect(userId: string) {
  const connection = new FakeConnection(userId);
  registerAgentConnection(userId, connection);
  return connection;
}

function rejectionWith(expectedMessage: string) {
  return (error: unknown) => {
    assert.ok(error && typeof error === 'object' && 'error' in error, `unexpected rejection shape: ${String(error)}`);
    return (error as { error: string }).error === expectedMessage;
  };
}

async function expectRejectsPromptly(promise: Promise<unknown>, expectedMessage: string) {
  const outcome = await Promise.race([
    promise.then(() => ({ resolved: true as const }), (error) => ({ error })),
    new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), 150)),
  ]);
  assert.ok(!('timedOut' in outcome), 'request should reject promptly');
  assert.ok(rejectionWith(expectedMessage)(outcome.error), `expected "${expectedMessage}", got ${JSON.stringify(outcome.error)}`);
}

const PROXY_REQ = {
  url: 'http://127.0.0.1:1234/v1/chat/completions',
  method: 'GET' as const,
  headers: { 'content-type': 'application/json' },
  body: null,
  timeoutMs: 5_000,
};

migrate();

console.log('1. zod round-trips for the four http_proxy_* frames');
{
  const requestFrame = {
    type: 'http_proxy_request',
    requestId: 'lmx-schema-req',
    url: 'http://127.0.0.1:1234/v1/chat/completions',
    method: 'POST',
    headers: { authorization: 'Bearer token' },
    body: '{"model":"qwen"}',
    timeoutMs: 300_000,
  } satisfies BackendToAgentMessage;
  const parsedRequest = BackendToAgentMessageSchema.safeParse(requestFrame);
  assert.equal(parsedRequest.success, true, 'http_proxy_request must parse');
  if (parsedRequest.success) assert.deepEqual(parsedRequest.data, requestFrame);

  const cancelFrame = { type: 'http_proxy_cancel', requestId: 'lmx-schema-req' } satisfies BackendToAgentMessage;
  const parsedCancel = BackendToAgentMessageSchema.safeParse(cancelFrame);
  assert.equal(parsedCancel.success, true, 'http_proxy_cancel must parse');
  if (parsedCancel.success) assert.deepEqual(parsedCancel.data, cancelFrame);

  const chunkFrame = {
    type: 'http_proxy_chunk',
    requestId: 'lmx-schema-chunk',
    seq: 0,
    text: 'data: {"delta":"hi"}\n\n',
  } satisfies AgentToBackendMessage;
  const parsedChunk = AgentToBackendMessageSchema.safeParse(chunkFrame);
  assert.equal(parsedChunk.success, true, 'http_proxy_chunk must parse');
  if (parsedChunk.success) assert.deepEqual(parsedChunk.data, chunkFrame);

  const responseFrame = {
    type: 'http_proxy_response',
    requestId: 'lmx-schema-resp',
    ok: true,
    status: 200,
    contentType: 'text/event-stream',
    totalBytes: 42,
  } satisfies AgentToBackendMessage;
  const parsedResponse = AgentToBackendMessageSchema.safeParse(responseFrame);
  assert.equal(parsedResponse.success, true, 'http_proxy_response must parse');
  if (parsedResponse.success) assert.deepEqual(parsedResponse.data, responseFrame);

  // strict(): unknown extra fields are rejected on every new frame.
  assert.equal(BackendToAgentMessageSchema.safeParse({ ...requestFrame, extra: 1 }).success, false);
  assert.equal(BackendToAgentMessageSchema.safeParse({ ...cancelFrame, extra: 1 }).success, false);
  assert.equal(AgentToBackendMessageSchema.safeParse({ ...chunkFrame, extra: 1 }).success, false);
  assert.equal(AgentToBackendMessageSchema.safeParse({ ...responseFrame, extra: 1 }).success, false);

  // Field-level validation mirrors global-constraints §5 verbatim.
  assert.equal(BackendToAgentMessageSchema.safeParse({ ...requestFrame, method: 'DELETE' }).success, false);
  assert.equal(BackendToAgentMessageSchema.safeParse({ ...requestFrame, body: undefined }).success, false);
  assert.equal(AgentToBackendMessageSchema.safeParse({ ...chunkFrame, seq: -1 }).success, false);
  assert.equal(AgentToBackendMessageSchema.safeParse({ ...chunkFrame, seq: 1.5 }).success, false);
}

console.log('2. happy path: chunks routed in order, terminal response resolves');
{
  const connection = connect('user-lmrelay-happy');
  const chunks: string[] = [];
  const pending = sendHttpProxyRequest(
    'user-lmrelay-happy',
    'lmx-happy-1',
    {
      url: PROXY_REQ.url,
      method: 'POST',
      headers: { authorization: 'Bearer x' },
      body: '{"prompt":"hi"}',
      timeoutMs: 5_000,
    },
    (text) => chunks.push(text),
  );
  assert.deepEqual(connection.sent.at(-1), {
    type: 'http_proxy_request',
    requestId: 'lmx-happy-1',
    url: PROXY_REQ.url,
    method: 'POST',
    headers: { authorization: 'Bearer x' },
    body: '{"prompt":"hi"}',
    timeoutMs: 5_000,
  });

  connection.receive({ type: 'http_proxy_chunk', requestId: 'lmx-happy-1', seq: 0, text: 'chunk-a' });
  connection.receive({ type: 'http_proxy_chunk', requestId: 'lmx-happy-1', seq: 1, text: 'chunk-b' });
  connection.receive({
    type: 'http_proxy_response',
    requestId: 'lmx-happy-1',
    ok: true,
    status: 200,
    contentType: 'text/event-stream',
    totalBytes: 14,
  });
  const result = (await pending) as HttpProxyResult;
  assert.deepEqual(result, { ok: true, status: 200, contentType: 'text/event-stream', totalBytes: 14 });
  assert.deepEqual(chunks, ['chunk-a', 'chunk-b']);
  connection.close();

  // A failed terminal frame resolves (does not reject) carrying ok:false.
  const failing = connect('user-lmrelay-fail');
  const failingPending = sendHttpProxyRequest('user-lmrelay-fail', 'lmx-fail-1', PROXY_REQ, () => {});
  failing.receive({ type: 'http_proxy_response', requestId: 'lmx-fail-1', ok: false, status: 0, error: 'connect ECONNREFUSED' });
  assert.deepEqual(await failingPending, { ok: false, status: 0, error: 'connect ECONNREFUSED' });
  failing.close();
}

console.log('3. disconnect mid-request rejects every pending for that connection');
{
  const connection = connect('user-lmrelay-disconnect');
  const first = sendHttpProxyRequest('user-lmrelay-disconnect', 'lmx-dc-1', PROXY_REQ, () => {});
  const second = sendHttpProxyRequest('user-lmrelay-disconnect', 'lmx-dc-2', PROXY_REQ, () => {});
  connection.close();
  await Promise.all([
    expectRejectsPromptly(first, 'local agent disconnected mid-command'),
    expectRejectsPromptly(second, 'local agent disconnected mid-command'),
  ]);

  // Connection replacement uses the same mass-rejection path.
  const oldConnection = connect('user-lmrelay-replace');
  const replaced = sendHttpProxyRequest('user-lmrelay-replace', 'lmx-replaced', PROXY_REQ, () => {});
  connect('user-lmrelay-replace');
  assert.equal(oldConnection.isConnected(), false);
  await expectRejectsPromptly(replaced, 'local agent disconnected mid-command');
}

console.log('4. cancel sends http_proxy_cancel; foreign userId is ignored');
{
  const connection = connect('user-lmrelay-cancel');
  const pending = sendHttpProxyRequest('user-lmrelay-cancel', 'lmx-cancel-1', PROXY_REQ, () => {});

  const sentBefore = connection.sent.length;
  cancelHttpProxyRequest('user-lmrelay-imposter', 'lmx-cancel-1');
  assert.equal(connection.sent.length, sentBefore, 'cancel from a different userId must be ignored');

  cancelHttpProxyRequest('user-lmrelay-cancel', 'lmx-cancel-1');
  assert.equal(connection.sent.length, sentBefore + 1);
  assert.deepEqual(connection.sent.at(-1), { type: 'http_proxy_cancel', requestId: 'lmx-cancel-1' });

  connection.receive({ type: 'http_proxy_response', requestId: 'lmx-cancel-1', ok: false, status: 0, error: 'cancelled' });
  assert.deepEqual(await pending, { ok: false, status: 0, error: 'cancelled' });
  connection.close();
}

console.log('5. duplicate ids rejected; unknown/wrong-connection frames ignored');
{
  const connection = connect('user-lmrelay-dup');
  const first = sendHttpProxyRequest('user-lmrelay-dup', 'lmx-dup-id', PROXY_REQ, () => {});
  await assert.rejects(
    sendHttpProxyRequest('user-lmrelay-dup', 'lmx-dup-id', PROXY_REQ, () => {}),
    rejectionWith('duplicate local agent request id'),
  );

  // Unknown requestId: delivered without effect, no crash.
  connection.receive({ type: 'http_proxy_chunk', requestId: 'lmx-no-such-request', seq: 0, text: 'stray' });

  // Another user's connection cannot inject chunks or a terminal frame.
  const stranger = connect('user-lmrelay-stranger');
  let chunkCount = 0;
  const watched = sendHttpProxyRequest('user-lmrelay-dup', 'lmx-watch', PROXY_REQ, () => { chunkCount += 1; });
  stranger.receive({ type: 'http_proxy_chunk', requestId: 'lmx-watch', seq: 0, text: 'cross-tenant leak' });
  stranger.receive({ type: 'http_proxy_response', requestId: 'lmx-watch', ok: true, status: 200 });
  assert.equal(chunkCount, 0, 'chunks from another connection must be ignored');
  let settled = false;
  watched.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(settled, false, 'a wrong-connection terminal frame must not resolve the pending');

  connection.receive({ type: 'http_proxy_chunk', requestId: 'lmx-watch', seq: 0, text: 'own-chunk' });
  connection.receive({ type: 'http_proxy_response', requestId: 'lmx-watch', ok: true, status: 204 });
  assert.deepEqual(await watched, { ok: true, status: 204 });
  assert.equal(chunkCount, 1);

  connection.close();
  stranger.close();
  await expectRejectsPromptly(first, 'local agent disconnected mid-command');
}

console.log('6. timeout expiry rejects AND best-effort sends http_proxy_cancel');
{
  const connection = connect('user-lmrelay-timeout');
  const startedAt = Date.now();
  const pending = sendHttpProxyRequest(
    'user-lmrelay-timeout',
    'lmx-timeout-1',
    { ...PROXY_REQ, timeoutMs: 100 },
    () => {},
  );
  await assert.rejects(pending, rejectionWith('local agent command timed out'));
  assert.ok(Date.now() - startedAt >= 75, 'expiry must respect the requested timeoutMs');
  assert.deepEqual(connection.sent.at(-1), { type: 'http_proxy_cancel', requestId: 'lmx-timeout-1' });
  connection.close();
}

console.log('7. SSRF allowlist matrix (global-constraints §6)');
{
  assert.deepEqual(DEFAULT_PROXY_ALLOWLIST, ['127.0.0.1:1234', 'localhost:1234', '[::1]:1234']);

  // Parsing: trims, lowercases, drops empties, falls back to default.
  assert.deepEqual(parseProxyAllowlist(undefined), DEFAULT_PROXY_ALLOWLIST);
  assert.deepEqual(parseProxyAllowlist(''), DEFAULT_PROXY_ALLOWLIST);
  assert.deepEqual(parseProxyAllowlist('  ,  '), DEFAULT_PROXY_ALLOWLIST);
  assert.deepEqual(parseProxyAllowlist('Example.COM:8080, LocalHost:9999 ,,'), ['example.com:8080', 'localhost:9999']);

  // Accepted.
  assert.deepEqual(isRelayUrlAllowed('http://127.0.0.1:1234/v1/chat/completions', DEFAULT_PROXY_ALLOWLIST), { allowed: true });
  assert.deepEqual(isRelayUrlAllowed('http://localhost:1234/v1/models', DEFAULT_PROXY_ALLOWLIST), { allowed: true });
  assert.deepEqual(isRelayUrlAllowed('http://LOCALHOST:1234/', DEFAULT_PROXY_ALLOWLIST), { allowed: true });
  assert.deepEqual(isRelayUrlAllowed('http://[::1]:1234/v1/models', DEFAULT_PROXY_ALLOWLIST), { allowed: true });
  assert.deepEqual(isRelayUrlAllowed('http://[::1]:1234/', ['::1:1234']), { allowed: true }, 'bracketless entry tolerated');
  assert.deepEqual(isRelayUrlAllowed('http://localhost:1234/', ['127.0.0.1:1234']), { allowed: true }, 'loopback names normalized');

  const rejections: Array<[string, string]> = [
    ['https://127.0.0.1:1234/', 'https scheme'],
    ['http://127.0.0.1:9999/', 'wrong port'],
    ['http://192.168.1.10:1234/', 'non-loopback host'],
    ['http://user:pw@127.0.0.1:1234/', 'credentials'],
    ['http://127.0.0.1:1234/#fragment', 'hash'],
    ['/v1/models', 'relative URL'],
    ['not-a-url', 'garbage'],
    ['file:///etc/passwd', 'file scheme'],
    ['http://localhost./v1/models', 'trailing-dot host bypass'],
    ['http://127.0.0.1:1234@evil.example/', 'host smuggled as credential'],
    ['http://localhost/', 'elided port must not match'],
  ];
  for (const [urlStr, label] of rejections) {
    const verdict = isRelayUrlAllowed(urlStr, DEFAULT_PROXY_ALLOWLIST);
    assert.equal(verdict.allowed, false, `${label} (${urlStr}) must be rejected`);
    assert.equal(typeof verdict.reason, 'string', `${label} rejection must carry a reason`);
  }

  // Custom env replaces the defaults entirely.
  const custom = parseProxyAllowlist('192.168.55.10:8080');
  assert.deepEqual(custom, ['192.168.55.10:8080']);
  assert.equal(isRelayUrlAllowed('http://192.168.55.10:8080/v1', custom).allowed, true);
  assert.equal(isRelayUrlAllowed('http://127.0.0.1:1234/v1', custom).allowed, false, 'defaults must not survive a custom env');
}

db.close();
for (const suffix of ['', '-shm', '-wal']) {
  try { fs.unlinkSync(`${testDbPath}${suffix}`); } catch { /* already absent */ }
}

console.log('lmstudio relay tests passed');
