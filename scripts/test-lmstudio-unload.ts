/**
 * OFFLINE acceptance harness for task 9 — §11 model memory management:
 * swap-on-load (single-slot), native REST unload, usage tracking + idle sweep,
 * and the memory settings precedence.
 *
 * Sections:
 * - PURE: stripVariantKey / selectSwapCandidates / catalog loadedInstanceIds /
 *   getLmStudioMemorySettings (invalid ⇒ 45; '0'/0 legitimately disables).
 * - SCRIPTED RELAY sequences (FakeConnection idiom of test-lmstudio-transport,
 *   no HTTP mocks): swap ejects foreign keys then loads B; same-key quant
 *   variants NEVER self-swap; autoSwap=false ejects nothing; 'already'
 *   short-circuits before any swap; unload resolves instance ids / reports
 *   not-loaded; sweep honors the 45-min boundary and '0'=off, skips in-flight
 *   keys, lowers counters on scripted relay terminal errors and NEVER throws
 *   on relay failure.
 * - REAL loopback HTTP mini-server: DIRECT-transport usage tracking (a held
 *   open stream blocks ejection; full body close releases it) while preserving
 *   Response .text()/.json()/.getReader() observability.
 *
 * db-touching: needs a Linux-built better-sqlite3 (shadow tree under WSL).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// Offline harness: temp DATABASE_PATH must be set BEFORE importing server/db.js.
const testDbPath = path.join(os.tmpdir(), `lmstudio-unload-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = testDbPath;

const { default: db, migrate } = await import('../server/db.js');
const { registerAgentConnection, unregisterAgentConnection } = await import(
  '../server/agentRelay/registry.js'
);
const {
  buildComplianceReport,
  ensureModelLoaded,
  getLmStudioMemorySettings,
  getModelCapabilities,
  lmstudioFetch,
  probeLmStudio,
  runLmStudioIdleSweep,
  unloadLmStudioModel,
} = await import('../server/providers/lmstudioTransport.js');
const {
  normalizeCatalogEntry,
  selectSwapCandidates,
  stripVariantKey,
} = await import('../server/providers/lmstudio.js');
type BackendToAgentMessage = import('../server/agentRelay/protocol.js').BackendToAgentMessage;
type AgentToBackendMessage = import('../server/agentRelay/protocol.js').AgentToBackendMessage;
type AgentConnection = import('../server/agentRelay/registry.js').AgentConnection;

// ---------------------------------------------------------------------------
// Environment hygiene: snapshot everything this suite touches, restore at end.
// ---------------------------------------------------------------------------
const TOUCHED_ENV_KEYS = [
  'LMSTUDIO_BASE_URL',
  'LMSTUDIO_API_TOKEN',
  'LMSTUDIO_IDLE_UNLOAD_MINUTES',
  'LMSTUDIO_AUTO_SWAP',
  'AGENT_HTTP_PROXY_ALLOW_HOSTS',
] as const;
const savedEnv = new Map<string, string | undefined>(
  TOUCHED_ENV_KEYS.map((key) => [key, process.env[key]]),
);
function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

// Closed loopback port so the DIRECT probe refuses instantly and scenarios
// exercise the RELAY transport deterministically.
const RELAY_BASE_URL = 'http://127.0.0.1:9';

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

// ---------------------------------------------------------------------------
// Scripted local-agent connection (same idiom as test-lmstudio-transport.ts):
// every http_proxy_request is answered by the current responder via queueMicrotask.
// ---------------------------------------------------------------------------
type ProxyRequestFrame = Extract<BackendToAgentMessage, { type: 'http_proxy_request' }>;
type Responder = (request: ProxyRequestFrame) => void;
interface Reply {
  status: number;
  text: string;
}

class ScriptedAgentConnection implements AgentConnection {
  readonly sent: BackendToAgentMessage[] = [];
  private callbacks: Array<(message: AgentToBackendMessage) => void> = [];
  private connected = true;

  constructor(
    private readonly userId: string,
    public responder: Responder = () => {},
  ) {}

  isConnected() {
    return this.connected;
  }

  send(message: BackendToAgentMessage) {
    this.sent.push(message);
    if (message.type === 'http_proxy_request') {
      const request = message;
      queueMicrotask(() => {
        if (this.connected) this.responder(request);
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

function connect(userId: string, responder: Responder): ScriptedAgentConnection {
  const connection = new ScriptedAgentConnection(userId, responder);
  registerAgentConnection(userId, connection);
  return connection;
}

function proxyRequests(connection: ScriptedAgentConnection): ProxyRequestFrame[] {
  return connection.sent.filter((m): m is ProxyRequestFrame => m.type === 'http_proxy_request');
}

function framesFor(connection: ScriptedAgentConnection, pathname: string): ProxyRequestFrame[] {
  return proxyRequests(connection).filter((frame) => new URL(frame.url).pathname === pathname);
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
function failRequest(connection: ScriptedAgentConnection, requestId: string, error: string): void {
  connection.receive({ type: 'http_proxy_response', requestId, ok: false, status: 0, error });
}

async function waitFor(condition: () => boolean, timeoutMs = 1000, stepMs = 5): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

interface ResponderOpts {
  v1Models?: unknown[];
  onLoad?: (body: string | null) => Reply;
  onUnload?: (body: string | null) => Reply;
  /** Custom /v1/chat/completions handling; default stays SILENT (holds the stream). */
  onChat?: (request: ProxyRequestFrame) => void;
}

