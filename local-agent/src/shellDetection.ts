/**
 * Startup-time detection of the best available shell for the current
 * process, memoized for the process lifetime, plus the explicit-argv
 * invocation builder `commandExecutor.ts`'s spawn call site uses.
 *
 * Preference order: on win32, `pwsh` -> `powershell` -> `cmd` (last resort,
 * no probe needed — `cmd.exe` always exists on a supported Windows install).
 * On POSIX, `bash` -> `sh` (same last-resort reasoning — `sh` always
 * exists). See the task brief's Rationale section for why pwsh/powershell
 * use `-EncodedCommand` rather than `-Command`.
 */

import { spawnSync } from 'node:child_process';

export type ShellKind = 'pwsh' | 'powershell' | 'cmd' | 'bash' | 'sh';

export interface DetectedShell {
  kind: ShellKind;
  execPath: string;
}

export interface ShellInvocation {
  file: string;
  args: string[];
  useShellTrue: boolean;
  command: string;
}

/** Minimal shape of `child_process.spawnSync`'s result a fake can satisfy in tests. */
export interface SpawnSyncResultLike {
  status: number | null;
  error?: Error;
}

export type SpawnSyncLike = (execPath: string, args: string[]) => SpawnSyncResultLike;

const PROBE_TIMEOUT_MS = 5_000;

const defaultSpawnSync: SpawnSyncLike = (execPath, args) => {
  try {
    return spawnSync(execPath, args, { windowsHide: true, timeout: PROBE_TIMEOUT_MS });
  } catch (error) {
    return { status: null, error: error as Error };
  }
};

/**
 * Pinned per the task brief's Rationale/Named-Risks section: the minimal
 * probe that confirms the interpreter starts and exits cleanly, without
 * loading a profile, prompting interactively, or printing a logo.
 */
const POWERSHELL_PROBE_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'];
const POSIX_SHELL_PROBE_ARGS = ['-c', 'exit 0'];

function probeSucceeds(spawnSyncFn: SpawnSyncLike, execPath: string, args: string[]): boolean {
  const result = spawnSyncFn(execPath, args);
  return !result.error && result.status === 0;
}

function detectWindowsShell(spawnSyncFn: SpawnSyncLike): DetectedShell {
  if (probeSucceeds(spawnSyncFn, 'pwsh', POWERSHELL_PROBE_ARGS)) return { kind: 'pwsh', execPath: 'pwsh' };
  if (probeSucceeds(spawnSyncFn, 'powershell', POWERSHELL_PROBE_ARGS)) return { kind: 'powershell', execPath: 'powershell' };
  // Last resort: cmd.exe always exists on a supported Windows install — no probe needed.
  return { kind: 'cmd', execPath: process.env.COMSPEC || 'cmd.exe' };
}

function detectPosixShell(spawnSyncFn: SpawnSyncLike): DetectedShell {
  if (probeSucceeds(spawnSyncFn, 'bash', POSIX_SHELL_PROBE_ARGS)) return { kind: 'bash', execPath: 'bash' };
  // Last resort: sh always exists on a POSIX system — no probe needed.
  return { kind: 'sh', execPath: 'sh' };
}

/**
 * Factory mirroring `createCommandExecutor`'s DI style (closure over local
 * state, no module-level singleton). The returned function memoizes its
 * result: detection runs at most once per factory instance, regardless of
 * how many times the returned function is called.
 */
export function createShellDetector(spawnSyncFn: SpawnSyncLike = defaultSpawnSync): () => DetectedShell {
  let cached: DetectedShell | undefined;
  return () => {
    if (!cached) {
      cached = process.platform === 'win32' ? detectWindowsShell(spawnSyncFn) : detectPosixShell(spawnSyncFn);
    }
    return cached;
  };
}

/**
 * Builds the explicit-argv invocation for `shell`. pwsh/powershell use
 * `-EncodedCommand` (base64 of the UTF-16LE command text) rather than
 * `-Command` — see the task brief's Rationale for why this sidesteps
 * PowerShell's own front-end argument-parsing quirks. bash/sh use `-c`
 * directly. `cmd` is the one exception: it keeps today's exact
 * `spawn(command, {shell:true, cwd, env})` path (`useShellTrue: true`), so
 * `commandExecutor.ts`'s spawn call site must branch on that flag rather
 * than always using `file`/`args`.
 */
export function buildShellInvocation(shell: DetectedShell, command: string): ShellInvocation {
  switch (shell.kind) {
    case 'pwsh':
    case 'powershell': {
      // Empirically verified (task-01 report, Decisions): stock Windows
      // PowerShell 5.1 (`powershell.exe` — the only PowerShell that ships
      // by default on Windows; `pwsh` is an opt-in install) emits a
      // `#< CLIXML ... progress ...` block on stderr for a routine
      // "preparing modules for first use" progress record on every
      // `-NonInteractive` invocation, even for a trivial one-line command.
      // Left unsuppressed, that would land on the model as spurious
      // error-looking noise on every single successful command run through
      // `powershell.exe`.
      //
      // Remediation (task-01 report, Round 1 — ARC-03/RC-03): an earlier
      // version of this fix prepended `$ProgressPreference =
      // 'SilentlyContinue'` directly ahead of `command` on its own line.
      // That broke any command whose first executable content must
      // legally be the *first statement* of the script — most importantly
      // a leading `param(...)` block (also `#Requires`, `[CmdletBinding()]`)
      // — because PowerShell only recognizes `param(...)` as a parameter
      // declaration when it is syntactically the first statement; with
      // `$ProgressPreference = ...` occupying that position instead,
      // PowerShell tried (and failed) to invoke `param` as a command,
      // *while still exiting 0* (the real error was buried in CLIXML on
      // stderr) — a silent-wrong-result regression on a common,
      // foreseeable script shape. Fixed by keeping `command` completely
      // unmodified and running it as the sole first statement of its own
      // isolated script block (`& { <command> }`), with the progress-
      // suppression assignment kept strictly *outside* that block:
      // `param(...)`/`#Requires`/`[CmdletBinding()]` are legal as the first
      // statement *of a script block* the same way they are for a script,
      // so this preserves both fixes at once. Empirically re-verified
      // (task-01 report, Remediation History) against real
      // `powershell.exe`/`pwsh`: a leading `param(...)` block now binds
      // correctly, the CLIXML noise stays suppressed, `exit <code>` from
      // inside the block still terminates the whole process with that
      // code, and `$env:`/`Set-Location` side effects made inside the
      // block still take effect process-wide (both are process-global,
      // not scriptblock-lexically-scoped).
      const guardedCommand = `$ProgressPreference = 'SilentlyContinue'\n& {\n${command}\n}`;
      const encoded = Buffer.from(guardedCommand, 'utf16le').toString('base64');
      return {
        file: shell.execPath,
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        useShellTrue: false,
        command,
      };
    }
    case 'bash':
    case 'sh':
      return { file: shell.execPath, args: ['-c', command], useShellTrue: false, command };
    case 'cmd':
      return { file: shell.execPath, args: [], useShellTrue: true, command };
  }
}
