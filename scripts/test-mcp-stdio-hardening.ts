import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate this test from the real dev/prod database before server modules are
// imported; server/db.ts reads DATABASE_PATH at module load time.
const tmpDbPath = path.join(os.tmpdir(), `test-mcp-stdio-hardening-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = tmpDbPath;

const { migrate, default: db } = await import('../server/db.js');
migrate();

const { buildSafeEnv, createAndConnectMcpClient } = await import('../server/mcp/client.js');

const allowedHostKeys = new Set([
  'PATH',
  'SystemRoot',
  'windir',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'LANG',
  'TMPDIR',
]);

const previousMarker = process.env.__TEST_MARKER__;
process.env.__TEST_MARKER__ = '1';

try {
  const configuredEnv = buildSafeEnv({
    CUSTOM_MCP_VAR: 'caller-value',
    PATH: 'caller-path',
  });
  const omittedEnv = buildSafeEnv();

  for (const [key, value] of Object.entries(configuredEnv)) {
    assert.ok(allowedHostKeys.has(key) || key === 'CUSTOM_MCP_VAR', `unexpected configured env key: ${key}`);
    if (allowedHostKeys.has(key) && key !== 'PATH') {
      assert.equal(value, process.env[key], `safe env should preserve the host value for ${key}`);
    }
  }
  for (const [key, value] of Object.entries(omittedEnv)) {
    assert.ok(allowedHostKeys.has(key), `unexpected omitted env key: ${key}`);
    assert.equal(value, process.env[key], `safe env should preserve the host value for ${key}`);
  }
  assert.equal(configuredEnv.CUSTOM_MCP_VAR, 'caller-value');
  assert.equal(configuredEnv.PATH, 'caller-path', 'caller env should override the host baseline');
  assert.equal('__TEST_MARKER__' in configuredEnv, false, 'configured env must not inherit arbitrary host variables');
  assert.equal('__TEST_MARKER__' in omittedEnv, false, 'omitted config.env must not inherit arbitrary host variables');

  await assert.rejects(
    () =>
      createAndConnectMcpClient(
        { transport: 'stdio', config: { command: 'format C:' } },
        { userId: 'test-mcp-stdio-refusal' }
      ),
    /Refused: command or arguments match a blocked pattern \(disk-format\)/
  );

  const refusalRow = db
    .prepare(
      `SELECT backend, tool_name, command, blocked_pattern, is_error
       FROM tool_executions
       WHERE user_id = ?
       ORDER BY rowid DESC
       LIMIT 1`
    )
    .get('test-mcp-stdio-refusal') as
    | {
        backend: string;
        tool_name: string;
        command: string;
        blocked_pattern: string;
        is_error: number;
      }
    | undefined;
  assert.deepEqual(refusalRow, {
    backend: 'mcp-stdio',
    tool_name: 'mcp_stdio_connect',
    command: 'format C:',
    blocked_pattern: 'disk-format',
    is_error: 1,
  });
} finally {
  if (previousMarker === undefined) delete process.env.__TEST_MARKER__;
  else process.env.__TEST_MARKER__ = previousMarker;

  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${tmpDbPath}${suffix}`, { force: true });
  }
}

console.log('MCP stdio hardening: OK');