function catalogResponderFor(
  getConnection: () => ScriptedAgentConnection,
  opts: ResponderOpts,
): Responder {
  return (request) => {
    const connection = getConnection();
    const pathname = new URL(request.url).pathname;
    if (pathname === '/api/v1/models') {
      replyText(connection, request.requestId, 200, JSON.stringify({ models: opts.v1Models ?? [] }));
      return;
    }
    if (pathname === '/api/v0/models') {
      replyText(connection, request.requestId, 200, '{"data":[]}');
      return;
    }
    if (pathname === '/api/v1/models/load' && request.method === 'POST') {
      const outcome = opts.onLoad?.(request.body) ?? { status: 200, text: '{}' };
      replyText(connection, request.requestId, outcome.status, outcome.text);
      return;
    }
    if (pathname === '/api/v1/models/unload' && request.method === 'POST') {
      const outcome = opts.onUnload?.(request.body) ?? { status: 200, text: '{}' };
      replyText(connection, request.requestId, outcome.status, outcome.text);
      return;
    }
    if (pathname === '/v1/chat/completions' && request.method === 'POST') {
      if (opts.onChat) opts.onChat(request);
      return; // default: silence — the stream stays pending until the test acts
    }
    replyText(connection, request.requestId, 404, `unexpected path ${pathname}`);
  };
}

