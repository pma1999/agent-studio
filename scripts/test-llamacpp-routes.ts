/**
 * OFFLINE acceptance harness for the llama.cpp model routes (task 3):
 *   GET  /api/models/llamacpp            (catalog, 30 s/user cache, fail-soft 503)
 *   GET  /api/models/llamacpp/status     (never-throw §5 payload + pendingRestart)
 *   POST /api/models/llamacpp/start      ({model, overrides?})
 *   POST /api/models/llamacpp/stop       (FROZEN envelope)
 *   GET  /api/models/llamacpp/config     (effective config view incl. §3 v2
 *                                         presets/activePreset/sampling and
 *                                         the §10 Increment 2d modelSampling map)
 *   POST /api/models/llamacpp/config     (zod-validated persistence with
 *                                         key-level errors; CANONICAL ⊕ presets;
 *                                         modelSampling persisted verbatim)
 *   GET  /api/models/llamacpp/logs       (bounded tail, fail-soft)
 *
 * No real llama-server and no real local-agent binary are required: scenarios
 * exercise the §2 capability gate against a MISSING agent, then wire a scripted
 * FakeConnection-style agent (capabilities:['llamacpp']) that answers
 * llamacpp_* frames deterministically. Direct probes refuse instantly because
 * nothing listens on the resolved loopback port's /health.
 *
 * db-touching: needs a Linux-built better-sqlite3 (shadow tree under WSL,
 * context-map.md §4 recipe).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Offline harness: temp DATABASE_PATH must be set BEFORE importing server/db.js.
const testDbPath = path.join(os.tmpdir(), `llamacpp-routes-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = testDbPath;
process.env.JWT_SECRET = 'test-secret';
// Configured models dir so listLlamacppModels reaches the scripted agent's
// scan responder instead of failing fast on the §3 no-default precondition.
process.env.LLAMACPP_MODELS_DIR = 'C:\\models';

const express = (await import('express')).default;
const { default: db, migrate } = await import('../server/db.js');
const { registerAgentConnection, unregisterAgentConnection } = await import(
  '../server/agentRelay/registry.js'
);
const modelsRouter = (await import('../server/routes/models.js')).default;
const {
  LLAMACPP_CAPABILITY_ERROR,
  resolveLlamacppConfig,
} = await import('../server/providers/llamacppTransport.js');
const { buildLlamaServerArgv, mergeKnobLayers } = await import('../server/providers/llamacpp.js');

type AgentToBackendMessage = import('../server/agentRelay/protocol.js').AgentToBackendMessage;
type BackendToAgentMessage = import('../server/agentRelay/protocol.js').BackendToAgentMessage;
type AgentConnection = import('../server/agentRelay/registry.js').AgentConnection;

let checks = 0;
function ok(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`ok ${checks} - ${name}`);
}

await migrate();

const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';

/** Direct settings-row manipulation for pendingRestart drift scenarios. */
function insertSettingRow(userId: string, key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?) '
    + 'ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value',
  ).run(userId, key, value);
}
function updateSettingRow(userId: string, key: string, value: string): void {
  db.prepare('UPDATE settings SET value = ? WHERE user_id = ? AND key = ?').run(value, userId, key);
}

/** Scripted agent answering ONLY llamacpp_* frames via queueMicrotask. */
class ScriptedConnection implements AgentConnection {
  readonly sent: BackendToAgentMessage[] = [];
  private callbacks: Array<(message: AgentToBackendMessage) => void> = [];
  private connected = true;

  constructor(
    private readonly userId: string,
    public responder: (message: Extract<BackendToAgentMessage, { requestId: string }>) => AgentToBackendMessage | void = () => {},
  ) {}

  isConnected() {
    return this.connected;
  }

