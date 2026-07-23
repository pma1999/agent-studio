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
import type { AgentToBackendMessage, CommandRequestMessage } from './transport.js';

/** Same allowlist-baseline principle as task-03's `mcp/client.ts` `SAFE_STDIO_ENV_KEYS`. */
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

export type SpawnFn = (
  command: string,
  options: { shell: true; cwd: string; env: NodeJS.ProcessEnv }
) => MinimalChildProcess;

export type KillTreeFn = (child: MinimalChildProcess) => void;

const defaultSpawnFn: SpawnFn = (command, options) => spawn(command, options) as unknown as MinimalChildProcess;

/**
 * Best-effort process-tree kill. Plain `child.kill()` is not sufficient here:
 * `shell: true` spawns an intermediary shell (`cmd.exe` via `COMSPEC` on
 * Windows) whose own children do not reliably receive a signal sent to the
 * shell process itself, so a killed shell can leave its real child (e.g. the
 * `npm.cmd` -> `node.exe` it launched) still running. On Windows we instead
 * use `taskkill /pid <pid> /t /f` (`/t` = kill the whole process tree) via a
 * follow-up spawn, per the named risk in the task brief. Non-Windows keeps a
 * SIGTERM-then-SIGKILL grace period for when cross-platform support lands.
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
  spawnFn?: SpawnFn;
  killTreeFn?: KillTreeFn;
}

export interface CommandExecutor {
  handleCommandRequest(request: CommandRequestMessage): Promise<void>;
  handleCommandCancel(requestId: string): void;
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
    let finalized = false;

    const child = spawnFn(request.command, { shell: true, cwd: resolvedCwd, env: buildSafeEnv() });
    activeChildren.set(request.requestId, child);

    const backstop = setTimeout(() => killTreeFn(child), request.timeoutMs);

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      stdoutAll += text;
      options.send({ type: 'command_output_chunk', requestId: request.requestId, stream: 'stdout', text, seq: seq++ });
    });
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderrAll += text;
      options.send({ type: 'command_output_chunk', requestId: request.requestId, stream: 'stderr', text, seq: seq++ });
    });

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

  return { handleCommandRequest, handleCommandCancel };
}
