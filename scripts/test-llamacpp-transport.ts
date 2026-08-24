/**
 * OFFLINE acceptance harness for task 2 — llamacpp transport service
 * (`server/providers/llamacppTransport.ts`) over the task-1 relay machinery.
 *
 * Sections:
 *  1. resolveLlamacppConfig precedence per key (default < env < setting),
 *     corrupt JSON knob/override rows repair to defaults + console.warn;
 *  2. probe direct-vs-relay-vs-unreachable selection incl. the capability
 *     gate, allowlist blocking, and the ~10 s cache (hit / force / expiry);
 *  3. llamacppFetch usage stamping ONLY for POST /v1/chat/completions with a
 *     model read from OUR outbound body (map state asserted);
 *  4. llamacppFetch transport behaviors: relay SSE passthrough, status-0 ⇒
 *     502 JSON, unreachable ⇒ 502 JSON, direct
 *     passthrough over a REAL loopback mini-server;
 *  5. ensureLlamacppRunning states already/started/swapped/failed against a
 *     scripted FakeConnection + a REAL loopback stand-in for llama-server
 *     /health (503 → 200 flip; health-timeout path);
 *  6. stopLlamacpp idempotency + gate failures;
 *  7. llamacpp_exited push updates tracked state (observed once disconnected);
 *  8. runLlamacppIdleSweep boundaries: strict >N eviction, '0'=off,
 *     in-flight skip, never throws on agent-less users.
 *
 * db-touching: needs a Linux-built better-sqlite3 — run in the
 * /tmp/opencode shadow tree under WSL (context-map.md §4 recipe).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// Offline harness: temp DATABASE_PATH must be set BEFORE importing server/db.js.
const testDbPath = path.join(os.tmpdir(), `llamacpp-transport-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = testDbPath;

const { default: db, migrate } = await import('../server/db.js');
const { registerAgentConnection, unregisterAgentConnection, getAgentCapabilities } = await import(
  '../server/agentRelay/registry.js'
);
const {
  ensureLlamacppRunning,
  getLlamacppStatus,
  getLastLaunchArgs,
  getLlamacppUsageSnapshot,
  listLlamacppModels,
  llamacppFetch,
  probeLlamacpp,
  PROBE_CACHE_TTL_MS,
  resolveLlamacppConfig,
  runLlamacppIdleSweep,
  stopLlamacpp,
} = await import('../server/providers/llamacppTransport.js');
const {
  buildLlamaServerArgv,
  collapseShardEntries,
  LLAMACPP_DEFAULT_KNOBS,
  mergeKnobLayers,
} = await import('../server/providers/llamacpp.js');
type AgentToBackendMessage = import('../server/agentRelay/protocol.js').AgentToBackendMessage;
type BackendToAgentMessage = import('../server/agentRelay/protocol.js').BackendToAgentMessage;
type AgentConnection = import('../server/agentRelay/registry.js').AgentConnection;

// ---------------------------------------------------------------------------
// Environment hygiene: snapshot everything this suite touches, restore at end.
// ---------------------------------------------------------------------------
const TOUCHED_ENV_KEYS = [
  'LLAMACPP_EXE_PATH',
  'LLAMACPP_MODELS_DIR',
  'LLAMACPP_PORT',
  'LLAMACPP_IDLE_UNLOAD_MINUTES',
  'AGENT_HTTP_PROXY_ALLOW_HOSTS',
] as const;
const savedEnv = new Map<string, string | undefined>(
  TOUCHED_ENV_KEYS.map((key) => [key, process.env[key]]),
);
function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** Loopback port guaranteed closed so the DIRECT probe refuses instantly. */
const CLOSED_PORT = 9;

function insertUser(userId: string): void {
  db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(
    userId,
    `${userId}@example.com`,
    'test',
  );
}

function insertSetting(userId: string, key: string, value: string): void {
  db.prepare('INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)').run(userId, key, value);
}

function updateSetting(userId: string, key: string, value: string): void {
  db.prepare('UPDATE settings SET value = ? WHERE user_id = ? AND key = ?').run(value, userId, key);
}

// ---------------------------------------------------------------------------
// Scripted local-agent connection: answers BOTH frame families (http_proxy_*
// for tunneled HTTP, llamacpp_* for scan/status/spawn/stop) via queueMicrotask.
// ---------------------------------------------------------------------------
type ProxyRequestFrame = Extract<BackendToAgentMessage, { type: 'http_proxy_request' }>;
type LlamacppFrame = Extract<BackendToAgentMessage, { requestId: string }> &
  Record<string, unknown>;

class ScriptedAgentConnection implements AgentConnection {
  readonly sent: BackendToAgentMessage[] = [];
  private callbacks: Array<(message: AgentToBackendMessage) => void> = [];
  private connected = true;

  constructor(
    private readonly userId: string,
    public proxyResponder: (request: ProxyRequestFrame) => void = () => {},
    public llamacppResponder: (message: LlamacppFrame) => void = () => {},
  ) {}

  isConnected() {
    return this.connected;
  }

  send(message: BackendToAgentMessage) {
    this.sent.push(message);
    if (message.type === 'http_proxy_request') {
      const request = message;
      queueMicrotask(() => {
        if (this.connected) this.proxyResponder(request);
      });
      return;
    }
    if (message.type.startsWith('llamacpp_')) {
      const frame = message as unknown as LlamacppFrame;
      queueMicrotask(() => {
        if (this.connected) this.llamacppResponder(frame);
      });
    }
  }

  onMessage(callback: (message: AgentToBackendMessage) => void) {
    this.callbacks.push(callback);
  }

  close() {
    if (!this.connected) return;
    this.connected = false;
    unregisterAgentConnection(this.userId, this);
  }

  receive(message: AgentToBackendMessage) {
    for (const callback of this.callbacks) callback(message);
  }
}

interface ConnectOpts {
  onProxy?: (connection: ScriptedAgentConnection, request: ProxyRequestFrame) => void;
  onLlamacpp?: (message: LlamacppFrame) => void;
  /** Declared hello capabilities; omitted ⇒ legacy agent without the field. */
  capabilities?: string[];
}

function connect(userId: string, opts: ConnectOpts = {}): ScriptedAgentConnection {
  const holder: { connection?: ScriptedAgentConnection } = {};
  const connection = new ScriptedAgentConnection(
    userId,
    (request) => opts.onProxy?.(holder.connection!, request),
    (message) => opts.onLlamacpp?.(message),
  );
  holder.connection = connection;
  registerAgentConnection(userId, connection);
  connection.receive({
    type: 'hello',
    agentVersion: '1.2.0',
    deviceName: 'test-agent',
    ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
  });
  return connection;
}



function proxyRequests(connection: ScriptedAgentConnection): ProxyRequestFrame[] {
  return connection.sent.filter((m): m is ProxyRequestFrame => m.type === 'http_proxy_request');
}

function llamacppSent<T extends BackendToAgentMessage['type']>(
  connection: ScriptedAgentConnection,
  type: T,
): Array<Extract<BackendToAgentMessage, { type: T }>> {
  return connection.sent.filter((m): m is Extract<BackendToAgentMessage, { type: T }> => m.type === type);
}

