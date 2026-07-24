import { Sandbox, type CommandResult, type SandboxOpts } from 'e2b';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { getSettingValue } from '../routes/settings.js';
import {
  cancelCommandRequest,
  getAgentShellInfo,
  isAgentConnected,
  sendCommandRequest,
} from '../agentRelay/registry.js';
import { logToolExecution } from './execAudit.js';
import type { RunToolResult } from './run.js';
import { scanCommand } from '../../shared/commandSafety.js';

export const MAX_COMMAND_OUTPUT_CHARS = 64_000;
export const DEFAULT_TIMEOUT_SECONDS = 120;
export const MAX_TIMEOUT_SECONDS = 1_800;
const MAX_SANDBOX_TIMEOUT_MS = 3_550_000;
const E2B_DEFAULT_CWD = '/home/user';
const CLIENT_DISCONNECT_ERROR = 'Command cancelled because the client disconnected.';
const LOCAL_BACKEND_ERROR = 'local agent is not connected';
const E2B_METADATA_MITIGATION_TIMEOUT_MS = 2_000;
const E2B_NETWORK_DENY_OUT = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
] as const;

/**
 * Best-effort defense-in-depth, not a guarantee: no package installation is
 * attempted, and a command running with sandbox root could undo these rules.
 * The template must already provide iptables or nft for this to do anything.
 */
const E2B_METADATA_MITIGATION_COMMAND = [
  'set -u',
  'if command -v iptables >/dev/null 2>&1 && iptables -w 2 -A OUTPUT -d 169.254.169.254/32 -j DROP; then',
  '  exit 0',
  'fi',
  'if command -v nft >/dev/null 2>&1; then',
  '  nft add table inet run_command_metadata_filter 2>/dev/null || true',
  "  nft 'add chain inet run_command_metadata_filter output { type filter hook output priority 0; policy accept; }' 2>/dev/null || true",
  '  if nft add rule inet run_command_metadata_filter output ip daddr 169.254.169.254 counter drop; then',
  '    exit 0',
  '  fi',
  'fi',
  'exit 127',
].join('\n');

export const runCommandArgsSchema = z.object({
  command: z.string().min(1, 'command is required'),
  cwd: z.string().optional(),
  backend: z.enum(['auto', 'local', 'sandbox']).default('auto'),
  timeout_seconds: z.number().finite().positive().default(DEFAULT_TIMEOUT_SECONDS),
});

export interface RunCommandContext {
  signal: AbortSignal;
  onOutputChunk: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void;
}

/**
 * Truncate each command stream independently while retaining both the head and
 * tail, since the useful diagnostic output is often at the end of a failure.
 */
export function truncateCommandOutput(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_COMMAND_OUTPUT_CHARS) return { text, truncated: false };

  let headLength = Math.floor(MAX_COMMAND_OUTPUT_CHARS / 2);
  let tailLength = MAX_COMMAND_OUTPUT_CHARS - headLength;
  let marker = '';

  // The marker length depends on the number of omitted characters. Iterate so
  // the returned string is never larger than MAX_COMMAND_OUTPUT_CHARS.
  for (let i = 0; i < 10; i++) {
    const omitted = text.length - headLength - tailLength;
    marker = `\n\n...[${omitted} characters omitted]...\n\n`;
    const available = MAX_COMMAND_OUTPUT_CHARS - marker.length;
    const nextHeadLength = Math.floor(available / 2);
    const nextTailLength = available - nextHeadLength;
    if (nextHeadLength === headLength && nextTailLength === tailLength) break;
    headLength = nextHeadLength;
    tailLength = nextTailLength;
  }

  const omitted = text.length - headLength - tailLength;
  marker = `\n\n...[${omitted} characters omitted]...\n\n`;
  const available = MAX_COMMAND_OUTPUT_CHARS - marker.length;
  headLength = Math.floor(available / 2);
  tailLength = available - headLength;
  const finalOmitted = text.length - headLength - tailLength;
  marker = `\n\n...[${finalOmitted} characters omitted]...\n\n`;

  return {
    text: `${text.slice(0, headLength)}${marker}${text.slice(-tailLength)}`,
    truncated: true,
  };
}

export function isRunCommandUsable(userId: string): boolean {
  const key = userId ? getSettingValue(userId, 'e2b_api_key') : '';
  return !!key?.trim();
}

function formatPlatform(platform: string): string {
  const normalized = platform.trim().toLowerCase();
  if (normalized === 'win32' || normalized === 'windows') return 'Windows';
  if (normalized === 'darwin' || normalized === 'macos' || normalized === 'mac os') return 'macOS';
  if (normalized === 'linux') return 'Linux';
  if (normalized === 'freebsd') return 'FreeBSD';
  return platform;
}