  send(message: BackendToAgentMessage) {
    this.sent.push(message);
    if ('requestId' in message && typeof message.type === 'string' && message.type.startsWith('llamacpp_')) {
      const request = message as Extract<BackendToAgentMessage, { requestId: string }>;
      queueMicrotask(() => {
        if (!this.connected) return;
        const response = this.responder(request);
        if (response) this.receive(response);
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

function connect(
  userId: string,
  responder: (message: Extract<BackendToAgentMessage, { requestId: string }>) => AgentToBackendMessage | void = () => {},
): ScriptedConnection {
  const connection = new ScriptedConnection(userId, responder);
  registerAgentConnection(userId, connection);
  connection.receive({
    type: 'hello',
    agentVersion: '1.2.0',
    deviceName: 'test-agent',
    capabilities: ['llamacpp'],
  });
  return connection;
}

/** Standard responder: scans list one GGUF; reports running when flipped on. */
function makeResponder(opts: {
  scanError?: string;
  files?: Array<{ path: string; name: string; sizeBytes?: number }>;
  runningPid?: number | null;
}) {
  return (request: Extract<BackendToAgentMessage, { requestId: string }>): AgentToBackendMessage | void => {
    switch (request.type) {
      case 'llamacpp_scan_request':
        if (opts.scanError) {
          return { type: 'llamacpp_scan_response', requestId: request.requestId, ok: false, error: opts.scanError };
        }
        return {
          type: 'llamacpp_scan_response',
          requestId: request.requestId,
          ok: true,
          entries: opts.files ?? [{ path: 'C:\\models\\Qwen3-Test.gguf', name: 'Qwen3-Test.gguf', sizeBytes: 1234 }],
        };
      case 'llamacpp_status_request':
        return {
          type: 'llamacpp_status_response',
          requestId: request.requestId,
          running: opts.runningPid != null,
          pid: opts.runningPid ?? null,
          ...(opts.runningPid != null
            ? { args: ['--model', 'C:\\models\\Qwen3-Test.gguf', '--alias', 'Qwen3-Test'], port: 8712 }
            : {}),
        };
      case 'llamacpp_logs_request':
        return {
          type: 'llamacpp_logs_response',
          requestId: request.requestId,
          ok: true,
          text: 'srv listening at http://127.0.0.1:8712',
          truncated: false,
        };
      default:
        return undefined;
    }
  };
}

/** Auth stub mirroring the real middleware contract; no credentials ⇒ 401 path. */
function fakeAuth(req: any, res: import('express').Response, next: () => void): void {
  const user = req.headers['x-test-user'];
  if (typeof user === 'string' && user) {
    req.userId = user;
  }
  next();
}

const app = express();
app.use(express.json());
app.use('/api/models', fakeAuth as never, modelsRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('no listen address');
const base = `http://127.0.0.1:${address.port}/api/models`;

async function call(
  method: 'GET' | 'POST',
  url: string,
  opts: { user?: string; body?: unknown } = {},
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.user ? { 'x-test-user': opts.user } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

try {
  // ---------------------------------------------------------------------
  // Section 1: auth guards — every endpoint rejects anonymous callers (401)
  // ---------------------------------------------------------------------
  for (const [method, url] of [
    ['GET', '/llamacpp'],
    ['GET', '/llamacpp/status'],
    ['POST', '/llamacpp/start'],
    ['POST', '/llamacpp/stop'],
    ['GET', '/llamacpp/config'],
    ['POST', '/llamacpp/config'],
    ['GET', '/llamacpp/logs'],
  ] as const) {
    const r = await call(method, url, { body: method === 'POST' ? {} : undefined });
    ok(`${method} ${url} without credentials -> 401`, () => {
      assert.equal(r.status, 401);
      assert.equal(r.json?.error, 'Unauthorized');
    });
  }

  // ---------------------------------------------------------------------
  // Section 2: §2 capability gate with NO agent connected — action routes
  // fail FAST with the frozen message instead of timing out; status REPORTS.
  // ---------------------------------------------------------------------
  {
    const gated: Array<['GET' | 'POST', string]> = [
      ['GET', '/llamacpp'],
      ['POST', '/llamacpp/start'],
      ['POST', '/llamacpp/stop'],
      ['GET', '/llamacpp/config'],
      ['POST', '/llamacpp/config'],
      ['GET', '/llamacpp/logs'],
    ];
    for (const [method, url] of gated) {
      const r = await call(method, url, { user: USER_A, body: method === 'POST' ? { model: 'm' } : undefined });
      ok(`${method} ${url} without capable agent -> 503 gate message`, () => {
        assert.equal(r.status, 503);
        assert.equal(r.json?.error, LLAMACPP_CAPABILITY_ERROR);
      });
    }
  }
  {
    const r = await call('GET', '/llamacpp/status', { user: USER_A });
    ok('status without capable agent -> 200 pinned payload reporting capabilitySupported:false', () => {
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, {
        agentConnected: false,
        capabilitySupported: false,
        running: false,
        pid: null,
        modelPath: null,
        modelKey: null,
        port: null,
        transport: null,
        healthy: null,
        startedAt: null,
        lastExitCode: null,
        argv: null,
        mtpActive: false,
        pendingRestart: false,
      });
    });
  }

  // ---------------------------------------------------------------------
  // Section 3: capable scripted agent wired — catalog behaviors
  // ---------------------------------------------------------------------
  let connection: ScriptedConnection | null = null;
  let responderOpts: Parameters<typeof makeResponder>[0] = {};
  {
    connection = connect(USER_A, (request) => makeResponder(responderOpts)(request));
  }

  {
    responderOpts = { scanError: 'models dir vanished' };
    const r = await call('GET', '/llamacpp', { user: USER_A });
    ok('catalog scan failure -> 503 {error} fail-soft envelope', () => {
      assert.equal(r.status, 503);
      assert.match(String(r.json?.error), /models dir vanished|scan/i);
    });
  }

  {
    responderOpts = { files: [{ path: 'C:\\models\\Qwen3-Test.gguf', name: 'Qwen3-Test.gguf', sizeBytes: 1234 }] };
    const r = await call('GET', '/llamacpp', { user: USER_A });
    ok('catalog happy path -> §5 envelope with namespaced id + metadata', () => {
      assert.equal(r.status, 200);
      assert.equal(Array.isArray(r.json?.data), true);
      assert.equal(r.json.data.length, 1);
      const entry = r.json.data[0];
      assert.equal(entry.id, 'llamacpp:Qwen3-Test');
      assert.equal(entry.name, 'Qwen3-Test');
      assert.equal(entry.description, '');
      assert.equal(entry.context_length, 0);
      assert.deepEqual(entry.pricing, { prompt: '0', completion: '0' });
      assert.equal(entry.path, 'C:\\models\\Qwen3-Test.gguf');
      assert.equal(entry.size_bytes, 1234);
      assert.equal(entry.shards, 1);
      assert.equal(entry.mtp_capable, false);
      assert.equal(entry.loaded, false);
    });

    const before = connection!.sent.filter((m) => m.type === 'llamacpp_scan_request').length;
    const r2 = await call('GET', '/llamacpp', { user: USER_A });
    const after = connection!.sent.filter((m) => m.type === 'llamacpp_scan_request').length;
    ok('catalog caches ~30 s per user (second hit sends NO new scan)', () => {
      assert.equal(r2.status, 200);
      assert.deepEqual(r2.json, r.json);
      assert.equal(after, before, 'scan frame count must not change on cache hit');
    });
  }

  // ---------------------------------------------------------------------
  // Section 4: start validation + classification
  // ---------------------------------------------------------------------
  for (const bad of [undefined, '', '   ', 5, null]) {
    const r = await call('POST', '/llamacpp/start', { user: USER_A, body: { model: bad } });
    ok(`start rejects invalid model (${JSON.stringify(bad) ?? 'missing'}) -> 400`, () => {
      assert.equal(r.status, 400);
      assert.equal(typeof r.json?.error, 'string');
    });
  }
  {
    const r = await call('POST', '/llamacpp/start', { user: USER_A, body: { model: 'Qwen3-Test', overrides: 'nonsense' } });
    ok('start rejects non-object overrides -> 400', () => {
      assert.equal(r.status, 400);
      assert.match(String(r.json?.error), /overrides/);
    });
  }
  {
    const r = await call('POST', '/llamacpp/start', { user: USER_A, body: { model: 'Qwen3-Test', overrides: { bogus_knob: 1 } } });
    ok('start rejects unknown override keys -> 400 with detail', () => {
      assert.equal(r.status, 400);
      assert.match(String(r.json?.error), /Invalid overrides/);
    });
  }
  {
    const r = await call('POST', '/llamacpp/start', { user: USER_A, body: { model: 'Absent-Model' } });
    ok('start unknown model -> 400 "was not found" (own per-user scan)', () => {
      assert.equal(r.status, 400);
      assert.match(String(r.json?.error), /was not found/);
    });
  }

  // ---------------------------------------------------------------------
  // Section 5: stop FROZEN envelope (nothing running = success)
  // ---------------------------------------------------------------------
  {
    const r = await call('POST', '/llamacpp/stop', { user: USER_A, body: {} });
    ok('stop with nothing running -> 200 {ok:true,status:"not-running"}', () => {
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { ok: true, status: 'not-running' });
    });
  }

  // ---------------------------------------------------------------------
  // Section 6: config validation + persistence round-trip
  // ---------------------------------------------------------------------
  {
    const r = await call('POST', '/llamacpp/config', { user: USER_A, body: {} });
    ok('config with no section -> 400 (all five sections named)', () => {
      assert.equal(r.status, 400);
      assert.match(String(r.json?.error), /defaults.*overrides.*presets.*activePreset.*sampling/s);
    });
  }
  {
    const r = await call('POST', '/llamacpp/config', { user: USER_A, body: { defaults: { ctx: 'huge' } } });
    ok('config rejects bad knob VALUE with key-level detail -> 400', () => {
      assert.equal(r.status, 400);
      assert.match(String(r.json?.error), /defaults\.ctx/);
    });
  }
  {
    const r = await call('POST', '/llamacpp/config', { user: USER_A, body: { overrides: { Bad: { nope: 1 } } } });
    ok('config rejects unknown override KEY with key-level detail -> 400', () => {
      assert.equal(r.status, 400);
      assert.match(String(r.json?.error), /Bad/);
    });
  }
  {
    const r = await call('POST', '/llamacpp/config', {
      user: USER_A,
      body: { defaults: { ctx: 16384 }, overrides: { 'Qwen3-Test': { mtp: 0 } } },
    });
    ok('valid config save -> 200 {ok:true}', () => {
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { ok: true });
    });
  }
  {
    const r = await call('GET', '/llamacpp/config', { user: USER_A });
    ok('config read-back shows persisted layer over canonical defaults', () => {
      assert.equal(r.status, 200);
      assert.equal(r.json?.ok, true);
      assert.equal(r.json.port, 8712); // scalar default (env unset)
      assert.equal(r.json.exePath, null);
      assert.equal(r.json.modelsDir, 'C:\\models'); // from the harness env fallback
      assert.equal(r.json.idleUnloadMinutes, 45);
      assert.equal(r.json.defaults.ctx, 16384);
      assert.equal(r.json.defaults.threads, 8); // untouched canonical value survives
      assert.deepEqual(r.json.overrides, { 'Qwen3-Test': { mtp: 0 } });
    });
  }

  // ---------------------------------------------------------------------
  // Section 6b: Increment 2 config sections — presets/activePreset/sampling
  // ---------------------------------------------------------------------
  {
    const r = await call('POST', '/llamacpp/config', {
      user: USER_A,
      body: { presets: { rapido: { reasoning_budget: -1 } }, activePreset: 'profundo' },
    });
    ok('config persists presets (CANONICAL ⊕ provided) + activePreset -> 200', () => {
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { ok: true });
    });

    const read = await call('GET', '/llamacpp/config', { user: USER_A });
    ok('config GET returns presets/activePreset/sampling with canonical fill', () => {
      assert.equal(read.status, 200);
      assert.deepEqual(
        read.json.presets,
        {
          rapido: { reasoning_budget: -1, mtp: 2 }, // provided ⊕ canonical slot values
          equilibrado: { reasoning_budget: 2048, mtp: 0 },
          profundo: { reasoning_budget: 4096, mtp: 0 },
        },
      );
      assert.equal(read.json.activePreset, 'profundo');
      assert.deepEqual(
        read.json.sampling,
        { temp: 0.6, top_p: 0.95, top_k: 20, min_p: 0, repeat_penalty: 1 },
      );
    });
  }
  {
    const r = await call('POST', '/llamacpp/config', {
      user: USER_A,
      body: { sampling: { temp: 0.7, top_p: 0.9, top_k: 40, min_p: 0.05, repeat_penalty: 1.1 } },
    });
    ok('config persists the sampling row verbatim and GET reflects it', () => {
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { ok: true });
    });

    const read = await call('GET', '/llamacpp/config', { user: USER_A });
    assert.deepEqual(
      read.json.sampling,
      { temp: 0.7, top_p: 0.9, top_k: 40, min_p: 0.05, repeat_penalty: 1.1 },
      'sampling row round-trips verbatim',
    );
    ok('sampling row survives a re-read (persisted, not derived)', () => {
      assert.deepEqual(
        read.json.sampling,
        { temp: 0.7, top_p: 0.9, top_k: 40, min_p: 0.05, repeat_penalty: 1.1 },
      );
    });
  }
  for (const [name, body, pattern] of [
    // Unknown knob keys surface inside the message on zod v4 strict objects:
    // "presets.rapido.(root): Unrecognized key: \"bogus\"".
    ['unknown knob key inside a preset', { presets: { rapido: { bogus: 1 }, equilibrado: {}, profundo: {} } }, /presets\.rapido[^\n]*bogus/],
    ['out-of-bounds preset knob', { presets: { rapido: { mtp: 9 }, equilibrado: {}, profundo: {} } }, /presets\.rapido\.mtp/],
    ['unknown preset id', { presets: { rapido: {}, equilibrado: {}, profundo: {}, veloz: {} } }, /presets\.veloz/],
    ['out-of-bounds sampling knob', { sampling: { temp: 5 } }, /sampling\.temp/],
    ['wire-name leak into sampling row', { sampling: { temperature: 0.6 } }, /sampling\.temperature|sampling\./],
  ] as Array<[string, unknown, RegExp]>) {
    const r = await call('POST', '/llamacpp/config', { user: USER_A, body });
    ok(`config rejects ${name} -> 400 with key-level detail`, () => {
      assert.equal(r.status, 400);
      assert.match(String(r.json?.error), pattern);
    });
  }
  {
    const r = await call('POST', '/llamacpp/config', { user: USER_A, body: { activePreset: 'veloz' } });
    ok('config rejects an unknown activePreset id -> 400 naming activePreset', () => {
      assert.equal(r.status, 400);
      assert.match(String(r.json?.error), /activePreset/);
    });
    const r2 = await call('POST', '/llamacpp/config', { user: USER_A, body: { activePreset: 7 } });
    ok('config rejects a non-string activePreset -> 400 naming activePreset', () => {
      assert.equal(r2.status, 400);
      assert.match(String(r2.json?.error), /activePreset/);
    });
    const read = await call('GET', '/llamacpp/config', { user: USER_A });
    ok('rejected writes left the stored pointer untouched (still profundo)', () => {
      assert.equal(read.json.activePreset, 'profundo');
    });
  }

  // ---------------------------------------------------------------------
  // Section 6b-2d (§10 Increment 2d): modelSampling section — GET returns
  // the resolved map; POST persists verbatim after key-level validation.
  // ---------------------------------------------------------------------
  {
    const r = await call('POST', '/llamacpp/config', {
      user: USER_A,
      body: { modelSampling: { 'Qwen3-Test': { temp: 1.0, presence_penalty: 1.5 }, Other: { top_k: 80 } } },
    });
    ok('config persists the modelSampling row verbatim -> 200 {ok:true}', () => {
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { ok: true });
    });

    const read = await call('GET', '/llamacpp/config', { user: USER_A });
    ok('config GET returns the resolved modelSampling map alongside sampling', () => {
      assert.equal(read.status, 200);
      assert.deepEqual(
        read.json.modelSampling,
        { 'Qwen3-Test': { temp: 1.0, presence_penalty: 1.5 }, Other: { top_k: 80 } },
      );
    });
    ok('config GET payload carries exactly the §5 amended field set (exhaustive keys)', () => {
      assert.deepEqual(
        Object.keys(read.json).sort(),
        [
          'activePreset',
          'defaults',
          'exePath',
          'idleUnloadMinutes',
          'modelSampling',
          'modelsDir',
          'ok',
          'overrides',
          'port',
          'presets',
          'sampling',
        ].sort(),
      );
    });
  }
  {
    // modelSampling ALONE satisfies the at-least-one-section rule; like every
    // config section it REPLACES its whole settings row.
    const r = await call('POST', '/llamacpp/config', {
      user: USER_A,
      body: { modelSampling: { Solo: { presence_penalty: -1.5 } } },
    });
    ok('modelSampling-only POST counts as a provided section -> 200', () => {
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { ok: true });
    });
    const read = await call('GET', '/llamacpp/config', { user: USER_A });
    ok('a modelSampling POST replaces the WHOLE row; partial entries persist as-stored', () => {
      assert.deepEqual(read.json.modelSampling, { Solo: { presence_penalty: -1.5 } });
    });
  }
  for (const [name, body, pattern] of [
    ['out-of-bounds value inside a model-sampling entry', { modelSampling: { Bad: { temp: 99 } } }, /modelSampling\.Bad\.temp/],
    ['presence_penalty outside −2..2', { modelSampling: { Bad: { presence_penalty: 2.01 } } }, /modelSampling\.Bad\.presence_penalty/],
    ['unknown key inside a model-sampling entry', { modelSampling: { Bad: { nope: 1 } } }, /modelSampling\.Bad[^\n]*nope/],
    ['non-object modelSampling section', { modelSampling: 42 }, /modelSampling/],
  ] as Array<[string, unknown, RegExp]>) {
    const r = await call('POST', '/llamacpp/config', { user: USER_A, body });
    ok(`config rejects ${name} -> 400 with key-level detail`, () => {
      assert.equal(r.status, 400);
      assert.match(String(r.json?.error), pattern);
    });
  }
  {
    const read = await call('GET', '/llamacpp/config', { user: USER_A });
    ok('rejected modelSampling writes left the stored row untouched (validate-before-persist)', () => {
      assert.deepEqual(read.json.modelSampling, { Solo: { presence_penalty: -1.5 } });
    });
  }

