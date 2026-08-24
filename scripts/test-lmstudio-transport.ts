import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Offline harness: temp DATABASE_PATH must be set BEFORE importing server/db.js.
const testDbPath = path.join(os.tmpdir(), `lmstudio-transport-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = testDbPath;

const { default: db, migrate } = await import('../server/db.js');
const { registerAgentConnection, unregisterAgentConnection } = await import(
  '../server/agentRelay/registry.js'
);
const {
  buildComplianceReport,
  ensureModelLoaded,
  getLmStudioSettings,
  getModelCapabilities,
  lmstudioFetch,
  probeLmStudio,
} = await import('../server/providers/lmstudioTransport.js');
type AgentToBackendMessage = import('../server/agentRelay/protocol.js').AgentToBackendMessage;
type BackendToAgentMessage = import('../server/agentRelay/protocol.js').BackendToAgentMessage;
type AgentConnection = import('../server/agentRelay/registry.js').AgentConnection;

// ---------------------------------------------------------------------------
// Environment hygiene: snapshot everything this suite touches, restore at end.
// ---------------------------------------------------------------------------
const TOUCHED_ENV_KEYS = [
  'LMSTUDIO_BASE_URL',
  'LMSTUDIO_API_TOKEN',
  'LMSTUDIO_LOAD_TIMEOUT_MS',
  'AGENT_HTTP_PROXY_ALLOW_HOSTS',
] as const;
const savedEnv = new Map<string, string | undefined>(
  TOUCHED_ENV_KEYS.map((key) => [key, process.env[key]]),
);
function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

// Base URL whose port is guaranteed closed on loopback so the DIRECT probe
// refuses instantly and scenarios exercise the RELAY transport deterministically.
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
// Scripted local-agent connection: every http_proxy_request is answered by the
// current responder via queueMicrotask (registered pendings exist by then).
// ---------------------------------------------------------------------------
type ProxyRequestFrame = Extract<BackendToAgentMessage, { type: 'http_proxy_request' }>;
type Responder = (request: ProxyRequestFrame) => void;

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

async function waitFor(condition: () => boolean, timeoutMs = 1000, stepMs = 5): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

try {
  migrate();

  // F3-01 guard: COUNT unhandled rejections instead of letting Node crash, so a
  // dangling-promise regression anywhere below fails this suite deterministically.
  let unhandledRejections = 0;
  process.on('unhandledRejection', () => {
    unhandledRejections += 1;
  });

  console.log('1. getLmStudioSettings precedence: default < env < setting; bad profile id -> default');
  {
    const userId = 't3-settings-user';
    insertUser(userId);

    let settings = getLmStudioSettings(userId);
    assert.equal(settings.baseUrl, 'http://127.0.0.1:1234');
    assert.equal(settings.token, null);
    assert.equal(settings.profileId, 'equilibrado');

    setEnv('LMSTUDIO_BASE_URL', 'http://10.0.0.5:1234');
    setEnv('LMSTUDIO_API_TOKEN', 'env-token');
    settings = getLmStudioSettings(userId);
    assert.equal(settings.baseUrl, 'http://10.0.0.5:1234');
    assert.equal(settings.token, 'env-token');

    insertSetting(userId, 'lmstudio_base_url', 'http://127.0.0.1:9999');
    insertSetting(userId, 'lmstudio_api_token', 'setting-token');
    insertSetting(userId, 'lmstudio_profile', 'rapido');
    settings = getLmStudioSettings(userId);
    assert.equal(settings.baseUrl, 'http://127.0.0.1:9999');
    assert.equal(settings.token, 'setting-token');
    assert.equal(settings.profileId, 'rapido');

    db.prepare('UPDATE settings SET value = ? WHERE user_id = ? AND key = ?').run(
      'not-a-profile',
      userId,
      'lmstudio_profile',
    );
    assert.equal(getLmStudioSettings(userId).profileId, 'equilibrado');

    // Prototype-key profile ids must fall back to default too (F3-03).
    for (const prototypeKey of ['toString', 'constructor', 'hasOwnProperty']) {
      db.prepare('UPDATE settings SET value = ? WHERE user_id = ? AND key = ?').run(
        prototypeKey,
        userId,
        'lmstudio_profile',
      );
      assert.equal(getLmStudioSettings(userId).profileId, 'equilibrado');
    }

    setEnv('LMSTUDIO_BASE_URL', undefined);
    setEnv('LMSTUDIO_API_TOKEN', undefined);
  }

  console.log('2. relay-path lmstudioFetch streams the exact SSE text with terminal status/content-type');
  {
    const SSE_TEXT = 'data: {"id":"chatcmpl-1"}\n\ndata: {"id":"chatcmpl-1"}\n\ndata: [DONE]\n\n';
    const userId = 't3-fetch-user';
    insertUser(userId);
    insertSetting(userId, 'lmstudio_base_url', RELAY_BASE_URL);
    setEnv('AGENT_HTTP_PROXY_ALLOW_HOSTS', '127.0.0.1:9');
    const connection = connect(userId, (request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/v1/chat/completions') {
        replyText(connection, request.requestId, 200, SSE_TEXT, 'text/event-stream');
      } else if (pathname === '/api/v1/models') {
        replyText(connection, request.requestId, 200, JSON.stringify({ models: [] }));
      } else if (pathname === '/api/v0/models') {
        replyText(connection, request.requestId, 200, '{"data":[]}');
      }
    });

    const responsePromise = lmstudioFetch(userId, '/v1/chat/completions', {
      method: 'POST',
      body: '{"model":"qwen/qwen3-30b","stream":true}',
    });
    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.equal(response.ok, true);
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    assert.equal(await response.text(), SSE_TEXT);

    const frame = proxyRequests(connection).at(-1);
    assert.ok(frame, 'an http_proxy_request frame must have been sent');
    assert.equal(frame.url, `${RELAY_BASE_URL}/v1/chat/completions`);
    assert.equal(frame.method, 'POST');
    assert.equal(frame.body, '{"model":"qwen/qwen3-30b","stream":true}');
    assert.ok(frame.requestId.length >= 8, 'request id must be generated');
    assert.ok(frame.timeoutMs > 0, 'relay request carries a finite registry timeout');

    // Probe caching: repeated calls ride the ~10s cache; force re-probes once.
    const sentBefore = connection.sent.length;
    await probeLmStudio(userId);
    await probeLmStudio(userId);
    assert.equal(connection.sent.length, sentBefore, 'cached probe must not hit the wire');
    await probeLmStudio(userId, { force: true });
    assert.equal(connection.sent.length, sentBefore + 1, 'forced probe sends exactly one relay request');

    connection.close();
  }

  console.log('3. abort propagation: cancel frame emitted and pending promise rejects promptly');
  {
    const userId = 't3-abort-user';
    insertUser(userId);
    insertSetting(userId, 'lmstudio_base_url', RELAY_BASE_URL);
    setEnv('AGENT_HTTP_PROXY_ALLOW_HOSTS', '127.0.0.1:9');
    // Answer probes so transport selection settles on relay; stay silent for the
    // chat completion itself so it stays pending until we abort.
    const connection = connect(userId, (request) => {
      if (new URL(request.url).pathname === '/api/v1/models') {
        replyText(connection, request.requestId, 200, '{"models":[]}');
      }
    });
    const controller = new AbortController();

    const pending = lmstudioFetch(userId, '/v1/chat/completions', {
      method: 'POST',
      body: '{}',
      signal: controller.signal,
    });
    const chatRequest = () =>
      proxyRequests(connection).find((frame) => new URL(frame.url).pathname === '/v1/chat/completions');
    await waitFor(() => chatRequest() !== undefined);
    controller.abort();

    await assert.rejects(pending, (error: unknown) =>
      error instanceof Error && error.name === 'AbortError',
    );
    await waitFor(() => connection.sent.some((m) => m.type === 'http_proxy_cancel'));
    assert.ok(connection.sent.some((m) => m.type === 'http_proxy_cancel'));

    // Realistic agent epilogue: cancelled fetch answers with the terminal frame
    // so the registry pending (and its timer) is fully drained.
    connection.receive({
      type: 'http_proxy_response',
      requestId: chatRequest()!.requestId,
      ok: false,
      status: 0,
      error: 'cancelled',
    });
    connection.close();
  }

  console.log('4. disconnect mid-stream: prompt failure (no hang), registry rejection surfaces');
  {
    const userId = 't3-disconnect-user';
    insertUser(userId);
    insertSetting(userId, 'lmstudio_base_url', RELAY_BASE_URL);
    setEnv('AGENT_HTTP_PROXY_ALLOW_HOSTS', '127.0.0.1:9');
    const connection = connect(userId, (request) => {
      if (new URL(request.url).pathname === '/api/v1/models') {
        replyText(connection, request.requestId, 200, '{"models":[]}');
      }
    });

    const pending = lmstudioFetch(userId, '/v1/chat/completions', { method: 'POST', body: '{}' });
    await waitFor(() =>
      proxyRequests(connection).some((frame) => new URL(frame.url).pathname === '/v1/chat/completions'),
    );
    const requestId = proxyRequests(connection).find(
      (frame) => new URL(frame.url).pathname === '/v1/chat/completions',
    )!.requestId;
    connection.receive({ type: 'http_proxy_chunk', requestId, seq: 0, text: 'data: partial\n\n' });
    connection.close(); // registry mass-rejects the pending

    const outcome = await Promise.race([
      pending.then(
        () => ({ settled: 'resolved' as const }),
        (error) => ({ settled: 'rejected' as const, message: String((error as Error)?.message ?? error) }),
      ),
      new Promise<{ hung: true }>((resolve) => setTimeout(() => resolve({ hung: true }), 750)),
    ]);
    assert.ok(!('hung' in outcome), 'disconnect must not hang the consumer');
    assert.equal(outcome.settled, 'rejected');
    assert.match(outcome.message, /disconnected mid-command/);
  }

  console.log('5. allowlist block: disallowed baseUrl is refused BEFORE any relay send');
  {
    const userId = 't3-blocked-user';
    insertUser(userId);
    insertSetting(userId, 'lmstudio_base_url', 'http://192.168.1.10:1234');
    setEnv('AGENT_HTTP_PROXY_ALLOW_HOSTS', undefined); // default allowlist (1234 only)
    let responderHits = 0;
    const connection = connect(userId, () => {
      responderHits += 1;
    });

    const probe = await probeLmStudio(userId, { force: true });
    assert.equal(probe.reachable, false);
    assert.equal(probe.transport, null);
    assert.equal(probe.agentConnected, true);
    assert.ok(typeof probe.blockedReason === 'string' && probe.blockedReason.length > 0);

    const response = await lmstudioFetch(userId, '/v1/models');
    assert.equal(response.ok, false);
    assert.equal(response.status, 502);
    const body = (await response.json()) as { error?: string; reason?: string };
    assert.ok(body.error);
    assert.ok(body.reason);

    assert.equal(proxyRequests(connection).length, 0, 'no relay frame may be sent for blocked URLs');
    assert.equal(responderHits, 0);
    connection.close();
  }

  console.log('6. ensureModelLoaded decisions over scripted relay catalog/load responses');
  {
    setEnv('AGENT_HTTP_PROXY_ALLOW_HOSTS', '127.0.0.1:9');

    // (a) openai-only surface -> unsupported
    {
      const userId = 't3-load-unsupported';
      insertUser(userId);
      insertSetting(userId, 'lmstudio_base_url', RELAY_BASE_URL);
      const connection = connect(userId, (request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === '/api/v1/models') {
          replyText(connection, request.requestId, 404, 'not found');
        } else if (pathname === '/api/v0/models') {
          replyText(connection, request.requestId, 200, '{"data":[]}');
        }
      });
      const result = await ensureModelLoaded(userId, 'qwen/qwen3-30b');
      assert.equal(result.loaded, false);
      assert.equal(result.mode, 'unsupported');
      connection.close();
    }

    const CATALOG_MODELS = [
      {
        key: 'qwen/qwen3-30b', // native v1 identity field (FF-01: not `id`)
        display_name: 'Qwen3 30B',
        max_context_length: 65536,
        quantization: { name: 'Q4_K_M' },
        capabilities: { trained_for_tool_use: true },
        loaded_instances: [{ id: 'inst-1', config: { context_length: 65536, flash_attention: true } }],
      },
      { key: 'qwen/qwen3-32b', display_name: 'Qwen3 32B', loaded_instances: [] },
    ];

    // (b) already loaded
    {
      const userId = 't3-load-already';
      insertUser(userId);
      insertSetting(userId, 'lmstudio_base_url', RELAY_BASE_URL);
      const connection = connect(userId, catalogResponderFor(() => connection, { v1Models: CATALOG_MODELS }));
      const result = await ensureModelLoaded(userId, 'qwen/qwen3-30b');
      assert.equal(result.loaded, true);
      assert.equal(result.mode, 'already');
      connection.close();
    }

    // (c) loads with EXACTLY the §3 REST fields of the ACTIVE profile (rapido), no ttl
    {
      const userId = 't3-load-loads';
      insertUser(userId);
      insertSetting(userId, 'lmstudio_base_url', RELAY_BASE_URL);
      insertSetting(userId, 'lmstudio_profile', 'rapido');
      let capturedBody: string | null | undefined;
      const connection = connect(
        userId,
        catalogResponderFor(() => connection, {
          v1Models: CATALOG_MODELS,
          onLoad(body) {
            capturedBody = body;
            return { status: 200, text: JSON.stringify({ instance_id: 'qwen/qwen3-32b', status: 'loaded' }) };
          },
        }),
      );
      const result = await ensureModelLoaded(userId, 'qwen/qwen3-32b');
      assert.equal(result.loaded, true);
      assert.equal(result.mode, 'loaded');

      assert.ok(typeof capturedBody === 'string', 'load endpoint must have been called');
      const parsed = JSON.parse(capturedBody as string) as Record<string, unknown>;
      assert.deepEqual(Object.keys(parsed).sort(), [
        'context_length',
        'echo_load_config',
        'eval_batch_size',
        'flash_attention',
        'model',
        'offload_kv_cache_to_gpu',
      ], 'load body must contain exactly the §3 REST fields');
      assert.deepEqual(parsed, {
        model: 'qwen/qwen3-32b',
        context_length: 32768, // rapido — the ACTIVE profile
        flash_attention: true,
        offload_kv_cache_to_gpu: false,
        eval_batch_size: 512,
        echo_load_config: true,
      });
      connection.close();
    }

    // (d) load failure -> mode 'failed', never throws
    {
      const userId = 't3-load-failed';
      insertUser(userId);
      insertSetting(userId, 'lmstudio_base_url', RELAY_BASE_URL);
      const connection = connect(
        userId,
        catalogResponderFor(() => connection, {
          v1Models: CATALOG_MODELS,
          onLoad() {
            return { status: 500, text: 'boom: out of memory' };
          },
        }),
      );
      const result = await ensureModelLoaded(userId, 'qwen/qwen3-32b');
      assert.equal(result.loaded, false);
      assert.equal(result.mode, 'failed');
      assert.ok(typeof result.error === 'string' && result.error.length > 0);
      connection.close();
    }

    // (e) key absent from the native catalog -> jit-fallback
    {
      const userId = 't3-load-jit';
      insertUser(userId);
      insertSetting(userId, 'lmstudio_base_url', RELAY_BASE_URL);
      const connection = connect(
        userId,
        catalogResponderFor(() => connection, {
          v1Models: [{ key: 'other/model' }], // documented shape; absent loaded_instances => unloaded
        }),
      );
      const result = await ensureModelLoaded(userId, 'qwen/qwen3-30b');
      assert.equal(result.loaded, false);
      assert.equal(result.mode, 'jit-fallback');
      connection.close();
    }
  }

  console.log('7. getModelCapabilities + buildComplianceReport delegate to the task-1 mappers');
  {
    setEnv('AGENT_HTTP_PROXY_ALLOW_HOSTS', '127.0.0.1:9');
    const userId = 't3-caps-user';
    insertUser(userId);
    insertSetting(userId, 'lmstudio_base_url', RELAY_BASE_URL);
    const connection = connect(
      userId,
      catalogResponderFor(() => connection, {
        v1Models: [
          {
            key: 'qwen/qwen3-30b',
            display_name: 'Qwen3 30B',
            max_context_length: 65536,
            quantization: { name: 'Q4_K_M', bits_per_weight: 4.56, size_bytes: 18688131232, params_string: '30.5B' },
            format: 'gguf',
            capabilities: { vision: false, trained_for_tool_use: true, reasoning: { allowed_options: ['off'], default: 'off' } },
            loaded_instances: [{ id: 'inst-9', config: { context_length: 4096, flash_attention: true } }],
          },
        ],
      }),
    );

    const caps = await getModelCapabilities(userId, 'qwen/qwen3-30b');
    assert.deepEqual(caps, { trainedForToolUse: true, maxContextLength: 65536 });
    const miss = await getModelCapabilities(userId, 'absent/model');
    assert.deepEqual(miss, { trainedForToolUse: null, maxContextLength: null });

    const report = await buildComplianceReport(userId, 'qwen/qwen3-30b');
    assert.equal(report.ok, true);
    assert.deepEqual(report.profile, { id: 'equilibrado', label: 'EQUILIBRADO' });
    assert.equal(report.apiSurface, 'native-v1');
    assert.equal(report.knobs.length, 10); // 4 REST + 6 advisory
    const contextKnob = report.knobs.find((k) => k.key === 'context_length');
    assert.ok(contextKnob);
    assert.equal(contextKnob.met, false); // live 4096 vs equilibrado 65536
    assert.equal(contextKnob.actual, '4096');
    const flashKnob = report.knobs.find((k) => k.key === 'flash_attention');
    assert.ok(flashKnob && flashKnob.met === true);
    const guiKnob = report.knobs.find((k) => k.key === 'gpu_offload');
    assert.ok(guiKnob && guiKnob.met === null && guiKnob.how === 'gui' && !!guiKnob.guidance);
    connection.close();

    // Unreachable user: fail-soft report with nothing observable (never throws).
    const offlineUserId = 't3-caps-offline';
    insertUser(offlineUserId);
    const offlineReport = await buildComplianceReport(offlineUserId, 'any/model');
    assert.equal(offlineReport.ok, true);
    assert.equal(offlineReport.apiSurface, null);
    assert.ok(offlineReport.knobs.every((k) => k.met === null));
  }

  console.log('8. mid-exchange disconnect: buffered exchange rejects cleanly (F3-01)');
  {
    const userId = 't3-midx-user';
    insertUser(userId);
    insertSetting(userId, 'lmstudio_base_url', RELAY_BASE_URL);
    setEnv('AGENT_HTTP_PROXY_ALLOW_HOSTS', '127.0.0.1:9');
    let probeAnswered = false;
    const connection = connect(userId, (request) => {
      if (new URL(request.url).pathname === '/api/v1/models') {
        if (!probeAnswered) {
          probeAnswered = true; // first hit is the PROBE — answer so transport settles on relay
          replyText(connection, request.requestId, 200, '{"models":[]}');
          return;
        }
        connection.close(); // second hit is the catalog fetch — agent vanishes mid-exchange
      }
    });

    const result = await ensureModelLoaded(userId, 'qwen/model-x');
    assert.equal(result.loaded, false);
    assert.equal(result.mode, 'failed');
    assert.match(result.error ?? '', /disconnected mid-command/);

    const caps = await getModelCapabilities(userId, 'qwen/model-x');
    assert.deepEqual(caps, { trainedForToolUse: null, maxContextLength: null });
    connection.close();
  }

  console.log('9. TOCTOU: allowlist re-checked at send time inside the probe cache window (F3-02)');
  {
    setEnv('AGENT_HTTP_PROXY_ALLOW_HOSTS', '127.0.0.1:9');
    const userId = 't3-toctou-user';
    insertUser(userId);
    insertSetting(userId, 'lmstudio_base_url', RELAY_BASE_URL);
    const connection = connect(userId, (request) => {
      if (new URL(request.url).pathname === '/api/v1/models') {
        replyText(connection, request.requestId, 200, '{"models":[]}');
      }
    });

    // Prime the ~10 s probe cache against the ALLOWED host.
    await probeLmStudio(userId);
    const framesBeforeFlip = proxyRequests(connection).length;

    // Flip the base URL to a NON-allowlisted host WITHOUT forcing a re-probe:
    // the cached verdict still says "relay", but nothing may be sent there.
    db.prepare('UPDATE settings SET value = ? WHERE user_id = ? AND key = ?').run(
      'http://192.168.1.10:1234',
      userId,
      'lmstudio_base_url',
    );

    const response = await lmstudioFetch(userId, '/v1/models');
    assert.equal(response.status, 502);
    assert.ok(((await response.json()) as { reason?: string }).reason);

    // Buffered path has no caller-side gate — only the relayStream choke point.
    const report = await buildComplianceReport(userId, 'qwen/model-x');
    assert.equal(report.ok, true);
    assert.ok(report.knobs.every((knob) => knob.actual === null));

    const framesAfterFlip = proxyRequests(connection).slice(framesBeforeFlip);
    assert.ok(
      framesAfterFlip.every((frame) => !frame.url.includes('192.168.1.10')),
      'no relay frame may target the non-allowlisted host',
    );
    connection.close();
  }

  console.log('10. buildComplianceReport is total under pre-terminal relay failure (F3-04)');
  {
    const userId = 't3-compliance-total-user';
    insertUser(userId);
    insertSetting(userId, 'lmstudio_base_url', RELAY_BASE_URL);
    setEnv('AGENT_HTTP_PROXY_ALLOW_HOSTS', '127.0.0.1:9');
    let probeAnswered = false;
    const connection = connect(userId, (request) => {
      if (new URL(request.url).pathname === '/api/v1/models') {
        if (!probeAnswered) {
          probeAnswered = true;
          replyText(connection, request.requestId, 200, '{"models":[]}');
          return;
        }
        connection.close(); // catalog fetch dies mid-exchange
      }
    });

    const report = await buildComplianceReport(userId, 'qwen/model-x');
    assert.equal(report.ok, true); // never throws
    assert.equal(report.apiSurface, null);
    assert.ok(report.knobs.length > 0 && report.knobs.every((knob) => knob.met === null));
    connection.close();
  }

  assert.equal(unhandledRejections, 0, 'no unhandled promise rejections may escape any section');
  console.log('lmstudio transport tests passed');
} finally {
  for (const [key, value] of savedEnv) setEnv(key, value);
  db.close();
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(`${testDbPath}${suffix}`); } catch { /* already absent */ }
  }
}

// --- helpers that need `connection` closures declared after use ---------------

function catalogResponderFor(
  getConnection: () => ScriptedAgentConnection,
  opts: {
    v1Models?: unknown[];
    v1Status?: number;
    onLoad?: (body: string | null) => { status: number; text: string };
  },
): Responder {
  return (request) => {
    const connection = getConnection();
    const pathname = new URL(request.url).pathname;
    if (pathname === '/api/v1/models') {
      const status = opts.v1Status ?? 200;
      const text =
        status === 200 ? JSON.stringify({ models: opts.v1Models ?? [] }) : 'native api unavailable';
      replyText(connection, request.requestId, status, text);
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
    replyText(connection, request.requestId, 404, `unexpected path ${pathname}`);
  };
}