try {
  migrate();

  // F3-01-style guard: COUNT unhandled rejections instead of letting Node crash.
  let unhandledRejections = 0;
  process.on('unhandledRejection', () => {
    unhandledRejections += 1;
  });


  console.log('1. stripVariantKey: portion before the FIRST @; @-less keys unchanged');
  {
    assert.equal(stripVariantKey('qwen/qwen3-coder-30b@q4_k_m'), 'qwen/qwen3-coder-30b');
    assert.equal(stripVariantKey('qwen/qwen3-coder-30b'), 'qwen/qwen3-coder-30b');
    assert.equal(stripVariantKey('org/model@q8_0@extra'), 'org/model', 'strips at the FIRST @ only');
    assert.equal(stripVariantKey('@leading'), '', '@-only key strips to empty base');
    assert.equal(stripVariantKey(''), '');
  }

  console.log('2. selectSwapCandidates: foreign bases only, order preserved, empty in ⇒ empty out');
  {
    const loaded = ['a/model-a@q4_k_m', 'a/model-a@q8_0', 'b/model-b', 'c/model-c'];
    // Quant variants of the SAME key are NEVER candidates (no self-swap).
    assert.deepEqual(selectSwapCandidates('a/model-a', loaded), ['b/model-b', 'c/model-c']);
    assert.deepEqual(selectSwapCandidates('a/model-a@q8_0', loaded), ['b/model-b', 'c/model-c']);
    assert.deepEqual(selectSwapCandidates('b/model-b', loaded), ['a/model-a@q4_k_m', 'a/model-a@q8_0', 'c/model-c']);
    assert.deepEqual(selectSwapCandidates('x/absent', []), [], 'empty input ⇒ empty output');
    assert.deepEqual(selectSwapCandidates('x/absent', loaded), loaded, 'order preserved');
    assert.deepEqual(selectSwapCandidates('zz/nothing-matches', ['n/o@q4']), ['n/o@q4']);
  }

  console.log('3. normalizeCatalogEntry extracts loadedInstanceIds ([] when absent)');
  {
    const withInstances = normalizeCatalogEntry({
      key: 'a/model',
      loaded_instances: [{ id: 'inst-1', config: {} }, { id: 'inst-2' }, { config: {} }, null],
    });
    assert.deepEqual(withInstances.loadedInstanceIds, ['inst-1', 'inst-2']);
    assert.equal(withInstances.loaded, true);

    const without = normalizeCatalogEntry({ key: 'a/model' });
    assert.deepEqual(without.loadedInstanceIds, []);
    assert.equal(without.loaded, false);

    // Additive: every pre-existing field keeps its meaning.
    assert.equal(withInstances.key, 'a/model');
    assert.deepEqual(withInstances.loadedConfigs, [{}, {}, {}, {}]);
  }

  console.log('4. getLmStudioMemorySettings precedence: default < env < setting; invalid ⇒ 45; 0 disables');
  {
    const userId = 't9-memory-user';
    insertUser(userId);

    let memory = getLmStudioMemorySettings(userId);
    assert.deepEqual(memory, { idleUnloadMinutes: 45, autoSwap: true });

    setEnv('LMSTUDIO_IDLE_UNLOAD_MINUTES', '7');
    setEnv('LMSTUDIO_AUTO_SWAP', 'false');
    memory = getLmStudioMemorySettings(userId);
    assert.deepEqual(memory, { idleUnloadMinutes: 7, autoSwap: false });

    insertSetting(userId, 'lmstudio_idle_unload_minutes', '90');
    insertSetting(userId, 'lmstudio_auto_swap', 'true');
    memory = getLmStudioMemorySettings(userId);
    assert.deepEqual(memory, { idleUnloadMinutes: 90, autoSwap: true });

    // Invalid minute values fall back to the DEFAULT 45 (setting beats env).
    // NB: an EMPTY string follows the getLmStudioSettings template idiom
    // ('' = unset ⇒ env/default), so it is deliberately not in this list.
    for (const invalid of ['abc', '-3', 'NaN', '-inf']) {
      db.prepare('UPDATE settings SET value = ? WHERE user_id = ? AND key = ?').run(
        invalid,
        userId,
        'lmstudio_idle_unload_minutes',
      );
      assert.equal(getLmStudioMemorySettings(userId).idleUnloadMinutes, 45, `invalid ${JSON.stringify(invalid)} ⇒ 45`);
    }
    // '' behaves as UNSET (template idiom): the env fallback applies.
    db.prepare('UPDATE settings SET value = ? WHERE user_id = ? AND key = ?').run('', userId, 'lmstudio_idle_unload_minutes');
    setEnv('LMSTUDIO_IDLE_UNLOAD_MINUTES', '12');
    assert.equal(getLmStudioMemorySettings(userId).idleUnloadMinutes, 12);
    setEnv('LMSTUDIO_IDLE_UNLOAD_MINUTES', undefined);
    assert.equal(getLmStudioMemorySettings(userId).idleUnloadMinutes, 45);
    // '0' legitimately DISABLES (setting and env forms).
    db.prepare('UPDATE settings SET value = ? WHERE user_id = ? AND key = ?').run('0', userId, 'lmstudio_idle_unload_minutes');
    assert.equal(getLmStudioMemorySettings(userId).idleUnloadMinutes, 0);
    db.prepare('DELETE FROM settings WHERE user_id = ? AND key = ?').run(userId, 'lmstudio_idle_unload_minutes');
    setEnv('LMSTUDIO_IDLE_UNLOAD_MINUTES', '0');
    assert.equal(getLmStudioMemorySettings(userId).idleUnloadMinutes, 0);
    setEnv('LMSTUDIO_IDLE_UNLOAD_MINUTES', undefined);

    // auto_swap: anything but 'false' ⇒ true.
    setEnv('LMSTUDIO_AUTO_SWAP', undefined); // isolate setting-only semantics first
    for (const truthy of ['TRUE', 'yes', '1']) {
      db.prepare('UPDATE settings SET value = ? WHERE user_id = ? AND key = ?').run(truthy, userId, 'lmstudio_auto_swap');
      assert.equal(getLmStudioMemorySettings(userId).autoSwap, true, `auto_swap ${JSON.stringify(truthy)} ⇒ true`);
    }
    db.prepare('UPDATE settings SET value = ? WHERE user_id = ? AND key = ?').run('false', userId, 'lmstudio_auto_swap');
    assert.equal(getLmStudioMemorySettings(userId).autoSwap, false);
    // '' behaves as UNSET (template idiom): the env fallback applies.
    db.prepare('UPDATE settings SET value = ? WHERE user_id = ? AND key = ?').run('', userId, 'lmstudio_auto_swap');
    setEnv('LMSTUDIO_AUTO_SWAP', 'false');
    assert.equal(getLmStudioMemorySettings(userId).autoSwap, false);
    setEnv('LMSTUDIO_AUTO_SWAP', undefined);
    assert.equal(getLmStudioMemorySettings(userId).autoSwap, true);
  }

  console.log('5. swap-on-load: foreign key ejected (native unload POST) BEFORE loading B');
  {
    setEnv('AGENT_HTTP_PROXY_ALLOW_HOSTS', '127.0.0.1:9');
    const userId = 't9-swap-user';
    insertUser(userId);
    insertSetting(userId, 'lmstudio_base_url', RELAY_BASE_URL);
    const sentOrder: string[] = [];
    const connection = connect(
      userId,
      catalogResponderFor(() => connection, {
        v1Models: [
          { key: 'swap/model-a', loaded_instances: [{ id: 'inst-a', config: {} }] },
          { key: 'swap/model-b', loaded_instances: [] },
        ],
        onUnload(body) {
          sentOrder.push(`unload:${body}`);
          return { status: 200, text: '{}' };
        },
        onLoad(body) {
          sentOrder.push(`load:${body}`);
          return { status: 200, text: JSON.stringify({ instance_id: 'inst-b', status: 'loaded' }) };
        },
      }),
    );

    const result = await ensureModelLoaded(userId, 'swap/model-b');
    assert.equal(result.loaded, true);
    assert.equal(result.mode, 'loaded');

    const unloadFrames = framesFor(connection, '/api/v1/models/unload');
    assert.equal(unloadFrames.length, 1, 'exactly one ejection for the one foreign loaded model');
    assert.equal(unloadFrames[0].body, JSON.stringify({ instance_id: 'inst-a' }));
    assert.equal(sentOrder.length, 2);
    assert.ok(sentOrder[0]?.startsWith('unload:'), 'the ejection must be sent FIRST');
    assert.ok(sentOrder[1]?.startsWith('load:'), 'the profile load must come AFTER the ejection');
    const loadBody = JSON.parse(sentOrder[1]!.slice('load:'.length)) as Record<string, unknown>;
    assert.equal(loadBody.model, 'swap/model-b'); // §3 load body proceeds unchanged
    connection.close();
  }

  console.log('6. same-key quant variant NEVER self-swaps');
  {
    setEnv('AGENT_HTTP_PROXY_ALLOW_HOSTS', '127.0.0.1:9');
    const userId = 't9-quant-user';
    insertUser(userId);
    insertSetting(userId, 'lmstudio_base_url', RELAY_BASE_URL);
    const connection = connect(
      userId,
      catalogResponderFor(() => connection, {
        v1Models: [
          { key: 'swap/model@q4_k_m', loaded_instances: [{ id: 'inst-q4', config: {} }] },
          { key: 'swap/model@q8_0', loaded_instances: [] },
        ],
      }),
    );

    const result = await ensureModelLoaded(userId, 'swap/model@q8_0');
    assert.equal(result.mode, 'loaded');
    assert.equal(
      framesFor(connection, '/api/v1/models/unload').length,
      0,
      'loading a quant variant of the SAME base key must eject nothing',
    );
    assert.equal(framesFor(connection, '/api/v1/models/load').length, 1);
    connection.close();
  }

  console.log('7. autoSwap=false ejects nothing (behavior otherwise identical)');
  {
    setEnv('AGENT_HTTP_PROXY_ALLOW_HOSTS', '127.0.0.1:9');
    const userId = 't9-noswap-user';
    insertUser(userId);
    insertSetting(userId, 'lmstudio_base_url', RELAY_BASE_URL);
    insertSetting(userId, 'lmstudio_auto_swap', 'false');
    const connection = connect(
      userId,
      catalogResponderFor(() => connection, {
        v1Models: [
          { key: 'swap/model-a', loaded_instances: [{ id: 'inst-a', config: {} }] },
          { key: 'swap/model-b', loaded_instances: [] },
        ],
      }),
    );

    const result = await ensureModelLoaded(userId, 'swap/model-b');
    assert.equal(result.loaded, true);
    assert.equal(result.mode, 'loaded');
    assert.equal(framesFor(connection, '/api/v1/models/unload').length, 0, 'no ejections when auto_swap=false');
    assert.equal(framesFor(connection, '/api/v1/models/load').length, 1, 'the load itself still proceeds');

    // env fallback form behaves identically
    const envUserId = 't9-noswap-env-user';
    insertUser(envUserId);
    insertSetting(envUserId, 'lmstudio_base_url', RELAY_BASE_URL);
    setEnv('LMSTUDIO_AUTO_SWAP', 'false');
    const envConnection = connect(
      envUserId,
      catalogResponderFor(() => envConnection, {
        v1Models: [{ key: 'swap/model-a', loaded_instances: [{ id: 'inst-a', config: {} }] }],
      }),
    );
    const envResult = await ensureModelLoaded(envUserId, 'swap/model-b');
    assert.equal(envResult.mode, 'jit-fallback'); // model-b absent from THIS catalog
    assert.equal(framesFor(envConnection, '/api/v1/models/unload').length, 0, 'env auto_swap=false ejects nothing');
    setEnv('LMSTUDIO_AUTO_SWAP', undefined);
    envConnection.close();
    connection.close();
  }

  console.log("8. 'already'-mode short-circuit stays BEFORE any swap consideration");
  {
    setEnv('AGENT_HTTP_PROXY_ALLOW_HOSTS', '127.0.0.1:9');
    const userId = 't9-already-user';
    insertUser(userId);
    insertSetting(userId, 'lmstudio_base_url', RELAY_BASE_URL);
    const connection = connect(
      userId,
      catalogResponderFor(() => connection, {
        v1Models: [
          { key: 'swap/model-a', loaded_instances: [{ id: 'inst-a', config: {} }] },
          { key: 'swap/model-b', loaded_instances: [{ id: 'inst-b', config: {} }] },
        ],
      }),
    );

    const result = await ensureModelLoaded(userId, 'swap/model-b');
    assert.equal(result.mode, 'already');
    assert.equal(
      framesFor(connection, '/api/v1/models/unload').length,
      0,
      'a loaded target must never cause ejections (foreign inst-a present!)',
    );
    assert.equal(framesFor(connection, '/api/v1/models/load').length, 0);
    connection.close();
  }

  console.log('9. unloadLmStudioModel: collects matching instance ids and unloads each');
  {
    setEnv('AGENT_HTTP_PROXY_ALLOW_HOSTS', '127.0.0.1:9');
    const userId = 't9-unload-user';
    insertUser(userId);
    insertSetting(userId, 'lmstudio_base_url', RELAY_BASE_URL);
    const unloadBodies: Array<string | null> = [];
    const connection = connect(
      userId,
      catalogResponderFor(() => connection, {
        v1Models: [
          {
            key: 'kill/model',
            loaded_instances: [{ id: 'i-1', config: {} }, { id: 'i-2' }],
          },
          { key: 'other/model', loaded_instances: [{ id: 'keep-me', config: {} }] },
        ],
        onUnload(body) {
          unloadBodies.push(body);
          return { status: 200, text: '{}' };
        },
      }),
    );

    const result = await unloadLmStudioModel(userId, 'kill/model');
    assert.deepEqual(result, { ok: true, status: 'unloaded', instancesUnloaded: 2 });
    assert.deepEqual(unloadBodies, [
      JSON.stringify({ instance_id: 'i-1' }),
      JSON.stringify({ instance_id: 'i-2' }),
    ]);

    // Variant-stripped matching: targeting a quant variant still finds the base's instances.
    const variantResult = await unloadLmStudioModel(userId, 'kill/model@q4_k_m');
    assert.equal(variantResult.ok, true);
    assert.equal(variantResult.instancesUnloaded, 2);
    connection.close();
  }

  console.log("10. unloadLmStudioModel: 'not-loaded' success when nothing matches");
  {
    setEnv('AGENT_HTTP_PROXY_ALLOW_HOSTS', '127.0.0.1:9');
    const userId = 't9-notloaded-user';
    insertUser(userId);
    insertSetting(userId, 'lmstudio_base_url', RELAY_BASE_URL);
    const connection = connect(
      userId,
      catalogResponderFor(() => connection, {
        v1Models: [{ key: 'calm/model', loaded_instances: [] }],
      }),
    );

    const result = await unloadLmStudioModel(userId, 'calm/model');
    assert.deepEqual(result, { ok: true, status: 'not-loaded', instancesUnloaded: 0 });
    assert.equal(framesFor(connection, '/api/v1/models/unload').length, 0, 'no unload POST without ids');
    connection.close();
  }

  console.log("11. unloadLmStudioModel: 'unsupported' on non-native-v1 surface; never throws");
  {
    const userId = 't9-unsupported-user';
    insertUser(userId);
    insertSetting(userId, 'lmstudio_base_url', RELAY_BASE_URL);
    setEnv('AGENT_HTTP_PROXY_ALLOW_HOSTS', '127.0.0.1:9');
    const connection = connect(userId, (request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/api/v1/models') {
        replyText(connection, request.requestId, 404, 'not found');
      } else if (pathname === '/api/v0/models') {
        replyText(connection, request.requestId, 200, '{"data":[]}');
      }
    });

    const result = await unloadLmStudioModel(userId, 'any/model');
    assert.equal(result.ok, false);
    assert.equal(result.status, 'unsupported');
    assert.match(result.error ?? '', /0\.4\.x/);
    connection.close();

    // Unreachable backend: 'failed' with an error, still never throws.
    const offline = await unloadLmStudioModel('t9-offline-unload-user', 'any/model');
    assert.equal(offline.ok, false);
    assert.equal(offline.status, 'failed');
    assert.ok(typeof offline.error === 'string' && offline.error.length > 0);
  }

  console.log('12. management traffic (catalog/status/compliance/unload) NEVER stamps usage');
  {
    setEnv('AGENT_HTTP_PROXY_ALLOW_HOSTS', '127.0.0.1:9');
    const userId = 't9-mgmt-user';
    insertUser(userId);
    insertSetting(userId, 'lmstudio_base_url', RELAY_BASE_URL);
    const connection = connect(
      userId,
      catalogResponderFor(() => connection, {
        v1Models: [{ key: 'mgmt/model', loaded_instances: [] }],
      }),
    );

    await probeLmStudio(userId);
    await buildComplianceReport(userId, 'mgmt/model');
    await getModelCapabilities(userId, 'mgmt/model');
    const unloadOutcome = await unloadLmStudioModel(userId, 'mgmt/model'); // not-loaded path
    assert.equal(unloadOutcome.status, 'not-loaded');
    const framesBeforeSweep = proxyRequests(connection).length;

    const ejected = await runLmStudioIdleSweep(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000);
    assert.equal(ejected, 0, 'sweep must find NOTHING tracked for management-only traffic');
    assert.equal(
      proxyRequests(connection).length - framesBeforeSweep,
      0,
      'management-only user must have zero tracked entries ⇒ zero sweep unload attempts',
    );
    connection.close();
  }

  console.log('13. sweep honors the 45-minute DEFAULT with exact N/N+1 boundary');
  {
    setEnv('AGENT_HTTP_PROXY_ALLOW_HOSTS', '127.0.0.1:9');
    const userId = 't9-idle-user';
    insertUser(userId);
    insertSetting(userId, 'lmstudio_base_url', RELAY_BASE_URL);
    const connection = connect(
      userId,
      catalogResponderFor(() => connection, {
        v1Models: [{ key: 'idle/model', loaded_instances: [{ id: 'inst-idle', config: {} }] }],
        onChat(request) {
          replyText(connection, request.requestId, 200, 'data: {"ok":true}\n\ndata: [DONE]\n\n', 'text/event-stream');
        },
      }),
    );

    // Stamp usage via ONE real inference round-trip (chat.ts's exact seam).
    const tBefore = Date.now();
    const response = await lmstudioFetch(userId, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'idle/model', messages: [] }),
    });
    assert.equal(response.status, 200);
    await response.text(); // fully consume ⇒ in-flight lowered
    const tAfter = Date.now();

    // At exactly N minutes elapsed (worst case stamp == tBefore): NOT yet idle.
    let ejected = await runLmStudioIdleSweep(tBefore + 45 * 60_000);
    assert.equal(ejected, 0, 'elapsed ≤ 45 min must be KEPT (boundary N)');
    assert.equal(framesFor(connection, '/api/v1/models/unload').length, 0);

    // One millisecond past the boundary (guaranteed elapsed ≥ N min + 1 ms): ejected.
    ejected = await runLmStudioIdleSweep(tAfter + 45 * 60_000 + 1);
    assert.equal(ejected, 1, 'idle > 45 min must be EJECTED (boundary N+1)');
    const unloadFrames = framesFor(connection, '/api/v1/models/unload');
    assert.equal(unloadFrames.length, 1);
    assert.equal(unloadFrames[0].body, JSON.stringify({ instance_id: 'inst-idle' }));

    // Tracking entry deleted after successful ejection: a second sweep is inert.
    ejected = await runLmStudioIdleSweep(tAfter + 45 * 60_000 + 2);
    assert.equal(ejected, 0);
    assert.equal(framesFor(connection, '/api/v1/models/unload').length, 1);
    connection.close();
  }

  console.log("14. sweep: '0' disables per-user idle unload entirely");
  {
    setEnv('AGENT_HTTP_PROXY_ALLOW_HOSTS', '127.0.0.1:9');
    const userId = 't9-disabled-user';
    insertUser(userId);
    insertSetting(userId, 'lmstudio_base_url', RELAY_BASE_URL);
    insertSetting(userId, 'lmstudio_idle_unload_minutes', '0');
    const connection = connect(
      userId,
      catalogResponderFor(() => connection, {
        v1Models: [{ key: 'off/model', loaded_instances: [{ id: 'inst-off', config: {} }] }],
        onChat(request) {
          replyText(connection, request.requestId, 200, 'data: {}\n\n', 'text/event-stream');
        },
      }),
    );

    const response = await lmstudioFetch(userId, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'off/model' }),
    });
    await response.text();

    const ejected = await runLmStudioIdleSweep(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000);
    assert.equal(ejected, 0, "'0' minutes must disable idle unload for the user");
    assert.equal(framesFor(connection, '/api/v1/models/unload').length, 0);
    connection.close();
  }

  console.log('15. sweep skips IN-FLIGHT keys; counter lowers on relay terminal error');
  {
    setEnv('AGENT_HTTP_PROXY_ALLOW_HOSTS', '127.0.0.1:9');
    const userId = 't9-inflight-user';
    insertUser(userId);
    insertSetting(userId, 'lmstudio_base_url', RELAY_BASE_URL);
    insertSetting(userId, 'lmstudio_idle_unload_minutes', '1'); // short window for test speed
    const connection = connect(
      userId,
      catalogResponderFor(() => connection, {
        v1Models: [{ key: 'busy/model', loaded_instances: [{ id: 'inst-busy', config: {} }] }],
      }), // onChat default: SILENT — stream held open
    );

    // Enter inference but DO NOT answer: the relay terminal never settles…
    const pending = lmstudioFetch(userId, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'busy/model' }),
    });
    await waitFor(() => framesFor(connection, '/v1/chat/completions').length === 1);

    // …so even a hugely-idle entry must be SKIPPED while in flight.
    let ejected = await runLmStudioIdleSweep(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000);
    assert.equal(ejected, 0, 'in-flight entries must never be ejected');
    assert.equal(framesFor(connection, '/api/v1/models/unload').length, 0);

    // Scripted TERMINAL ERROR lowers the counter (relay failure epilogue).
    failRequest(connection, framesFor(connection, '/v1/chat/completions')[0].requestId, 'boom');
    const settled = await pending;
    assert.equal(settled.status, 502); // status-0 terminal maps to 502 (existing semantics)

    // Counter lowered: the next sweep ejects the now-idle entry.
    ejected = await runLmStudioIdleSweep(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000);
    assert.equal(ejected, 1, 'after the stream settles the entry becomes ejectable again');
    assert.equal(framesFor(connection, '/api/v1/models/unload')[0].body, JSON.stringify({ instance_id: 'inst-busy' }));
    connection.close();
  }

  console.log('16. sweep NEVER throws on relay failures (unload error + dead agent)');
  {
    setEnv('AGENT_HTTP_PROXY_ALLOW_HOSTS', '127.0.0.1:9');
    // (a) unload exchange dies at the RELAY level (scripted status-0 terminal).
    const userIdA = 't9-fail-unload-user';
    insertUser(userIdA);
    insertSetting(userIdA, 'lmstudio_base_url', RELAY_BASE_URL);
    insertSetting(userIdA, 'lmstudio_idle_unload_minutes', '1');
    const baseResponder = catalogResponderFor(() => connectionA, {
      v1Models: [{ key: 'flaky/model', loaded_instances: [{ id: 'inst-flaky', config: {} }] }],
      onChat(request) {
        replyText(connectionA, request.requestId, 200, 'data: {}\n\n', 'text/event-stream');
      },
    });
    const connectionA = connect(userIdA, (request) => {
      if (new URL(request.url).pathname === '/api/v1/models/unload') {
        failRequest(connectionA, request.requestId, 'simulated relay failure');
        return;
      }
      baseResponder(request);
    });

    const stampResponse = await lmstudioFetch(userIdA, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'flaky/model' }),
    });
    assert.equal(stampResponse.status, 200);
    await stampResponse.text();

    let ejected = await runLmStudioIdleSweep(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000);
    assert.equal(ejected, 0, 'failed unload keeps the tracking entry (retry next tick)');
    assert.equal(framesFor(connectionA, '/api/v1/models/unload').length, 1, 'the attempt WAS made');
    // Entry retained ⇒ a later sweep retries (still without throwing).
    ejected = await runLmStudioIdleSweep(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000 + 5);
    assert.equal(ejected, 0);
    assert.equal(framesFor(connectionA, '/api/v1/models/unload').length, 2);
    connectionA.close();

    // (b) agent GONE at sweep time: probe degrades to unreachable; still no throw.
    const userIdB = 't9-dead-agent-user';
    insertUser(userIdB);
    insertSetting(userIdB, 'lmstudio_base_url', RELAY_BASE_URL);
    insertSetting(userIdB, 'lmstudio_idle_unload_minutes', '1');
    const connectionB = connect(
      userIdB,
      catalogResponderFor(() => connectionB, {
        v1Models: [{ key: 'gone/model', loaded_instances: [{ id: 'inst-gone', config: {} }] }],
        onChat(request) {
          replyText(connectionB, request.requestId, 200, 'data: {}\n\n', 'text/event-stream');
        },
      }),
    );
    const goneResponse = await lmstudioFetch(userIdB, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gone/model' }),
    });
    await goneResponse.text();
    connectionB.close(); // agent vanishes after usage was stamped

    ejected = await runLmStudioIdleSweep(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000);
    assert.equal(ejected, 0, 'unreachable agent ⇒ failed unload, no throw, entry kept');
  }

  console.log('17. DIRECT transport: held stream blocks ejection, body close releases, observability preserved');
  {
    const directUnloadBodies: Array<string | null> = [];
    const heldChats: Array<http.ServerResponse> = [];
    const directServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          models: [{ key: 'direct/model', loaded_instances: [{ id: 'd-inst', config: {} }] }],
        }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/models/unload') {
        let raw = '';
        req.on('data', (chunk) => {
          raw += chunk;
        });
        req.on('end', () => {
          directUnloadBodies.push(raw);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{}');
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"chunk":1}\n\n');
        heldChats.push(res); // hold the BODY open
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => directServer.listen(0, '127.0.0.1', resolve));
    const address = directServer.address();
    if (!address || typeof address === 'string') throw new Error('no listen address');

    try {
      const userId = 't9-direct-user';
      insertUser(userId);
      insertSetting(userId, 'lmstudio_base_url', `http://127.0.0.1:${address.port}`);
      insertSetting(userId, 'lmstudio_idle_unload_minutes', '1');

      const probe = await probeLmStudio(userId);
            assert.equal(probe.transport, 'direct', 'scenario premise: direct transport');

      const response = await lmstudioFetch(userId, '/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'direct/model' }),
      });
      assert.equal(response.status, 200);

      // Body held open ⇒ in-flight ⇒ skipped even when maximally idle.
      let ejected = await runLmStudioIdleSweep(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000);
      assert.equal(ejected, 0, 'open direct stream must pin its key against the sweep');
      assert.equal(directUnloadBodies.length, 0);

      // Finish the stream and FULLY consume via .text() (observability intact).
      for (const held of heldChats) held.end('data: [DONE]\n\n');
      const text = await response.text();
      assert.equal(text, 'data: {"chunk":1}\n\ndata: [DONE]\n\n');

      await new Promise((resolve) => setTimeout(resolve, 25)); // settle microtasks/timers
      ejected = await runLmStudioIdleSweep(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000);
      assert.equal(ejected, 1, 'closed body releases the in-flight counter ⇒ ejectable');
      assert.deepEqual(directUnloadBodies, [JSON.stringify({ instance_id: 'd-inst' })]);
    } finally {
      // Destroy ref'd server-side keep-alive sockets or the process cannot exit.
      directServer.closeAllConnections?.();
      directServer.close();
    }
  }

  assert.equal(unhandledRejections, 0, 'no unhandled promise rejections may escape any section');
  console.log('lmstudio unload/memory tests passed');
} finally {
  for (const [key, value] of savedEnv) setEnv(key, value);
  db.close();
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(`${testDbPath}${suffix}`); } catch { /* already absent */ }
  }
}