  // ---------------------------------------------------------------------
  // Section 6c: status payload carries computed pendingRestart
  // ---------------------------------------------------------------------
  {
    responderOpts = { runningPid: null };
    const r = await call('GET', '/llamacpp/status', { user: USER_A });
    ok('status (not running) exposes pendingRestart:false after mtpActive', () => {
      assert.equal(r.status, 200);
      assert.equal(r.json?.running, false);
      assert.equal(typeof r.json?.pendingRestart, 'boolean');
      assert.equal(r.json.pendingRestart, false);
      // §5 amendment field order contract: pendingRestart appended AFTER mtpActive.
      const keys = Object.keys(r.json);
      assert.ok(keys.indexOf('pendingRestart') > keys.indexOf('mtpActive'), 'pendingRestart comes after mtpActive');
    });
  }
  {
    // Running child reporting argv that EXACTLY matches what the persisted
    // settings would spawn now ⇒ pendingRestart false; then a persisted knob
    // edit flips it to true without any agent interaction.
    const config = resolveLlamacppConfig(USER_A);
    const knobs = mergeKnobLayers(
      config.knobs,
      config.presets[config.activePreset],
      config.overrides['Qwen3-Test'],
    );
    const runningArgs = buildLlamaServerArgv({
      modelPath: 'C:\\models\\Qwen3-Test.gguf',
      modelKey: 'Qwen3-Test',
      port: 8712,
      knobs,
      mtpCapable: false,
    }).args;
    let overrideStatus: Record<string, unknown> | null = { running: true, pid: 900, args: runningArgs, port: 8712 };
    connection!.responder = (request) => {
      if (overrideStatus && request.type === 'llamacpp_status_request') {
        return { type: 'llamacpp_status_response' as const, requestId: request.requestId, lastExitCode: null, ...overrideStatus };
      }
      return makeResponder(responderOpts)(request);
    };
    const r1 = await call('GET', '/llamacpp/status', { user: USER_A });
    ok('status (running, no drift) computes pendingRestart:false from persisted rows', () => {
      assert.equal(r1.status, 200);
      assert.equal(r1.json.running, true);
      assert.deepEqual(r1.json.argv, runningArgs);
      assert.equal(r1.json.pendingRestart, false);
    });

    const originalRow = db
      .prepare('SELECT value FROM settings WHERE user_id = ? AND key = ?')
      .get(USER_A, 'llamacpp_load_defaults') as { value: string } | undefined;
    const originalDefaults = originalRow?.value ?? null;
    insertSettingRow(USER_A, 'llamacpp_load_defaults', JSON.stringify({ threads: 6 }));
    const r2 = await call('GET', '/llamacpp/status', { user: USER_A });
    ok('status flips pendingRestart:true after a persisted knob edit while running', () => {
      assert.equal(r2.json.pendingRestart, true);
    });
    // Restore EXACTLY the pre-edit persisted stack.
    if (originalDefaults === null) {
      db.prepare('DELETE FROM settings WHERE user_id = ? AND key = ?').run(USER_A, 'llamacpp_load_defaults');
    } else {
      updateSettingRow(USER_A, 'llamacpp_load_defaults', originalDefaults);
    }
    const r3 = await call('GET', '/llamacpp/status', { user: USER_A });
    ok('status returns to pendingRestart:false once settings match the child again', () => {
      assert.equal(r3.json.pendingRestart, false);
    });
    overrideStatus = null;
  }

