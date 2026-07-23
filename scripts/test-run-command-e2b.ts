import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Sandbox } from 'e2b';

const dbPath = path.join(os.tmpdir(), `agent-studio-run-command-${process.pid}-${crypto.randomUUID()}.db`);
process.env.DATABASE_PATH = dbPath;

const { default: db, migrate } = await import('../server/db.js');
migrate();
const { isRunCommandUsable, runCommandTool, truncateCommandOutput, MAX_COMMAND_OUTPUT_CHARS } = await import('../server/tools/execCommand.js');
const { getBuiltinExecutor } = await import('../server/tools/registry.js');
const { resolveToolsFromIds } = await import('../server/tools/resolve.js');
const {
  registerAgentConnection,
  unregisterAgentConnection,
} = await import('../server/agentRelay/registry.js');
const { buildToolOutputChunkEvent, buildToolResultEvent } = await import('../server/routes/chat.js');
type AgentToBackendMessage = import('../server/agentRelay/protocol.js').AgentToBackendMessage;
type BackendToAgentMessage = import('../server/agentRelay/protocol.js').BackendToAgentMessage;
type AgentConnection = import('../server/agentRelay/registry.js').AgentConnection;

class FakeConnection implements AgentConnection {
  readonly sent: BackendToAgentMessage[] = [];
  private callbacks: Array<(message: AgentToBackendMessage) => void> = [];
  private connected = true;
  onSend: ((message: BackendToAgentMessage) => void) | undefined;

  isConnected() { return this.connected; }
  send(message: BackendToAgentMessage) {
    this.sent.push(message);
    this.onSend?.(message);
  }
  onMessage(callback: (message: AgentToBackendMessage) => void) { this.callbacks.push(callback); }
  close() { this.connected = false; }
  receive(message: AgentToBackendMessage) {
    for (const callback of this.callbacks) callback(message);
  }
}

function connectLocal(userId: string, connection = new FakeConnection()) {
  registerAgentConnection(userId, connection);
  return connection;
}

function disconnectLocal(userId: string, connection: FakeConnection) {
  connection.close();
  unregisterAgentConnection(userId, connection);
}

const userId = `run-command-test-${crypto.randomUUID()}`;
db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(userId, `${userId}@example.test`, 'test');
db.prepare('INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)').run(userId, 'e2b_api_key', '');
migrate();
const seededTool = db.prepare("SELECT id FROM tools WHERE user_id = ? AND name = 'run_command'").get(userId) as { id: string };
assert.ok(seededTool);
assert.equal((await resolveToolsFromIds([seededTool.id], [], userId)).resolvedTools.length, 0);

assert.equal(isRunCommandUsable(userId), false);
db.prepare('UPDATE settings SET value = ? WHERE user_id = ? AND key = ?').run('test-e2b-key', userId, 'e2b_api_key');
assert.equal(isRunCommandUsable(userId), true);
assert.equal((await resolveToolsFromIds([seededTool.id], [], userId)).resolvedTools[0]?.name, 'run_command');

const sandboxStatic = Sandbox as unknown as {
  create: (options?: unknown) => Promise<unknown>;
};
const originalCreate = sandboxStatic.create;
let createCalls = 0;
sandboxStatic.create = async () => {
  createCalls++;
  throw new Error('sandbox should not be created');
};

try {
  const invalid = await runCommandTool({}, userId, { signal: new AbortController().signal, onOutputChunk: () => {} });
  assert.equal(invalid.isError, true);
  assert.match(JSON.parse(invalid.output).error, /command/i);

  const blocked = await runCommandTool(
    { command: 'format C:', backend: 'sandbox' },
    userId,
    { signal: new AbortController().signal, onOutputChunk: () => {} }
  );
  assert.equal(blocked.isError, true);
  assert.deepEqual(JSON.parse(blocked.output).blocked, { tier: 1, pattern: 'disk-format' });
  assert.equal(createCalls, 0);

  const local = await runCommandTool(
    { command: 'echo hello', backend: 'local' },
    userId,
    { signal: new AbortController().signal, onOutputChunk: () => {} }
  );
  assert.equal(JSON.parse(local.output).error, 'local agent is not connected');
} finally {
  sandboxStatic.create = originalCreate;
}

