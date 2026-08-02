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
 *       string (ENOENT 'error' on POSIX; cmd.exe "not recognized" exit on
 *       win32 — both before the ready grace window).
 *   (4) `handleDisconnect()` kills every running child without crashing.
 *   (5) a duplicate `mcp_start_request` for the same channel is idempotent:
 *       immediate ok:true and no second spawn (counted via stdout marker
 *       lines from each spawned child).
 *
 * Children are spawned through the executor's own `spawn` path, using
 * `process.execPath` (the node running tsx) with a small inline script file —
 * avoids PATH lookups and cmd.exe `-e` quoting on win32, where the executor
 * spawns with `shell:true`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMcpExecutor } from './mcpExecutor.js';
import type { AgentToBackendMessage } from './transport.js';

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

function makeExecutor() {
  const sent: AgentToBackendMessage[] = [];
  const executor = createMcpExecutor({ send: (message) => sent.push(message) });
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
async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<void> {
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

async function main() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-executor-test-'));
  const echoScript = path.join(tmpDir, 'echo.cjs');
  const idleScript = path.join(tmpDir, 'idle.cjs');
  const markerScript = path.join(tmpDir, 'marker.cjs');
  await fs.writeFile(echoScript, ECHO_SCRIPT);
  await fs.writeFile(idleScript, IDLE_SCRIPT);
  await fs.writeFile(markerScript, MARKER_SCRIPT);

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

  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  console.log('\nmcpExecutor: all tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
