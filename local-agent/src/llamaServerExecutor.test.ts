/**
 * Plain-script acceptance test for `llamaServerExecutor.ts` (task 1 of the
 * llamacpp-local-provider bundle). Repo convention: `tsx`,
 * `node:assert/strict`, no test framework, no real processes — every process
 * creation goes through the injected `spawnFn` seam (including the Windows
 * taskkill killer spawns), and stop grace windows use short real timeouts
 * with generous polling waits instead of a timer-mocking library (none exists
 * in this repo).
 *
 * Coverage:
 *   (a)  validation refusals BEFORE any spawn — relative exePath,
 *        nonexistent exePath, wrong basename, non-loopback host, port out of
 *        range, second-spawn while tracked (exact §2 error string).
 *   (b)  successful spawn — exact argv/options passed to spawn
 *        ({shell:false, windowsHide:true, cwd:dirname(exePath)}), pid in the
 *        response, status reports running with startedAt from nowMs.
 *   (c)  posix soft→hard — SIGTERM then SIGKILL after graceMs, forced:true.
 *   (d)  win32 soft→hard — taskkill /pid P then /pid P /t /f after graceMs,
 *        forced:true; child dying during grace resolves promptly forced:false.
 *   (e)  idempotent stops — unknown pid and stale/mismatched pid both answer
 *        ok:true without touching anything.
 *   (f)  exactly-once exit push with stderrTail; spontaneous death carries no
 *        terminatedByAgent; late duplicate close ignored; status afterwards.
 *   (g)  64 KiB ring buffer + logs bounded by maxBytes + truncated flag;
 *        respawn works after a child exited.
 *   (h)  scan — case-insensitive .gguf inclusion, mmproj* exclusion,
 *        path/name/sizeBytes entries, non-recursive, truncation at 2000,
 *        bad/relative dir refused.
 *   (i)  handleDisconnect kills the tracked child (hard tree kill on win32),
 *        emits terminatedByAgent:true exactly once, stays usable.
 *   (j)  synchronous spawn throw → ok:false, nothing tracked.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import {
  createLlamaServerExecutor,
  LLAMACPP_RING_BUFFER_BYTES,
  SCAN_ENTRY_CAP,
  type LlamaServerExecutorOptions,
} from './llamaServerExecutor.js';
import type { MinimalChildProcess } from './commandExecutor.js';
import type {
  AgentToBackendMessage,
  LlamacppSpawnMessage,
} from './transport.js';

type ExitedEvent = Extract<AgentToBackendMessage, { type: 'llamacpp_exited' }>;
type SpawnResponse = Extract<AgentToBackendMessage, { type: 'llamacpp_spawn_response' }>;
type StopResponse = Extract<AgentToBackendMessage, { type: 'llamacpp_stop_response' }>;
type StatusResponse = Extract<AgentToBackendMessage, { type: 'llamacpp_status_response' }>;
type LogsResponse = Extract<AgentToBackendMessage, { type: 'llamacpp_logs_response' }>;
type ScanResponse = Extract<AgentToBackendMessage, { type: 'llamacpp_scan_response' }>;

/** Fake child satisfying MinimalChildProcess; stdio are EventEmitters. */
class FakeChildProcess extends EventEmitter implements MinimalChildProcess {
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kills: Array<NodeJS.Signals | number | undefined> = [];

  constructor(pid: number | undefined) {
    super();
    this.pid = pid;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal);
    return true;
  }
  emitStdout(chunk: string | Buffer) {
    this.stdout.emit('data', chunk);
  }
  emitStderr(chunk: string | Buffer) {
    this.stderr.emit('data', chunk);
  }
  emitClose(code: number | null) {
    this.exitCode = code;
    this.emit('close', code);
  }
}

interface Harness {
  executor: ReturnType<typeof createLlamaServerExecutor>;
  sent: AgentToBackendMessage[];
  spawnCalls: Array<{ cmd: string; args: string[]; options: object }>;
  children: FakeChildProcess[];
}

let nextPid = 4242;

