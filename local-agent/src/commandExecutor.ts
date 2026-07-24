/**
 * Handles one `command_request` end to end: workspace-root cwd resolution,
 * the two-tier destructive-command guard (via `shared/commandSafety.ts`,
 * task-02 — reused as-is, never forked), the Tier-2 console confirmation
 * prompt, spawning, live output streaming, the timeout backstop, and
 * cancellation.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { scanCommand, isPathWithinRoot } from '../../shared/commandSafety.js';
import { buildShellInvocation, type DetectedShell, type ShellInvocation } from './shellDetection.js';
import type { AgentToBackendMessage, CommandRequestMessage } from './transport.js';

/**
 * Same allowlist-baseline principle as task-03's `mcp/client.ts`
 * `SAFE_STDIO_ENV_KEYS`.
 *
 * `PATHEXT` (Remediation Round 2 — empirically root-caused, see task-01
 * report): this key predates the pwsh/powershell explicit-argv rework and
 * was harmless while every Windows command ran through `cmd.exe`
 * (`shell:true`), which does not need it to run a native executable
 * correctly. It became load-bearing the moment `pwsh`/`powershell` became
 * the default Windows shell: without `PATHEXT` in the child's environment,
 * PowerShell silently fails to properly launch/wait-for/capture-stdio-from
 * *any* native external command (confirmed for Python and `whoami.exe`, on
 * both `pwsh` and Windows PowerShell 5.1) — it still exits 0, with empty
 * stdout and no side effects, so the failure is invisible unless you know
 * to look for it. Harmless to include unconditionally: `buildSafeEnv()`
 * below already skips any key absent from `process.env` (inert on POSIX,
 * where `PATHEXT` does not exist).
 */
const SAFE_ENV_KEYS = [
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
  'PATHEXT',
] as const;

export function buildSafeEnv(): NodeJS.ProcessEnv {
  const safeEnv: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) safeEnv[key] = value;
  }
  return safeEnv;
}

export const DEFAULT_CONFIRMATION_TIMEOUT_MS = 60_000;
const KILL_GRACE_PERIOD_MS = 3_000;

/**
 * Ceiling on how much stdout/stderr this local agent will accumulate in
 * memory *and* forward live over the WS relay, per stream, per command
 * (ARC-02). This is deliberately larger than the backend's own
 * `MAX_COMMAND_OUTPUT_CHARS` (64,000, in `server/tools/execCommand.ts`)
 * because this is the raw, pre-truncation capture point: the backend still
 * truncates (head+tail) whatever we send it down to its own final display
 * limit, so this cap only exists to stop a single runaway command (`yes`, an
 * infinite-loop script, a very verbose/looping build) from growing this
 * process's own memory or flooding the relay connection without bound for as
 * long as its own timeout allows (up to 1800s server-side). 2,000,000 chars
 * (~2MB) per stream is comfortably above anything a legitimate command's
 * useful output would need, while bounding worst-case per-command memory to a
 * few MB regardless of how long a misbehaving process keeps writing.
 */
export const DEFAULT_MAX_OUTPUT_CHARS_PER_STREAM = 2_000_000;

export type SendFn = (message: AgentToBackendMessage) => void;
export type ConfirmFn = (command: string) => Promise<'approved' | 'declined' | 'timeout'>;

/** Minimal shape both the real `child_process.spawn` result and test fakes satisfy. */
export interface MinimalChildProcess {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/**
 * Reworked (task-01) to take the already-built `ShellInvocation` rather than
 * a bare command string + `shell: true`. This is what lets pwsh/bash spawn
 * via explicit argv (`useShellTrue: false`) while `cmd` keeps today's exact
 * `spawn(command, {shell:true, cwd, env})` path (`useShellTrue: true`) — see
 * `shellDetection.ts`'s `buildShellInvocation`.
 */
export type SpawnFn = (
  invocation: ShellInvocation,
  options: { cwd: string; env: NodeJS.ProcessEnv }
) => MinimalChildProcess;

export type KillTreeFn = (child: MinimalChildProcess) => void;

const defaultSpawnFn: SpawnFn = (invocation, options) => {
  if (invocation.useShellTrue) {
    // Last-resort cmd.exe path: today's exact, unmodified call — Node's own
    // shell:true quoting for cmd.exe is correct and must not be hand-rolled.
    return spawn(invocation.command, { shell: true, cwd: options.cwd, env: options.env }) as unknown as MinimalChildProcess;
  }
  return spawn(invocation.file, invocation.args, { cwd: options.cwd, env: options.env }) as unknown as MinimalChildProcess;
};

/**
 * Best-effort process-tree kill. Plain `child.kill()` is not sufficient here:
 * the spawned shell (`pwsh.exe`/`powershell.exe`/`cmd.exe` on Windows,
 * whichever `createShellDetector()` picked — see `shellDetection.ts`) is
 * itself only an intermediary, and its own children do not reliably receive
 * a signal sent to that shell process itself, so a killed shell can leave
 * its real child (e.g. the `npm.cmd` -> `node.exe` it launched) still
 * running. On Windows we instead use `taskkill /pid <pid> /t /f` (`/t` =
 * kill the whole process tree) via a follow-up spawn, per the named risk in
 * the task brief — empirically verified (task-01 report) to still kill the
 * full tree regardless of which shell is the immediate child. Non-Windows
 * keeps a SIGTERM-then-SIGKILL grace period for when cross-platform support
 * lands.
 */
export const defaultKillTree: KillTreeFn = (child) => {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f']);
    return;
  }
  child.kill('SIGTERM');
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, KILL_GRACE_PERIOD_MS).unref?.();
};

