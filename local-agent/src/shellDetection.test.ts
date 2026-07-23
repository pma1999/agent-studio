/**
 * Plain-script test (repo convention: `tsx`, `node:assert`, no test-framework
 * dependency — matches `commandExecutor.test.ts`; manually run, not wired
 * into any `npm test` script). Covers the fallback-ordering and memoization
 * scenarios called out in the task brief's Tests/Acceptance Criteria
 * sections, using an injected fake `spawnSync`-like function for detection
 * (no real process spawning there) — plus, since Remediation Round 1
 * (ARC-03/RC-03), a handful of real-process regression scenarios that spawn
 * actual `powershell.exe`/`pwsh` on this machine (Windows real spawns are
 * the only way to catch a PowerShell parser/argument-position regression
 * like the one that round found; matches this codebase's existing
 * convention of exercising real OS state in local-agent tests, e.g.
 * `fileOpsExecutor.test.ts`'s real on-disk delete-tier checks).
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createShellDetector, buildShellInvocation, type DetectedShell, type SpawnSyncLike } from './shellDetection.js';

const ok = { status: 0 };
const notFound = { status: null, error: new Error('ENOENT') };

/** Runs `fn` with `process.platform` temporarily overridden, then restores it. */
function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

/** Builds a fake `spawnSync`-like probe: succeeds only for execPaths in `available`, and records every call. */
function makeFakeProbe(available: string[]): { probe: SpawnSyncLike; calls: string[] } {
  const calls: string[] = [];
  const probe: SpawnSyncLike = (execPath) => {
    calls.push(execPath);
    return available.includes(execPath) ? ok : notFound;
  };
  return { probe, calls };
}

function main() {
  // pwsh present -> picks pwsh (first in preference order).
  withPlatform('win32', () => {
    const { probe } = makeFakeProbe(['pwsh']);
    const detect = createShellDetector(probe);
    const shell = detect();
    assert.equal(shell.kind, 'pwsh');
    assert.equal(shell.execPath, 'pwsh');
  });
  console.log('(1) pwsh found -> picks pwsh: OK');

  // pwsh absent, powershell present -> picks powershell.
  withPlatform('win32', () => {
    const { probe } = makeFakeProbe(['powershell']);
    const detect = createShellDetector(probe);
    const shell = detect();
    assert.equal(shell.kind, 'powershell');
    assert.equal(shell.execPath, 'powershell');
  });
  console.log('(2) pwsh absent, powershell found -> picks powershell: OK');

  // both absent -> falls back to cmd (no probe needed for cmd itself).
  withPlatform('win32', () => {
    const { probe, calls } = makeFakeProbe([]);
    const detect = createShellDetector(probe);
    const shell = detect();
    assert.equal(shell.kind, 'cmd');
    assert.ok(shell.execPath.length > 0);
    assert.deepEqual(calls, ['pwsh', 'powershell'], 'must probe pwsh then powershell before falling back to cmd');
  });
  console.log('(3) both pwsh and powershell absent -> falls back to cmd: OK');

  // POSIX: bash present -> picks bash.
  withPlatform('linux', () => {
    const { probe } = makeFakeProbe(['bash']);
    const detect = createShellDetector(probe);
    const shell = detect();
    assert.equal(shell.kind, 'bash');
    assert.equal(shell.execPath, 'bash');
  });
  console.log('(4) POSIX bash found -> picks bash: OK');

  // POSIX: bash absent -> falls back to sh.
  withPlatform('linux', () => {
    const { probe, calls } = makeFakeProbe([]);
    const detect = createShellDetector(probe);
    const shell = detect();
    assert.equal(shell.kind, 'sh');
    assert.equal(shell.execPath, 'sh');
    assert.deepEqual(calls, ['bash'], 'must probe bash before falling back to sh');
  });
  console.log('(5) POSIX bash absent -> falls back to sh: OK');

  // Memoization: a second call to the same detector instance must not re-invoke the probe.
  withPlatform('win32', () => {
    const { probe, calls } = makeFakeProbe(['pwsh']);
    const detect = createShellDetector(probe);
    const first = detect();
    const second = detect();
    assert.deepEqual(first, second);
    assert.equal(calls.length, 1, 'the probe function must only be invoked once across repeated calls to the same detector');
  });
  console.log('(6) second call to the same detector instance does not re-probe (memoization): OK');

  // buildShellInvocation: pwsh/powershell use -EncodedCommand, utf16le/base64 encoded,
  // with the empirically-required $ProgressPreference guard kept OUTSIDE an isolated
  // `& { ... }` script block wrapping the command completely unmodified (see
  // shellDetection.ts's Remediation comment, ARC-03/RC-03) — the encoded payload
  // decodes back to guard-line + `& { <exact original command> }`, and the
  // invocation's own `command` field stays the exact, unmodified original text.
  {
    const command = 'echo "hi there" && exit 1';
    const invocation = buildShellInvocation({ kind: 'pwsh', execPath: 'pwsh' }, command);
    assert.equal(invocation.file, 'pwsh');
    assert.equal(invocation.useShellTrue, false);
    assert.equal(invocation.command, command, 'the command field itself must stay the exact original text');
    assert.deepEqual(invocation.args.slice(0, 3), ['-NoLogo', '-NoProfile', '-NonInteractive']);
    assert.equal(invocation.args[3], '-EncodedCommand');
    const encoded = invocation.args[4];
    const decoded = Buffer.from(encoded, 'base64').toString('utf16le');
    assert.equal(
      decoded,
      `$ProgressPreference = 'SilentlyContinue'\n& {\n${command}\n}`,
      'must decode to the progress-suppression guard line followed by the exact original command wrapped in its own & { } script block'
    );
    assert.ok(decoded.includes(command), 'the original command text must survive byte-for-byte, unmodified, inside the wrapper');
  }
  console.log(
    '(7) buildShellInvocation encodes pwsh/powershell commands via -EncodedCommand, with the progress guard kept outside an unmodified & { } wrapper: OK'
  );

  // buildShellInvocation: bash/sh use plain -c argv, no shell:true.
  {
    const command = 'echo hi && exit 1';
    const invocation = buildShellInvocation({ kind: 'bash', execPath: 'bash' }, command);
    assert.equal(invocation.file, 'bash');
    assert.deepEqual(invocation.args, ['-c', command]);
    assert.equal(invocation.useShellTrue, false);
  }
  console.log('(8) buildShellInvocation builds explicit -c argv for bash/sh: OK');

  // buildShellInvocation: cmd keeps useShellTrue (today's exact spawn(command, {shell:true,...}) path).
  {
    const command = 'echo hi && exit 1';
    const invocation = buildShellInvocation({ kind: 'cmd', execPath: 'C:\\Windows\\System32\\cmd.exe' }, command);
    assert.equal(invocation.useShellTrue, true);
    assert.equal(invocation.command, command);
  }
  console.log('(9) buildShellInvocation keeps cmd on the useShellTrue path: OK');

  console.log('\nshellDetection: all tests passed (structural/detection)');
}