function makeHarness(
  overrides: Partial<LlamaServerExecutorOptions> & { failSpawn?: boolean } = {}
): Harness {
  const sent: AgentToBackendMessage[] = [];
  const spawnCalls: Array<{ cmd: string; args: string[]; options: object }> = [];
  const children: FakeChildProcess[] = [];
  const spawnFn = (cmd: string, args: string[], o: object): MinimalChildProcess => {
    if (overrides.failSpawn) throw new Error('spawn exploded');
    spawnCalls.push({ cmd, args, options: o });
    const child = new FakeChildProcess(nextPid);
    nextPid += 1;
    children.push(child);
    return child;
  };
  const executor = createLlamaServerExecutor({
    send: (message) => sent.push(message),
    platform: 'win32',
    nowMs: () => 1_234_567_890,
    ...overrides,
    spawnFn: overrides.spawnFn ?? spawnFn,
  });
  return { executor, sent, spawnCalls, children };
}

function spawnMsg(overrides: Partial<LlamacppSpawnMessage> = {}): LlamacppSpawnMessage {
  return {
    type: 'llamacpp_spawn',
    requestId: 'sp',
    exePath: FIXTURE_WIN_EXE,
    host: '127.0.0.1',
    port: 8712,
    args: ['--model', 'm.gguf'],
    ...overrides,
  };
}