export interface CommandExecutorOptions {
  workspaceRoot: string;
  allowOutsideWorkspace: boolean;
  send: SendFn;
  confirmTier2: ConfirmFn;
  /** Detected once at startup (`createShellDetector()`) and reused for every command. */
  shell: DetectedShell;
  spawnFn?: SpawnFn;
  killTreeFn?: KillTreeFn;
  /** Overridable for tests; defaults to `DEFAULT_MAX_OUTPUT_CHARS_PER_STREAM`. */
  maxOutputCharsPerStream?: number;
}

export interface CommandExecutor {
  handleCommandRequest(request: CommandRequestMessage): Promise<void>;
  handleCommandCancel(requestId: string): void;
  /**
   * Called when the transport connection to the backend has dropped (ARC-04):
   * kills every still-running child process tied to an in-flight request on
   * that now-dead connection, the same way `command_cancel` already kills a
   * process today, so a command doesn't keep running locally after the
   * backend has already given up on it.
   */
  handleDisconnect(): void;
}

/** Minimal shape of `readline/promises`'s `Interface.question` that a fake can satisfy in tests. */
export interface QuestionerLike {
  question(query: string, options?: { signal?: AbortSignal }): Promise<string>;
}

/**
 * The real, console-based Tier-2 `ConfirmFn`: prints the exact command and
 * waits up to `timeoutMs` (default 60s, per the brief) for the human to type
 * `yes`. This is a deliberate v1 scope decision (console prompt, not a native
 * GUI dialog) — see the task brief's Constraints.
 */
export function createConsoleConfirmer(rl: QuestionerLike, timeoutMs = DEFAULT_CONFIRMATION_TIMEOUT_MS): ConfirmFn {
  return async (command: string) => {
    console.log('\n' + '='.repeat(64));
    console.log('TIER-2 CONFIRMATION REQUIRED — this command needs your approval:');
    console.log(`  ${command}`);
    console.log(`Type "yes" within ${Math.round(timeoutMs / 1000)}s to run it, or anything else to decline.`);
    console.log('='.repeat(64));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const answer = await rl.question('> ', { signal: controller.signal });
      clearTimeout(timer);
      return answer.trim().toLowerCase() === 'yes' ? 'approved' : 'declined';
    } catch {
      clearTimeout(timer);
      return 'timeout';
    }
  };
}

