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
  getAgentShellInfo,
  registerAgentConnection,
  sendCommandRequest,
  sendFileOpRequest,
  unregisterAgentConnection,
} = await import('../server/agentRelay/registry.js');
const {
  AgentToBackendMessageSchema,
  BackendToAgentMessageSchema,
  hashToken,
  validateAgentToken,
} = await import('../server/agentRelay/protocol.js');
const { exchangePairingCode, issuePairingCode, mountAgentTransport } = await import('../server/routes/agent.js');
const { buildRunCommandDisclosure } = await import('../server/tools/execCommand.js');
const { buildResolvedBuiltinTool } = await import('../server/tools/resolve.js');
const { getBuiltinDefinition } = await import('../server/tools/registry.js');
type AgentToBackendMessage = import('../server/agentRelay/protocol.js').AgentToBackendMessage;
type BackendToAgentMessage = import('../server/agentRelay/protocol.js').BackendToAgentMessage;
type AgentConnection = import('../server/agentRelay/registry.js').AgentConnection;

class FakeConnection implements AgentConnection {
  readonly sent: BackendToAgentMessage[] = [];
  private callbacks: Array<(message: AgentToBackendMessage) => void> = [];
  private connected = true;
  identity: { platform?: string; shell?: { kind: string; execPath: string } } | undefined;
  onClosed: (() => void) | undefined;

