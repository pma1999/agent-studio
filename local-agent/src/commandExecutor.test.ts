/**
 * Plain-script test (repo convention: `tsx`, `node:assert`, no test-framework
 * dependency — matches `scripts/test-command-safety.ts` et al.) covering the
 * behaviors called out in the task brief's Tests section:
 *   (a) a Tier-1 command never reaches `child_process.spawn`.
 *   (b) a Tier-2 command sends `command_awaiting_confirmation` before
 *       blocking on console input, and respects both the `yes` and timeout
 *       paths (including a direct, simulated-stdin test of the real
 *       `createConsoleConfirmer` console module).
 *   (c) a `cwd` resolving outside `AGENT_WORKSPACE_ROOT` is rejected when
 *       `allowOutsideWorkspace` is false and allowed when true.
 *   (d) stdout/stderr are emitted as multiple `command_output_chunk`
 *       messages as they arrive, not buffered into one.
 * Plus a bonus cancellation check (killTreeFn invoked, a command_response
 * still follows) since it is cheap and directly exercises a named risk.
 *
 * Plus (Remediation Round 2): a real-process regression test for the
 * `PATHEXT`-omission bug (see task-01 report) — spawns real
 * `pwsh`/`powershell` on this machine via `buildSafeEnv()` +
 * `buildShellInvocation()` (the exact same functions `defaultSpawnFn` uses),
 * running a native external executable (not a PowerShell cmdlet), matching
 * `shellDetection.test.ts`'s established convention of real-process checks
 * for this exact class of PowerShell bug (a unit-level assertion on the env
 * object alone cannot prove PowerShell actually launches/waits/captures
 * stdio from a native child correctly).
 *
 * Plus (quick-local-agent-python-utf8): a real-process regression test for
 * the `PYTHONIOENCODING`-omission bug (a Python child crashing with
 * `UnicodeEncodeError` when printing emoji to a redirected pipe) — same
 * real-spawn, win32-gated, graceful-skip pattern as the PATHEXT check above.
 */