// Local routing streams chunks in order, truncates final output, and wins over E2B for auto.
{
  const connection = connectLocal(userId);
  const chunks: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];
  const largeStdout = 'head'.repeat(20_000) + 'tail'.repeat(20_000);
  let localRequestCount = 0;
  connection.onSend = (message) => {
    if (message.type !== 'command_request') return;
    localRequestCount++;
    if (localRequestCount === 1) {
      connection.receive({ type: 'command_output_chunk', requestId: message.requestId, stream: 'stdout', text: 'first', seq: 0 });
      connection.receive({ type: 'command_output_chunk', requestId: message.requestId, stream: 'stderr', text: 'second', seq: 1 });
      connection.receive({
        type: 'command_response',
        requestId: message.requestId,
        exitCode: 0,
        stdout: largeStdout,
        stderr: '',
        durationMs: 8,
        blockedPattern: 'confirmation-test',
        confirmation: 'approved',
      });
      return;
    }
    connection.receive({
      type: 'command_response',
      requestId: message.requestId,
      exitCode: 0,
      stdout: 'auto-local',
      stderr: '',
      durationMs: 2,
    });
  };

  let unexpectedE2bCreates = 0;
  sandboxStatic.create = async () => {
    unexpectedE2bCreates++;
    throw new Error('auto must prefer the connected local agent');
  };
  try {
    db.prepare('UPDATE settings SET value = ? WHERE user_id = ? AND key = ?').run('', userId, 'e2b_api_key');
    assert.equal((await resolveToolsFromIds([seededTool.id], [], userId)).resolvedTools[0]?.name, 'run_command');
    db.prepare('UPDATE settings SET value = ? WHERE user_id = ? AND key = ?').run('test-e2b-key', userId, 'e2b_api_key');

    const local = await runCommandTool(
      { command: 'echo local', cwd: 'project', backend: 'local', timeout_seconds: 0.2 },
      userId,
      { signal: new AbortController().signal, onOutputChunk: (chunk) => chunks.push(chunk) }
    );
    const localOutput = JSON.parse(local.output);
    assert.equal(local.isError, false);
    assert.deepEqual(local.metadata, { backend: 'local', exit_code: 0 });
    assert.equal(localOutput.backend, 'local');
    assert.equal(localOutput.exit_code, 0);
    assert.equal(localOutput.resolved_cwd, 'project');
    assert.equal(localOutput.stdout.length, MAX_COMMAND_OUTPUT_CHARS);
    assert.equal(localOutput.truncated, true);
    assert.deepEqual(chunks, [
      { stream: 'stdout', text: 'first' },
      { stream: 'stderr', text: 'second' },
    ]);

    const automatic = await runCommandTool(
      { command: 'echo automatic', backend: 'auto' },
      userId,
      { signal: new AbortController().signal, onOutputChunk: () => {} }
    );
    assert.equal(JSON.parse(automatic.output).stdout, 'auto-local');
    assert.equal(unexpectedE2bCreates, 0);
  } finally {
    sandboxStatic.create = originalCreate;
    disconnectLocal(userId, connection);
  }
}