  isConnected() { return this.connected; }
  send(message: BackendToAgentMessage) { this.sent.push(message); }
  onMessage(callback: (message: AgentToBackendMessage) => void) { this.callbacks.push(callback); }
  close() {
    if (!this.connected) return;
    this.connected = false;
    this.onClosed?.();
  }
  getIdentity() { return this.identity; }
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

// All fourteen file-op wire variants accept the pinned camelCase shapes.
{
  const requests: BackendToAgentMessage[] = [
    { type: 'read_file_request', requestId: 'schema-read', path: 'a.txt', offset: 1, limit: 10 },
    { type: 'write_file_request', requestId: 'schema-write', path: 'a.txt', content: 'hello', hasBeenRead: true },
    {
      type: 'edit_file_request',
      requestId: 'schema-edit',
      path: 'a.txt',
      oldString: 'hello',
      newString: 'world',
      replaceAll: true,
      hasBeenRead: true,
    },
    { type: 'delete_file_request', requestId: 'schema-delete', path: 'a.txt', recursive: false },
    { type: 'list_directory_request', requestId: 'schema-list', path: '.' },
    { type: 'send_file_request', requestId: 'schema-send-file', path: 'export.csv' },
    {
      type: 'receive_file_request',
      requestId: 'schema-receive-file',
      fileId: 'staged-abc123',
      filename: 'notes.txt',
      sizeBytes: 1024,
      mimeType: 'text/plain',
    },
  ];
  const responses: AgentToBackendMessage[] = [
    {
      type: 'read_file_response',
      requestId: 'schema-read',
      ok: true,
      content: '1\thello',
      totalLines: 1,
      startLine: 1,
      endLine: 1,
      truncated: false,
    },
    { type: 'write_file_response', requestId: 'schema-write', ok: true, bytesWritten: 5, created: false },
    { type: 'edit_file_response', requestId: 'schema-edit', ok: true, replacementsMade: 1 },
    { type: 'delete_file_response', requestId: 'schema-delete', ok: false, confirmation: 'declined' },
    {
      type: 'list_directory_response',
      requestId: 'schema-list',
      ok: true,
      entries: [{ name: 'a.txt', type: 'file', sizeBytes: 5 }],
      truncated: false,
      totalEntries: 1,
    },
    {
      type: 'send_file_response',
      requestId: 'schema-send-file',
      ok: true,
      fileId: 'file-abc123',
      filename: 'export.csv',
      mimeType: 'text/csv',
      sizeBytes: 2048,
      expiresAt: new Date().toISOString(),
    },
    {
      type: 'receive_file_response',
      requestId: 'schema-receive-file',
      ok: true,
      writtenPath: 'uploads/notes.txt',
      bytesWritten: 1024,
    },
  ];
  for (const request of requests) assert.equal(BackendToAgentMessageSchema.safeParse(request).success, true);
  for (const response of responses) assert.equal(AgentToBackendMessageSchema.safeParse(response).success, true);
  assert.equal(BackendToAgentMessageSchema.safeParse({
    type: 'read_file_request',
    requestId: 'invalid-offset',
    path: 'a.txt',
    offset: 0,
  }).success, false);
  assert.equal(AgentToBackendMessageSchema.safeParse({
    type: 'write_file_response',
    requestId: 'strict-response',
    ok: true,
    bytes_written: 5,
  }).success, false);
  assert.equal(BackendToAgentMessageSchema.safeParse({
    type: 'send_file_request',
    requestId: 'invalid-send-file',
  }).success, false);
  assert.equal(BackendToAgentMessageSchema.safeParse({
    type: 'send_file_request',
    requestId: 'invalid-send-file-extra',
    path: 'export.csv',
    extra: 'field',
  }).success, false);
  assert.equal(AgentToBackendMessageSchema.safeParse({
    type: 'send_file_response',
    requestId: 'strict-send-file-response',
    ok: true,
    file_id: 'file-abc123',
  }).success, false);
  assert.equal(BackendToAgentMessageSchema.safeParse({
    type: 'receive_file_request',
    requestId: 'invalid-receive-file',
    fileId: 'staged-abc123',
  }).success, false);
  assert.equal(BackendToAgentMessageSchema.safeParse({
    type: 'receive_file_request',
    requestId: 'invalid-receive-file-extra',
    fileId: 'staged-abc123',
    filename: 'notes.txt',
    sizeBytes: 1024,
    mimeType: 'text/plain',
    extra: 'field',
  }).success, false);
  assert.equal(AgentToBackendMessageSchema.safeParse({
    type: 'receive_file_response',
    requestId: 'strict-receive-file-response',
    ok: true,
    written_path: 'uploads/notes.txt',
  }).success, false);
}

// Hello identity is retained for disclosure text, while older hello messages
// and connections that never sent hello remain undisclosed.
{
  const neverHello = connect('user-never-hello');
  assert.equal(getAgentShellInfo('user-never-hello'), undefined);
  neverHello.close();

  const oldAgent = connect('user-old-agent');
  oldAgent.receive({ type: 'hello', agentVersion: 'old', deviceName: 'old agent' });
  assert.equal(getAgentShellInfo('user-old-agent'), undefined);
  oldAgent.close();

  const knownAgent = connect('user-known-agent');
  knownAgent.identity = { platform: 'win32', shell: { kind: 'pwsh', execPath: 'C:\\Program Files\\PowerShell\\pwsh.exe' } };
  assert.deepEqual(getAgentShellInfo('user-known-agent'), knownAgent.identity);
  knownAgent.close();
}

// Shell disclosure covers local known/unknown, sandbox-only, both, and neither.
{
  const localKnown = connect('user-disclosure-known');
  localKnown.identity = { platform: 'win32', shell: { kind: 'pwsh', execPath: 'pwsh.exe' } };
  const knownDisclosure = buildRunCommandDisclosure('user-disclosure-known');
  assert.match(knownDisclosure, /Windows/);
  assert.match(knownDisclosure, /pwsh/);
  assert.match(knownDisclosure, /\$env:VAR/);
  assert.match(knownDisclosure, /\$\(\.\.\.\)/);
  assert.match(knownDisclosure, /read_file.*write_file.*edit_file.*delete_file/);
  const resolvedRun = buildResolvedBuiltinTool({
    id: 'run-command', name: 'run_command', description: '', parameters_schema: '{}', type: 'builtin', config: null,
  }, 'user-disclosure-known');
  assert.ok(resolvedRun?.openAIDef.function.description.endsWith(knownDisclosure));
  const resolvedWebSearch = buildResolvedBuiltinTool({
    id: 'web-search', name: 'web_search', description: '', parameters_schema: '{}', type: 'builtin', config: null,
  }, 'user-disclosure-known');
  assert.equal(resolvedWebSearch?.openAIDef.function.description, getBuiltinDefinition('web_search')?.function.description);
  localKnown.close();

  const localUnknown = connect('user-disclosure-unknown');
  assert.match(buildRunCommandDisclosure('user-disclosure-unknown'), /does not disclose its shell dialect/);
  localUnknown.close();

  const sandboxUser = 'user-disclosure-sandbox';
  db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(sandboxUser, `${sandboxUser}@example.com`, 'test');
  db.prepare('INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)').run(sandboxUser, 'e2b_api_key', 'test-key');
  const sandboxDisclosure = buildRunCommandDisclosure(sandboxUser);
  assert.match(sandboxDisclosure, /ephemeral Linux VM running `\/bin\/bash`/);
  assert.match(sandboxDisclosure, /POSIX\/bash syntax/);

  const bothUser = 'user-disclosure-both';
  db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(bothUser, `${bothUser}@example.com`, 'test');
  db.prepare('INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)').run(bothUser, 'e2b_api_key', 'test-key');
  const both = connect(bothUser);
  both.identity = { platform: 'linux', shell: { kind: 'bash', execPath: '/bin/bash' } };
  const bothDisclosure = buildRunCommandDisclosure(bothUser);
  assert.match(bothDisclosure, /Linux/);
  assert.match(bothDisclosure, /ephemeral Linux VM running `\/bin\/bash`/);
  both.close();

  const neitherDisclosure = buildRunCommandDisclosure('user-disclosure-neither');
  assert.equal(neitherDisclosure, '');
}

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

// File-op responses share the pending-request map and resolve without wire metadata.
{
  const connection = connect('user-file-resolve');
  const request = sendFileOpRequest<{
    ok: boolean;
    content?: string;
    totalLines?: number;
    startLine?: number;
    endLine?: number;
    truncated?: boolean;
  }>(
    'user-file-resolve',
    { type: 'read_file_request', requestId: 'file-request-resolve', path: 'notes.txt', offset: 1, limit: 20 },
    500,
  );
  assert.deepEqual(connection.sent.at(-1), {
    type: 'read_file_request',
    requestId: 'file-request-resolve',
    path: 'notes.txt',
    offset: 1,
    limit: 20,
  });
  connection.receive({
    type: 'read_file_response',
    requestId: 'file-request-resolve',
    ok: true,
    content: '1\thello',
    totalLines: 1,
    startLine: 1,
    endLine: 1,
    truncated: false,
  });
  assert.deepEqual(await request, {
    ok: true,
    content: '1\thello',
    totalLines: 1,
    startLine: 1,
    endLine: 1,
    truncated: false,
  });
  connection.close();
}

// A receive_file_response resolves its pending request like every other file op.
{
  const connection = connect('user-receive-file');
  const request = sendFileOpRequest<{ ok: boolean; writtenPath?: string; bytesWritten?: number }>(
    'user-receive-file',
    {
      type: 'receive_file_request',
      requestId: 'receive-file-resolve',
      fileId: 'staged-abc123',
      filename: 'notes.txt',
      sizeBytes: 1024,
      mimeType: 'text/plain',
    },
    500,
  );
  assert.deepEqual(connection.sent.at(-1), {
    type: 'receive_file_request',
    requestId: 'receive-file-resolve',
    fileId: 'staged-abc123',
    filename: 'notes.txt',
    sizeBytes: 1024,
    mimeType: 'text/plain',
  });
  connection.receive({
    type: 'receive_file_response',
    requestId: 'receive-file-resolve',
    ok: true,
    writtenPath: 'uploads/notes.txt',
    bytesWritten: 1024,
  });
  assert.deepEqual(await request, { ok: true, writtenPath: 'uploads/notes.txt', bytesWritten: 1024 });
  connection.close();
}

// File-op disconnect and replacement rejection use the shared immediate path.
{
  const connection = connect('user-file-disconnect');
  const first = sendFileOpRequest(
    'user-file-disconnect',
    { type: 'list_directory_request', requestId: 'file-request-disconnect-1', path: '.' },
    5_000,
  );
  const second = sendFileOpRequest(
    'user-file-disconnect',
    { type: 'write_file_request', requestId: 'file-request-disconnect-2', path: 'new.txt', content: 'x', hasBeenRead: false },
    5_000,
  );
  connection.close();
  await Promise.all([expectRejectsPromptly(first), expectRejectsPromptly(second)]);

  const oldConnection = connect('user-file-replace');
  const pending = sendFileOpRequest(
    'user-file-replace',
    { type: 'edit_file_request', requestId: 'file-request-replaced', path: 'a.txt', oldString: 'a', newString: 'b', hasBeenRead: true },
    5_000,
  );
  connect('user-file-replace');
  assert.equal(oldConnection.isConnected(), false);
  await expectRejectsPromptly(pending);
}

// Delete confirmation resets the shared timeout; an unconfirmed file op does not.
{
  const resetConnection = connect('user-file-reset');
  const resetRequest = sendFileOpRequest<{
    ok: boolean;
    kind?: 'file' | 'directory';
    confirmation?: 'declined' | 'timeout';
  }>(
    'user-file-reset',
    { type: 'delete_file_request', requestId: 'file-request-reset', path: 'large', recursive: true },
    200,
  );
  setTimeout(() => resetConnection.receive({
    type: 'command_awaiting_confirmation',
    requestId: 'file-request-reset',
  }), 150);
  setTimeout(() => resetConnection.receive({
    type: 'delete_file_response',
    requestId: 'file-request-reset',
    ok: true,
    kind: 'directory',
  }), 300);
  assert.deepEqual(await resetRequest, { ok: true, kind: 'directory' });
  resetConnection.close();

  const timeoutConnection = connect('user-file-timeout');
  const startedAt = Date.now();
  await assert.rejects(
    sendFileOpRequest(
      'user-file-timeout',
      { type: 'list_directory_request', requestId: 'file-request-timeout', path: '.' },
      200,
    ),
    (error: unknown) => typeof error === 'object' && error !== null && 'error' in error
      && (error as { error: string }).error === 'local agent command timed out',
  );
  assert.ok(Date.now() - startedAt >= 175, 'file request must retain its original timeout');
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

// Real WebSocket upgrade: bearer auth, hello/heartbeat ack, file-op validation,
// and malformed input resilience.
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
  let observedIdentity: unknown;
  console.warn = (...args: unknown[]) => warnings.push(args);

  try {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${paired.token}` } });
      const seen = new Set<string>();
      let fileRequestStarted = false;
      let fileResponseResolved = false;
      const timer = setTimeout(() => reject(new Error('WebSocket acknowledgement timeout')), 1_000);
      const finishIfComplete = () => {
        if (!seen.has('hello_ack') || !seen.has('heartbeat_ack') || !fileResponseResolved) return;
        observedIdentity = getAgentShellInfo(userId);
        clearTimeout(timer);
        socket.close();
        resolve();
      };
      socket.on('open', () => {
        socket.send('not-json');
        socket.send(JSON.stringify({
          type: 'hello',
          agentVersion: 'test',
          deviceName: 'WebSocket test device',
          platform: 'linux',
          shell: { kind: 'bash', execPath: '/bin/bash' },
        }));
        socket.send(JSON.stringify({ type: 'heartbeat' }));
      });
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as BackendToAgentMessage;
        seen.add(message.type);
        if (message.type === 'hello_ack' && !fileRequestStarted) {
          fileRequestStarted = true;
          sendFileOpRequest<{ ok: boolean; entries?: unknown[] }>(
            userId,
            { type: 'list_directory_request', requestId: 'ws-file-request', path: '.' },
            500,
          ).then((result) => {
            assert.deepEqual(result, {
              ok: true,
              entries: [{ name: 'notes.txt', type: 'file', sizeBytes: 5 }],
              truncated: false,
              totalEntries: 1,
            });
            fileResponseResolved = true;
            finishIfComplete();
          }, reject);
        }
        if (message.type === 'list_directory_request') {
          assert.deepEqual(message, {
            type: 'list_directory_request',
            requestId: 'ws-file-request',
            path: '.',
          });
          socket.send(JSON.stringify({
            type: 'list_directory_response',
            requestId: message.requestId,
            ok: true,
            entries: [{ name: 'notes.txt', type: 'file', sizeBytes: 5 }],
            truncated: false,
            totalEntries: 1,
          }));
        }
        finishIfComplete();
      });
      socket.on('error', reject);
    });
    assert.deepEqual(observedIdentity, { platform: 'linux', shell: { kind: 'bash', execPath: '/bin/bash' } });

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
