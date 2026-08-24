/**
 * Task 1 acceptance suite (plans/llamacpp-local-provider/task-1-brief.md):
 * `llamacpp_*` wire frames, capability negotiation, the generic registry
 * sender, the exit-push hook, and the port-parameterized proxy allowlist.
 *
 * Repo convention: plain `tsx` + `node:assert/strict`, no test framework.
 * db-touching idiom: DATABASE_PATH is set BEFORE dynamically importing
 * server/db.js (same as scripts/test-agent-relay.ts).
 *
 * Sections:
 *   (1)  zod round-trip of all 12 new frames — valid shapes parse; unknown
 *        extra keys are rejected by `.strict()`; pinned ranges/enums enforced.
 *   (2)  capability negotiation — `getAgentCapabilities` returns the
 *        hello-declared list, per-user, cleaned up on unregister.
 *   (3)  `sendLlamacppRequest` — resolve (payload minus type/requestId),
 *        timeout+cancel frame, disconnect rejection, duplicate-id rejection,
 *        not-connected rejection.
 *   (4)  exit hook — fires on `llamacpp_exited` with the declaring userId,
 *        unsubscribe stops delivery.
 *   (5)  `buildEffectiveAllowlist` — keeps parsed env entries, appends the
 *        three loopback forms of the extra port, defaults preserved, and the
 *        produced list actually gates `isRelayUrlAllowed`.
 *   (6)  scripted spawn→status→stop→exited sequence over FakeConnection with
 *        every backend-sent frame re-validated against the zod union.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testDbPath = path.join(os.tmpdir(), `llamacpp-relay-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = testDbPath;

const { default: db, migrate } = await import('../server/db.js');
const { AgentToBackendMessageSchema, BackendToAgentMessageSchema } = await import(
  '../server/agentRelay/protocol.js'
);
const {
  getAgentCapabilities,
  registerAgentConnection,
  registerLlamacppExitHook,
  sendLlamacppRequest,
  unregisterAgentConnection,
} = await import('../server/agentRelay/registry.js');
const {
  DEFAULT_PROXY_ALLOWLIST,
  buildEffectiveAllowlist,
  isRelayUrlAllowed,
} = await import('../server/agentRelay/httpProxyAllowlist.js');

type AgentToBackendMessage = import('../server/agentRelay/protocol.js').AgentToBackendMessage;
type BackendToAgentMessage = import('../server/agentRelay/protocol.js').BackendToAgentMessage;
type AgentConnection = import('../server/agentRelay/registry.js').AgentConnection;

class FakeConnection implements AgentConnection {
  readonly sent: BackendToAgentMessage[] = [];
  private callbacks: Array<(message: AgentToBackendMessage) => void> = [];
  private connected = true;

  isConnected() {
    return this.connected;
  }
  send(message: BackendToAgentMessage) {
    this.sent.push(message);
  }
  onMessage(callback: (message: AgentToBackendMessage) => void) {
    this.callbacks.push(callback);
  }
  close() {
    if (!this.connected) return;
    this.connected = false;
    this.onClosed?.();
  }
  receive(message: AgentToBackendMessage) {
    for (const callback of this.callbacks) callback(message);
  }
  private onClosed: (() => void) | undefined;
  declareOnClosed(cb: () => void) {
    this.onClosed = cb;
  }
}

function connect(userId: string, connection = new FakeConnection()) {
  connection.declareOnClosed(() => unregisterAgentConnection(userId, connection));
  registerAgentConnection(userId, connection);
  return connection;
}

async function main() {
  migrate();

  // (1) Every new frame parses; `.strict()` rejects unknown keys; pinned
  //     ranges and enums hold (global-constraints.md §2 verbatim).
  {
    const validBackendToAgent: BackendToAgentMessage[] = [
      { type: 'llamacpp_scan_request', requestId: 'r1', dir: 'D:\\models' },
      {
        type: 'llamacpp_spawn',
        requestId: 'r2',
        exePath: 'D:\\llama\\llama-server.exe',
        host: '127.0.0.1',
        port: 8712,
        args: ['--host', '127.0.0.1', '--port', '8712', '--model', 'm.gguf'],
      },
      { type: 'llamacpp_stop', requestId: 'r3', pid: 4242, graceMs: 3000 },
      { type: 'llamacpp_status_request', requestId: 'r4' },
      { type: 'llamacpp_logs_request', requestId: 'r5', maxBytes: 8192 },
    ];
    const validAgentToBackend: AgentToBackendMessage[] = [
      {
        type: 'llamacpp_scan_response',
        requestId: 'r1',
        ok: true,
        entries: [{ path: 'D:\\models\\a.gguf', name: 'a.gguf', sizeBytes: 5 }],
        truncated: false,
      },
      { type: 'llamacpp_scan_response', requestId: 'r1b', ok: false, error: 'unreadable dir' },
      { type: 'llamacpp_spawn_response', requestId: 'r2', ok: true, pid: 4242 },
      { type: 'llamacpp_spawn_response', requestId: 'r2b', ok: false, error: 'refused' },
      { type: 'llamacpp_stop_response', requestId: 'r3', ok: true, forced: true },
      {
        type: 'llamacpp_status_response',
        requestId: 'r4',
        running: true,
        pid: 4242,
        exePath: 'D:\\llama\\llama-server.exe',
        args: ['--model', 'm.gguf'],
        host: '127.0.0.1',
        port: 8712,
        startedAt: 1234,
        lastExitCode: null,
        lastExitAt: null,
      },
      { type: 'llamacpp_logs_response', requestId: 'r5', ok: true, text: 'log line', truncated: false },
      { type: 'llamacpp_exited', pid: 4242, exitCode: 0, terminatedByAgent: true, stderrTail: 'bye' },
    ];

    const backendToAgentTypes = new Set([
      'llamacpp_scan_request',
      'llamacpp_spawn',
      'llamacpp_stop',
      'llamacpp_status_request',
      'llamacpp_logs_request',
    ]);
    for (const frame of [...validBackendToAgent, ...validAgentToBackend]) {
      const schema = backendToAgentTypes.has(frame.type)
        ? BackendToAgentMessageSchema
        : AgentToBackendMessageSchema;
      const parsed = schema.safeParse(frame);
      assert.equal(parsed.success, true, `frame should parse: ${JSON.stringify(frame)}`);

      const withExtra = { ...frame, unexpectedKey: true } as Record<string, unknown>;
      const strictParsed = schema.safeParse(withExtra);
      assert.equal(strictParsed.success, false, `.strict() should reject unknown key on ${frame.type}`);
    }

    // Pinned ranges/enums (§2 comments).
    const baseSpawn = {
      type: 'llamacpp_spawn',
      requestId: 'rng',
      exePath: '/x/llama-server',
      host: '127.0.0.1',
      port: 8712,
      args: [],
    };
    assert.equal(BackendToAgentMessageSchema.safeParse({ ...baseSpawn, port: 1023 }).success, false, 'port < 1024');
    assert.equal(BackendToAgentMessageSchema.safeParse({ ...baseSpawn, port: 65536 }).success, false, 'port > 65535');
    assert.equal(BackendToAgentMessageSchema.safeParse({ ...baseSpawn, port: 1024 }).success, true, 'port == 1024');
    assert.equal(BackendToAgentMessageSchema.safeParse({ ...baseSpawn, port: 65535 }).success, true, 'port == 65535');
    assert.equal(
      BackendToAgentMessageSchema.safeParse({ ...baseSpawn, host: '0.0.0.0' }).success,
      false,
      'non-loopback host literal rejected'
    );
    assert.equal(
      BackendToAgentMessageSchema.safeParse({ type: 'llamacpp_stop', requestId: 'g', pid: 1, graceMs: -1 }).success,
      false,
      'negative graceMs rejected'
    );
    assert.equal(
      BackendToAgentMessageSchema.safeParse({ type: 'llamacpp_logs_request', requestId: 'l', maxBytes: 0 }).success,
      false,
      'maxBytes 0 rejected'
    );
    assert.equal(
      BackendToAgentMessageSchema.safeParse({ type: 'llamacpp_logs_request', requestId: 'l', maxBytes: 65537 })
        .success,
      false,
      'maxBytes > 65536 rejected'
    );
    // Unsolicited push carries NO requestId.
    assert.equal(
      AgentToBackendMessageSchema.safeParse({ type: 'llamacpp_exited', pid: 4242, exitCode: null }).success,
      true,
      'llamacpp_exited without requestId parses'
    );
    console.log('(1) zod round-trip + .strict() + pinned ranges over 12 new frames: OK');
  }

  // (2) Capability negotiation: hello-declared list exposed per user.
  {
    const conn = connect('cap-user');
    conn.receive({ type: 'hello', agentVersion: '1.2.0', deviceName: 'dev', capabilities: ['llamacpp'] });
    assert.deepEqual(getAgentCapabilities('cap-user'), ['llamacpp']);

    // Tenant isolation: another user has no capabilities.
    assert.equal(getAgentCapabilities('other-user'), undefined);

    // A later hello WITHOUT capabilities clears the declaration.
    conn.receive({ type: 'hello', agentVersion: '1.2.0', deviceName: 'dev' });
    assert.equal(getAgentCapabilities('cap-user'), undefined);

    // Re-declare, then unregister — accessor goes back to undefined.
    conn.receive({ type: 'hello', agentVersion: '1.2.0', deviceName: 'dev', capabilities: ['llamacpp'] });
    assert.deepEqual(getAgentCapabilities('cap-user'), ['llamacpp']);
    unregisterAgentConnection('cap-user', conn);
    assert.equal(getAgentCapabilities('cap-user'), undefined);
    console.log('(2) getAgentCapabilities returns hello-declared list with tenant checks + cleanup: OK');
  }

  // (3) sendLlamacppRequest sender semantics equal to existing senders.
  {
    const user = 'sender-user';
    const conn = connect(user);

    // Resolve arm: payload arrives minus type/requestId.
    const pendingStatus = sendLlamacppRequest<Record<string, unknown>>(
      user,
      { type: 'llamacpp_status_request', requestId: 'w1' },
      5000
    );
    assert.equal(conn.sent.length, 1);
    assert.deepEqual(conn.sent[0], { type: 'llamacpp_status_request', requestId: 'w1' });
    conn.receive({ type: 'llamacpp_status_response', requestId: 'w1', running: false, pid: null, lastExitCode: 2 });
    assert.deepEqual(await pendingStatus, { running: false, pid: null, lastExitCode: 2 });

    // Timeout rejects AND sends the same cancel frame other senders send.
    const pendingTimeout = sendLlamacppRequest(user, { type: 'llamacpp_logs_request', requestId: 'w2', maxBytes: 16 }, 25);
    await assert.rejects(pendingTimeout, (err: { error: string }) => err.error === 'local agent command timed out');
    const cancel = conn.sent.find((m) => m.type === 'command_cancel');
    assert.ok(cancel && cancel.requestId === 'w2', 'timeout must send command_cancel like existing senders');

    // Duplicate requestId rejected while first is in flight.
    const pendingDup = sendLlamacppRequest(user, { type: 'llamacpp_status_request', requestId: 'w3' }, 5000);
    await assert.rejects(
      sendLlamacppRequest(user, { type: 'llamacpp_status_request', requestId: 'w3' }, 5000),
      (err: { error: string }) => err.error === 'duplicate local agent request id'
    );

    // Disconnect rejects every in-flight request for that connection.
    conn.close();
    await assert.rejects(pendingDup, (err: { error: string }) => err.error === 'local agent disconnected mid-command');

    // Unknown user → not-connected rejection.
    await assert.rejects(
      sendLlamacppRequest(user, { type: 'llamacpp_status_request', requestId: 'w4' }, 1000),
      (err: { error: string }) => err.error === 'local agent is not connected'
    );
    console.log('(3) sendLlamacppRequest resolve/timeout-cancel/duplicate/disconnect/not-connected: OK');
  }

  // (4) Exit hook fires on llamacpp_exited; unsubscribe stops delivery.
  {
    const events: Array<{ userId: string; e: AgentToBackendMessage }> = [];
    const unsubscribe = registerLlamacppExitHook((userId, e) => events.push({ userId, e }));
    const conn = connect('hook-user');
    conn.receive({ type: 'llamacpp_exited', pid: 7, exitCode: null, terminatedByAgent: true, stderrTail: 'CUDA error' });
    assert.equal(events.length, 1);
    assert.equal(events[0].userId, 'hook-user');
    assert.deepEqual(events[0].e, {
      type: 'llamacpp_exited',
      pid: 7,
      exitCode: null,
      terminatedByAgent: true,
      stderrTail: 'CUDA error',
    });
    unsubscribe();
    conn.receive({ type: 'llamacpp_exited', pid: 7, exitCode: 0 });
    assert.equal(events.length, 1, 'unsubscribed hook must not fire again');
    conn.close();
    console.log('(4) registerLlamacppExitHook fires on llamacpp_exited + unsubscribe: OK');
  }

  // (5) buildEffectiveAllowlist parameterization (§7).
  {
    const previous = process.env.AGENT_HTTP_PROXY_ALLOW_HOSTS;
    try {
      process.env.AGENT_HTTP_PROXY_ALLOW_HOSTS = 'example.com:80, 127.0.0.1:9999';
      const effective = buildEffectiveAllowlist(8712);
      for (const entry of ['example.com:80', '127.0.0.1:9999']) {
        assert.ok(effective.includes(entry), `env entry ${entry} kept`);
      }
      for (const entry of ['127.0.0.1:8712', 'localhost:8712', '[::1]:8712']) {
        assert.ok(effective.includes(entry), `loopback form ${entry} added`);
      }
      assert.ok(isRelayUrlAllowed('http://127.0.0.1:8712/health', effective).allowed);
      assert.ok(isRelayUrlAllowed('http://localhost:8712/v1/models', effective).allowed);
      assert.ok(isRelayUrlAllowed('http://[::1]:8712/health', effective).allowed);
      assert.equal(isRelayUrlAllowed('http://127.0.0.1:8711/health', effective).allowed, false);

      // No env → existing default fallback preserved; port-less call adds nothing.
      delete process.env.AGENT_HTTP_PROXY_ALLOW_HOSTS;
      assert.deepEqual(buildEffectiveAllowlist(), DEFAULT_PROXY_ALLOWLIST);
    } finally {
      if (previous === undefined) delete process.env.AGENT_HTTP_PROXY_ALLOW_HOSTS;
      else process.env.AGENT_HTTP_PROXY_ALLOW_HOSTS = previous;
    }
    console.log('(5) buildEffectiveAllowlist keeps env entries + adds three loopback:port forms: OK');
  }

  // (6) Scripted spawn→status→stop→exited sequence over FakeConnection.
  {
    const events: AgentToBackendMessage[] = [];
    registerLlamacppExitHook((_userId, e) => events.push(e));
    const user = 'seq-user';
    const conn = connect(user);

    const spawnReq: BackendToAgentMessage = {
      type: 'llamacpp_spawn',
      requestId: 'seq-1',
      exePath: 'C:\\llama\\llama-server.exe',
      host: '127.0.0.1',
      port: 8712,
      args: ['--host', '127.0.0.1', '--port', '8712'],
    };
    const spawnPending = sendLlamacppRequest<Record<string, unknown>>(user, spawnReq, 2000);
    const sentSpawn = conn.sent.find((m) => m.type === 'llamacpp_spawn');
    assert.ok(sentSpawn, 'spawn frame forwarded over the connection');
    assert.deepEqual(sentSpawn, spawnReq);
    BackendToAgentMessageSchema.parse(sentSpawn); // wire-valid output
    conn.receive({ type: 'llamacpp_spawn_response', requestId: 'seq-1', ok: true, pid: 99 });
    assert.deepEqual(await spawnPending, { ok: true, pid: 99 });

    const statusPending = sendLlamacppRequest<Record<string, unknown>>(
      user,
      { type: 'llamacpp_status_request', requestId: 'seq-2' },
      2000
    );
    conn.receive({ type: 'llamacpp_status_response', requestId: 'seq-2', running: true, pid: 99, port: 8712 });
    assert.deepEqual(await statusPending, { running: true, pid: 99, port: 8712 });

    const stopPending = sendLlamacppRequest<Record<string, unknown>>(
      user,
      { type: 'llamacpp_stop', requestId: 'seq-3', pid: 99, graceMs: 500 },
      2000
    );
    conn.receive({ type: 'llamacpp_stop_response', requestId: 'seq-3', ok: true, forced: true });
    assert.deepEqual(await stopPending, { ok: true, forced: true });

    conn.receive({ type: 'llamacpp_exited', pid: 99, exitCode: 0, terminatedByAgent: true, stderrTail: 'done' });
    const exited = events.find((e) => e.type === 'llamacpp_exited');
    assert.ok(exited && exited.pid === 99 && exited.terminatedByAgent === true);

    conn.close();
    console.log('(6) scripted spawn/status/stop/exited sequence over FakeConnection: OK');
  }

  db.close();
  fs.rmSync(testDbPath, { force: true });
  console.log('\nAll test-llamacpp-relay sections passed.');
}

main().catch((error) => {
  console.error('test-llamacpp-relay FAILED:', error);
  process.exit(1);
});