// Declined and timed-out confirmations are refusals: the command did not execute.
{
  const connection = connectLocal(userId);
  const confirmations: Array<'declined' | 'timeout'> = ['declined', 'timeout'];
  let responseIndex = 0;
  connection.onSend = (message) => {
    if (message.type !== 'command_request') return;
    const confirmation = confirmations[responseIndex++];
    connection.receive({
      type: 'command_response',
      requestId: message.requestId,
      exitCode: null,
      stdout: '',
      stderr: '',
      durationMs: 1,
      blockedPattern: 'confirmation-test',
      confirmation,
    });
  };

  try {
    for (const confirmation of confirmations) {
      const result = await runCommandTool(
        { command: `confirmation ${confirmation}`, backend: 'local' },
        userId,
        { signal: new AbortController().signal, onOutputChunk: () => {} }
      );
      const output = JSON.parse(result.output);
      assert.equal(result.isError, true);
      assert.equal(typeof output.error, 'string');
      assert.equal(output.confirmation, confirmation);
    }
  } finally {
    disconnectLocal(userId, connection);
  }
}

// Agent disconnect and browser cancellation both settle promptly without hanging.
{
  const disconnecting = connectLocal(userId);
  const pending = runCommandTool(
    { command: 'sleep 20', backend: 'local', timeout_seconds: 5 },
    userId,
    { signal: new AbortController().signal, onOutputChunk: () => {} }
  );
  disconnectLocal(userId, disconnecting);
  const disconnected = await Promise.race([
    pending,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('local disconnect hung')), 100)),
  ]);
  assert.equal(JSON.parse(disconnected.output).error, 'local agent disconnected mid-command');

  const cancellable = connectLocal(userId);
  const cancelController = new AbortController();
  const cancelledPending = runCommandTool(
    { command: 'sleep 20', backend: 'local', timeout_seconds: 5 },
    userId,
    { signal: cancelController.signal, onOutputChunk: () => {} }
  );
  cancelController.abort();
  const cancelled = await Promise.race([
    cancelledPending,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('local cancellation hung')), 100)),
  ]);
  assert.equal(JSON.parse(cancelled.output).error, 'Command cancelled because the client disconnected.');
  assert.ok(cancellable.sent.some((message) => message.type === 'command_cancel'));
  disconnectLocal(userId, cancellable);
}

