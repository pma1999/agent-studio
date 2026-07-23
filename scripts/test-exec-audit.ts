import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate this test from the real dev/prod database: point DATABASE_PATH at a
// throwaway file before server/db.ts is imported (it reads the env var at
// module load time).
const tmpDbPath = path.join(os.tmpdir(), `test-exec-audit-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = tmpDbPath;

const { migrate, default: db } = await import('../server/db.js');
migrate();

// Import execAudit only after migrate() has created tool_executions — its
// insert statement is prepared at module load time.
const { logToolExecution } = await import('../server/tools/execAudit.js');

// 1. Command longer than 4000 chars is truncated to exactly 4000 before insert.
const longCommand = 'echo-' + 'x'.repeat(5000);
logToolExecution({
  userId: 'test-user-truncation',
  toolName: 'run_command',
  backend: 'local',
  command: longCommand,
});

const row = db
  .prepare('SELECT command FROM tool_executions WHERE user_id = ?')
  .get('test-user-truncation') as { command: string } | undefined;

assert.ok(row, 'expected a row to be inserted for test-user-truncation');
assert.equal(row!.command.length, 4000, 'command column should be truncated to exactly 4000 characters');
assert.equal(row!.command, longCommand.slice(0, 4000));

// 2. Missing optional fields never throws (swallow-and-log only).
assert.doesNotThrow(() => {
  logToolExecution({
    userId: 'test-user-minimal',
    toolName: 'run_command',
    backend: 'local',
  });
});
const minimalRow = db
  .prepare('SELECT * FROM tool_executions WHERE user_id = ?')
  .get('test-user-minimal') as Record<string, unknown> | undefined;
assert.ok(minimalRow, 'expected a row to be inserted for test-user-minimal despite missing optional fields');

// 3. A deliberately malformed entry (violates the backend CHECK constraint)
// must be swallowed, not thrown — a logging failure must never break the
// caller's actual tool execution.
assert.doesNotThrow(() => {
  // @ts-expect-error -- intentionally invalid backend value to exercise the
  // swallow-and-console.error path.
  logToolExecution({
    userId: 'test-user-malformed',
    toolName: 'run_command',
    backend: 'not-a-real-backend',
  });
});
const malformedRow = db
  .prepare('SELECT * FROM tool_executions WHERE user_id = ?')
  .get('test-user-malformed');
assert.equal(malformedRow, undefined, 'the malformed insert should have failed silently and inserted nothing');

db.close();
for (const suffix of ['', '-wal', '-shm']) {
  fs.rmSync(`${tmpDbPath}${suffix}`, { force: true });
}

console.log('execAudit logToolExecution: OK');