function localShellContrast(kind: string): string {
  if (kind === 'pwsh' || kind === 'powershell') {
    return 'PowerShell uses `;` to sequence commands, `$env:VAR` for environment variables, and `$(...)` for command substitution; POSIX shells commonly use `&&`, `$VAR`, and `2>/dev/null` for corresponding syntax.';
  }
  if (kind === 'cmd') {
    return 'cmd uses `&` or `&&` to sequence commands, `%VAR%` for environment variables, and `2>NUL` to discard stderr; POSIX shells commonly use `&&`, `$VAR`, and `2>/dev/null` for corresponding syntax.';
  }
  return 'POSIX shells use `&&` to require a successful previous command, `$VAR` for environment variables, and `2>/dev/null` to discard stderr; PowerShell commonly uses `;`, `$env:VAR`, and `$(...)` for corresponding syntax.';
}

export function buildRunCommandDisclosure(userId: string): string {
  const paragraphs: string[] = [];
  if (isAgentConnected(userId)) {
    const identity = getAgentShellInfo(userId);
    if (identity?.platform && identity.shell?.kind) {
      paragraphs.push(
        `The connected local agent targets ${formatPlatform(identity.platform)} and uses the ${identity.shell.kind} shell. ${localShellContrast(identity.shell.kind)} Prefer the dedicated \`read_file\`, \`write_file\`, \`edit_file\`, and \`delete_file\` tools over shell redirection or heredocs for creating/editing files.`,
      );
    } else {
      paragraphs.push('This agent version does not disclose its shell dialect; inspect output/errors and adjust syntax if a command fails.');
    }
  }
  if (isRunCommandUsable(userId)) {
    paragraphs.push('The `sandbox` backend is an ephemeral Linux VM running `/bin/bash` — use POSIX/bash syntax.');
  }
  return paragraphs.join('\n\n');
}

function resolveSandboxCwd(cwd: string | undefined): string {
  const trimmed = cwd?.trim();
  if (!trimmed || trimmed === '.') return E2B_DEFAULT_CWD;
  if (trimmed.startsWith('/')) return trimmed;
  const segments = trimmed.split('/').filter((segment) => segment && segment !== '.');
  let resolved = E2B_DEFAULT_CWD;
  for (const segment of segments) {
    if (segment === '..') {
      if (resolved !== '/') resolved = resolved.slice(0, resolved.lastIndexOf('/')) || '/';
    } else {
      resolved += `/${segment}`;
    }
  }
  return resolved;
}

function isCommandResult(value: unknown): value is CommandResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<CommandResult>;
  return typeof result.exitCode === 'number' && typeof result.stdout === 'string' && typeof result.stderr === 'string';
}

function errorMessage(error: unknown): string {
  if (
    error
    && typeof error === 'object'
    && 'error' in error
    && typeof (error as { error?: unknown }).error === 'string'
  ) {
    return (error as { error: string }).error;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Hash userId for structural logs without emitting PII. */
function hashUserId(userId: string | undefined): string {
  if (!userId) return 'anon';
  let h = 0;
  for (let i = 0; i < userId.length; i++) {
    h = (h << 5) - h + userId.charCodeAt(i);
    h |= 0;
  }
  return `u${Math.abs(h).toString(36)}`;
}

function logMetadataMitigation(userId: string, status: 'applied' | 'failed' | 'timed_out' | 'cancelled', durationMs: number): void {
  const line = `[run_command] ${hashUserId(userId)} backend=e2b metadata_firewall=${status} duration_ms=${durationMs}`;
  if (status === 'applied') {
    console.log(line);
  } else {
    console.warn(line);
  }
}

/**
 * Attempt the in-guest metadata block before user code. This is best-effort
 * defense-in-depth, not a guarantee: a command running with sandbox root
 * could itself undo these rules. Failures, missing tools, and timeouts are
 * deliberately logged as structural facts and never block user execution.
 */
async function attemptMetadataMitigation(sandbox: Sandbox, userId: string, signal: AbortSignal): Promise<void> {
  const startedAt = Date.now();
  let status: 'applied' | 'failed' | 'timed_out' | 'cancelled' = 'failed';
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener = () => {};
  const mitigationController = new AbortController();

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        status = 'timed_out';
        mitigationController.abort();
        reject(new Error('metadata mitigation timeout'));
      }, E2B_METADATA_MITIGATION_TIMEOUT_MS);
    });
    const abortPromise = new Promise<never>((_, reject) => {
      const onAbort = () => {
        status = 'cancelled';
        mitigationController.abort();
        reject(new Error(CLIENT_DISCONNECT_ERROR));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    });
    const result = await Promise.race([
      sandbox.commands.run(E2B_METADATA_MITIGATION_COMMAND, {
        timeoutMs: E2B_METADATA_MITIGATION_TIMEOUT_MS,
        signal: mitigationController.signal,
      }),
      timeoutPromise,
      abortPromise,
    ]);
    status = isCommandResult(result) && result.exitCode === 0 ? 'applied' : 'failed';
  } catch {
    // Do not expose the mitigation command or its output; continue below.
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    removeAbortListener();
    logMetadataMitigation(userId, status, Date.now() - startedAt);
  }
}