// A response just before the relay deadline clears the timeout and cannot be overwritten by it.
{
  const connection = connectLocal(userId);
  connection.onSend = (message) => {
    if (message.type !== 'command_request') return;
    setTimeout(() => connection.receive({
      type: 'command_response',
      requestId: message.requestId,
      exitCode: 0,
      stdout: 'deadline winner',
      stderr: '',
      durationMs: 35,
    }), 35);
  };
  const result = await runCommandTool(
    { command: 'echo deadline', backend: 'local', timeout_seconds: 0.05 },
    userId,
    { signal: new AbortController().signal, onOutputChunk: () => {} }
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(JSON.parse(result.output).stdout, 'deadline winner');
  assert.equal(connection.sent.filter((message) => message.type === 'command_cancel').length, 0);
  disconnectLocal(userId, connection);
}

assert.deepEqual(
  buildToolOutputChunkEvent('call-command', { stream: 'stderr', text: 'live' }, 4),
  { tool_output_chunk: { id: 'call-command', stream: 'stderr', text: 'live', seq: 4 } }
);
assert.deepEqual(
  buildToolResultEvent('call-command', 'run_command', {
    output: '{"stdout":"ok"}',
    isError: false,
    source: 'builtin',
    metadata: { backend: 'local', exit_code: 0 },
  }, 12),
  {
    tool_result: {
      id: 'call-command',
      name: 'run_command',
      ok: true,
      result: '{"stdout":"ok"}',
      duration_ms: 12,
      source: 'builtin',
      metadata: { backend: 'local', exit_code: 0 },
    },
  }
);
assert.equal(
  'metadata' in buildToolResultEvent('call-web', 'web_search', {
    output: '[]',
    isError: false,
    source: 'builtin',
    metadata: { should_not_leak: true },
  }, 3).tool_result,
  false
);

const truncated = truncateCommandOutput('head'.repeat(20_000) + 'tail'.repeat(20_000));
assert.equal(truncated.truncated, true);
assert.equal(truncated.text.length, MAX_COMMAND_OUTPUT_CHARS);
assert.match(truncated.text, /head/);
assert.match(truncated.text, /tail$/);

process.env.HOST_ONLY_SECRET = 'must-not-enter-sandbox';
process.env.DATABASE_PATH = dbPath;
db.prepare('INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)').run(userId, 'e2b_allow_internet', 'true');

let createOptions: Record<string, unknown> | undefined;
let commandOptions: Record<string, unknown> | undefined;
const commandsRun: string[] = [];
let killed = false;
const fakeSandbox = {
  commands: {
    run: async (command: string, options: Record<string, unknown>) => {
      commandsRun.push(command);
      commandOptions = options;
      if (commandsRun.length === 1) return { stdout: '', stderr: 'iptables/nft unavailable', exitCode: 127 };
      return { stdout: 'hello', stderr: '', exitCode: 0 };
    },
  },
  kill: async () => {
    killed = true;
    return true;
  },
};
sandboxStatic.create = async (options?: unknown) => {
  createOptions = options as Record<string, unknown>;
  return fakeSandbox;
};

try {
  const result = await runCommandTool(
    { command: 'printf hello', backend: 'sandbox', timeout_seconds: 2000 },
    userId,
    { signal: new AbortController().signal, onOutputChunk: () => {} }
  );
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(result.output), {
    stdout: 'hello',
    stderr: '',
    exit_code: 0,
    backend: 'e2b',
    resolved_cwd: '/home/user',
    timeout_seconds_applied: 1800,
    truncated: false,
  });
  assert.deepEqual(createOptions?.envs, {});
  assert.equal(createOptions?.allowInternetAccess, true);
  assert.equal(createOptions?.timeoutMs, 1_830_000);
  assert.equal(createOptions?.apiKey, 'test-e2b-key');
  assert.deepEqual((createOptions?.network as { denyOut: string[] }).denyOut, [
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
  ]);
  assert.equal(commandsRun.length, 2);
  assert.match(commandsRun[0], /169\.254\.169\.254/);
  assert.equal(commandsRun[1], 'printf hello');
  assert.equal(commandOptions?.timeoutMs, 1_800_000);
  assert.equal(killed, true);
} finally {
  sandboxStatic.create = originalCreate;
}

let cancelKilled = false;
const cancelSandbox = {
  commands: {
    run: async () => new Promise<never>(() => {}),
  },
  kill: async () => {
    cancelKilled = true;
    return true;
  },
};
sandboxStatic.create = async () => cancelSandbox;
try {
  const cancelController = new AbortController();
  const pending = runCommandTool(
    { command: 'sleep 20', backend: 'sandbox' },
    userId,
    { signal: cancelController.signal, onOutputChunk: () => {} }
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  cancelController.abort();
  const cancelled = await pending;
  assert.equal(JSON.parse(cancelled.output).error, 'Command cancelled because the client disconnected.');
  assert.equal(cancelKilled, true);
} finally {
  sandboxStatic.create = originalCreate;
}

const auditCount = db.prepare("SELECT COUNT(*) AS count FROM tool_executions WHERE user_id = ? AND tool_name = 'run_command'").get(userId) as { count: number };
assert.equal(auditCount.count, 12);
const localAudit = db.prepare(`
  SELECT backend, blocked_pattern, confirmation_required, confirmation_result
  FROM tool_executions
  WHERE user_id = ? AND command = 'echo local'
`).get(userId) as {
  backend: string;
  blocked_pattern: string | null;
  confirmation_required: number;
  confirmation_result: string | null;
};
assert.deepEqual(localAudit, {
  backend: 'local',
  blocked_pattern: 'confirmation-test',
  confirmation_required: 1,
  confirmation_result: 'approved',
});

const inertExecutor = getBuiltinExecutor('run_command');
assert.ok(inertExecutor);
assert.equal(
  await inertExecutor({}, undefined, userId),
  JSON.stringify({ error: 'run_command requires the interactive execution context; not available from Model Council in v1.' })
);

console.log('run_command E2B executor: OK');