export function createCommandExecutor(options: CommandExecutorOptions): CommandExecutor {
  const spawnFn = options.spawnFn ?? defaultSpawnFn;
  const killTreeFn = options.killTreeFn ?? defaultKillTree;
  const maxOutputCharsPerStream = options.maxOutputCharsPerStream ?? DEFAULT_MAX_OUTPUT_CHARS_PER_STREAM;
  const activeChildren = new Map<string, MinimalChildProcess>();

  function executeCommand(
    request: CommandRequestMessage,
    resolvedCwd: string,
    confirmation?: 'approved'
  ): void {
    const start = Date.now();
    let seq = 0;
    let stdoutAll = '';
    let stderrAll = '';
    let stdoutCapped = false;
    let stderrCapped = false;
    let finalized = false;

    const invocation = buildShellInvocation(options.shell, request.command);
    const child = spawnFn(invocation, { cwd: resolvedCwd, env: buildSafeEnv() });
    activeChildren.set(request.requestId, child);

    const backstop = setTimeout(() => killTreeFn(child), request.timeoutMs);

    /**
     * Shared handler for both streams (ARC-02): bounds in-memory
     * accumulation AND live-relayed volume together, since both are driven by
     * the same `data` events. Once a stream's ceiling is hit, one truncation
     * marker is appended/relayed and every further chunk for that stream is
     * silently dropped (the process itself keeps running to completion or
     * the timeout backstop, whichever comes first — only capture/relay
     * stops).
     */
    const handleStreamData = (stream: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const capped = stream === 'stdout' ? stdoutCapped : stderrCapped;
      if (capped) return;

      const text = chunk.toString();
      const current = stream === 'stdout' ? stdoutAll : stderrAll;
      const remaining = maxOutputCharsPerStream - current.length;
      const textToKeep = text.length <= remaining ? text : text.slice(0, Math.max(0, remaining));

      if (textToKeep.length > 0) {
        if (stream === 'stdout') stdoutAll += textToKeep;
        else stderrAll += textToKeep;
        options.send({ type: 'command_output_chunk', requestId: request.requestId, stream, text: textToKeep, seq: seq++ });
      }

      if (text.length > remaining) {
        const marker =
          `\n[local-agent] ${stream} truncated locally after ${maxOutputCharsPerStream} characters; ` +
          `the command kept running, but further ${stream} was not captured or relayed.`;
        if (stream === 'stdout') {
          stdoutAll += marker;
          stdoutCapped = true;
        } else {
          stderrAll += marker;
          stderrCapped = true;
        }
        options.send({ type: 'command_output_chunk', requestId: request.requestId, stream, text: marker, seq: seq++ });
      }
    };

    child.stdout?.on('data', (chunk) => handleStreamData('stdout', chunk));
    child.stderr?.on('data', (chunk) => handleStreamData('stderr', chunk));

    const finalize = (exitCode: number | null) => {
      if (finalized) return;
      finalized = true;
      clearTimeout(backstop);
      activeChildren.delete(request.requestId);
      options.send({
        type: 'command_response',
        requestId: request.requestId,
        exitCode,
        stdout: stdoutAll,
        stderr: stderrAll,
        durationMs: Date.now() - start,
        confirmation,
      });
    };

    child.on('error', (error) => {
      stderrAll += `${stderrAll ? '\n' : ''}[local-agent] failed to start command: ${error.message}`;
      finalize(null);
    });
    child.on('close', (code) => finalize(code));
  }

  async function handleCommandRequest(request: CommandRequestMessage): Promise<void> {
    const cwdInput = request.cwd ?? '.';
    const resolvedCwd = path.resolve(options.workspaceRoot, cwdInput);

    if (!options.allowOutsideWorkspace && !isPathWithinRoot(cwdInput, options.workspaceRoot)) {
      options.send({
        type: 'command_response',
        requestId: request.requestId,
        exitCode: null,
        stdout: '',
        stderr: `Rejected: working directory "${resolvedCwd}" resolves outside the workspace root "${options.workspaceRoot}" and allowOutsideWorkspace is disabled. This command was not run.`,
        durationMs: 0,
        blockedPattern: 'cwd-outside-workspace',
      });
      return;
    }

    const verdict = scanCommand(request.command, options.workspaceRoot, options.allowOutsideWorkspace);

    if (verdict.tier === 1) {
      options.send({
        type: 'command_response',
        requestId: request.requestId,
        exitCode: null,
        stdout: '',
        stderr: `Blocked: this command matched an always-blocked pattern (${verdict.label}) and was not run.`,
        durationMs: 0,
        blockedPattern: verdict.label,
      });
      return;
    }

    if (verdict.tier === 2) {
      // Sent before blocking on console input: this is what lets the backend
      // reset the command's own execution-timeout clock so a late approval
      // isn't immediately cancelled (see global-constraints.md "Confirmation-
      // wait vs command-timeout interaction").
      options.send({ type: 'command_awaiting_confirmation', requestId: request.requestId });
      const decisionStart = Date.now();
      const decision = await options.confirmTier2(request.command);
      if (decision !== 'approved') {
        options.send({
          type: 'command_response',
          requestId: request.requestId,
          exitCode: null,
          stdout: '',
          stderr:
            decision === 'timeout'
              ? 'Confirmation timed out after 60s; command was not run.'
              : 'Command declined at the local console; command was not run.',
          durationMs: Date.now() - decisionStart,
          confirmation: decision,
        });
        return;
      }
      executeCommand(request, resolvedCwd, 'approved');
      return;
    }

    executeCommand(request, resolvedCwd);
  }

  function handleCommandCancel(requestId: string): void {
    const child = activeChildren.get(requestId);
    if (!child) return;
    killTreeFn(child);
  }

  function handleDisconnect(): void {
    // Snapshot the keys first: killTreeFn is best-effort/async (real kills
    // resolve later via the child's own 'close' event, which is what removes
    // an entry from activeChildren), so iterating the live map directly would
    // be safe here regardless, but a snapshot keeps the intent explicit.
    for (const requestId of [...activeChildren.keys()]) {
      handleCommandCancel(requestId);
    }
  }

  return { handleCommandRequest, handleCommandCancel, handleDisconnect };
}