export async function runCommandTool(
  args: Record<string, unknown>,
  userId: string,
  ctx: RunCommandContext
): Promise<RunToolResult> {
  const startedAt = Date.now();
  const rawCommand = typeof args?.command === 'string' ? args.command : null;
  let auditLogged = false;
  let selectedBackend: 'local' | 'e2b' = 'e2b';
  let auditCwd: string | null = null;

  const finish = (
    output: Record<string, unknown>,
    isError: boolean,
    details: {
      exitCode?: number | null;
      blockedPattern?: string | null;
      confirmationRequired?: boolean;
      confirmationResult?: 'approved' | 'declined' | 'timeout' | null;
    } = {}
  ): RunToolResult => {
    if (!auditLogged) {
      auditLogged = true;
      logToolExecution({
        userId,
        toolName: 'run_command',
        backend: selectedBackend,
        command: rawCommand,
        cwd: auditCwd,
        exitCode: details.exitCode ?? null,
        durationMs: Date.now() - startedAt,
        blockedPattern: details.blockedPattern ?? null,
        confirmationRequired: details.confirmationRequired,
        confirmationResult: details.confirmationResult ?? null,
        isError,
      });
    }
    return {
      output: JSON.stringify(output),
      isError,
      source: 'builtin',
      metadata: { backend: selectedBackend, exit_code: details.exitCode ?? null },
    };
  };

  const parsed = runCommandArgsSchema.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; ');
    return finish({ error: `Invalid run_command arguments: ${issues}` }, true);
  }

  const { command, cwd, backend, timeout_seconds: requestedTimeoutSeconds } = parsed.data;
  selectedBackend = backend === 'local' || (backend === 'auto' && isAgentConnected(userId))
    ? 'local'
    : 'e2b';
  auditCwd = cwd ?? null;
  const verdict = scanCommand(command, null, true);
  if (verdict.tier === 1) {
    return finish(
      { error: 'Command blocked by the command-safety policy.', blocked: { tier: 1, pattern: verdict.label || 'unknown' } },
      true,
      { blockedPattern: verdict.label || 'unknown' }
    );
  }

  const timeoutSeconds = Math.min(requestedTimeoutSeconds, MAX_TIMEOUT_SECONDS);
  const timeoutMs = Math.max(1, Math.floor(timeoutSeconds * 1000));

  if (selectedBackend === 'local') {
    if (!isAgentConnected(userId)) {
      return finish({ error: LOCAL_BACKEND_ERROR }, true);
    }
    if (ctx.signal.aborted) {
      return finish({ error: CLIENT_DISCONNECT_ERROR }, true);
    }

    const requestId = `command_${nanoid()}`;
    let removeAbortListener = () => {};
    try {
      const commandPromise = sendCommandRequest(
        userId,
        requestId,
        command,
        cwd,
        timeoutMs,
        ctx.onOutputChunk,
      );
      const abortPromise = new Promise<never>((_, reject) => {
        const onAbort = () => {
          try {
            cancelCommandRequest(userId, requestId);
          } catch (error) {
            console.error('[run_command] failed to cancel local command:', error);
          }
          reject(new Error(CLIENT_DISCONNECT_ERROR));
        };
        ctx.signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => ctx.signal.removeEventListener('abort', onAbort);
        if (ctx.signal.aborted) onAbort();
      });

      const result = await Promise.race([commandPromise, abortPromise]);
      const resultDetails = {
        exitCode: result.exitCode ?? null,
        blockedPattern: result.blockedPattern ?? null,
        confirmationRequired: result.confirmation !== undefined,
        confirmationResult: result.confirmation ?? null,
      };
      if (result.confirmation === 'declined' || result.confirmation === 'timeout') {
        return finish(
          {
            error: result.confirmation === 'declined'
              ? 'Command confirmation was declined; the command was not executed.'
              : 'Command confirmation timed out; the command was not executed.',
            confirmation: result.confirmation,
          },
          true,
          resultDetails,
        );
      }

      const stdout = truncateCommandOutput(String(result.stdout ?? ''));
      const stderr = truncateCommandOutput(String(result.stderr ?? ''));
      return finish(
        {
          stdout: stdout.text,
          stderr: stderr.text,
          exit_code: result.exitCode ?? null,
          backend: 'local',
          resolved_cwd: cwd?.trim() || '(workspace root)',
          timeout_seconds_applied: timeoutSeconds,
          truncated: stdout.truncated || stderr.truncated,
        },
        false,
        resultDetails,
      );
    } catch (error) {
      if (ctx.signal.aborted || errorMessage(error) === CLIENT_DISCONNECT_ERROR) {
        return finish({ error: CLIENT_DISCONNECT_ERROR }, true);
      }
      return finish({ error: errorMessage(error) }, true);
    } finally {
      removeAbortListener();
    }
  }

  const sandboxTimeoutMs = Math.min(timeoutMs + 30_000, MAX_SANDBOX_TIMEOUT_MS);
  const resolvedCwd = resolveSandboxCwd(cwd);
  let sandbox: Sandbox | null = null;
  let killPromise: Promise<unknown> | null = null;
  const killSandbox = (): Promise<unknown> => {
    if (!sandbox) return Promise.resolve();
    if (!killPromise) {
      killPromise = sandbox.kill().catch((error) => {
        console.error('[run_command] failed to kill E2B sandbox:', error);
      });
    }
    return killPromise;
  };

  try {
    const e2bApiKey = getSettingValue(userId, 'e2b_api_key').trim();
    if (!e2bApiKey) {
      return finish({ error: 'E2B execution is not configured for this user: e2b_api_key is missing.' }, true);
    }

    const allowInternetAccess = getSettingValue(userId, 'e2b_allow_internet').trim().toLowerCase() === 'true';
    // E2B denyOut is enforced for routed RFC1918 egress, not guest loopback
    // or the metadata link. The in-guest attempt below is best-effort
    // defense-in-depth, not a guarantee: sandbox-root user code can undo it.
    const sandboxOptions: SandboxOpts = {
      apiKey: e2bApiKey,
      envs: {},
      allowInternetAccess,
      timeoutMs: sandboxTimeoutMs,
      signal: ctx.signal,
      ...(allowInternetAccess ? { network: { denyOut: [...E2B_NETWORK_DENY_OUT] } } : {}),
    };

    if (ctx.signal.aborted) {
      return finish({ error: CLIENT_DISCONNECT_ERROR }, true);
    }

    sandbox = await Sandbox.create(sandboxOptions);
    if (ctx.signal.aborted) {
      void killSandbox();
      return finish({ error: CLIENT_DISCONNECT_ERROR }, true);
    }

    await attemptMetadataMitigation(sandbox, userId, ctx.signal);
    if (ctx.signal.aborted) {
      void killSandbox();
      return finish({ error: CLIENT_DISCONNECT_ERROR }, true);
    }

    let removeAbortListener = () => {};
    const abortPromise = new Promise<never>((_, reject) => {
      const onAbort = () => {
        void killSandbox();
        reject(new Error(CLIENT_DISCONNECT_ERROR));
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => ctx.signal.removeEventListener('abort', onAbort);
    });
    const commandPromise = sandbox.commands.run(command, {
      cwd: resolvedCwd,
      timeoutMs,
      signal: ctx.signal,
    });

    let result: CommandResult;
    try {
      result = await Promise.race([commandPromise, abortPromise]);
    } catch (error) {
      if (ctx.signal.aborted || errorMessage(error) === CLIENT_DISCONNECT_ERROR) {
        return finish({ error: CLIENT_DISCONNECT_ERROR }, true);
      }
      if (isCommandResult(error)) {
        result = error;
      } else {
        return finish({ error: errorMessage(error) }, true);
      }
    } finally {
      removeAbortListener();
    }

    const stdout = truncateCommandOutput(String(result.stdout ?? ''));
    const stderr = truncateCommandOutput(String(result.stderr ?? ''));
    return finish(
      {
        stdout: stdout.text,
        stderr: stderr.text,
        exit_code: result.exitCode ?? null,
        backend: 'e2b',
        resolved_cwd: resolvedCwd,
        timeout_seconds_applied: timeoutSeconds,
        truncated: stdout.truncated || stderr.truncated,
      },
      false,
      { exitCode: result.exitCode ?? null }
    );
  } catch (error) {
    if (ctx.signal.aborted) {
      return finish({ error: CLIENT_DISCONNECT_ERROR }, true);
    }
    return finish({ error: errorMessage(error) }, true);
  } finally {
    void killSandbox();
  }
}