/** Runs `shell`'s real, actual invocation for `command` and returns exit code + streams. */
function spawnReal(shell: DetectedShell, command: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const invocation = buildShellInvocation(shell, command);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.file, invocation.args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Remediation Round 1 (ARC-03/RC-03) regression coverage: spawns the real
 * `powershell.exe`/`pwsh` on this machine (Windows-only, matching this
 * component's own platform scope) to prove the fix empirically, not just
 * structurally — a purely structural assertion on the built invocation
 * cannot catch a PowerShell parser/argument-position regression the way
 * actually running it can (this is exactly how the regression itself was
 * first missed, then caught).
 */
async function realProcessRegressionTests(): Promise<void> {
  if (process.platform !== 'win32') {
    console.log('(skip) real-process PowerShell regression tests: not on win32');
    return;
  }

  for (const shell of [
    { kind: 'pwsh', execPath: 'pwsh' },
    { kind: 'powershell', execPath: 'powershell' },
  ] as const) {
    // (a) A leading param() block must still be recognized as the script's
    // parameter declaration (the exact case ARC-03/RC-03 broke) — must not
    // error and must not fall through to "param not recognized as a cmdlet".
    {
      const result = await spawnReal(shell, `param($Name)\nWrite-Output "Hello, $Name"`);
      assert.equal(result.code, 0, `${shell.kind}: leading param() block must still exit 0`);
      assert.ok(!result.stderr.includes("'param'"), `${shell.kind}: param must not be misinterpreted as an unrecognized command`);
      assert.ok(result.stdout.includes('Hello,'), `${shell.kind}: param() block script must still run and produce output`);
    }

    // (a2) [CmdletBinding()] immediately preceding param() — same requirement.
    {
      const result = await spawnReal(shell, `[CmdletBinding()]\nparam($Name)\nWrite-Output "Hi, $Name"`);
      assert.equal(result.code, 0, `${shell.kind}: [CmdletBinding()] + param() must still exit 0`);
      assert.ok(!result.stderr.includes("'param'"), `${shell.kind}: param must not be misinterpreted with CmdletBinding present`);
    }

    // (b) The original CLIXML progress-noise issue must not regress: a
    // trivial one-line command must produce clean stderr.
    {
      const result = await spawnReal(shell, `Write-Output "hello world" ; exit 7`);
      assert.equal(result.code, 7, `${shell.kind}: exit code must propagate through the wrapper`);
      assert.equal(result.stdout, 'hello world\r\n', `${shell.kind}: stdout must be exactly the command's own output`);
      assert.equal(result.stderr, '', `${shell.kind}: stderr must stay clean (no CLIXML progress-noise regression)`);
    }

    // (c) Ordinary multi-line scripts with embedded quotes/newlines still work.
    {
      const command = `Write-Output "quoted 'text' and a newline\nsecond line" ; exit 7`;
      const result = await spawnReal(shell, command);
      assert.equal(result.code, 7);
      assert.equal(result.stdout, "quoted 'text' and a newline\nsecond line\r\n");
    }
  }
  console.log('(10) real-process PowerShell regression suite (param()/[CmdletBinding()]/CLIXML-noise/quoting) on pwsh + powershell: OK');
}

async function run(): Promise<void> {
  main();
  await realProcessRegressionTests();
  console.log('\nshellDetection: all tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
