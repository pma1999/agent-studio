import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const testDbPath = path.join(os.tmpdir(), `agent-relay-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = testDbPath;

const { default: db, migrate } = await import('../server/db.js');
const {
  cancelCommandRequest,
  registerAgentConnection,
  sendCommandRequest,
  unregisterAgentConnection,
} = await import('../server/agentRelay/registry.js');
const { hashToken, validateAgentToken } = await import('../server/agentRelay/protocol.js');
const { exchangePairingCode, issuePairingCode, mountAgentTransport } = await import('../server/routes/agent.js');
type AgentToBackendMessage = import('../server/agentRelay/protocol.js').AgentToBackendMessage;
type BackendToAgentMessage = import('../server/agentRelay/protocol.js').BackendToAgentMessage;
type AgentConnection = import('../server/agentRelay/registry.js').AgentConnection;

class FakeConnection implements AgentConnection {
  readonly sent: BackendToAgentMessage[] = [];
  private callbacks: Array<(message: AgentToBackendMessage) => void> = [];
  private connected = true;
  onClosed: (() => void) | undefined;

  isConnected() { return this.connected; }
  send(message: BackendToAgentMessage) { this.sent.push(message); }
  onMessage(callback: (message: AgentToBackendMessage) => void) { this.callbacks.push(callback); }
  close() {
    if (!this.connected) return;
    this.connected = false;
    this.onClosed?.();
  }
  receive(message: AgentToBackendMessage) {
    for (const callback of this.callbacks) callback(message);
  }
}

function connect(userId: string, connection = new FakeConnection()) {
  connection.onClosed = () => unregisterAgentConnection(userId, connection);
  registerAgentConnection(userId, connection);
  return connection;
}

async function expectRejectsPromptly(promise: Promise<unknown>) {
  const result = await Promise.race([
    promise.then(() => ({ resolved: true }), (error) => ({ error })),
    new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), 75)),
  ]);
  assert.ok('error' in result, 'request should reject promptly');
  assert.deepEqual(result.error, { error: 'local agent disconnected mid-command' });
}

migrate();

// Matching response resolves and output chunks are streamed.
{
  const connection = connect('user-resolve');
  const chunks: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];
  const request = sendCommandRequest('user-resolve', 'request-resolve', 'echo ok', undefined, 500, (chunk) => chunks.push(chunk));
  connection.receive({ type: 'command_output_chunk', requestId: 'request-resolve', stream: 'stdout', text: 'o', seq: 0 });
  connection.receive({
    type: 'command_response',
    requestId: 'request-resolve',
    exitCode: 0,
    stdout: 'ok',
    stderr: '',
    durationMs: 4,
  });
  assert.deepEqual(await request, { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 4 });
  assert.deepEqual(chunks, [{ stream: 'stdout', text: 'o' }]);
  connection.close();
}

// Disconnect and replacement both use the same immediate mass-rejection path.
{
  const connection = connect('user-disconnect');
  const first = sendCommandRequest('user-disconnect', 'request-disconnect-1', 'sleep', undefined, 5_000, () => {});
  const second = sendCommandRequest('user-disconnect', 'request-disconnect-2', 'sleep', undefined, 5_000, () => {});
  connection.close();
  await Promise.all([expectRejectsPromptly(first), expectRejectsPromptly(second)]);

  const oldConnection = connect('user-replace');
  const pending = sendCommandRequest('user-replace', 'request-replaced', 'sleep', undefined, 5_000, () => {});
  connect('user-replace');
  assert.equal(oldConnection.isConnected(), false);
  await expectRejectsPromptly(pending);
}

// Cancellation is sent over the same connection.
{
  const connection = connect('user-cancel');
  const pending = sendCommandRequest('user-cancel', 'request-cancel', 'sleep', undefined, 5_000, () => {});
  cancelCommandRequest('user-cancel', 'request-cancel');
  assert.deepEqual(connection.sent.at(-1), { type: 'command_cancel', requestId: 'request-cancel' });
  connection.close();
  await pending.catch(() => undefined);
}

// Confirmation starts a fresh timeout; without it, the original deadline remains.
{
  const resetConnection = connect('user-reset');
  const resetRequest = sendCommandRequest('user-reset', 'request-reset', 'confirm', undefined, 200, () => {});
  setTimeout(() => resetConnection.receive({ type: 'command_awaiting_confirmation', requestId: 'request-reset' }), 150);
  setTimeout(() => resetConnection.receive({
    type: 'command_response',
    requestId: 'request-reset',
    exitCode: 0,
    stdout: 'approved',
    stderr: '',
    durationMs: 10,
    confirmation: 'approved',
  }), 300);
  assert.equal((await resetRequest).confirmation, 'approved');
  resetConnection.close();

  const timeoutConnection = connect('user-timeout');
  const startedAt = Date.now();
  await assert.rejects(
    sendCommandRequest('user-timeout', 'request-timeout', 'no confirmation', undefined, 200, () => {}),
    (error: unknown) => typeof error === 'object' && error !== null && 'error' in error
      && (error as { error: string }).error === 'local agent command timed out',
  );
  assert.ok(Date.now() - startedAt >= 175, 'request must retain its original timeout');
  timeoutConnection.close();
}

// Pairing persists only a token hash, consumes the code once, and revocation invalidates validation.
{
  const userId = 'relay-test-user';
  db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(userId, 'relay-test@example.com', 'test');
  const failedAttempt = issuePairingCode(userId);
  assert.throws(() => exchangePairingCode(failedAttempt.code, ''));
  assert.throws(() => exchangePairingCode(failedAttempt.code, 'Valid on retry'));

  const { code } = issuePairingCode(userId);
  const paired = exchangePairingCode(code, 'Test laptop');
  const stored = db.prepare('SELECT token_hash FROM paired_agents WHERE id = ?').get(paired.agent_id) as { token_hash: string };
  assert.equal(stored.token_hash, hashToken(paired.token));
  assert.notEqual(stored.token_hash, paired.token);
  assert.throws(() => exchangePairingCode(code, 'Again'));
  assert.deepEqual(validateAgentToken(paired.token), { userId, agentId: paired.agent_id });
  db.prepare("UPDATE paired_agents SET revoked_at = datetime('now') WHERE id = ?").run(paired.agent_id);
  assert.equal(validateAgentToken(paired.token), null);
}

// Real WebSocket upgrade: bearer auth, hello/heartbeat ack, and malformed input resilience.
{
  const userId = 'relay-ws-user';
  db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(userId, 'relay-ws@example.com', 'test');
  const issued = issuePairingCode(userId);
  const paired = exchangePairingCode(issued.code, 'WebSocket test device');
  const server = createServer();
  mountAgentTransport(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `ws://127.0.0.1:${address.port}/api/agent/connect`;
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => warnings.push(args);

  try {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${paired.token}` } });
      const seen = new Set<string>();
      const timer = setTimeout(() => reject(new Error('WebSocket acknowledgement timeout')), 1_000);
      socket.on('open', () => {
        socket.send('not-json');
        socket.send(JSON.stringify({ type: 'hello', agentVersion: 'test', deviceName: 'WebSocket test device' }));
        socket.send(JSON.stringify({ type: 'heartbeat' }));
      });
      socket.on('message', (raw) => {
        seen.add((JSON.parse(raw.toString()) as { type: string }).type);
        if (!seen.has('hello_ack') || !seen.has('heartbeat_ack')) return;
        clearTimeout(timer);
        socket.close();
        resolve();
      });
      socket.on('error', reject);
    });

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, { headers: { Authorization: 'Bearer invalid-token' } });
      socket.on('unexpected-response', (_request, response) => {
        try {
          assert.equal(response.statusCode, 401);
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          response.destroy();
        }
      });
      socket.on('open', () => reject(new Error('invalid token unexpectedly connected')));
      socket.on('error', () => undefined);
    });
    assert.ok(warnings.some((args) => String(args[0]).includes('Dropped unreadable agent message')));
  } finally {
    console.warn = originalWarn;
  }
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

db.close();
for (const suffix of ['', '-shm', '-wal']) {
  try { fs.unlinkSync(`${testDbPath}${suffix}`); } catch { /* already absent */ }
}

console.log('agent relay tests passed');
