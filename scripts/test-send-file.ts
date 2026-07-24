import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testDbPath = path.join(os.tmpdir(), `send-file-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = testDbPath;

const { default: db, migrate } = await import('../server/db.js');
const {
  registerAgentConnection,
  unregisterAgentConnection,
} = await import('../server/agentRelay/registry.js');
const { buildResolvedBuiltinTool } = await import('../server/tools/resolve.js');
const { getBuiltinDefinition, getBuiltinExecutor } = await import('../server/tools/registry.js');
const { sendFileTool } = await import('../server/tools/execSendFile.js');
type AgentConnection = import('../server/agentRelay/registry.js').AgentConnection;
type AgentToBackendMessage = import('../server/agentRelay/protocol.js').AgentToBackendMessage;
type BackendToAgentMessage = import('../server/agentRelay/protocol.js').BackendToAgentMessage;

class FakeConnection implements AgentConnection {
  readonly sent: BackendToAgentMessage[] = [];
  private callbacks: Array<(message: AgentToBackendMessage) => void> = [];
  private connected = true;

  constructor(private readonly respond: (request: BackendToAgentMessage) => AgentToBackendMessage | undefined) {}

  isConnected() { return this.connected; }
  send(message: BackendToAgentMessage) {
    this.sent.push(message);
    const response = this.respond(message);
    if (response) this.receive(response);
  }
  onMessage(callback: (message: AgentToBackendMessage) => void) { this.callbacks.push(callback); }
  close() {
    if (!this.connected) return;
    this.connected = false;
  }
  receive(message: AgentToBackendMessage) {
    for (const callback of this.callbacks) callback(message);
  }
}

function connect(userId: string, respond: (request: BackendToAgentMessage) => AgentToBackendMessage | undefined) {
  const connection = new FakeConnection(respond);
  registerAgentConnection(userId, connection);
  return connection;
}

migrate();

// Registration: builtin definition/executor exist and resolve.
assert.ok(getBuiltinDefinition('send_file'), 'send_file should have a builtin definition');
assert.ok(getBuiltinExecutor('send_file'), 'send_file should have a builtin executor');
const resolved = buildResolvedBuiltinTool({
  id: 'send_file',
  name: 'send_file',
  description: '',
  parameters_schema: '{}',
  type: 'builtin',
  config: null,
}, 'send-file-registration-user');
assert.ok(resolved, 'send_file should resolve via buildResolvedBuiltinTool');

// Byte-identical seed/registry check: Task 02's db.ts fileToolSeeds entry for
// send_file must exactly match this task's BUILTIN_DEFINITIONS entry, per
// this codebase's "keep the seed and the registry definition manually
// aligned" convention (mirrors the same check test-file-ops.ts performs for
// the five existing file ops).
const sendFileDefinition = getBuiltinDefinition('send_file')!;
const seededSendFileRow = db.prepare(
  "SELECT description, parameters_schema FROM tools WHERE user_id = (SELECT id FROM users WHERE email = 'local@localhost' LIMIT 1) AND name = 'send_file'"
).get() as { description: string; parameters_schema: string } | undefined;
assert.ok(seededSendFileRow, 'send_file should be seeded for the default local user');
assert.equal(seededSendFileRow!.description, sendFileDefinition.function.description, 'send_file seed description should match the registry');
assert.deepEqual(JSON.parse(seededSendFileRow!.parameters_schema), sendFileDefinition.function.parameters, 'send_file seed schema should match the registry');

// Model-Council gate: no conversationId -> fails before ever touching the relay.
const councilConnection = connect('send-file-council-user', () => {
  throw new Error('relay should not be reached for the Model-Council gate');
});
const councilResult = await sendFileTool({ path: 'chart.png' }, 'send-file-council-user', undefined);
const councilOutput = JSON.parse(councilResult) as { ok: boolean; error: string };
assert.equal(councilOutput.ok, false);
assert.match(councilOutput.error, /interactive execution context/);
assert.equal(councilConnection.sent.length, 0, 'Model-Council gate must not send anything over the relay');
unregisterAgentConnection('send-file-council-user', councilConnection);

// Disconnected-agent gate: no connection registered at all.
const disconnectedResult = await sendFileTool({ path: 'a.png' }, 'send-file-disconnected-user', 'conv-1');
const disconnectedOutput = JSON.parse(disconnectedResult) as { ok: boolean; error: string };
assert.equal(disconnectedOutput.ok, false);
assert.equal(disconnectedOutput.error, 'local agent is not connected');

// Invalid-args: missing path fails validation before the relay is touched.
const invalidArgsConnection = connect('send-file-invalid-user', () => {
  throw new Error('relay should not be reached for invalid arguments');
});
const invalidResult = await sendFileTool({}, 'send-file-invalid-user', 'conv-1');
const invalidOutput = JSON.parse(invalidResult) as { ok: boolean; error: string };
assert.equal(invalidOutput.ok, false);
assert.match(invalidOutput.error, /path/);
assert.equal(invalidArgsConnection.sent.length, 0, 'invalid arguments must not send anything over the relay');
unregisterAgentConnection('send-file-invalid-user', invalidArgsConnection);

// Success path: relay round trip returns ok:true with the exact response fields.
const successExpiresAt = new Date(Date.now() + 1000).toISOString();
const successConnection = connect('send-file-success-user', (request) => {
  assert.equal(request.type, 'send_file_request');
  if (request.type !== 'send_file_request') return undefined;
  assert.equal(request.path, 'chart.png');
  return {
    type: 'send_file_response',
    requestId: request.requestId,
    ok: true,
    fileId: 'f1',
    filename: 'chart.png',
    mimeType: 'image/png',
    sizeBytes: 123,
    expiresAt: successExpiresAt,
  };
});
const successResult = await sendFileTool({ path: 'chart.png' }, 'send-file-success-user', 'conv-1');
const successOutput = JSON.parse(successResult);
assert.deepEqual(successOutput, {
  ok: true,
  fileId: 'f1',
  filename: 'chart.png',
  mimeType: 'image/png',
  sizeBytes: 123,
  expiresAt: successExpiresAt,
});
unregisterAgentConnection('send-file-success-user', successConnection);

// Failure path: agent-reported error surfaces as ok:false with its message.
const failureConnection = connect('send-file-failure-user', (request) => {
  if (request.type !== 'send_file_request') return undefined;
  return {
    type: 'send_file_response',
    requestId: request.requestId,
    ok: false,
    error: 'File not found',
  };
});
const failureResult = await sendFileTool({ path: 'missing.png' }, 'send-file-failure-user', 'conv-1');
const failureOutput = JSON.parse(failureResult);
assert.deepEqual(failureOutput, { ok: false, error: 'File not found' });
unregisterAgentConnection('send-file-failure-user', failureConnection);

// Audit log: exactly one row per call, backend 'local', toolName 'send_file'.
const auditUsers = [
  'send-file-council-user',
  'send-file-disconnected-user',
  'send-file-invalid-user',
  'send-file-success-user',
  'send-file-failure-user',
];
for (const userId of auditUsers) {
  const rows = db.prepare(
    "SELECT tool_name, backend, is_error FROM tool_executions WHERE user_id = ? AND tool_name = 'send_file'"
  ).all(userId) as { tool_name: string; backend: string; is_error: number }[];
  assert.equal(rows.length, 1, `${userId} should have exactly one send_file audit row`);
  assert.equal(rows[0].backend, 'local');
}
assert.equal(
  (db.prepare(
    "SELECT is_error FROM tool_executions WHERE user_id = 'send-file-success-user' AND tool_name = 'send_file'"
  ).get() as { is_error: number }).is_error,
  0,
);
assert.equal(
  (db.prepare(
    "SELECT is_error FROM tool_executions WHERE user_id = 'send-file-failure-user' AND tool_name = 'send_file'"
  ).get() as { is_error: number }).is_error,
  1,
);

db.close();
for (const suffix of ['', '-shm', '-wal']) {
  try { fs.unlinkSync(`${testDbPath}${suffix}`); } catch { /* already absent */ }
}

console.log('send_file tool tests passed');