function replyText(
  connection: ScriptedAgentConnection,
  requestId: string,
  status: number,
  text: string,
  contentType = 'application/json',
): void {
  connection.receive({ type: 'http_proxy_chunk', requestId, seq: 0, text });
  connection.receive({
    type: 'http_proxy_response',
    requestId,
    ok: status >= 200 && status < 300,
    status,
    contentType,
  });
}

/** Scripted terminal FAILURE ({ok:false,status:0,error}) — relay-level failure. */
function failProxyRequest(connection: ScriptedAgentConnection, requestId: string, error: string): void {
  connection.receive({ type: 'http_proxy_response', requestId, ok: false, status: 0, error });
}

async function waitFor(condition: () => boolean, timeoutMs = 2000, stepMs = 5): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

function captureWarnings(fn: () => void): string[] {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(' '));
  };
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

/**
 * REAL loopback mini-server standing in for llama-server: public GET /health
 * with a 503 "Loading model" → 200 {"status":"ok"} flip, plus optional extra
 * handlers. Remember closeAllConnections() so the process can exit.
 */
interface FakeLlamaServer {
  port: number;
  healthHits(): number;
  setReady(ready: boolean): void;
  close(): void;
}

function startFakeLlamaServer(opts: {
  initialReady?: boolean;
  /** Flip to ready when the Nth /health hit arrives (simulates load finishing). */
  readyAfterHits?: number;
  extra?: (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => boolean;
}): Promise<FakeLlamaServer> {
  let ready = opts.initialReady ?? false;
  let hits = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') {
      hits += 1;
      if (!ready && opts.readyAfterHits !== undefined && hits >= opts.readyAfterHits) ready = true;
      if (!ready) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 503, message: 'Loading model', type: 'unavailable_error' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (opts.extra?.(req, res, url)) return;
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no listen address');
      resolve({
        port: address.port,
        healthHits: () => hits,
        setReady: (value: boolean) => {
          ready = value;
        },
        close: () => {
          server.closeAllConnections?.();
          server.close();
        },
      });
    });
  });
}

function usageEntry(userId: string, modelKey: string): { lastUsedAt: number; inFlight: number } | undefined {
  const snapshot = getLlamacppUsageSnapshot();
  return snapshot.find((e) => e.userId === userId && e.modelKey === modelKey);
}