function findSent<T extends AgentToBackendMessage['type']>(
  sent: AgentToBackendMessage[],
  type: T
): Array<Extract<AgentToBackendMessage, { type: T }>> {
  return sent.filter((m): m is Extract<AgentToBackendMessage, { type: T }> => m.type === type);
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Shared fixture: one temp dir holding correctly-named binaries for both
// platforms plus a wrongly-named one for the basename refusal test.
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llamacpp-exec-test-'));
const FIXTURE_WIN_EXE = path.join(fixtureDir, 'llama-server.exe');
const FIXTURE_POSIX_EXE = path.join(fixtureDir, 'llama-server');
const FIXTURE_WRONG_NAME = path.join(fixtureDir, 'other.exe');
fs.writeFileSync(FIXTURE_WIN_EXE, '');
fs.writeFileSync(FIXTURE_POSIX_EXE, '');
fs.writeFileSync(FIXTURE_WRONG_NAME, '');

async function main() {
  // (a) Validation refusals — all BEFORE any process starts.
  {
    const { executor, sent, spawnCalls } = makeHarness();
    executor.handleLlamacppScan({ type: 'llamacpp_scan_request', requestId: 's0', dir: fixtureDir }); // sanity: unrelated

    executor.handleLlamacppSpawn(spawnMsg({ requestId: 'v-rel', exePath: 'tools\\llama-server.exe' }));
    assert.match(findSent(sent, 'llamacpp_spawn_response').at(-1)!.error!, /absolute/i);

    const nonexistent = path.join(os.tmpdir(), `no-such-dir-${Date.now()}`, 'llama-server.exe');
    executor.handleLlamacppSpawn(spawnMsg({ requestId: 'v-miss', exePath: nonexistent }));
    assert.match(findSent(sent, 'llamacpp_spawn_response').at(-1)!.error!, /exist/i);

    executor.handleLlamacppSpawn(spawnMsg({ requestId: 'v-name', exePath: FIXTURE_WRONG_NAME }));
    assert.match(findSent(sent, 'llamacpp_spawn_response').at(-1)!.error!, /llama-server/i);

    executor.handleLlamacppSpawn(
      spawnMsg({ requestId: 'v-host', host: '0.0.0.0' as unknown as '127.0.0.1' })
    );
    assert.match(findSent(sent, 'llamacpp_spawn_response').at(-1)!.error!, /loopback/i);

    for (const [label, port] of [
      ['low', 1023],
      ['high', 65536],
    ] as const) {
      executor.handleLlamacppSpawn(spawnMsg({ requestId: `v-port-${label}`, port }));
      assert.match(
        findSent(sent, 'llamacpp_spawn_response').at(-1)!.error!,
        /port/i,
        `port ${label} must be refused`
      );
    }

    assert.equal(spawnCalls.length, 0, 'no refusals may reach the spawn seam');

    // Successful tracked spawn, then a second spawn attempt.
    executor.handleLlamacppSpawn(spawnMsg({ requestId: 'v-first' }));
    assert.equal(findSent(sent, 'llamacpp_spawn_response').at(-1)!.ok, true);
    executor.handleLlamacppSpawn(spawnMsg({ requestId: 'v-second' }));
    const second = findSent(sent, 'llamacpp_spawn_response').at(-1)!;
    assert.equal(second.ok, false);
    assert.equal(second.error, 'llama-server already running; stop it first');
    console.log('(a) validation refusals before any spawn + exact second-spawn error: OK');
  }

  // (b) Successful spawn: exact argv/options, pid reported, status running.
  {
    const { executor, sent, spawnCalls, children } = makeHarness();
    const args = ['--host', '127.0.0.1', '--port', '8712', '--model', 'm.gguf'];
    executor.handleLlamacppSpawn(spawnMsg({ requestId: 'b1', args }));
    const response = findSent(sent, 'llamacpp_spawn_response').at(-1)!;
    assert.deepEqual(
      { ok: response.ok, pid: response.pid },
      { ok: true, pid: children[0].pid }
    );
    assert.equal(spawnCalls.length, 1);
    assert.deepEqual(spawnCalls[0], {
      cmd: FIXTURE_WIN_EXE,
      args,
      options: { shell: false, windowsHide: true, cwd: path.dirname(FIXTURE_WIN_EXE) },
    });

    executor.handleLlamacppStatus({ type: 'llamacpp_status_request', requestId: 'b2' });
    const status = findSent(sent, 'llamacpp_status_response').at(-1)!;
    assert.equal(status.running, true);
    assert.equal(status.pid, children[0].pid);
    assert.equal(status.exePath, FIXTURE_WIN_EXE);
    assert.deepEqual(status.args, args);
    assert.equal(status.host, '127.0.0.1');
    assert.equal(status.port, 8712);
    assert.equal(status.startedAt, 1_234_567_890);
    console.log('(b) successful spawn passes exact argv/options and status shows running: OK');
    children[0].emitClose(0); // clean up for later sections reusing state
  }

  // (c) posix soft→hard: SIGTERM → SIGKILL, forced:true on hard path.
  {
    const { executor, sent, children } = makeHarness({ platform: 'linux' });
    executor.handleLlamacppSpawn(spawnMsg({ requestId: 'c1', exePath: FIXTURE_POSIX_EXE }));
    const child = children[0];
    executor.handleLlamacppStop({ type: 'llamacpp_stop', requestId: 'c2', pid: child.pid!, graceMs: 20 });
    assert.deepEqual(child.kills, ['SIGTERM'], 'posix soft stop sends SIGTERM first');
    await waitFor(() => findSent(sent, 'llamacpp_stop_response').length > 0, 'posix stop response');
    const stop = findSent(sent, 'llamacpp_stop_response').at(-1)!;
    assert.equal(stop.ok, true);
    assert.equal(stop.forced, true, 'SIGKILL escalation must mark forced:true');
    assert.ok(child.kills.includes('SIGKILL'), 'SIGKILL sent after grace');
    child.emitClose(null); // SIGKILL takes the child down (exitCode stays null)
    await waitFor(() => findSent(sent, 'llamacpp_exited').length > 0, 'posix exited push');
    assert.equal(findSent(sent, 'llamacpp_exited').at(-1)!.terminatedByAgent, true);
    console.log('(c) posix SIGTERM→SIGKILL grace sequencing with forced:true: OK');
  }

  // (d) win32 soft→hard taskkill sequencing; prompt resolution when the
  //     child dies during the grace window.
  {
    const { executor, sent, spawnCalls, children } = makeHarness();
    executor.handleLlamacppSpawn(spawnMsg({ requestId: 'd1' }));
    const child = children[0];
    const pidArg = String(child.pid);
    executor.handleLlamacppStop({ type: 'llamacpp_stop', requestId: 'd2', pid: child.pid!, graceMs: 30 });
    assert.deepEqual(spawnCalls[1], {
      cmd: 'taskkill',
      args: ['/pid', pidArg],
      options: { shell: false, windowsHide: true },
    }, 'win32 soft kill runs taskkill /pid P first');
    await waitFor(() => findSent(sent, 'llamacpp_stop_response').length > 0, 'win32 stop response', 5000);
    const stop = findSent(sent, 'llamacpp_stop_response').at(-1)!;
    assert.equal(stop.forced, true);
    assert.deepEqual(spawnCalls[2]?.args, ['/pid', pidArg, '/t', '/f'], 'hard tree kill follows grace');
    child.emitClose(null); // the hard kill takes the child down
    await waitFor(() => findSent(sent, 'llamacpp_exited').length > 0, 'win32 exited push');
    assert.equal(findSent(sent, 'llamacpp_exited').at(-1)!.terminatedByAgent, true);

    // Child dies during grace window → prompt forced:false, no hard kill.
    const { executor: exec2, sent: sent2, spawnCalls: calls2, children: kids2 } = makeHarness();
    exec2.handleLlamacppSpawn(spawnMsg({ requestId: 'd3' }));
    exec2.handleLlamacppStop({ type: 'llamacpp_stop', requestId: 'd4', pid: kids2[0].pid!, graceMs: 10_000 });
    kids2[0].emitClose(0);
    const began = Date.now();
    await waitFor(() => findSent(sent2, 'llamacpp_stop_response').length > 0, 'prompt stop response', 2000);
    assert.ok(Date.now() - began < 5_000, 'stop resolved promptly on child death during grace');
    assert.equal(findSent(sent2, 'llamacpp_stop_response').at(-1)!.forced, false);
    assert.equal(calls2.length, 2, 'only the soft taskkill was issued');
    console.log('(d) win32 taskkill soft→hard + prompt forced:false when death wins the race: OK');
  }

  // (e) Idempotent stops: unknown pid, stale pid, duplicate stop.
  {
    const { executor, sent, spawnCalls, children } = makeHarness();
    executor.handleLlamacppStop({ type: 'llamacpp_stop', requestId: 'e-none', pid: 7777, graceMs: 50 });
    assert.equal(findSent(sent, 'llamacpp_stop_response').at(-1)!.ok, true);
    assert.equal(spawnCalls.length, 0, 'no taskkill for unknown pid');

    executor.handleLlamacppSpawn(spawnMsg({ requestId: 'e-spawn' }));
    executor.handleLlamacppStop({ type: 'llamacpp_stop', requestId: 'e-stale', pid: 9999, graceMs: 50 });
    assert.equal(findSent(sent, 'llamacpp_stop_response').at(-1)!.ok, true);
    assert.equal(children[0].kills.length, 0, 'stale pid must not touch the live child');
    assert.equal(spawnCalls.length, 1);

    executor.handleLlamacppStop({ type: 'llamacpp_stop', requestId: 'e-stop1', pid: children[0].pid!, graceMs: 10_000 });
    executor.handleLlamacppStop({ type: 'llamacpp_stop', requestId: 'e-stop2', pid: children[0].pid!, graceMs: 10_000 });
    assert.equal(findSent(sent, 'llamacpp_stop_response').at(-1)!.requestId, 'e-stop2');
    assert.equal(findSent(sent, 'llamacpp_stop_response').filter((r) => r.requestId === 'e-stop2').length, 1);
    assert.equal(spawnCalls.length, 2, 'duplicate stop does not double-issue the soft kill');
    children[0].emitClose(0);
    await waitFor(
      () => findSent(sent, 'llamacpp_stop_response').some((r) => r.requestId === 'e-stop1'),
      'first stop resolution'
    );
    console.log('(e) idempotent stop of unknown/stale pid + duplicate stop handling: OK');
  }

  // (f) Exactly-once exit push carrying stderrTail; spontaneous deaths carry
  //     no terminatedByAgent; status reflects the last exit.
  {
    const { executor, sent, children } = makeHarness();
    executor.handleLlamacppSpawn(spawnMsg({ requestId: 'f1' }));
    const child = children[0];
    child.emitStderr('llama_init: boom\n');
    child.emitStderr('second line\n');
    child.emitStdout('stdout noise\n');
    child.emitClose(3);
    const exits = findSent(sent, 'llamacpp_exited');
    assert.equal(exits.length, 1, 'exactly one exited push per child death');
    const event = exits[0] as ExitedEvent;
    assert.equal(event.pid, child.pid);
    assert.equal(event.exitCode, 3);
    assert.ok(event.stderrTail!.includes('llama_init: boom'));
    assert.ok(event.stderrTail!.includes('second line'));
    assert.equal(event.terminatedByAgent, undefined, 'spontaneous death is not agent-terminated');

    child.emitClose(3); // late duplicate close must be ignored
    assert.equal(findSent(sent, 'llamacpp_exited').length, 1);

    executor.handleLlamacppStatus({ type: 'llamacpp_status_request', requestId: 'f2' });
    const status = findSent(sent, 'llamacpp_status_response').at(-1)! as StatusResponse;
    assert.equal(status.running, false);
    assert.equal(status.lastExitCode, 3);
    assert.equal(status.lastExitAt, 1_234_567_890);
    assert.equal(status.pid, null);
    console.log('(f) exactly-once exited push with stderrTail + post-exit status: OK');
  }

  // (g) Ring buffer caps at 64 KiB; logs responses bounded by maxBytes;
  //     respawn allowed after exit.
  {
    assert.equal(LLAMACPP_RING_BUFFER_BYTES, 64 * 1024);
    const { executor, sent, children } = makeHarness();
    executor.handleLlamacppSpawn(spawnMsg({ requestId: 'g1' }));
    children[0].emitStdout('A'.repeat(70_000));
    children[0].emitClose(null);

    executor.handleLlamacppLogs({ type: 'llamacpp_logs_request', requestId: 'g2', maxBytes: 65_536 });
    let logs = findSent(sent, 'llamacpp_logs_response').at(-1)! as LogsResponse;
    assert.equal(logs.ok, true);
    assert.equal(logs.text!.length, 65_536, 'ring holds only the last 64 KiB');
    assert.equal(logs.truncated, true, 'older bytes were dropped');
    assert.ok(logs.text!.split('').every((c) => c === 'A'));

    executor.handleLlamacppLogs({ type: 'llamacpp_logs_request', requestId: 'g3', maxBytes: 10 });
    logs = findSent(sent, 'llamacpp_logs_response').at(-1)! as LogsResponse;
    assert.equal(logs.text!.length, 10, 'response never exceeds maxBytes');
    assert.equal(logs.truncated, true);

    // Respawn after exit is allowed (single-slot applies to tracked children only).
    executor.handleLlamacppSpawn(spawnMsg({ requestId: 'g4' }));
    children[1].emitStdout('abcde');
    executor.handleLlamacppLogs({ type: 'llamacpp_logs_request', requestId: 'g5', maxBytes: 65_536 });
    logs = findSent(sent, 'llamacpp_logs_response').at(-1)! as LogsResponse;
    assert.deepEqual({ text: logs.text, truncated: logs.truncated }, { text: 'abcde', truncated: false });
    console.log('(g) 64 KiB ring cap + maxBytes-bounded logs + respawn after exit: OK');
  }

  // (h) Scan filtering and cap.
  {
    const { executor, sent } = makeHarness();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llamacpp-scan-test-'));
    fs.writeFileSync(path.join(dir, 'm.gguf'), '12345');
    fs.writeFileSync(path.join(dir, 'N.GGUF'), 'x'); // case-insensitive extension
    fs.writeFileSync(path.join(dir, 'mmproj-f16.gguf'), 'projection');
    fs.writeFileSync(path.join(dir, 'MMproj-other.gguf'), 'projection');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'nope');
    fs.mkdirSync(path.join(dir, 'sub.gguf_dir')); // directories never listed

    executor.handleLlamacppScan({ type: 'llamacpp_scan_request', requestId: 'h1', dir });
    const scan = findSent(sent, 'llamacpp_scan_response').at(-1)! as ScanResponse;
    assert.equal(scan.ok, true);
    assert.deepEqual(scan.entries, [
      { path: path.join(dir, 'N.GGUF'), name: 'N.GGUF', sizeBytes: 1 },
      { path: path.join(dir, 'm.gguf'), name: 'm.gguf', sizeBytes: 5 },
    ]);
    assert.notEqual(scan.truncated, true);

    executor.handleLlamacppScan({ type: 'llamacpp_scan_request', requestId: 'h2', dir: 'relative/path' });
    assert.equal(findSent(sent, 'llamacpp_scan_response').at(-1)!.ok, false);

    executor.handleLlamacppScan({
      type: 'llamacpp_scan_request',
      requestId: 'h3',
      dir: path.join(os.tmpdir(), `definitely-missing-${Date.now()}`),
    });
    assert.equal(findSent(sent, 'llamacpp_scan_response').at(-1)!.ok, false);

    // Truncation at the 2000-entry cap.
    const bigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llamacpp-scan-cap-'));
    for (let i = 0; i < SCAN_ENTRY_CAP + 2; i += 1) {
      fs.writeFileSync(path.join(bigDir, `model-${String(i).padStart(6, '0')}.gguf`), '');
    }
    executor.handleLlamacppScan({ type: 'llamacpp_scan_request', requestId: 'h4', dir: bigDir });
    const capped = findSent(sent, 'llamacpp_scan_response').at(-1)! as ScanResponse;
    assert.equal(capped.entries!.length, SCAN_ENTRY_CAP, 'entries hard-capped at 2000');
    assert.equal(capped.truncated, true, 'truncation flag set past the cap');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(bigDir, { recursive: true, force: true });
    console.log('(h) scan filter (.GGUF/mmproj/non-recursive) + 2000-entry truncation: OK');
  }

  // (i) handleDisconnect: hard tree kill + single agent-terminated push.
  {
    const { executor, sent, spawnCalls, children } = makeHarness();
    executor.handleLlamacppSpawn(spawnMsg({ requestId: 'i1' }));
    const pidArg = String(children[0].pid!);
    executor.handleDisconnect();
    assert.deepEqual(spawnCalls.at(-1), {
      cmd: 'taskkill',
      args: ['/pid', pidArg, '/t', '/f'],
      options: { shell: false, windowsHide: true },
    }, 'disconnect uses the hard tree kill on win32');
    children[0].emitClose(null); // the kill takes the child down
    await waitFor(() => findSent(sent, 'llamacpp_exited').length > 0, 'disconnect exited push');
    assert.equal(findSent(sent, 'llamacpp_exited').length, 1);
    assert.equal(findSent(sent, 'llamacpp_exited')[0].terminatedByAgent, true);

    executor.handleDisconnect(); // idempotent: nothing tracked anymore
    assert.equal(findSent(sent, 'llamacpp_exited').length, 1);

    // Executor persists across reconnects: a fresh spawn works afterwards.
    executor.handleLlamacppSpawn(spawnMsg({ requestId: 'i2' }));
    assert.equal(findSent(sent, 'llamacpp_spawn_response').at(-1)!.ok, true);
    children[1].emitClose(0);
    console.log('(i) handleDisconnect hard-kills tracked child + terminatedByAgent once: OK');
  }

  // (j) Synchronous spawn failure → ok:false, nothing tracked.
  {
    const { executor, sent } = makeHarness({ failSpawn: true });
    executor.handleLlamacppSpawn(spawnMsg({ requestId: 'j1' }));
    const response = findSent(sent, 'llamacpp_spawn_response').at(-1)!;
    assert.equal(response.ok, false);
    assert.match(response.error!, /exploded/);
    executor.handleLlamacppStatus({ type: 'llamacpp_status_request', requestId: 'j2' });
    assert.equal((findSent(sent, 'llamacpp_status_response').at(-1)! as StatusResponse).running, false);
    console.log('(j) synchronous spawn throw answered ok:false with nothing tracked: OK');
  }

  fs.rmSync(fixtureDir, { recursive: true, force: true });
  console.log('\nAll llamaServerExecutor.test sections passed.');
}

main().catch((error) => {
  console.error('llamaServerExecutor.test FAILED:', error);
  process.exit(1);
});