import assert from 'node:assert/strict';
import { spawn as realSpawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import {
  buildSafeEnv,
  createCommandExecutor,
  createConsoleConfirmer,
  type CommandExecutorOptions,
  type KillTreeFn,
  type MinimalChildProcess,
  type QuestionerLike,
  type SpawnFn,
} from './commandExecutor.js';
import { buildShellInvocation, createShellDetector } from './shellDetection.js';
import type { AgentToBackendMessage } from './transport.js';

const WORKSPACE = path.resolve('C:\\agent-studio-test-workspace');

class FakeChildProcess extends EventEmitter implements MinimalChildProcess {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill(): boolean {
    return true;
  }
}

function makeSpawnFn(): { spawnFn: SpawnFn; children: FakeChildProcess[] } {
  const children: FakeChildProcess[] = [];
  const spawnFn: SpawnFn = () => {
    const child = new FakeChildProcess();
    children.push(child);
    return child;
  };
  return { spawnFn, children };
}

/**
 * Fixed to `cmd` in tests: with `spawnFn` faked out entirely (every test
 * below injects its own `spawnFn` that ignores the `ShellInvocation` it
 * receives and returns a `FakeChildProcess`), the specific detected shell
 * never affects test behavior — only `buildShellInvocation`'s own dedicated
 * coverage in `shellDetection.test.ts` exercises the encoding differences.
 */
const TEST_SHELL: CommandExecutorOptions['shell'] = { kind: 'cmd', execPath: 'C:\\Windows\\System32\\cmd.exe' };

function makeExecutor(overrides: Partial<CommandExecutorOptions> & { spawnFn?: SpawnFn } = {}) {
  const sent: AgentToBackendMessage[] = [];
  const options: CommandExecutorOptions = {
    workspaceRoot: WORKSPACE,
    allowOutsideWorkspace: false,
    send: (message) => sent.push(message),
    confirmTier2: async () => 'approved',
    shell: TEST_SHELL,
    ...overrides,
  };
  return { executor: createCommandExecutor(options), sent };
}

function findResponse(sent: AgentToBackendMessage[]) {
  return sent.find((m) => m.type === 'command_response') as Extract<AgentToBackendMessage, { type: 'command_response' }>;
}

async function main() {
  // (a) Tier-1 command never reaches spawn.
  {
    let spawnCalled = false;
    const spawnFn: SpawnFn = () => {
      spawnCalled = true;
      throw new Error('spawn must not be called for a Tier-1 command');
    };
    const { executor, sent } = makeExecutor({ spawnFn });
    await executor.handleCommandRequest({ type: 'command_request', requestId: 'r-tier1', command: 'diskpart', timeoutMs: 5_000 });
    assert.equal(spawnCalled, false, 'Tier-1 command reached spawn');
    const response = findResponse(sent);
    assert.ok(response, 'expected a command_response for a Tier-1 command');
    assert.equal(response.blockedPattern, 'diskpart');
    assert.equal(response.confirmation, undefined);
    console.log('(a) Tier-1 command never reaches spawn: OK');
  }

  // (b1) Tier-2: command_awaiting_confirmation is sent before console read is invoked.
  {
    const order: string[] = [];
    const { spawnFn, children } = makeSpawnFn();
    const { executor } = makeExecutor({
      send: (message) => order.push(`send:${message.type}`),
      confirmTier2: async () => {
        order.push('confirm:called');
        return 'approved';
      },
      spawnFn,
    });
    await executor.handleCommandRequest({
      type: 'command_request',
      requestId: 'r-order',
      command: 'git push --force origin main',
      timeoutMs: 5_000,
    });
    children[0]?.emit('close', 0); // let the approved execution finish so no timer is left pending
    assert.deepEqual(
      order.slice(0, 2),
      ['send:command_awaiting_confirmation', 'confirm:called'],
      'command_awaiting_confirmation must be sent before blocking on console input'
    );
    console.log('(b1) command_awaiting_confirmation precedes console read: OK');
  }

  // (b2) Tier-2 approved ("yes") path executes and reports confirmation: 'approved'.
  {
    const { spawnFn, children } = makeSpawnFn();
    const { executor, sent } = makeExecutor({ confirmTier2: async () => 'approved', spawnFn });
    await executor.handleCommandRequest({
      type: 'command_request',
      requestId: 'r-approved',
      command: 'git push --force origin main',
      timeoutMs: 5_000,
    });
    assert.equal(children.length, 1, 'approved Tier-2 command must execute');
    children[0].emit('close', 0);
    const response = findResponse(sent);
    assert.equal(response.confirmation, 'approved');
    assert.equal(response.exitCode, 0);
    console.log('(b2) Tier-2 approved path executes: OK');
  }

  // (b3) Tier-2 timeout path never executes and reports confirmation: 'timeout'.
  {
    let spawnCalled = false;
    const spawnFn: SpawnFn = () => {
      spawnCalled = true;
      throw new Error('must not spawn on timeout');
    };
    const { executor, sent } = makeExecutor({ confirmTier2: async () => 'timeout', spawnFn });
    await executor.handleCommandRequest({
      type: 'command_request',
      requestId: 'r-timeout',
      command: 'git push --force origin main',
      timeoutMs: 5_000,
    });
    assert.equal(spawnCalled, false, 'declined/timed-out Tier-2 command must not execute');
    const response = findResponse(sent);
    assert.equal(response.confirmation, 'timeout');
    assert.equal(response.exitCode, null);
    console.log('(b3) Tier-2 timeout path skips execution: OK');
  }

  // (b4) Direct, simulated-stdin coverage of the real console confirmer.
  {
    const yesRl: QuestionerLike = { question: async () => 'yes' };
    assert.equal(await createConsoleConfirmer(yesRl, 1_000)('rm -rf /'), 'approved');

    const noRl: QuestionerLike = { question: async () => 'nope' };
    assert.equal(await createConsoleConfirmer(noRl, 1_000)('rm -rf /'), 'declined');

    const neverAnswersRl: QuestionerLike = {
      question: (_query, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    };
    assert.equal(await createConsoleConfirmer(neverAnswersRl, 20)('rm -rf /'), 'timeout');
    console.log('(b4) createConsoleConfirmer yes/declined/timeout (simulated stdin): OK');
  }

  // (c) cwd resolving outside the workspace root.
  {
    const { spawnFn, children } = makeSpawnFn();
    const { executor, sent } = makeExecutor({ allowOutsideWorkspace: false, spawnFn });
    await executor.handleCommandRequest({ type: 'command_request', requestId: 'r-cwd-blocked', command: 'echo hi', cwd: '..', timeoutMs: 5_000 });
    assert.equal(children.length, 0, 'cwd outside workspace root must be rejected when allowOutsideWorkspace is false');
    assert.equal(findResponse(sent).blockedPattern, 'cwd-outside-workspace');
    console.log('(c1) cwd outside workspace root rejected by default: OK');
  }
  {
    const { spawnFn, children } = makeSpawnFn();
    const { executor, sent } = makeExecutor({ allowOutsideWorkspace: true, spawnFn });
    await executor.handleCommandRequest({ type: 'command_request', requestId: 'r-cwd-allowed', command: 'echo hi', cwd: '..', timeoutMs: 5_000 });
    assert.equal(children.length, 1, 'cwd outside workspace root must be allowed when allowOutsideWorkspace is true');
    children[0].emit('close', 0);
    assert.equal(findResponse(sent).blockedPattern, undefined);
    console.log('(c2) cwd outside workspace root allowed with allowOutsideWorkspace: OK');
  }

  // (d) stdout/stderr streamed as multiple chunk messages, not buffered.
  {
    const { spawnFn, children } = makeSpawnFn();
    const { executor, sent } = makeExecutor({ spawnFn });
    await executor.handleCommandRequest({ type: 'command_request', requestId: 'r-stream', command: 'echo hi', timeoutMs: 5_000 });
    const child = children[0];
    child.stdout.emit('data', Buffer.from('line one\n'));
    child.stdout.emit('data', Buffer.from('line two\n'));
    child.stderr.emit('data', Buffer.from('a warning\n'));
    child.emit('close', 0);

    const chunks = sent.filter((m) => m.type === 'command_output_chunk');
    assert.equal(chunks.length, 3, 'each data event must produce its own command_output_chunk message');
    const response = findResponse(sent);
    assert.equal(response.stdout, 'line one\nline two\n');
    assert.equal(response.stderr, 'a warning\n');
    assert.equal(response.exitCode, 0);
    console.log('(d) stdout/stderr streamed incrementally as separate chunks: OK');
  }

  // (bonus) cancellation invokes killTreeFn and a command_response still follows.
  {
    const { spawnFn, children } = makeSpawnFn();
    let killedPid: number | undefined;
    const killTreeFn: KillTreeFn = (child) => {
      killedPid = child.pid;
    };
    const { executor, sent } = makeExecutor({ spawnFn, killTreeFn });
    await executor.handleCommandRequest({ type: 'command_request', requestId: 'r-cancel', command: 'echo hi', timeoutMs: 5_000 });
    executor.handleCommandCancel('r-cancel');
    assert.equal(killedPid, children[0].pid, 'cancel must invoke killTreeFn on the request active child');
    children[0].emit('close', 1); // simulate the process actually terminating after the kill signal
    assert.ok(findResponse(sent), 'a command_response must still be sent after cancellation');
    console.log('(bonus) command_cancel kills the active child and still resolves with a command_response: OK');
  }

  // (ARC-02) in-memory accumulation and live-relayed chunk volume are both
  // capped per stream, with a truncation marker appended once the ceiling is
  // hit, and further data for that stream is dropped rather than growing
  // without bound.
  {
    const { spawnFn, children } = makeSpawnFn();
    const { executor, sent } = makeExecutor({ spawnFn, maxOutputCharsPerStream: 20 });
    await executor.handleCommandRequest({ type: 'command_request', requestId: 'r-cap', command: 'echo hi', timeoutMs: 5_000 });
    const child = children[0];
    child.stdout.emit('data', Buffer.from('a'.repeat(15))); // under the cap: kept in full
    child.stdout.emit('data', Buffer.from('b'.repeat(15))); // pushes past the 20-char cap: truncated + marker
    child.stdout.emit('data', Buffer.from('c'.repeat(15))); // arrives after capped: must be dropped entirely
    child.emit('close', 0);

    const stdoutChunks = sent.filter((m) => m.type === 'command_output_chunk' && m.stream === 'stdout') as Extract<
      AgentToBackendMessage,
      { type: 'command_output_chunk' }
    >[];
    // Expect exactly 3 relayed stdout chunks: the first data event kept in
    // full, the truncated remainder of the second event (5 chars fit the
    // remaining capacity), and a separate truncation-marker chunk — the
    // third data event (all "c"s) must not produce any chunk at all.
    assert.equal(stdoutChunks.length, 3, 'no further chunks may be relayed once the per-stream cap is hit');
    assert.equal(stdoutChunks[0].text, 'a'.repeat(15));
    assert.equal(stdoutChunks[1].text, 'b'.repeat(5), 'the second chunk must be truncated to the remaining capacity');
    assert.ok(stdoutChunks[2].text.includes('truncated locally'), 'a truncation marker must be relayed once the cap is hit');
    assert.ok(
      !sent.some((m) => m.type === 'command_output_chunk' && m.text.includes('c'.repeat(15))),
      'no bytes from the third (post-cap) data event may leak through'
    );

    const response = findResponse(sent);
    // The final command_response's accumulated stdout must be exactly the
    // 20 real characters that fit under the cap (never the full 45 the
    // process actually wrote — the third data event's "c"s must never reach
    // the accumulator), plus the truncation marker.
    assert.ok(response.stdout.startsWith('a'.repeat(15) + 'b'.repeat(5)), 'kept prefix must match what was under the cap');
    assert.ok(!response.stdout.includes('c'.repeat(15)), 'no output beyond the cap may reach the final command_response');
    assert.ok(response.stdout.includes('truncated locally'), 'the final command_response must carry a truncated-locally indicator');
    console.log('(ARC-02) per-stream output accumulation and relay are both capped: OK');
  }

  // (ARC-04) disconnect kills every active child process rather than letting
  // it keep running with no live connection to report back to.
  {
    const { spawnFn, children } = makeSpawnFn();
    const killedPids: number[] = [];
    const killTreeFn: KillTreeFn = (child) => {
      killedPids.push(child.pid!);
    };
    const { executor } = makeExecutor({ spawnFn, killTreeFn });
    await executor.handleCommandRequest({ type: 'command_request', requestId: 'r-disc-1', command: 'echo one', timeoutMs: 5_000 });
    await executor.handleCommandRequest({ type: 'command_request', requestId: 'r-disc-2', command: 'echo two', timeoutMs: 5_000 });
    assert.equal(children.length, 2, 'both commands must have spawned before disconnect');

    executor.handleDisconnect();

    assert.deepEqual(
      killedPids.sort(),
      children.map((c) => c.pid).sort(),
      'handleDisconnect must kill every active child tied to in-flight requests'
    );
    // Simulate the OS actually tearing the processes down after the kill
    // signal; must not throw or hang even with no live connection left.
    children[0].emit('close', 1);
    children[1].emit('close', 1);
    console.log('(ARC-04) disconnect kills every active child process: OK');
  }

  // (PATHEXT regression, Remediation Round 2) real-process check: SAFE_ENV_KEYS
  // must include PATHEXT, or pwsh/powershell silently fail to properly
  // launch/wait-for/capture-stdio-from a native external command (returns
  // exit 0 with empty stdout instead of erroring) — see task-01 report for
  // the full root-cause diagnosis. This spawns real pwsh/powershell via the
  // exact same buildSafeEnv()/buildShellInvocation() functions
  // defaultSpawnFn uses, running whoami.exe (a native executable, not a
  // PowerShell cmdlet — the one class of command this bug affects).
  if (process.platform === 'win32') {
    for (const kind of ['pwsh', 'powershell'] as const) {
      const probe = spawnSync(kind, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0']);
      if (probe.error || probe.status !== 0) {
        console.log(`(skip) PATHEXT regression check for ${kind}: not installed on this machine`);
        continue;
      }
      const invocation = buildShellInvocation({ kind, execPath: kind }, 'whoami.exe');
      const child = realSpawn(invocation.file, invocation.args, { env: buildSafeEnv() });
      let stdout = '';
      const exitCode: number | null = await new Promise((resolve) => {
        child.stdout.on('data', (d) => (stdout += d));
        child.on('close', (code) => resolve(code));
      });
      assert.equal(exitCode, 0, `${kind}: whoami.exe via buildSafeEnv() must exit 0`);
      assert.ok(
        stdout.trim().length > 0,
        `${kind}: whoami.exe must produce non-empty stdout when PATHEXT is present in buildSafeEnv() ` +
          `(empty stdout here means SAFE_ENV_KEYS regressed to omit PATHEXT again — the exact bug this test guards against)`
      );
      console.log(`(PATHEXT) ${kind}: buildSafeEnv() lets a native command (whoami.exe) run and report output correctly: OK`);
    }
  } else {
    console.log('(skip) PATHEXT regression check: not on win32');
  }

  // (PYTHONIOENCODING regression, quick-local-agent-python-utf8) real-process
  // check: a real Python process spawned through the exact buildSafeEnv() +
  // buildShellInvocation() + spawn path (not a mocked SpawnFn) that prints an
  // emoji must not raise UnicodeEncodeError. Mirrors the PATHEXT real-process
  // check above (real spawn, real buildSafeEnv()/buildShellInvocation(),
  // win32-gated, graceful skip if the interpreter isn't installed) because
  // this exact bug class — a Python child falling back to the host's legacy
  // console codepage once its stdout/stderr become a redirected pipe — is
  // invisible to unit tests that mock spawnFn/fake children.
  if (process.platform === 'win32') {
    const pythonLauncher = ['python', 'py'].find((candidate) => {
      const probe = spawnSync(candidate, ['--version']);
      return !probe.error && probe.status === 0;
    });
    if (!pythonLauncher) {
      console.log('(skip) PYTHONIOENCODING regression check: no python/py interpreter installed on this machine');
    } else {
      // Negative control, run first: informational, not asserted as a hard
      // failure. It normally reproduces the crash this fix exists to prevent
      // when PYTHONIOENCODING is absent from the child's env (i.e.
      // buildSafeEnv() before this fix) — an emoji printed to a redirected
      // pipe with only PATH forwarded, the same shape buildSafeEnv() produced
      // previously. But whether this reproduces is itself host-codepage-
      // dependent (e.g. a machine with Windows' "Use Unicode UTF-8 for
      // worldwide language support" beta setting enabled has ACP/OEMCP already
      // at 65001, so the unpatched control would *not* crash there either) —
      // asserting a specific host codepage here would reintroduce exactly the
      // machine-dependence this fix exists to eliminate, so it is logged, not
      // asserted. The positive assertions below (via buildSafeEnv()) are the
      // actual regression guard and hold regardless of host codepage.
      const emojiPrintCommand = `${pythonLauncher} -c "print(chr(0x2705))"`;
      const controlChild = realSpawn(pythonLauncher, ['-c', 'print(chr(0x2705))'], { env: { PATH: process.env.PATH } });
      let controlStderr = '';
      const controlExitCode: number | null = await new Promise((resolve) => {
        controlChild.stderr.on('data', (d) => (controlStderr += d));
        controlChild.on('close', (code) => resolve(code));
      });
      if (controlExitCode !== 0 && controlStderr.includes('UnicodeEncodeError')) {
        console.log('(control) confirmed: without PYTHONIOENCODING, this machine reproduces UnicodeEncodeError on an emoji print to a piped stdout');
      } else {
        console.log(
          "(note) this machine's default codepage already encodes UTF-8 (or otherwise did not crash without PYTHONIOENCODING); " +
            'negative control inconclusive here, proceeding to the positive assertions'
        );
      }

      // The actual fix, exercised through the real spawn path: buildSafeEnv()
      // + buildShellInvocation() + spawn, using whichever shell this machine
      // actually detects (pwsh/powershell/cmd), running the emoji-printing
      // Python one-liner.
      const shell = createShellDetector()();
      const invocation = buildShellInvocation(shell, emojiPrintCommand);
      const env = buildSafeEnv();
      const child = invocation.useShellTrue
        ? realSpawn(invocation.command, { shell: true, env })
        : realSpawn(invocation.file, invocation.args, { env });
      let stdout = '';
      let stderr = '';
      const exitCode: number | null = await new Promise((resolve) => {
        child.stdout!.on('data', (d) => (stdout += d));
        child.stderr!.on('data', (d) => (stderr += d));
        child.on('close', (code) => resolve(code));
      });
      assert.equal(exitCode, 0, `python via buildSafeEnv()/buildShellInvocation() must exit 0 when printing an emoji, got stderr: ${stderr.slice(0, 500)}`);
      assert.ok(!stderr.includes('UnicodeEncodeError'), `stderr must not contain UnicodeEncodeError: ${stderr.slice(0, 500)}`);
      assert.ok(stdout.includes('✅'), `stdout must contain the actual emoji when decoded as UTF-8, got: ${JSON.stringify(stdout)}`);
      console.log(`(PYTHONIOENCODING) ${pythonLauncher} via ${shell.kind}: buildSafeEnv() lets an emoji-printing Python one-liner run and report output without a UnicodeEncodeError: OK`);
    }
  } else {
    console.log('(skip) PYTHONIOENCODING regression check: not on win32');
  }

  console.log('\ncommandExecutor: all tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