try {
  migrate();

  // F3-01-style guard: COUNT unhandled rejections instead of letting Node crash.
  let unhandledRejections = 0;
  process.on('unhandledRejection', () => {
    unhandledRejections += 1;
  });

  // -------------------------------------------------------------------------
  console.log('1. resolveLlamacppConfig precedence per key + corrupt-row repair');
  {
    const userId = 't2-config-user';
    insertUser(userId);

    // Defaults: no env, no settings.
    let config = resolveLlamacppConfig(userId);
    assert.equal(config.exePath, null, 'exe_path has NO default');
    assert.equal(config.modelsDir, null, 'models_dir has NO default');
    assert.equal(config.port, 8712);
    assert.equal(config.idleUnloadMinutes, 45);
    assert.deepEqual(config.knobs, LLAMACPP_DEFAULT_KNOBS, 'knob bag defaults to the canonical bag');
    assert.deepEqual(config.overrides, {});

    // Env layer.
    setEnv('LLAMACPP_EXE_PATH', 'D:\\tools\\llama-server.exe');
    setEnv('LLAMACPP_MODELS_DIR', 'D:\\models-env');
    setEnv('LLAMACPP_PORT', '9001');
    setEnv('LLAMACPP_IDLE_UNLOAD_MINUTES', '7');
    config = resolveLlamacppConfig(userId);
    assert.equal(config.exePath, 'D:\\tools\\llama-server.exe');
    assert.equal(config.modelsDir, 'D:\\models-env');
    assert.equal(config.port, 9001);
    assert.equal(config.idleUnloadMinutes, 7);

    // Setting layer beats env.
    insertSetting(userId, 'llamacpp_exe_path', 'C:\\bins\\llama-server.exe');
    insertSetting(userId, 'llamacpp_models_dir', 'D:\\models-setting');
    insertSetting(userId, 'llamacpp_port', '9100');
    insertSetting(userId, 'llamacpp_idle_unload_minutes', '90');
    config = resolveLlamacppConfig(userId);
    assert.equal(config.exePath, 'C:\\bins\\llama-server.exe');
    assert.equal(config.modelsDir, 'D:\\models-setting');
    assert.equal(config.port, 9100);
    assert.equal(config.idleUnloadMinutes, 90);

    // Invalid scalars fall back to the DEFAULT (mirrors the lmstudio resolver).
    updateSetting(userId, 'llamacpp_port', 'abc');
    updateSetting(userId, 'llamacpp_idle_unload_minutes', '-3');
    config = resolveLlamacppConfig(userId);
    assert.equal(config.port, 8712, 'invalid port setting ⇒ default');
    assert.equal(config.idleUnloadMinutes, 45, 'invalid minutes setting ⇒ default');

    // '0' legitimately disables idle unload (setting form).
    updateSetting(userId, 'llamacpp_idle_unload_minutes', '0');
    assert.equal(resolveLlamacppConfig(userId).idleUnloadMinutes, 0);

    // Corrupt JSON knob row ⇒ canonical defaults + console.warn, never throws.
    updateSetting(userId, 'llamacpp_idle_unload_minutes', '30');
    insertSetting(userId, 'llamacpp_load_defaults', '{not-json');
    let warnings = captureWarnings(() => {
      config = resolveLlamacppConfig(userId);
    });
    assert.deepEqual(config.knobs, LLAMACPP_DEFAULT_KNOBS);
    assert.equal(warnings.length, 1, 'corrupt knob row warns exactly once');

    // Partially-invalid knob row (unknown key) ⇒ whole row rejected ⇒
    // canonical defaults + warn (§3: corrupt row ⇒ defaults, never throw).
    updateSetting(userId, 'llamacpp_load_defaults', JSON.stringify({ threads: 6, totally_bogus: 1 }));
    warnings = captureWarnings(() => {
      config = resolveLlamacppConfig(userId);
    });
    assert.deepEqual(config.knobs, LLAMACPP_DEFAULT_KNOBS, 'invalid row ⇒ full canonical defaults');
    assert.equal(warnings.length, 1);

    // Valid partial knob row merges over the canonical defaults silently.
    updateSetting(userId, 'llamacpp_load_defaults', JSON.stringify({ ctx: 4096, flash_attn: 'auto' }));
    config = resolveLlamacppConfig(userId);
    assert.deepEqual(config.knobs, { ...LLAMACPP_DEFAULT_KNOBS, ctx: 4096, flash_attn: 'auto' });
    assert.deepEqual(config.overrides, {});

    // Overrides row: corrupt JSON ⇒ {} + warn; per-entry validation drops bad models.
    insertSetting(userId, 'llamacpp_model_overrides', '{oops');
    warnings = captureWarnings(() => {
      config = resolveLlamacppConfig(userId);
    });
    assert.deepEqual(config.overrides, {});
    assert.ok(warnings.length >= 1, 'corrupt overrides row warns');

    updateSetting(userId, 'llamacpp_model_overrides', '{"good-model": null}');
    assert.deepEqual(resolveLlamacppConfig(userId).overrides, {}, 'null entries dropped ⇒ {}');

    // Overrides row validated as a WHOLE: any invalid entry ⇒ {} + warn.
    updateSetting(userId, 'llamacpp_model_overrides', JSON.stringify({
      'good-model': { threads: 4 },
      'bad-model': { threads: -9 },
    }));
    warnings = captureWarnings(() => {
      config = resolveLlamacppConfig(userId);
    });
    assert.deepEqual(config.overrides, {}, 'row with any invalid entry treated as empty');
    assert.ok(warnings.length >= 1, 'invalid overrides row warns');

    setEnv('LLAMACPP_EXE_PATH', undefined);
    setEnv('LLAMACPP_MODELS_DIR', undefined);
    setEnv('LLAMACPP_PORT', undefined);
    setEnv('LLAMACPP_IDLE_UNLOAD_MINUTES', undefined);
  }

  // -------------------------------------------------------------------------
  console.log('2. probe: direct vs relay vs unreachable vs blocked + ~10 s cache');
  {
    // (a) DIRECT: real loopback /health, no agent involved.
    const directServer = await startFakeLlamaServer({ initialReady: true });
    try {
      const userId = 't2-probe-direct';
      insertUser(userId);
      insertSetting(userId, 'llamacpp_port', String(directServer.port));

      const probe = await probeLlamacpp(userId, { force: true });
      assert.equal(probe.reachable, true);
      assert.equal(probe.transport, 'direct');
      assert.equal(probe.agentConnected, false);
      assert.equal(probe.capabilitySupported, false);
      assert.equal(directServer.healthHits() >= 1, true);
    } finally {
      directServer.close();
    }

    // (b) RELAY: closed direct port, capable agent tunnels /health.
    setEnv('AGENT_HTTP_PROXY_ALLOW_HOSTS', `127.0.0.1:${CLOSED_PORT}`);
    const relayUserId = 't2-probe-relay';
    insertUser(relayUserId);
    insertSetting(relayUserId, 'llamacpp_port', String(CLOSED_PORT));
    const relayConn = connect(relayUserId, {
      capabilities: ['llamacpp'],
      onProxy: (conn, request) => {
        if (new URL(request.url).pathname === '/health') {
          replyText(conn, request.requestId, 200, '{"status":"ok"}');
        } else {
          replyText(conn, request.requestId, 404, '{}');
        }
      },
    });

    const relayProbe = await probeLlamacpp(relayUserId, { force: true });
    assert.equal(relayProbe.reachable, true);
    assert.equal(relayProbe.transport, 'relay');
    assert.equal(relayProbe.agentConnected, true);
    assert.equal(relayProbe.capabilitySupported, true);

    // Cache HIT: no additional wire traffic within the TTL.
    const framesBefore = proxyRequests(relayConn).length;
    const cachedProbe = await probeLlamacpp(relayUserId);
    assert.equal(cachedProbe.transport, 'relay');
    assert.equal(proxyRequests(relayConn).length, framesBefore, 'cached probe must not hit the wire');

    // FORCE bypasses the cache: exactly one more relay request.
    await probeLlamacpp(relayUserId, { force: true });
    assert.equal(proxyRequests(relayConn).length, framesBefore + 1, 'forced probe sends exactly one request');

    // TTL EXPIRY: aging the entry past PROBE_CACHE_TTL_MS re-probes.
    await probeLlamacpp(relayUserId, { nowMs: Date.now() + PROBE_CACHE_TTL_MS + 1 });
    assert.equal(proxyRequests(relayConn).length, framesBefore + 2, 'expired probe re-computes');

    // (c) Capability MISS: same wiring, legacy hello without the field.
    const legacyUserId = 't2-probe-legacy';
    insertUser(legacyUserId);
    insertSetting(legacyUserId, 'llamacpp_port', String(CLOSED_PORT));
    const legacyConn = connect(legacyUserId, {
      onProxy: (conn, request) => replyText(conn, request.requestId, 200, '{}'),
    });
    assert.equal(getAgentCapabilities(legacyUserId), undefined);
    const legacyProbe = await probeLlamacpp(legacyUserId, { force: true });
    assert.equal(legacyProbe.reachable, false);
    assert.equal(legacyProbe.transport, null);
    assert.equal(legacyProbe.agentConnected, true);
    assert.equal(legacyProbe.capabilitySupported, false, 'hello without capabilities ⇒ unsupported');
    assert.equal(proxyRequests(legacyConn).length, 0, 'capability gate fires BEFORE any relay send');
    legacyConn.close();

    // (d) RESOLVED-PORT UNION (§7): even with NO usable env allowlist, the
    // loopback trio of the RESOLVED configured port is always effective, so
    // the relay probe still gets through. (A hard block is unreachable through
    // this provider by construction: request URLs derive from settings only,
    // and the resolved port is always unioned into the effective list.)
    setEnv('AGENT_HTTP_PROXY_ALLOW_HOSTS', undefined); // falls back to the :1234 trio only
    const unionProbe = await probeLlamacpp(relayUserId, { force: true });
    assert.equal(unionProbe.reachable, true);
    assert.equal(unionProbe.transport, 'relay');
    assert.equal(unionProbe.agentConnected, true);
    assert.equal(unionProbe.capabilitySupported, true);
    assert.equal(proxyRequests(relayConn).length, framesBefore + 3, 'unioned-port probe sends exactly one request');

    // (e) UNREACHABLE: agent gone entirely.
    relayConn.close();
    const aloneProbe = await probeLlamacpp(relayUserId, { force: true });
    assert.equal(aloneProbe.reachable, false);
    assert.equal(aloneProbe.transport, null);
    assert.equal(aloneProbe.agentConnected, false);
    assert.equal(aloneProbe.capabilitySupported, false);
    setEnv('AGENT_HTTP_PROXY_ALLOW_HOSTS', undefined);
  }

  // -------------------------------------------------------------------------
  console.log('3. llamacppFetch stamps usage ONLY for POST /v1/chat/completions (outbound body model)');
  {
    setEnv('AGENT_HTTP_PROXY_ALLOW_HOSTS', `127.0.0.1:${CLOSED_PORT}`);
    const userId = 't2-usage-user';
    insertUser(userId);
    insertSetting(userId, 'llamacpp_port', String(CLOSED_PORT));
    const conn = connect(userId, {
      capabilities: ['llamacpp'],
      onProxy: (c, request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === '/health') replyText(c, request.requestId, 200, '{"status":"ok"}');
        else if (pathname === '/v1/chat/completions') {
          replyText(c, request.requestId, 200, 'data: {"x":1}\n\ndata: [DONE]\n\n', 'text/event-stream');
        } else replyText(c, request.requestId, 200, '{}');
      },
    });

    // Two distinct models via the outbound body + a non-inference POST.
    const r1 = await llamacppFetch(userId, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'usage-model-a', messages: [] }),
    });
    assert.equal(r1.status, 200);
    await r1.text();

    const r2 = await llamacppFetch(userId, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'usage-model-b', messages: [] }),
    });
    await r2.text();

    const r3 = await llamacppFetch(userId, '/v1/chat/completions', {
      method: 'POST',
      body: 'not-json-at-all',
    });
    await r3.text(); // invalid body ⇒ no model ⇒ no stamp

    const r4 = await llamacppFetch(userId, '/v1/models'); // management-ish GET
    await r4.text();

    const now = Date.now();
    const a = usageEntry(userId, 'usage-model-a');
    const b = usageEntry(userId, 'usage-model-b');
    assert.ok(a, 'model-a stamped');
    assert.ok(b, 'model-b stamped (read from EACH outbound body)');
    assert.ok(a.lastUsedAt <= now && now - a.lastUsedAt < 60_000);
    assert.equal(a.inFlight, 0, 'fully consumed response releases the in-flight counter');
    assert.equal(b.inFlight, 0);
    assert.equal(usageEntry(userId, 'not-a-model'), undefined);

    const stampedKeys = getLlamacppUsageSnapshot()
      .filter((e) => e.userId === userId)
      .map((e) => e.modelKey)
      .sort();
    assert.deepEqual(stampedKeys, ['usage-model-a', 'usage-model-b'], 'exactly two entries for the user');

    conn.close();
    setEnv('AGENT_HTTP_PROXY_ALLOW_HOSTS', undefined);
  }

  // -------------------------------------------------------------------------
  console.log('4. llamacppFetch transport behaviors (relay split + direct passthrough)');
  {
    setEnv('AGENT_HTTP_PROXY_ALLOW_HOSTS', `127.0.0.1:${CLOSED_PORT}`);

    // (a) Relay streaming: chunks arrive verbatim in order with terminal meta.
    const streamUserId = 't2-fetch-stream';
    insertUser(streamUserId);
    insertSetting(streamUserId, 'llamacpp_port', String(CLOSED_PORT));
    const CHUNKS = ['data: {"i":1}\n\n', 'data: {"i":2}\n\n', 'data: [DONE]\n\n'];
    const streamConn = connect(streamUserId, {
      capabilities: ['llamacpp'],
      onProxy: (c, request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === '/health') {
          replyText(c, request.requestId, 200, '{"status":"ok"}');
          return;
        }
        if (pathname === '/v1/chat/completions' && request.method === 'POST') {
          let seq = 0;
          for (const chunk of CHUNKS) {
            c.receive({ type: 'http_proxy_chunk', requestId: request.requestId, seq, text: chunk });
            seq += 1;
          }
          c.receive({
            type: 'http_proxy_response',
            requestId: request.requestId,
            ok: true,
            status: 200,
            contentType: 'text/event-stream',
          });
          return;
        }
        replyText(c, request.requestId, 404, '{}');
      },
    });

    const streamed = await llamacppFetch(streamUserId, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'stream-model' }),
    });
    assert.equal(streamed.status, 200);
    assert.equal(streamed.headers.get('content-type'), 'text/event-stream');
    const reader = streamed.body!.getReader();
    const decoder = new TextDecoder();
    let streamedText = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      streamedText += decoder.decode(value, { stream: true });
    }
    assert.equal(streamedText, CHUNKS.join(''), 'chunk passthrough preserves bytes and order');
    assert.equal(usageEntry(streamUserId, 'stream-model')?.inFlight ?? 1, 0, 'terminal settlement releases in-flight');
    streamConn.close();

    // (b) Relay status-0 terminal ⇒ explanatory 502 JSON.
    const deadUserId = 't2-fetch-dead-relay';
    insertUser(deadUserId);
    insertSetting(deadUserId, 'llamacpp_port', String(CLOSED_PORT));
    const deadConn = connect(deadUserId, {
      capabilities: ['llamacpp'],
      onProxy: (c, request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === '/health') {
          replyText(c, request.requestId, 200, '{"status":"ok"}'); // probe succeeds via relay
          return;
        }
        failProxyRequest(c, request.requestId, 'simulated relay failure'); // the CHAT request dies
      },
    });
    const failed = await llamacppFetch(deadUserId, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'doomed-model' }),
    });
    assert.equal(failed.status, 502);
    const failedBody = await failed.json() as { error?: string };
    assert.match(failedBody.error ?? '', /relay/i);
    assert.equal(usageEntry(deadUserId, 'doomed-model')?.inFlight ?? 1, 0, 'failure releases the counter');
    deadConn.close();

    // (c) Unreachable (probe fails both ways) ⇒ 502 JSON, no throw.
    const darkUserId = 't2-fetch-dark';
    insertUser(darkUserId);
    insertSetting(darkUserId, 'llamacpp_port', String(CLOSED_PORT));
    const dark = await llamacppFetch(darkUserId, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'dark-model' }),
    });
    assert.equal(dark.status, 502);
    const darkBody = await dark.json() as { error?: string };
    assert.ok((darkBody.error ?? '').length > 0);
    assert.equal(usageEntry(darkUserId, 'dark-model')?.inFlight ?? 1, 0);

    // (d) Direct passthrough over a REAL loopback server.
    const directServer = await startFakeLlamaServer({
      initialReady: true,
      extra: (req, res, url) => {
        if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end('data: {"direct":true}\n\ndata: [DONE]\n\n');
          return true;
        }
        return false;
      },
    });
    try {
      const directUserId = 't2-fetch-direct';
      insertUser(directUserId);
      insertSetting(directUserId, 'llamacpp_port', String(directServer.port));
      const direct = await llamacppFetch(directUserId, '/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'direct-model' }),
      });
      assert.equal(direct.status, 200);
      assert.equal(await direct.text(), 'data: {"direct":true}\n\ndata: [DONE]\n\n');
      assert.ok(usageEntry(directUserId, 'direct-model'), 'direct inference stamps usage too');
      assert.equal(usageEntry(directUserId, 'direct-model')?.inFlight, 0);
    } finally {
      directServer.close();
    }
  }

  // -------------------------------------------------------------------------
  console.log('5. ensureLlamacppRunning states: failed/already/started/swapped + health wait');
  {
    const EXE = 'C:\\bins\\llama-server.exe';

    // (a) Capability gate fires FIRST with a descriptive error.
    {
      const userId = 't2-ensure-nocap';
      insertUser(userId);
      insertSetting(userId, 'llamacpp_exe_path', EXE);
      insertSetting(userId, 'llamacpp_models_dir', 'D:\\models');
      const conn = connect(userId); // legacy hello, no capabilities
      const outcome = await ensureLlamacppRunning(userId, 'Any-Model');
      assert.deepEqual(outcome, {
        running: false,
        mode: 'failed',
        error: 'Local agent does not support llama.cpp — update the local agent.',
      });
      assert.equal(conn.sent.length, 0, 'gated ensure sends no frames');
      assert.equal(getLastLaunchArgs(userId), null);
      conn.close();
    }

    // (b) Unconfigured exe path ⇒ descriptive failure, no frames.
    {
      const userId = 't2-ensure-noexe';
      insertUser(userId);
      insertSetting(userId, 'llamacpp_models_dir', 'D:\\models');
      const conn = connect(userId, { capabilities: ['llamacpp'] });
      const outcome = await ensureLlamacppRunning(userId, 'Any-Model');
      assert.equal(outcome.mode, 'failed');
      assert.match(outcome.error ?? '', /exe/i);
      assert.equal(conn.sent.length, 0);
      conn.close();
    }

    // Shared fake llama-server for the live-flow cases below.
    const fakeServer = await startFakeLlamaServer({ initialReady: true });
    const MODELS_DIR = 'D:\\models';
    const ENTRIES = [
      { path: `${MODELS_DIR}\\Tiny-MTP.gguf`, name: 'Tiny-MTP.gguf', sizeBytes: 1234 },
      { path: `${MODELS_DIR}\\Plain-00001-of-00002.gguf`, name: 'Plain-00001-of-00002.gguf', sizeBytes: 10 },
      { path: `${MODELS_DIR}\\Plain-00002-of-00002.gguf`, name: 'Plain-00002-of-00002.gguf', sizeBytes: 11 },
    ];
    const COLLAPSED = collapseShardEntries(ENTRIES);
    const tinyEntry = COLLAPSED.find((e) => e.key === 'Tiny-MTP')!;
    const plainEntry = COLLAPSED.find((e) => e.key.startsWith('Plain'))!;
    assert.equal(plainEntry.shards, 2);

    const makeModelUser = async (name: string, knobsRow?: Record<string, unknown>): Promise<string> => {
      insertUser(name);
      insertSetting(name, 'llamacpp_exe_path', EXE);
      insertSetting(name, 'llamacpp_models_dir', MODELS_DIR);
      insertSetting(name, 'llamacpp_port', String(fakeServer.port));
      if (knobsRow) insertSetting(name, 'llamacpp_load_defaults', JSON.stringify(knobsRow));
      return name;
    };

    const standardLlamacppResponder =
      (getConnection: () => ScriptedAgentConnection, statusOverride?: Record<string, unknown>) =>
      (message: LlamacppFrame): void => {
        const conn = getConnection();
        if (message.type === 'llamacpp_scan_request') {
          conn.receive({
            type: 'llamacpp_scan_response',
            requestId: String(message.requestId),
            ok: true,
            entries: ENTRIES,
            truncated: false,
          });
          return;
        }
        if (message.type === 'llamacpp_status_request') {
          conn.receive({
            type: 'llamacpp_status_response',
            requestId: String(message.requestId),
            running: false,
            pid: null,
            args: null,
            port: null,
            lastExitCode: null,
            ...(statusOverride ?? {}),
          });
          return;
        }
        if (message.type === 'llamacpp_spawn') {
          conn.receive({
            type: 'llamacpp_spawn_response',
            requestId: String(message.requestId),
            ok: true,
            pid: 4242,
          });
          return;
        }
        if (message.type === 'llamacpp_stop') {
          conn.receive({
            type: 'llamacpp_stop_response',
            requestId: String(message.requestId),
            ok: true,
            forced: false,
          });
          return;
        }
        conn.receive({
          type: 'llamacpp_logs_response',
          requestId: String(message.requestId),
          ok: true,
          text: '',
          truncated: false,
        });
      };

    try {
      // (c) STARTED: spawn frame carries the fully merged argv; usage stamped.
      {
        const userId = await makeModelUser('t2-ensure-started', { threads: 6 });
        const conn = connect(userId, {
          capabilities: ['llamacpp'],
          onLlamacpp: standardLlamacppResponder(() => conn),
        });

        const expectedKnobs = mergeKnobLayers(
          LLAMACPP_DEFAULT_KNOBS,
          { threads: 6 },                    // global load-defaults row
          { gpu_layers: '20' },              // per-model override (set below)
          { ctx: 2048 },                     // request-level override
        );
        insertSetting(userId, 'llamacpp_model_overrides', JSON.stringify({ 'Tiny-MTP': { gpu_layers: '20' } }));
        const expectedArgv = buildLlamaServerArgv({
          modelPath: tinyEntry.path,
          modelKey: 'Tiny-MTP',
          port: fakeServer.port,
          knobs: expectedKnobs,
          mtpCapable: tinyEntry.mtpCapable,
        }).args;

        const outcome = await ensureLlamacppRunning(userId, 'Tiny-MTP', { overrides: { ctx: 2048 } });
        assert.equal(outcome.mode, 'started', outcome.error);
        assert.equal(outcome.running, true, outcome.error);
        assert.equal(outcome.pid, 4242);
        assert.equal(outcome.port, fakeServer.port);
        assert.deepEqual(outcome.argv, expectedArgv, 'spawn argv = request > model > global > default');

        const spawns = llamacppSent(conn, 'llamacpp_spawn');
        assert.equal(spawns.length, 1);
        assert.equal(spawns[0].exePath, EXE);
        assert.equal(spawns[0].host, '127.0.0.1');
        assert.equal(spawns[0].port, fakeServer.port);
        assert.deepEqual(spawns[0].args, expectedArgv);
        assert.equal(expectedArgv.includes('--spec-type'), true, 'MTP-capable file ⇒ spec pair present');
        assert.equal(expectedArgv[expectedArgv.indexOf('--threads') + 1], '6');

        assert.deepEqual(getLastLaunchArgs(userId), { argv: expectedArgv, modelKey: 'Tiny-MTP' });
        assert.ok(usageEntry(userId, 'Tiny-MTP'), 'successful ensure stamps usage');

        // Status view while everything is up.
        const status = await getLlamacppStatus(userId);
        assert.equal(status.agentConnected, true);
        assert.equal(status.capabilitySupported, true);

        conn.close();
      }

      // (d) ALREADY: running child with SAME model+port ⇒ no stop, no spawn.
      {
        const userId = await makeModelUser('t2-ensure-already');
        const alreadyArgs = [
          '--model', tinyEntry.path,
          '--alias', 'Tiny-MTP',
          '--host', '127.0.0.1',
          '--port', String(fakeServer.port),
        ];
        const conn = connect(userId, {
          capabilities: ['llamacpp'],
          onLlamacpp: standardLlamacppResponder(() => conn, {
            running: true,
            pid: 111,
            args: alreadyArgs,
            port: fakeServer.port,
            startedAt: 12345,
          }),
        });

        const outcome = await ensureLlamacppRunning(userId, 'Tiny-MTP');
        assert.deepEqual(
          { running: outcome.running, mode: outcome.mode, pid: outcome.pid },
          { running: true, mode: 'already', pid: 111 },
        );
        assert.equal(llamacppSent(conn, 'llamacpp_spawn').length, 0, 'already ⇒ no spawn');
        assert.equal(llamacppSent(conn, 'llamacpp_stop').length, 0, 'already ⇒ no stop');
        assert.ok(usageEntry(userId, 'Tiny-MTP'));
        conn.close();
      }

      // (e) SWAPPED: different loaded model ⇒ stop(pid) THEN spawn.
      {
        const userId = await makeModelUser('t2-ensure-swapped');
        const conn = connect(userId, {
          capabilities: ['llamacpp'],
          onLlamacpp: standardLlamacppResponder(() => conn, {
            running: true,
            pid: 777,
            args: ['--model', 'D:\\other\\Old.gguf', '--alias', 'Old', '--port', String(fakeServer.port)],
            port: fakeServer.port,
          }),
        });

        const outcome = await ensureLlamacppRunning(userId, 'Plain-00001-of-00002');
        assert.equal(outcome.mode, 'swapped');
        assert.equal(outcome.running, true);
        const stops = llamacppSent(conn, 'llamacpp_stop');
        const spawns = llamacppSent(conn, 'llamacpp_spawn');
        assert.equal(stops.length, 1);
        assert.equal(stops[0].pid, 777);
        assert.ok(stops[0].graceMs >= 0);
        assert.equal(spawns.length, 1);
        assert.equal(spawns[0].args[spawns[0].args.indexOf('--model') + 1], plainEntry.path);
        const sentTypes = conn.sent.map((m) => m.type);
        assert.ok(
          sentTypes.indexOf('llamacpp_stop') < sentTypes.indexOf('llamacpp_spawn'),
          'swap ALWAYS stops before spawning',
        );
        assert.ok(usageEntry(userId, 'Plain-00001-of-00002'));
        conn.close();
      }

      // (f) Spawn refusal from the agent ⇒ failed with the agent's error.
      {
        const userId = await makeModelUser('t2-ensure-spawnfail');
        const conn = connect(userId, {
          capabilities: ['llamacpp'],
          onLlamacpp: (message) => {
            if (message.type === 'llamacpp_spawn') {
              conn.receive({
                type: 'llamacpp_spawn_response',
                requestId: String(message.requestId),
                ok: false,
                error: 'llama-server already running; stop it first',
              });
              return;
            }
            standardLlamacppResponder(() => conn)(message);
          },
        });
        const outcome = await ensureLlamacppRunning(userId, 'Tiny-MTP');
        assert.equal(outcome.running, false);
        assert.equal(outcome.mode, 'failed');
        assert.match(outcome.error ?? '', /already running|stop it first/i);
        assert.equal(getLastLaunchArgs(userId), null, 'failed launches leave no launch record');
        conn.close();
      }

      // (g) Health NEVER turns 200 within the budget ⇒ failed (timeout path).
      {
        const loadingServer = await startFakeLlamaServer({ initialReady: false }); // stuck at 503
        try {
          const userId = 't2-ensure-healthtimeout';
          insertUser(userId);
          insertSetting(userId, 'llamacpp_exe_path', EXE);
          insertSetting(userId, 'llamacpp_models_dir', MODELS_DIR);
          insertSetting(userId, 'llamacpp_port', String(loadingServer.port));
          const conn = connect(userId, {
            capabilities: ['llamacpp'],
            onLlamacpp: standardLlamacppResponder(() => conn),
          });
          const outcome = await ensureLlamacppRunning(userId, 'Tiny-MTP', { waitHealthMs: 600 });
          assert.equal(outcome.running, false);
          assert.equal(outcome.mode, 'failed');
          assert.match(outcome.error ?? '', /health|timed out|ready/i);
          assert.ok(loadingServer.healthHits() >= 1, 'health endpoint was actually polled');
          assert.equal(getLastLaunchArgs(userId), null);
          conn.close();
        } finally {
          loadingServer.close();
        }
      }

      // (h) 503 → 200 sequence: readiness reached on a LATER poll (the fake
      // server answers 503 twice, then flips to 200 on its 3rd health hit).
      {
        const warmingServer = await startFakeLlamaServer({ readyAfterHits: 3 });
        try {
          const userId = 't2-ensure-warming';
          insertUser(userId);
          insertSetting(userId, 'llamacpp_exe_path', EXE);
          insertSetting(userId, 'llamacpp_models_dir', MODELS_DIR);
          insertSetting(userId, 'llamacpp_port', String(warmingServer.port));
          const conn = connect(userId, {
            capabilities: ['llamacpp'],
            onLlamacpp: standardLlamacppResponder(() => conn),
          });
          const outcome = await ensureLlamacppRunning(userId, 'Tiny-MTP', { waitHealthMs: 15_000 });
          assert.equal(outcome.mode, 'started', outcome.error);
          assert.equal(outcome.running, true, outcome.error);
          assert.ok(warmingServer.healthHits() >= 3, 'polling continued past the 503s');
          conn.close();
        } finally {
          warmingServer.close();
        }
      }

      // (i) Unknown model key ⇒ descriptive failure (scan ran, nothing spawned).
      {
        const userId = await makeModelUser('t2-ensure-unknown');
        const conn = connect(userId, {
          capabilities: ['llamacpp'],
          onLlamacpp: standardLlamacppResponder(() => conn),
        });
        const outcome = await ensureLlamacppRunning(userId, 'No-Such-Model');
        assert.equal(outcome.mode, 'failed');
        assert.match(outcome.error ?? '', /No-Such-Model/);
        assert.equal(llamacppSent(conn, 'llamacpp_spawn').length, 0);
        conn.close();
      }

      // (j) FF-F-01 — relay-mode readiness: NOTHING listens on the resolved
      // port at the backend (remote-backend deployment), but the paired
      // capable agent answers /health through the SAME relay seam
      // llamacppFetch uses. Start must succeed through relay quickly instead
      // of deterministically burning its whole health budget and 502-ing.
      {
        setEnv('AGENT_HTTP_PROXY_ALLOW_HOSTS', `127.0.0.1:${CLOSED_PORT}`);
        const userId = 't2-ensure-relay-health';
        insertUser(userId);
        insertSetting(userId, 'llamacpp_exe_path', EXE);
        insertSetting(userId, 'llamacpp_models_dir', MODELS_DIR);
        insertSetting(userId, 'llamacpp_port', String(CLOSED_PORT)); // guaranteed dead loopback
        const conn = connect(userId, {
          capabilities: ['llamacpp'],
          onProxy: (c, request) => {
            if (new URL(request.url).pathname === '/health') {
              replyText(c, request.requestId, 200, '{"status":"ok"}');
            }
          },
          onLlamacpp: standardLlamacppResponder(() => conn),
        });

        const t0 = Date.now();
        const outcome = await ensureLlamacppRunning(userId, 'Tiny-MTP', { waitHealthMs: 20_000 });
        const elapsedMs = Date.now() - t0;
        assert.equal(outcome.mode, 'started', outcome.error);
        assert.equal(outcome.running, true);
        assert.equal(outcome.port, CLOSED_PORT);
        assert.ok(
          elapsedMs < 15_000,
          `relay-mode health wait must succeed well under budget (took ${elapsedMs} ms)`,
        );
        assert.ok(
          proxyRequests(conn).some((frame) => new URL(frame.url).pathname === '/health'),
          'readiness must be confirmed THROUGH the relay seam',
        );
        assert.ok(usageEntry(userId, 'Tiny-MTP'), 'successful relay-mode start stamps usage');
        conn.close();
        setEnv('AGENT_HTTP_PROXY_ALLOW_HOSTS', undefined);
      }
    } finally {
      fakeServer.close();
    }
  }

  // -------------------------------------------------------------------------
  console.log('6. listLlamacppModels: scan frame + collapse + 30 s cache; gates fire');
  {
    setEnv('AGENT_HTTP_PROXY_ALLOW_HOSTS', `127.0.0.1:${CLOSED_PORT}`);
    const userId = 't2-list-user';
    insertUser(userId);
    insertSetting(userId, 'llamacpp_models_dir', 'D:\\models');
    insertSetting(userId, 'llamacpp_port', String(CLOSED_PORT));
    const ENTRIES = [
      { path: 'D:\\models\\Solo.gguf', name: 'Solo.gguf', sizeBytes: 5 },
      { path: 'D:\\models\\Set-00001-of-00002.gguf', name: 'Set-00001-of-00002.gguf', sizeBytes: 1 },
      { path: 'D:\\models\\Set-00002-of-00002.gguf', name: 'Set-00002-of-00002.gguf', sizeBytes: 2 },
    ];
    const conn = connect(userId, {
      capabilities: ['llamacpp'],
      onLlamacpp: (message) => {
        if (message.type === 'llamacpp_scan_request') {
          conn.receive({
            type: 'llamacpp_scan_response',
            requestId: String(message.requestId),
            ok: true,
            entries: ENTRIES,
          });
        }
      },
    });

    const models = await listLlamacppModels(userId);
    assert.deepEqual(models, [
      { key: 'Solo', path: 'D:\\models\\Solo.gguf', sizeBytes: 5, shards: 1, mtpCapable: false },
      { key: 'Set-00001-of-00002', path: 'D:\\models\\Set-00001-of-00002.gguf', sizeBytes: 3, shards: 2, mtpCapable: false },
    ], 'first-appearance order preserved; shards collapsed with summed size');
    assert.equal(llamacppSent(conn, 'llamacpp_scan_request').length, 1);

    // Cache hit within 30 s: no second scan frame.
    await listLlamacppModels(userId);
    assert.equal(llamacppSent(conn, 'llamacpp_scan_request').length, 1, 'catalog cached for ~30 s');

    // Force busts the cache.
    await listLlamacppModels(userId, { force: true });
    assert.equal(llamacppSent(conn, 'llamacpp_scan_request').length, 2);

    conn.close();

    // Capability gate: descriptive throw, never a silent timeout.
    const legacyUserId = 't2-list-legacy';
    insertUser(legacyUserId);
    const legacyConn = connect(legacyUserId); // no capabilities
    await assert.rejects(
      () => listLlamacppModels(legacyUserId, { force: true }),
      /does not support llama\.cpp/,
    );
    legacyConn.close();

    // Missing models dir ⇒ descriptive throw.
    const noDirUserId = 't2-list-nodir';
    insertUser(noDirUserId);
    const noDirConn = connect(noDirUserId, { capabilities: ['llamacpp'] });
    await assert.rejects(() => listLlamacppModels(noDirUserId, { force: true }), /models.*dir|dir.*not configured/i);
    noDirConn.close();
    setEnv('AGENT_HTTP_PROXY_ALLOW_HOSTS', undefined);
  }

  // -------------------------------------------------------------------------
  console.log('7. stopLlamacpp: idempotent, gated, never throws');
  {
    const userId = 't2-stop-user';
    insertUser(userId);
    insertSetting(userId, 'llamacpp_port', String(CLOSED_PORT));
    let runningPid: number | null = 555;
    const conn = connect(userId, {
      capabilities: ['llamacpp'],
      onLlamacpp: (message) => {
        if (message.type === 'llamacpp_status_request') {
          conn.receive({
            type: 'llamacpp_status_response',
            requestId: String(message.requestId),
            running: runningPid !== null,
            pid: runningPid,
            args: runningPid !== null ? ['--model', 'X.gguf', '--alias', 'X'] : null,
            port: null,
          });
          return;
        }
        if (message.type === 'llamacpp_stop') {
          runningPid = null; // agent-side kill succeeds
          conn.receive({
            type: 'llamacpp_stop_response',
            requestId: String(message.requestId),
            ok: true,
            forced: false,
          });
        }
      },
    });

    const first = await stopLlamacpp(userId);
    assert.deepEqual(first, { ok: true, status: 'stopped' });
    const stops = llamacppSent(conn, 'llamacpp_stop');
    assert.equal(stops.length, 1);
    assert.equal(stops[0].pid, 555);

    // Idempotent: stopping again is a SUCCESS 'not-running'.
    const second = await stopLlamacpp(userId);
    assert.deepEqual(second, { ok: true, status: 'not-running' });
    assert.equal(llamacppSent(conn, 'llamacpp_stop').length, 1, 'no stop frame without a tracked pid');
    conn.close();

    // Capability miss ⇒ ok:false + descriptive error.
    const legacyUserId = 't2-stop-legacy';
    insertUser(legacyUserId);
    const legacyConn = connect(legacyUserId);
    const gated = await stopLlamacpp(legacyUserId);
    assert.equal(gated.ok, false);
    assert.match(gated.error ?? '', /does not support llama\.cpp/);
    legacyConn.close();

    // Agent gone ⇒ total (no throw), truthful failure.
    const ghost = await stopLlamacpp('t2-stop-never-paired');
    assert.equal(ghost.ok, false);
    assert.ok(typeof ghost.error === 'string' && ghost.error.length > 0);
  }

  // -------------------------------------------------------------------------
  console.log('8. llamacpp_exited push updates tracked state (visible once disconnected)');
  {
    const EXE = 'C:\\bins\\llama-server.exe';
    const fakeServer = await startFakeLlamaServer({ initialReady: true });
    try {
      const userId = 't2-exit-user';
      insertUser(userId);
      insertSetting(userId, 'llamacpp_exe_path', EXE);
      insertSetting(userId, 'llamacpp_models_dir', 'D:\\models');
      insertSetting(userId, 'llamacpp_port', String(fakeServer.port));
      const conn = connect(userId, {
        capabilities: ['llamacpp'],
        onLlamacpp: (message) => {
          if (message.type === 'llamacpp_scan_request') {
            conn.receive({
              type: 'llamacpp_scan_response',
              requestId: String(message.requestId),
              ok: true,
              entries: [{ path: 'D:\\models\\Crashy.gguf', name: 'Crashy.gguf' }],
            });
            return;
          }
          if (message.type === 'llamacpp_status_request') {
            conn.receive({
              type: 'llamacpp_status_response',
              requestId: String(message.requestId),
              running: false,
              pid: null,
              args: null,
              port: null,
            });
            return;
          }
          if (message.type === 'llamacpp_spawn') {
            conn.receive({
              type: 'llamacpp_spawn_response',
              requestId: String(message.requestId),
              ok: true,
              pid: 909,
            });
          }
        },
      });

      const started = await ensureLlamacppRunning(userId, 'Crashy');
      assert.equal(started.mode, 'started');
      assert.equal(started.pid, 909);

      // Unsolicited exit push arrives while STILL connected…
      conn.receive({ type: 'llamacpp_exited', pid: 909, exitCode: 137, stderrTail: 'CUDA error' });
      // …then the agent vanishes (state unknown ⇒ internal state is the truth).
      conn.close();

      const status = await getLlamacppStatus(userId);
      assert.equal(status.agentConnected, false);
      assert.equal(status.running, false, 'exit push flipped tracked running state off');
      assert.equal(status.lastExitCode, 137, 'exit code captured from the push');
    } finally {
      fakeServer.close();
    }
  }

  // -------------------------------------------------------------------------
  console.log('9. runLlamacppIdleSweep boundaries: >N eviction, 0=off, in-flight skip, total');
  {
    setEnv('AGENT_HTTP_PROXY_ALLOW_HOSTS', `127.0.0.1:${CLOSED_PORT}`);
    let runningPid: number | null = 321;

    // Stamp ONE entry via a real inference round-trip (the chat.ts seam).
    const userId = 't2-sweep-user';
    insertUser(userId);
    insertSetting(userId, 'llamacpp_port', String(CLOSED_PORT));
    insertSetting(userId, 'llamacpp_idle_unload_minutes', '1');
    const conn = connect(userId, {
      capabilities: ['llamacpp'],
      onProxy: (c, request) => {
        if (new URL(request.url).pathname === '/health') {
          replyText(c, request.requestId, 200, '{"status":"ok"}');
          return;
        }
        if (new URL(request.url).pathname === '/v1/chat/completions' && request.method === 'POST') {
          replyText(c, request.requestId, 200, 'data: {}\n\n', 'text/event-stream');
        }
      },
      onLlamacpp: (message) => {
        if (message.type === 'llamacpp_status_request') {
          conn.receive({
            type: 'llamacpp_status_response',
            requestId: String(message.requestId),
            running: runningPid !== null,
            pid: runningPid,
            args: runningPid !== null ? ['--model', 'Idle-Model.gguf', '--alias', 'Idle-Model'] : null,
            port: null,
          });
          return;
        }
        if (message.type === 'llamacpp_stop') {
          runningPid = null;
          conn.receive({
            type: 'llamacpp_stop_response',
            requestId: String(message.requestId),
            ok: true,
            forced: false,
          });
        }
      },
    });

    const stamp = await llamacppFetch(userId, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'Idle-Model' }),
    });
    await stamp.text();
    // FF-F-02: derive the boundary from the ACTUAL stamped timestamp (read
    // back from the usage map), not from a later Date.now() — any tick between
    // stamping and sampling used to make the KEEP case strictly older than the
    // threshold and eject it (~1-in-4 flake observed at the final review gate).
    const stampedAt = usageEntry(userId, 'Idle-Model')!.lastUsedAt;

    // Strictly-idle rule: elapsed == threshold ⇒ KEEP.
    let ejected = await runLlamacppIdleSweep(stampedAt + 60_000);
    assert.equal(ejected, 0, 'elapsed ≤ N minutes must be KEPT (boundary N)');
    assert.equal(llamacppSent(conn, 'llamacpp_stop').length, 0);

    // One ms past the threshold ⇒ EJECT: unload = stop frame; tracking cleaned.
    ejected = await runLlamacppIdleSweep(stampedAt + 60_000 + 1);
    assert.equal(ejected, 1, 'idle > N minutes ejects exactly the one entry');
    assert.equal(llamacppSent(conn, 'llamacpp_stop').length, 1);
    assert.equal(usageEntry(userId, 'Idle-Model'), undefined, 'tracking entry deleted after success');
    ejected = await runLlamacppIdleSweep(stampedAt + 60_000 + 2);
    assert.equal(ejected, 0, 'second sweep is inert (entry gone)');

    // '0' disables per-user idle unload entirely.
    const offUser = 't2-sweep-off';
    insertUser(offUser);
    insertSetting(offUser, 'llamacpp_port', String(CLOSED_PORT));
    insertSetting(offUser, 'llamacpp_idle_unload_minutes', '0');
    const offConn = connect(offUser, {
      capabilities: ['llamacpp'],
      onProxy: (c, request) => {
        if (new URL(request.url).pathname === '/health') replyText(c, request.requestId, 200, '{"status":"ok"}');
        else replyText(c, request.requestId, 200, 'data: {}\n\n', 'text/event-stream');
      },
      onLlamacpp: () => {},
    });
    const offStamp = await llamacppFetch(offUser, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'Off-Model' }),
    });
    await offStamp.text();
    ejected = await runLlamacppIdleSweep(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000);
    assert.equal(ejected, 0, "'0' minutes ⇒ user skipped");
    assert.equal(llamacppSent(offConn, 'llamacpp_stop').length, 0);
    assert.ok(usageEntry(offUser, 'Off-Model'), 'entry retained while disabled');
    offConn.close();

    // IN-FLIGHT skip: held relay stream pins the entry against the sweep.
    const busyUser = 't2-sweep-busy';
    insertUser(busyUser);
    insertSetting(busyUser, 'llamacpp_port', String(CLOSED_PORT));
    insertSetting(busyUser, 'llamacpp_idle_unload_minutes', '1');
    const busyConn = connect(busyUser, {
      capabilities: ['llamacpp'],
      onProxy: (c, request) => {
        if (new URL(request.url).pathname === '/health') {
          replyText(c, request.requestId, 200, '{"status":"ok"}');
          return;
        }
        // /v1/chat/completions stays SILENT — the stream is held open.
      },
      onLlamacpp: (message) => {
        if (message.type === 'llamacpp_status_request') {
          busyConn.receive({
            type: 'llamacpp_status_response',
            requestId: String(message.requestId),
            running: true,
            pid: 654,
            args: ['--alias', 'Busy-Model'],
            port: null,
          });
          return;
        }
        if (message.type === 'llamacpp_stop') {
          busyConn.receive({
            type: 'llamacpp_stop_response',
            requestId: String(message.requestId),
            ok: true,
            forced: false,
          });
        }
      },
    });
    const busyPending = llamacppFetch(busyUser, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'Busy-Model' }),
    });
    await waitFor(() => proxyRequests(busyConn).some((f) => new URL(f.url).pathname === '/v1/chat/completions'));
    assert.equal(usageEntry(busyUser, 'Busy-Model')?.inFlight, 1, 'premise: one in-flight stream');

    ejected = await runLlamacppIdleSweep(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000);
    assert.equal(ejected, 0, 'in-flight entries must NEVER be ejected');
    assert.equal(llamacppSent(busyConn, 'llamacpp_stop').length, 0);

    // Terminal relay failure settles the stream and lowers the counter…
    const busyFrame = proxyRequests(busyConn).find((f) => new URL(f.url).pathname === '/v1/chat/completions')!;
    failProxyRequest(busyConn, busyFrame.requestId, 'boom');
    const settled = await busyPending;
    assert.equal(settled.status, 502);
    // …so the next tick ejects again (unload = stop of the tracked child).
    ejected = await runLlamacppIdleSweep(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000);
    assert.equal(ejected, 1, 'settled entry becomes ejectable again');
    assert.equal(llamacppSent(busyConn, 'llamacpp_stop')[0].pid, 654);
    busyConn.close();

    // NEVER throws on an agent-less user: stamped entry + vanished agent.
    const goneUser = 't2-sweep-gone';
    insertUser(goneUser);
    insertSetting(goneUser, 'llamacpp_port', String(CLOSED_PORT));
    insertSetting(goneUser, 'llamacpp_idle_unload_minutes', '1');
    const goneConn = connect(goneUser, {
      capabilities: ['llamacpp'],
      onProxy: (c, request) => {
        if (new URL(request.url).pathname === '/health') replyText(c, request.requestId, 200, '{"status":"ok"}');
        else replyText(c, request.requestId, 200, 'data: {}\n\n', 'text/event-stream');
      },
    });
    const goneStamp = await llamacppFetch(goneUser, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'Gone-Model' }),
    });
    await goneStamp.text();
    goneConn.close(); // agent vanishes after stamping

    ejected = await runLlamacppIdleSweep(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000);
    assert.equal(ejected, 0, 'unreachable agent ⇒ failed unload, no throw, entry kept');
    assert.ok(usageEntry(goneUser, 'Gone-Model'), 'kept for a future tick');
    setEnv('AGENT_HTTP_PROXY_ALLOW_HOSTS', undefined);
  }

  assert.equal(unhandledRejections, 0, 'no unhandled promise rejections may escape any section');
  console.log('llamacpp transport tests passed');
} finally {
  for (const [key, value] of savedEnv) setEnv(key, value);
  db.close();
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(`${testDbPath}${suffix}`); } catch { /* already absent */ }
  }
}
