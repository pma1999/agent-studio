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
  assert.equal(JSON.parse(local.output).error, "backend 'local' is not available yet — no local agent support is configured for this deployment.");
} finally {
  sandboxStatic.create = originalCreate;
}

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
assert.equal(auditCount.count, 5);

const inertExecutor = getBuiltinExecutor('run_command');
assert.ok(inertExecutor);
assert.equal(
  await inertExecutor({}, undefined, userId),
  JSON.stringify({ error: 'run_command requires the interactive execution context; not available from Model Council in v1.' })
);

console.log('run_command E2B executor: OK');
