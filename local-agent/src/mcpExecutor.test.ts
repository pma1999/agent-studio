/**
 * Plain-script test (repo convention: `tsx`, `node:assert`, no test-framework
 * dependency — matches `commandExecutor.test.ts`) covering the MCP bridge:
 *   (1) start → the child receives an 'initialize' JSON-RPC line on stdin and
 *       the executor forwards the child's stdout line back as `mcp_message`
 *       with the right channelId (real node child as an echo server).
 *   (2) `mcp_start_response ok:true` carries the right requestId, and
 *       `mcp_stop_request` kills the child (observed via process death) and
 *       answers `mcp_stop_response ok:true`; stopping an unknown channel is
 *       idempotent-ok.
 *   (3) a nonexistent command → `mcp_start_response ok:false` with an error
 *       string (cross-spawn normalizes command-not-found on every platform).
 *   (4) `handleDisconnect()` kills every running child without crashing.
 *   (5) a duplicate `mcp_start_request` for the same channel is idempotent:
 *       immediate ok:true and no second spawn (counted via stdout marker
 *       lines from each spawned child).
 *   (6) shell metacharacters remain literal argv entries and an unconfigured
 *       host secret is not inherited, while explicitly configured env is.
 *   (7) malformed command/args/env/cwd are rejected at the executor boundary.
 *   (8) oversized stdout lines and inbound JSON-RPC payloads are bounded; a
 *       bad frame does not poison a channel's following valid messages.
 *   (9) stderr logging stops at its configured byte ceiling.
 *   (10) configured env and argv secrets written to stderr in split writes
 *        are redacted from local logs and the backend failure response even
 *        when their names carry no credential hint.
 *
 * Children are spawned through the executor's own `spawn` path, using
 * `process.execPath` (the node running tsx) with a small inline script file —
 * avoids PATH lookups while still exercising cross-spawn's literal argv path.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMcpExecutor } from './mcpExecutor.js';
import type { McpExecutorOptions } from './mcpExecutor.js';
import type { AgentToBackendMessage, MCPStartRequestMessage } from './transport.js';

type StartResponse = Extract<AgentToBackendMessage, { type: 'mcp_start_response' }>;
type StopResponse = Extract<AgentToBackendMessage, { type: 'mcp_stop_response' }>;
type McpMessage = Extract<AgentToBackendMessage, { type: 'mcp_message' }>;

function isStartResponse(m: AgentToBackendMessage): m is StartResponse {
  return m.type === 'mcp_start_response';
}

function isStopResponse(m: AgentToBackendMessage): m is StopResponse {
  return m.type === 'mcp_stop_response';
}

function isPidMessage(m: AgentToBackendMessage): m is McpMessage {
  return m.type === 'mcp_message' && typeof (m.payload as { pid?: unknown })?.pid === 'number';
}

function makeExecutor(overrides: Omit<Partial<McpExecutorOptions>, 'send'> = {}) {
  const sent: AgentToBackendMessage[] = [];
  const executor = createMcpExecutor({ send: (message) => sent.push(message), ...overrides });
  return { executor, sent };
}

async function waitFor<T extends AgentToBackendMessage>(
  sent: AgentToBackendMessage[],
  predicate: (m: AgentToBackendMessage) => m is T,
  timeoutMs = 5_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = sent.find(predicate);
    if (found) return found;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for message`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForCount<T extends AgentToBackendMessage>(
  sent: AgentToBackendMessage[],
  predicate: (m: AgentToBackendMessage) => m is T,
  count: number,
  timeoutMs = 5_000
): Promise<T[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = sent.filter(predicate);
    if (found.length >= count) return found.slice(0, count);
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${count} messages`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Resolves once `pid` is gone (process.kill(pid, 0) throws ESRCH). */
async function waitForProcessExit(pid: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() >= deadline) throw new Error(`process ${pid} still alive after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Echo server: prints one ready line, then mirrors stdin to stdout. The
// ready line also drives the executor's on-first-stdout ok:true, keeping
// tests off the 100ms grace timer.
const ECHO_SCRIPT = `console.log(JSON.stringify({ ready: true }));\nprocess.stdin.on('data', (d) => process.stdout.write(d));\n`;
// Long-running idle child that reports its own pid.
const IDLE_SCRIPT = `console.log(JSON.stringify({ pid: process.pid }));\nprocess.stdin.on('data', () => {});\n`;
// Idle child that reports a spawn marker + pid (used to count spawns).
const MARKER_SCRIPT = `console.log(JSON.stringify({ spawned: true, pid: process.pid }));\nprocess.stdin.on('data', () => {});\n`;
// Reports argv + two selected env keys and then remains available for teardown.
const ARGV_ENV_SCRIPT =
  `console.log(JSON.stringify({ argv: process.argv.slice(2), inheritedSecret: process.env.MCP_EXECUTOR_SECRET_SHOULD_NOT_LEAK, explicitEnv: process.env.MCP_EXECUTOR_EXPLICIT_ENV }));\n` +
  `process.stdin.on('data', () => {});\n`;
// An over-limit line followed by a valid JSON-RPC-shaped object.
const OVERSIZE_SCRIPT =
  `process.stdout.write('x'.repeat(512) + '\\n' + JSON.stringify({ afterOversize: true }) + '\\n');\n` +
  `process.stdin.on('data', (d) => process.stdout.write(d));\n`;
const STDERR_SCRIPT =
  `console.log(JSON.stringify({ stderrReady: true }));\n` +
  `process.stderr.write('e'.repeat(512));\n` +
  `process.stdin.on('data', () => {});\n`;
const STDERR_SECRET_SCRIPT =
  `const fromEnv = process.env.MCP_TEST_OPAQUE_VALUE ?? '';\n` +
  `const fromArg = process.argv[2] ?? '';\n` +
  `const split = (label, value) => { process.stderr.write(label); process.stderr.write(value.slice(0, Math.ceil(value.length / 2))); process.stderr.write(value.slice(Math.ceil(value.length / 2)) + '\\n'); };\n` +
  `split('opaque=', fromEnv);\n` +
  `split('argument=', fromArg);\n` +
  `setTimeout(() => process.exit(17), 10);\n`;

async function main() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-executor-test-'));
  const echoScript = path.join(tmpDir, 'echo.cjs');
  const idleScript = path.join(tmpDir, 'idle.cjs');
  const markerScript = path.join(tmpDir, 'marker.cjs');
  const argvEnvScript = path.join(tmpDir, 'argv-env.cjs');
  const oversizeScript = path.join(tmpDir, 'oversize.cjs');
  const stderrScript = path.join(tmpDir, 'stderr.cjs');
  const stderrSecretScript = path.join(tmpDir, 'stderr-secret.cjs');
  await fs.writeFile(echoScript, ECHO_SCRIPT);
  await fs.writeFile(idleScript, IDLE_SCRIPT);
  await fs.writeFile(markerScript, MARKER_SCRIPT);
  await fs.writeFile(argvEnvScript, ARGV_ENV_SCRIPT);
  await fs.writeFile(oversizeScript, OVERSIZE_SCRIPT);
  await fs.writeFile(stderrScript, STDERR_SCRIPT);
  await fs.writeFile(stderrSecretScript, STDERR_SECRET_SCRIPT);

  // (1) start + initialize echo round trip through the child's stdin/stdout.
  {
    const { executor, sent } = makeExecutor();
    executor.handleMcpStartRequest({
      type: 'mcp_start_request',
      requestId: 'start-1',
      channelId: 'ch-1',
      config: { command: process.execPath, args: [echoScript] },
    });
    const start = await waitFor(sent, isStartResponse);
    assert.equal(start.requestId, 'start-1');
    assert.equal(start.ok, true);

    const payload = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };
    executor.handleMcpMessage({ type: 'mcp_message', channelId: 'ch-1', payload });
    const echoed = await waitFor(
      sent,
      (m): m is McpMessage =>
        m.type === 'mcp_message' && m.channelId === 'ch-1' && JSON.stringify(m.payload) === JSON.stringify(payload)
    );
    assert.deepEqual(echoed.payload, payload);

    executor.handleMcpStopRequest({ type: 'mcp_stop_request', requestId: 'stop-1', channelId: 'ch-1' });
    console.log('(1) start → initialize echo round trip via mcp_message: OK');
  }

  // (2) start_response requestId + stop kills the child and answers ok:true.
  {
    const { executor, sent } = makeExecutor();
    executor.handleMcpStartRequest({
      type: 'mcp_start_request',
      requestId: 'start-2',
      channelId: 'ch-2',
      config: { command: process.execPath, args: [idleScript] },
    });
    const start = await waitFor(sent, isStartResponse);
    assert.equal(start.requestId, 'start-2');
    assert.equal(start.ok, true);

    const pidMsg = await waitFor(sent, isPidMessage);
    const pid = (pidMsg.payload as { pid: number }).pid;

    executor.handleMcpStopRequest({ type: 'mcp_stop_request', requestId: 'stop-2', channelId: 'ch-2' });
    const stop = await waitFor(sent, isStopResponse);
    assert.equal(stop.requestId, 'stop-2');
    assert.equal(stop.ok, true);
    await waitForProcessExit(pid); // the child's 'exit' fired and the OS tore it down

    // Stopping an unknown channel is idempotent-ok.
    executor.handleMcpStopRequest({ type: 'mcp_stop_request', requestId: 'stop-2b', channelId: 'never-existed' });
    const stopB = await waitFor(sent, (m): m is StopResponse => isStopResponse(m) && m.requestId === 'stop-2b');
    assert.equal(stopB.ok, true);
    console.log('(2) start_response requestId + stop kills child + idempotent stop: OK');
  }

  // (3) nonexistent command → ok:false with an error string.
  {
    const { executor, sent } = makeExecutor();
    executor.handleMcpStartRequest({
      type: 'mcp_start_request',
      requestId: 'start-3',
      channelId: 'ch-3',
      config: { command: 'definitely-not-a-real-command-xyz' },
    });
    const start = await waitFor(sent, isStartResponse);
    assert.equal(start.ok, false);
    assert.ok(typeof start.error === 'string' && start.error.length > 0, 'error string must be present');
    console.log('(3) nonexistent command → start_response ok:false with error: OK');
  }

  // (4) handleDisconnect kills every running child; no crash.
  {
    const { executor, sent } = makeExecutor();
    executor.handleMcpStartRequest({
      type: 'mcp_start_request',
      requestId: 'start-4a',
      channelId: 'ch-4a',
      config: { command: process.execPath, args: [idleScript] },
    });
    executor.handleMcpStartRequest({
      type: 'mcp_start_request',
      requestId: 'start-4b',
      channelId: 'ch-4b',
      config: { command: process.execPath, args: [idleScript] },
    });
    await waitFor(sent, (m): m is StartResponse => isStartResponse(m) && m.requestId === 'start-4a');
    await waitFor(sent, (m): m is StartResponse => isStartResponse(m) && m.requestId === 'start-4b');
    const pidMessages = await waitForCount(sent, isPidMessage, 2);
    const pids = pidMessages.map((m) => (m.payload as { pid: number }).pid);

    executor.handleDisconnect();
    for (const pid of pids) await waitForProcessExit(pid);
    console.log('(4) handleDisconnect kills all children without crashing: OK');
  }

  // (5) duplicate start for the same channel: immediate ok:true, no respawn.
  {
    const { executor, sent } = makeExecutor();
    const config = { command: process.execPath, args: [markerScript] };
    executor.handleMcpStartRequest({
      type: 'mcp_start_request',
      requestId: 'start-5a',
      channelId: 'ch-5',
      config,
    });
    await waitFor(sent, (m): m is StartResponse => isStartResponse(m) && m.requestId === 'start-5a');

    executor.handleMcpStartRequest({
      type: 'mcp_start_request',
      requestId: 'start-5b',
      channelId: 'ch-5',
      config,
    });
    const second = await waitFor(sent, (m): m is StartResponse => isStartResponse(m) && m.requestId === 'start-5b');
    assert.equal(second.ok, true);

    // Give a hypothetical second spawn time to write its marker line; there
    // must still be exactly one spawned-marker mcp_message.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const markers = sent.filter(
      (m): m is McpMessage => m.type === 'mcp_message' && (m.payload as { spawned?: unknown })?.spawned === true
    );
    assert.equal(markers.length, 1, 'a second mcp_start_request must not spawn another child');

    executor.handleMcpStopRequest({ type: 'mcp_stop_request', requestId: 'stop-5', channelId: 'ch-5' });
    console.log('(5) duplicate start for the same channel is idempotent (no respawn): OK');
  }

  // (6) argv is literal (no shell metachar interpretation) and host secrets
  // are not inherited unless the MCP config explicitly supplies them.
  {
    const secretKey = 'MCP_EXECUTOR_SECRET_SHOULD_NOT_LEAK';
    const explicitKey = 'MCP_EXECUTOR_EXPLICIT_ENV';
    const previousSecret = process.env[secretKey];
    process.env[secretKey] = 'host-only-secret';
    const literalArgs = [
      'semi;colon',
      'ampersand&echo injected',
      'pipe|more',
      'redirect>never-created',
      '$(whoami)',
      '`whoami`',
      '%PATH%',
      'spaces "quotes" and \\slashes',
    ];

    const { executor, sent } = makeExecutor();
    try {
      executor.handleMcpStartRequest({
        type: 'mcp_start_request',
        requestId: 'start-6',
        channelId: 'ch-6',
        config: {
          command: process.execPath,
          args: [argvEnvScript, ...literalArgs],
          env: { [explicitKey]: 'explicit-value' },
        },
      });
      const start = await waitFor(sent, (m): m is StartResponse => isStartResponse(m) && m.requestId === 'start-6');
      assert.equal(start.ok, true);
      const report = await waitFor(
        sent,
        (m): m is McpMessage =>
          m.type === 'mcp_message' &&
          m.channelId === 'ch-6' &&
          Array.isArray((m.payload as { argv?: unknown }).argv)
      );
      const payload = report.payload as { argv: string[]; inheritedSecret?: string; explicitEnv?: string };
      assert.deepEqual(payload.argv, literalArgs, 'metacharacters and whitespace must survive as literal argv');
      assert.equal(payload.inheritedSecret, undefined, 'unconfigured host secrets must not cross the process boundary');
      assert.equal(payload.explicitEnv, 'explicit-value', 'explicit MCP env must be passed to the child');
    } finally {
      executor.handleMcpStopRequest({ type: 'mcp_stop_request', requestId: 'stop-6', channelId: 'ch-6' });
      if (previousSecret === undefined) delete process.env[secretKey];
      else process.env[secretKey] = previousSecret;
    }
    console.log('(6) metacharacters stay literal and only explicitly configured env crosses the boundary: OK');
  }

  // (7) execution-boundary validation remains effective even if a future
  // caller bypasses transport.ts' decoder.
  {
    const { executor, sent } = makeExecutor();
    const invalidConfigs: unknown[] = [
      { command: '' },
      { command: process.execPath, args: 'not-an-array' },
      { command: process.execPath, env: { TOKEN: 42 } },
      { command: process.execPath, cwd: 42 },
    ];
    for (const [index, config] of invalidConfigs.entries()) {
      const requestId = `start-7-${index}`;
      executor.handleMcpStartRequest({
        type: 'mcp_start_request',
        requestId,
        channelId: `ch-7-${index}`,
        config,
      } as unknown as MCPStartRequestMessage);
      const response = await waitFor(
        sent,
        (m): m is StartResponse => isStartResponse(m) && m.requestId === requestId
      );
      assert.equal(response.ok, false);
      assert.match(response.error ?? '', /^Invalid MCP stdio config:/);
    }
    console.log('(7) malformed command, args, env and cwd are rejected before spawn: OK');
  }

  // (8) a child cannot force unbounded line retention, and the relay cannot
  // force an unbounded stdin write. Both channels remain usable afterwards.
  {
    const { executor, sent } = makeExecutor({ maxStdoutLineBytes: 128, maxInboundPayloadBytes: 128 });
    executor.handleMcpStartRequest({
      type: 'mcp_start_request',
      requestId: 'start-8',
      channelId: 'ch-8',
      config: { command: process.execPath, args: [oversizeScript] },
    });
    const start = await waitFor(sent, (m): m is StartResponse => isStartResponse(m) && m.requestId === 'start-8');
    assert.equal(start.ok, true);
    await waitFor(
      sent,
      (m): m is McpMessage =>
        m.type === 'mcp_message' && m.channelId === 'ch-8' && (m.payload as { afterOversize?: unknown }).afterOversize === true
    );

    executor.handleMcpMessage({
      type: 'mcp_message',
      channelId: 'ch-8',
      payload: { jsonrpc: '2.0', id: 'too-large', method: 'test', params: { blob: 'x'.repeat(512) } },
    });
    const rejection = await waitFor(
      sent,
      (m): m is McpMessage =>
        m.type === 'mcp_message' &&
        m.channelId === 'ch-8' &&
        (m.payload as { id?: unknown }).id === 'too-large' &&
        typeof (m.payload as { error?: unknown }).error === 'object'
    );
    assert.equal((rejection.payload as { error: { code: number } }).error.code, -32600);

    const smallPayload = { jsonrpc: '2.0', id: 'small', method: 'ping' };
    executor.handleMcpMessage({ type: 'mcp_message', channelId: 'ch-8', payload: smallPayload });
    await waitFor(
      sent,
      (m): m is McpMessage =>
        m.type === 'mcp_message' &&
        m.channelId === 'ch-8' &&
        (m.payload as { id?: unknown }).id === 'small' &&
        (m.payload as { method?: unknown }).method === 'ping'
    );
    executor.handleMcpStopRequest({ type: 'mcp_stop_request', requestId: 'stop-8', channelId: 'ch-8' });
    console.log('(8) stdout-line and inbound-payload ceilings reject only the offending frame: OK');
  }

  // (9) stderr is useful for diagnostics but cannot flood the console forever.
  {
    const originalConsoleError = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => logged.push(args.map(String).join(' '));
    const { executor, sent } = makeExecutor({ maxStderrBytes: 64 });
    try {
      executor.handleMcpStartRequest({
        type: 'mcp_start_request',
        requestId: 'start-9',
        channelId: 'ch-9',
        config: { command: process.execPath, args: [stderrScript] },
      });
      const start = await waitFor(sent, (m): m is StartResponse => isStartResponse(m) && m.requestId === 'start-9');
      assert.equal(start.ok, true);
      const deadline = Date.now() + 5_000;
      while (!logged.some((line) => line.includes('further stderr suppressed')) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(logged.some((line) => line.includes('further stderr suppressed after 64 bytes')));
      assert.ok(!logged.some((line) => line.includes('e'.repeat(65))), 'no log entry may contain more than the cap');
    } finally {
      executor.handleMcpStopRequest({ type: 'mcp_stop_request', requestId: 'stop-9', channelId: 'ch-9' });
      console.error = originalConsoleError;
    }
    console.log('(9) stderr logging is capped and reports suppression once: OK');
  }

  // (10) Diagnostics are assembled as complete bounded lines before
  // redaction. Every explicit env value and argv entry is confidential, so
  // opaque names and split process writes cannot bypass the scrubber.
  {
    const envSecret = 'local-agent-opaque-env-value-7ebcf53b';
    const argvSecret = 'local-agent-opaque-argv-value-5a41d906';
    const originalConsoleError = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => logged.push(args.map(String).join(' '));
    const { executor, sent } = makeExecutor({ maxStderrBytes: 1_024, readyGraceMs: 2_000 });
    try {
      executor.handleMcpStartRequest({
        type: 'mcp_start_request',
        requestId: 'start-10',
        channelId: 'ch-10',
        config: {
          command: process.execPath,
          args: [stderrSecretScript, argvSecret],
          env: { MCP_TEST_OPAQUE_VALUE: envSecret },
        },
      });
      const start = await waitFor(
        sent,
        (m): m is StartResponse => isStartResponse(m) && m.requestId === 'start-10'
      );
      assert.equal(start.ok, false);
      const diagnostics = `${logged.join('\n')}\n${start.error ?? ''}`;
      assert.ok(diagnostics.includes('[REDACTED]'), 'diagnostics should retain an explicit redaction marker');
      assert.ok(!diagnostics.includes(envSecret), 'opaque env value must not appear in logs or backend response');
      assert.ok(!diagnostics.includes(argvSecret), 'argv value must not appear in logs or backend response');
    } finally {
      console.error = originalConsoleError;
      executor.handleMcpStopRequest({ type: 'mcp_stop_request', requestId: 'stop-10', channelId: 'ch-10' });
    }
    console.log('(10) opaque env/argv values are redacted across split stderr writes: OK');
  }

  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  console.log('\nmcpExecutor: all tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
