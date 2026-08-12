import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testDbPath = path.join(os.tmpdir(), `file-ops-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = testDbPath;

const { default: db, migrate } = await import('../server/db.js');
const {
  registerAgentConnection,
  unregisterAgentConnection,
} = await import('../server/agentRelay/registry.js');
const { buildResolvedBuiltinTool } = await import('../server/tools/resolve.js');
const { getBuiltinDefinition } = await import('../server/tools/registry.js');
const { runTool } = await import('../server/tools/run.js');
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

function tool(name: string, userId: string) {
  const resolved = buildResolvedBuiltinTool({
    id: name,
    name,
    description: '',
    parameters_schema: '{}',
    type: 'builtin',
    config: null,
  }, userId);
  assert.ok(resolved, `expected ${name} to resolve`);
  return resolved;
}

migrate();

const fileToolNames = ['read_file', 'write_file', 'edit_file', 'delete_file', 'list_directory'];
for (const name of fileToolNames) {
  assert.ok(getBuiltinDefinition(name), `${name} should have a builtin definition`);
}

const requestLog: BackendToAgentMessage[] = [];
const connection = connect('file-ops-user', (request) => {
  requestLog.push(request);
  switch (request.type) {
    case 'read_file_request':
      return {
        type: 'read_file_response',
        requestId: request.requestId,
        ok: true,
        content: 'x'.repeat(70_000),
        totalLines: 1,
        startLine: 1,
        endLine: 1,
        truncated: false,
      };
    case 'write_file_request':
      return {
        type: 'write_file_response',
        requestId: request.requestId,
        ok: request.hasBeenRead,
        error: request.hasBeenRead ? undefined : 'Please read_file before overwriting an existing file.',
        bytesWritten: request.hasBeenRead ? Buffer.byteLength(request.content, 'utf8') : undefined,
        created: false,
      };
    case 'edit_file_request':
      return {
        type: 'edit_file_response',
        requestId: request.requestId,
        ok: request.hasBeenRead,
        error: request.hasBeenRead ? undefined : 'Please read_file before editing an existing file.',
        replacementsMade: request.hasBeenRead ? 1 : undefined,
      };
    case 'delete_file_request':
      return {
        type: 'delete_file_response',
        requestId: request.requestId,
        ok: true,
        kind: request.recursive ? 'directory' : 'file',
      };
    case 'list_directory_request':
      return {
        type: 'list_directory_response',
        requestId: request.requestId,
        ok: true,
        entries: [{ name: 'notes.txt', type: 'file', sizeBytes: 5 }],
        truncated: false,
        totalEntries: 1,
      };
    default:
      return undefined;
  }
});

// The generic runTool path delegates all five file tools and keeps the plain
// JSON executor output wrapped in a RunToolResult.
const readResult = await runTool([tool('read_file', 'file-ops-user')], 'read_file', { path: 'notes.txt' }, undefined, 'file-ops-user', 'conv-file-ops');
assert.equal(readResult.isError, false);
const readOutput = JSON.parse(readResult.output) as { content: string; truncated: boolean };
assert.equal(readOutput.truncated, true);
assert.ok(readOutput.content.includes('characters omitted'));
assert.equal(readOutput.content.length, 64_000);
const readRequest = requestLog.at(-1);
assert.equal(readRequest?.type, 'read_file_request');
if (readRequest?.type === 'read_file_request') {
  assert.equal(readRequest.offset, 1);
  assert.equal(readRequest.limit, 2_000);
}

const writeResult = await runTool([tool('write_file', 'file-ops-user')], 'write_file', { path: 'notes.txt', content: 'updated' }, undefined, 'file-ops-user', 'conv-file-ops');
assert.equal(writeResult.isError, false);
const writeRequest = requestLog.at(-1);
assert.equal(writeRequest?.type, 'write_file_request');
assert.equal(writeRequest && 'hasBeenRead' in writeRequest ? writeRequest.hasBeenRead : false, true);

const editResult = await runTool([tool('edit_file', 'file-ops-user')], 'edit_file', { path: 'notes.txt', old_string: 'updated', new_string: 'edited' }, undefined, 'file-ops-user', 'conv-file-ops');
assert.equal(editResult.isError, false);
const editRequest = requestLog.at(-1);
assert.equal(editRequest?.type, 'edit_file_request');
assert.equal(editRequest && 'hasBeenRead' in editRequest ? editRequest.hasBeenRead : false, true);

const deleteResult = await runTool([tool('delete_file', 'file-ops-user')], 'delete_file', { path: 'notes.txt' }, undefined, 'file-ops-user', 'conv-file-ops');
assert.equal(deleteResult.isError, false);

const listResult = await runTool([tool('list_directory', 'file-ops-user')], 'list_directory', {}, undefined, 'file-ops-user', 'conv-file-ops');
assert.equal(listResult.isError, false);
const listRequest = requestLog.at(-1);
assert.deepEqual(listRequest && listRequest.type === 'list_directory_request' ? listRequest.path : null, '.');

// The agent receives the guard bit and owns the final existing-path decision.
const guardResult = await runTool([tool('write_file', 'file-ops-user')], 'write_file', { path: 'unread.txt', content: 'blocked' }, undefined, 'file-ops-user', 'unread-conversation');
assert.equal(guardResult.isError, true);
assert.match(JSON.parse(guardResult.output).error, /read_file/);
const unreadRequest = requestLog.at(-1);
assert.equal(unreadRequest && unreadRequest.type === 'write_file_request' ? unreadRequest.hasBeenRead : true, false);

// Model Council calls and disconnected local execution fail before the wire request.
const councilResult = await runTool([tool('read_file', 'file-ops-user')], 'read_file', { path: 'notes.txt' }, undefined, 'file-ops-user');
assert.equal(councilResult.isError, true);
assert.match(JSON.parse(councilResult.output).error, /not available from Model Council/);
unregisterAgentConnection('file-ops-user', connection);
const disconnectedResult = await runTool([tool('read_file', 'file-ops-user')], 'read_file', { path: 'notes.txt' }, undefined, 'file-ops-user', 'disconnected-conversation');
assert.equal(disconnectedResult.isError, true);
assert.equal(JSON.parse(disconnectedResult.output).error, 'local agent is not connected');

const validationConnection = connect('file-ops-validation', () => undefined);
const invalidResult = await runTool([tool('read_file', 'file-ops-validation')], 'read_file', { path: 42 }, undefined, 'file-ops-validation', 'validation-conversation');
assert.equal(invalidResult.isError, true);
assert.match(JSON.parse(invalidResult.output).error, /^Invalid read_file arguments:/);
unregisterAgentConnection('file-ops-validation', validationConnection);

// Migration seeds all users and remains usable by the registration copy path.
const migrationUserId = 'file-ops-existing-user';
db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(migrationUserId, `${migrationUserId}@example.com`, 'test');
const ordinaryUserId = 'file-ops-ordinary-user';
db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(ordinaryUserId, `${ordinaryUserId}@example.com`, 'test');
const collisionCustomDescription = 'Existing custom read_file HTTP tool';
const collisionCustomSchema = JSON.stringify({ type: 'object', properties: { input: { type: 'string' } }, required: ['input'] });
const collisionCustomConfig = JSON.stringify({ url: 'https://example.test/read-file', method: 'POST' });
db.prepare(`
  INSERT INTO tools (id, user_id, name, description, parameters_schema, type, config)
  VALUES (?, ?, 'read_file', ?, ?, 'http', ?)
`).run('file-ops-collision-custom', migrationUserId, collisionCustomDescription, collisionCustomSchema, collisionCustomConfig);
assert.doesNotThrow(() => migrate(), 'migration should tolerate a custom tool name collision');
for (const user of db.prepare('SELECT id FROM users').all() as { id: string }[]) {
  const names = (db.prepare("SELECT name FROM tools WHERE user_id = ? AND type = 'builtin'").all(user.id) as { name: string }[]).map((row) => row.name);
  for (const name of fileToolNames) assert.ok(names.includes(name), `${user.id} should have ${name}`);
}

const collisionRows = db.prepare(`
  SELECT id, name, description, parameters_schema, type, config
  FROM tools
  WHERE user_id = ? AND (name = 'read_file' OR id = 'file-ops-collision-custom')
  ORDER BY CASE type WHEN 'http' THEN 0 ELSE 1 END, name
`).all(migrationUserId) as { id: string; name: string; description: string; parameters_schema: string; type: string; config: string | null }[];
assert.deepEqual(collisionRows, [
  {
    id: 'file-ops-collision-custom',
    name: 'read_file_custom',
    description: collisionCustomDescription,
    parameters_schema: collisionCustomSchema,
    type: 'http',
    config: collisionCustomConfig,
  },
  {
    id: collisionRows.find((row) => row.type === 'builtin')?.id,
    name: 'read_file',
    description: getBuiltinDefinition('read_file')!.function.description,
    parameters_schema: JSON.stringify(getBuiltinDefinition('read_file')!.function.parameters),
    type: 'builtin',
    config: null,
  },
], 'a custom tool collision should preserve the custom row and add the builtin row');

// A second migration must not rename or duplicate either side of the collision.
assert.doesNotThrow(() => migrate(), 'migration should remain idempotent after resolving a collision');
const collisionRowsAfterSecondMigration = db.prepare(`
  SELECT id, name, description, parameters_schema, type, config
  FROM tools
  WHERE user_id = ? AND (name LIKE 'read_file%')
  ORDER BY CASE type WHEN 'http' THEN 0 ELSE 1 END, name
`).all(migrationUserId) as { id: string; name: string; description: string; parameters_schema: string; type: string; config: string | null }[];
assert.equal(collisionRowsAfterSecondMigration.filter((row) => row.type === 'builtin' && row.name === 'read_file').length, 1);
assert.deepEqual(collisionRowsAfterSecondMigration.find((row) => row.id === 'file-ops-collision-custom'), collisionRows[0]);
assert.equal((db.prepare("SELECT COUNT(*) AS count FROM tools WHERE user_id = ? AND type = 'builtin' AND name = 'read_file'").get(migrationUserId) as { count: number }).count, 1);

for (const name of fileToolNames) {
  const definition = getBuiltinDefinition(name)!;
  const row = db.prepare('SELECT description, parameters_schema FROM tools WHERE user_id = (SELECT id FROM users WHERE email = \'local@localhost\' LIMIT 1) AND name = ?').get(name) as { description: string; parameters_schema: string };
  assert.equal(row.description, definition.function.description, `${name} migration description should match the registry`);
  assert.deepEqual(JSON.parse(row.parameters_schema), definition.function.parameters, `${name} migration schema should match the registry`);
}

const freshUserId = 'file-ops-fresh-user';
db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(freshUserId, `${freshUserId}@example.com`, 'test');
const defaultUser = db.prepare("SELECT id FROM users WHERE email = 'local@localhost' LIMIT 1").get() as { id: string };
const builtins = db.prepare("SELECT name, description, parameters_schema, type, config FROM tools WHERE user_id = ? AND type = 'builtin'").all(defaultUser.id) as { name: string; description: string; parameters_schema: string; type: string; config: string | null }[];
for (const builtin of builtins) {
  db.prepare('INSERT INTO tools (id, user_id, name, description, parameters_schema, type, config) VALUES (?, ?, ?, ?, ?, ?, ?)').run(`${freshUserId}-${builtin.name}`, freshUserId, builtin.name, builtin.description, builtin.parameters_schema, builtin.type, builtin.config);
}
const freshNames = (db.prepare("SELECT name FROM tools WHERE user_id = ? AND type = 'builtin'").all(freshUserId) as { name: string }[]).map((row) => row.name);
for (const name of fileToolNames) assert.ok(freshNames.includes(name), `fresh registration should copy ${name}`);

const auditRows = db.prepare("SELECT tool_name, backend, conversation_id, is_error FROM tool_executions WHERE user_id = 'file-ops-user'").all() as { tool_name: string; backend: string; conversation_id: string | null; is_error: number }[];
assert.ok(auditRows.some((row) => row.tool_name === 'read_file' && row.backend === 'local' && row.conversation_id === 'conv-file-ops' && row.is_error === 0));
assert.ok(auditRows.some((row) => row.tool_name === 'write_file' && row.conversation_id === 'unread-conversation' && row.is_error === 1));

const chatSource = fs.readFileSync(path.join(process.cwd(), 'server/routes/chat.ts'), 'utf8');
assert.match(chatSource, /const keepaliveTimer = setInterval\(/);
assert.doesNotMatch(chatSource, /if \(name === 'run_command'\)[\s\S]{0,250}setInterval\(/);
assert.match(
  chatSource,
  /runTool\(\s*resolvedTools,\s*name,\s*args,\s*mcpClients,\s*userId,\s*conversation_id,\s*messages,\s*\{[\s\S]{0,300}authorizeMcpCall,[\s\S]{0,300}mcpControl:/,
);

db.close();
for (const suffix of ['', '-shm', '-wal']) {
  try { fs.unlinkSync(`${testDbPath}${suffix}`); } catch { /* already absent */ }
}

console.log('file operation tool tests passed');