  // ---------------------------------------------------------------------
  // Section 7: logs — bounded, fail-soft, running vs not-running
  // ---------------------------------------------------------------------
  {
    const r = await call('GET', '/llamacpp/logs', { user: USER_A });
    ok('logs while NOT running -> empty success envelope', () => {
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { ok: true, text: '', truncated: false });
    });
  }
  {
    responderOpts = { runningPid: 4321 };
    const r = await call('GET', '/llamacpp/logs', { user: USER_A });
    ok('logs while running -> agent ring-buffer tail', () => {
      assert.equal(r.status, 200);
      assert.equal(r.json?.ok, true);
      assert.equal(r.json?.text, 'srv listening at http://127.0.0.1:8712');
      assert.equal(r.json?.truncated, false);
    });
    const logsFrames = connection!.sent.filter(
      (m): m is Extract<BackendToAgentMessage, { type: 'llamacpp_logs_request' }> => m.type === 'llamacpp_logs_request',
    );
    ok('logs frame carries clamped maxBytes within protocol bounds', () => {
      const last = logsFrames.at(-1);
      assert.ok(last, 'expected a logs frame to be sent');
      assert.ok(last.maxBytes >= 1 && last.maxBytes <= 65_536);
    });

    const before = logsFrames.length;
    await call('GET', '/llamacpp/logs?maxBytes=99999999', { user: USER_A });
    const clamped = (connection!.sent.filter((m) => m.type === 'llamacpp_logs_request') as Array<{ maxBytes?: number }>).at(-1);
    await call('GET', '/llamacpp/logs?maxBytes=potato', { user: USER_A });
    const defaulted = (connection!.sent.filter((m) => m.type === 'llamacpp_logs_request') as Array<{ maxBytes?: number }>).at(-1);
    ok('maxBytes query clamps high values and defaults invalid ones to 8192', () => {
      assert.equal(clamped?.maxBytes, 65_536);
      assert.equal(defaulted?.maxBytes, 8192);
      assert.ok((connection!.sent.filter((m) => m.type === 'llamacpp_logs_request').length) > before);
    });
  }

  // ---------------------------------------------------------------------
  // Section 8: tenant isolation — another user's catalog is separate
  // ---------------------------------------------------------------------
  {
    responderOpts = { files: [] };
    connect(USER_B, (request) => makeResponder(responderOpts)(request));
    const r = await call('GET', '/llamacpp', { user: USER_B });
    ok('per-user isolation: USER_B gets its own empty catalog, not USER_A cache', () => {
      assert.equal(r.status, 200);
      assert.deepEqual(r.json.data, []);
    });
  }

  console.log(`\nllamacpp route tests passed (${checks} checks)`);
} finally {
  server.close();
  try {
    fs.rmSync(testDbPath, { force: true });
  } catch {
    /* best effort */
  }
}
