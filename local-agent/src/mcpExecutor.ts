/**
 * Bridges backend-driven MCP server sessions onto the user's machine: spawns
 * MCP servers (e.g. Playwright MCP, whose browser must open on this PC) as
 * stdio child processes and relays newline-delimited JSON-RPC between the
 * WebSocket relay and the child's stdin/stdout.
 *
 * Ready-decision (documented choice): `mcp_start_response ok:true` is sent on
 * the child's FIRST stdout line, falling back to a 100ms grace timer if the
 * child produces no stdout (some servers emit nothing until they receive an
 * `initialize`). This gives real spawn failures a deterministic window to win
 * over the success response — `ENOENT` on POSIX ('error' fires on the next
 * tick) and cross-spawn's normalized command-not-found error on Windows — so
 * a dead-on-arrival server is reported as `ok:false` rather than silently
 * accepted. If the child is simply slow, the 100ms timer still answers
 * promptly and the backend's own request timeout backstops a server that
 * never talks at all.
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import { buildSafeEnv } from './commandExecutor.js';
import type { AgentToBackendMessage, MCPMessageMessage, MCPStartRequestMessage, MCPStopRequestMessage } from './transport.js';

/** Window after spawn during which a silent child still gets answered ok:true. */
const READY_GRACE_MS = 100;
/** Maximum size of one newline-delimited JSON-RPC message from a child. */
export const DEFAULT_MAX_STDOUT_LINE_BYTES = 8 * 1024 * 1024;
/** Maximum size of one JSON-RPC message accepted from the relay. */
export const DEFAULT_MAX_INBOUND_PAYLOAD_BYTES = 8 * 1024 * 1024;
/** Maximum amount of unwritten data allowed in a child's stdin buffer. */
export const DEFAULT_MAX_STDIN_BUFFER_BYTES = 16 * 1024 * 1024;
/** Maximum stderr volume logged per channel. Retention is bounded separately. */
export const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
/** Ceiling on retained stderr per channel (used in failure messages). */
const MAX_STDERR_TAIL_BYTES = 4_096;

const MAX_COMMAND_BYTES = 32 * 1024;
const MAX_CWD_BYTES = 32 * 1024;
const MAX_ARG_COUNT = 512;
const MAX_ARGV_BYTES = 1024 * 1024;
const MAX_ENV_ENTRIES = 256;
const MAX_ENV_BYTES = 256 * 1024;
const REDACTION_MARKER = '[REDACTED]';

function escapeRegExp(value: string): string {
  return value.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

/**
 * Builds a channel-local diagnostic redactor. Every explicit environment
 * value and argv entry is treated as confidential: neither semantic key names
 * nor token-shape heuristics are a sufficient trust boundary. If a configured
 * value is larger than the diagnostic ceiling, all child-controlled
 * diagnostic text is suppressed because arbitrary fragments cannot be
 * redacted reliably.
 */
function createDiagnosticRedactor(
  config: ValidatedMcpConfig,
  maxDiagnosticBytes: number
): (value: string) => string {
  const candidates = new Set<string>();
  const maxVisibleChars = Math.max(maxDiagnosticBytes, MAX_STDERR_TAIL_BYTES);
  let suppressAllChildText = false;

  const addCandidate = (value: string): void => {
    if (!value) return;
    if (value.length > maxVisibleChars) {
      suppressAllChildText = true;
      return;
    }
    candidates.add(value);

    // Multiline values may be emitted one stderr line at a time.
    for (const part of value.split(/\r?\n/)) {
      if (part.length > 0) candidates.add(part);
    }
  };

  for (const value of Object.values(config.env ?? {})) addCandidate(value);
  for (const arg of config.args) addCandidate(arg);

  const literalSecrets = [...candidates].sort((left, right) => right.length - left.length);

  return (value: string): string => {
    if (suppressAllChildText && value.length > 0) return REDACTION_MARKER;
    let redacted = value;
    for (const secret of literalSecrets) {
      redacted = redacted.replace(new RegExp(escapeRegExp(secret), 'g'), REDACTION_MARKER);
    }

    // Preserve labels and surrounding diagnostics while scrubbing common
    // credential encodings that may originate from an SDK rather than env.
    redacted = redacted
      .replace(
        /((?:authorization|proxy-authorization)\s*:\s*)(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi,
        '$1' + REDACTION_MARKER
      )
      .replace(
        /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s/@]+@/gi,
        '$1' + REDACTION_MARKER + '@'
      )
      .replace(
        /((?:"|')?(?:api[_-]?key|access[_-]?key|auth(?:orization)?|bearer|client[_-]?secret|cookie|credential|password|passwd|private[_-]?key|pwd|refresh[_-]?token|secret|session[_-]?id|token)(?:"|')?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&\r\n]+)/gi,
        '$1' + REDACTION_MARKER
      )
      .replace(
        /((?:--)?(?:api-key|access-key|auth|client-secret|password|secret|token)\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&\r\n]+)/gi,
        '$1' + REDACTION_MARKER
      )
      .replace(
        /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
        REDACTION_MARKER
      )
      .replace(/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTION_MARKER)
      .replace(/\b(?:sk|rk|pk)-(?:live|test|proj)-[A-Za-z0-9_-]{12,}\b/gi, REDACTION_MARKER)
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,})\b/g, REDACTION_MARKER)
      .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTION_MARKER)
      .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, REDACTION_MARKER)
      .replace(/\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{10,}\b/g, REDACTION_MARKER);

    return redacted;
  };
}

interface ValidatedMcpConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

type ConfigValidation = { ok: true; config: ValidatedMcpConfig } | { ok: false; error: string };

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

/**
 * Re-validates config at the execution boundary. The WebSocket decoder also
 * validates these fields, but the executor is security-sensitive and must not
 * rely on every present or future caller having gone through that decoder.
 */
function validateMcpConfig(value: unknown): ConfigValidation {
  if (!isRecord(value)) return { ok: false, error: 'config must be an object' };

  const { command, args, env, cwd } = value;
  if (typeof command !== 'string' || command.trim().length === 0) {
    return { ok: false, error: 'command must be a non-empty string' };
  }
  if (command.includes('\0')) return { ok: false, error: 'command must not contain NUL bytes' };
  if (utf8Bytes(command) > MAX_COMMAND_BYTES) return { ok: false, error: 'command is too large' };

  if (args !== undefined && (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string'))) {
    return { ok: false, error: 'args must be an array of strings' };
  }
  const normalizedArgs = (args ?? []) as string[];
  if (normalizedArgs.length > MAX_ARG_COUNT) return { ok: false, error: `args exceeds ${MAX_ARG_COUNT} entries` };
  let argvBytes = 0;
  for (const arg of normalizedArgs) {
    if (arg.includes('\0')) return { ok: false, error: 'args must not contain NUL bytes' };
    argvBytes += utf8Bytes(arg);
    if (argvBytes > MAX_ARGV_BYTES) return { ok: false, error: 'args payload is too large' };
  }

  let normalizedEnv: Record<string, string> | undefined;
  if (env !== undefined) {
    if (!isRecord(env)) return { ok: false, error: 'env must be an object with string values' };
    const entries = Object.entries(env);
    if (entries.length > MAX_ENV_ENTRIES) return { ok: false, error: `env exceeds ${MAX_ENV_ENTRIES} entries` };
    normalizedEnv = {};
    let envBytes = 0;
    for (const [key, envValue] of entries) {
      if (
        key.length === 0 ||
        key.includes('=') ||
        key.includes('\0') ||
        typeof envValue !== 'string' ||
        envValue.includes('\0')
      ) {
        return { ok: false, error: 'env keys and values must be valid NUL-free strings' };
      }
      envBytes += utf8Bytes(key) + utf8Bytes(envValue);
      if (envBytes > MAX_ENV_BYTES) return { ok: false, error: 'env payload is too large' };
      normalizedEnv[key] = envValue;
    }
  }

  if (cwd !== undefined) {
    if (typeof cwd !== 'string') return { ok: false, error: 'cwd must be a string' };
    if (cwd.includes('\0')) return { ok: false, error: 'cwd must not contain NUL bytes' };
    if (utf8Bytes(cwd) > MAX_CWD_BYTES) return { ok: false, error: 'cwd is too large' };
  }

  return {
    ok: true,
    config: { command, args: [...normalizedArgs], env: normalizedEnv, cwd: cwd as string | undefined },
  };
}

/** Host variables are allowlisted by commandExecutor; server config is explicit and wins. */
export function buildMcpEnv(configEnv?: Record<string, string>): NodeJS.ProcessEnv {
  const env = buildSafeEnv();
  for (const [key, value] of Object.entries(configEnv ?? {})) {
    // Windows treats environment names case-insensitively. Remove an
    // allowlisted spelling such as PATH before applying an explicit `Path`,
    // otherwise Node may choose one of the duplicate spellings arbitrarily.
    if (process.platform === 'win32') {
      const existing = Object.keys(env).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
      if (existing !== undefined) delete env[existing];
    }
    env[key] = value;
  }
  return env;
}

export interface McpExecutorOptions {
  send: (message: AgentToBackendMessage) => void;
  /** Production-safe defaults are overridable only to make boundary tests small and deterministic. */
  readyGraceMs?: number;
  maxStdoutLineBytes?: number;
  maxInboundPayloadBytes?: number;
  maxStdinBufferBytes?: number;
  maxStderrBytes?: number;
}

export interface McpExecutor {
  handleMcpStartRequest(message: MCPStartRequestMessage): void;
  handleMcpStopRequest(message: MCPStopRequestMessage): void;
  handleMcpMessage(message: MCPMessageMessage): void;
  handleDisconnect(): void;
}

interface LiveChannel {
  child: ChildProcess;
  /** requestId of the start request this channel is (or was) awaiting. */
  startRequestId: string;
  ready: boolean;
  readyTimer?: NodeJS.Timeout;
  redactDiagnostic: (value: string) => string;
  stderrTail: Buffer;
  stderrBytesLogged: number;
  stderrTruncated: boolean;
  stderrLine: Buffer;
}

/**
 * Kills one MCP child. Cross-spawn may use a correctly escaped cmd.exe shim
 * for `.cmd` launchers on Windows, so killing only the immediate process can
 * still orphan the real MCP server. `taskkill /t` preserves tree teardown.
 */
function killChild(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = nodeSpawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      env: buildSafeEnv(),
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', () => child.kill('SIGKILL'));
    killer.once('exit', (code) => {
      if (code !== 0) child.kill('SIGKILL');
    });
    killer.unref();
    return;
  }
  try {
    // POSIX children are started in their own process group below, so the
    // negative PID tears down grandchildren too.
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

function positiveLimit(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new Error(`${label} must be a positive integer`);
  return resolved;
}

function appendBufferTail(current: Buffer, chunk: Buffer, maxBytes: number): Buffer {
  const relevantChunk = chunk.length > maxBytes ? chunk.subarray(chunk.length - maxBytes) : chunk;
  if (relevantChunk.length >= maxBytes) return Buffer.from(relevantChunk);
  const combined = Buffer.concat([current, relevantChunk]);
  return combined.length > maxBytes ? combined.subarray(combined.length - maxBytes) : combined;
}

export function createMcpExecutor(options: McpExecutorOptions): McpExecutor {
  const readyGraceMs = positiveLimit(options.readyGraceMs, READY_GRACE_MS, 'readyGraceMs');
  const maxStdoutLineBytes = positiveLimit(
    options.maxStdoutLineBytes,
    DEFAULT_MAX_STDOUT_LINE_BYTES,
    'maxStdoutLineBytes'
  );
  const maxInboundPayloadBytes = positiveLimit(
    options.maxInboundPayloadBytes,
    DEFAULT_MAX_INBOUND_PAYLOAD_BYTES,
    'maxInboundPayloadBytes'
  );
  const maxStdinBufferBytes = positiveLimit(
    options.maxStdinBufferBytes,
    DEFAULT_MAX_STDIN_BUFFER_BYTES,
    'maxStdinBufferBytes'
  );
  const maxStderrBytes = positiveLimit(options.maxStderrBytes, DEFAULT_MAX_STDERR_BYTES, 'maxStderrBytes');
  const channels = new Map<string, LiveChannel>();

  const removeChannel = (channelId: string): void => {
    const channel = channels.get(channelId);
    if (channel?.readyTimer) clearTimeout(channel.readyTimer);
    channels.delete(channelId);
  };

  const markReady = (channelId: string): void => {
    const channel = channels.get(channelId);
    if (!channel || channel.ready) return;
    channel.ready = true;
    if (channel.readyTimer) {
      clearTimeout(channel.readyTimer);
      channel.readyTimer = undefined;
    }
    options.send({ type: 'mcp_start_response', requestId: channel.startRequestId, ok: true });
  };

  function handleMcpStartRequest(message: MCPStartRequestMessage): void {
    const { channelId, requestId } = message;
    if (channels.has(channelId)) {
      // Idempotent: the backend may retry a start whose response was lost on
      // a dropped relay connection; the live child stays, answer with this
      // request's own requestId.
      options.send({ type: 'mcp_start_response', requestId, ok: true });
      return;
    }

    const validation = validateMcpConfig(message.config);
    if (!validation.ok) {
      options.send({
        type: 'mcp_start_response',
        requestId,
        ok: false,
        error: `Invalid MCP stdio config: ${validation.error}`,
      });
      return;
    }

    const redactDiagnostic = createDiagnosticRedactor(validation.config, maxStderrBytes);
    let child: ChildProcess;
    try {
      // Cross-spawn resolves Windows `.cmd` launchers while escaping each argv
      // item. No caller-controlled command or argument is interpreted as shell
      // syntax; configured environment values are the only non-baseline values
      // deliberately exposed to the child.
      child = crossSpawn(validation.config.command, validation.config.args, {
        env: buildMcpEnv(validation.config.env),
        cwd: validation.config.cwd,
        shell: false,
        stdio: 'pipe',
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      options.send({
        type: 'mcp_start_response',
        requestId,
        ok: false,
        error: redactDiagnostic(error instanceof Error ? error.message : String(error)),
      });
      return;
    }

    const channel: LiveChannel = {
      child,
      startRequestId: requestId,
      ready: false,
      redactDiagnostic,
      stderrTail: Buffer.alloc(0),
      stderrBytesLogged: 0,
      stderrTruncated: false,
      stderrLine: Buffer.alloc(0),
    };
    channels.set(channelId, channel);
    channel.readyTimer = setTimeout(() => markReady(channelId), readyGraceMs);

    // Default stdio is piped, so stdout/stderr/stdin are guaranteed present.
    child.stdout!.on('error', () => {
      /* readline also observes stream end; nothing to do here */
    });
    child.stdin?.on('error', () => {
      // EPIPE (or a destroyed stream) after the child died: the channel map
      // teardown already happened via 'exit'; swallowing keeps relay messages
      // racing a dying child from crashing the agent.
    });

    const processStdoutLine = (lineBytes: Buffer): void => {
      markReady(channelId);
      const withoutCr = lineBytes.at(-1) === 0x0d ? lineBytes.subarray(0, -1) : lineBytes;
      const line = withoutCr.toString('utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        console.warn(
          `[local-agent] MCP channel ${channelId}: ignored non-JSON stdout diagnostic (${lineBytes.length} bytes; content redacted)`
        );
        return;
      }
      if (!isRecord(parsed)) {
        console.warn(
          `[local-agent] MCP channel ${channelId}: ignored non-object stdout diagnostic (${lineBytes.length} bytes; content redacted)`
        );
        return;
      }
      options.send({ type: 'mcp_message', channelId, payload: parsed });
    };

    // Bounded newline framing. `readline` retains an entire unterminated line,
    // which lets a broken/malicious child grow the agent without limit before
    // a single `line` event fires.
    let stdoutParts: Buffer[] = [];
    let stdoutLineBytes = 0;
    let droppingOversizedLine = false;
    child.stdout!.on('data', (rawChunk: Buffer | string) => {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(0x0a, offset);
        const end = newline === -1 ? chunk.length : newline;
        const segment = chunk.subarray(offset, end);

        if (!droppingOversizedLine) {
          if (stdoutLineBytes + segment.length > maxStdoutLineBytes) {
            stdoutParts = [];
            stdoutLineBytes = 0;
            droppingOversizedLine = true;
          } else if (segment.length > 0) {
            stdoutParts.push(segment);
            stdoutLineBytes += segment.length;
          }
        }

        if (newline === -1) break;
        if (droppingOversizedLine) {
          markReady(channelId);
          console.warn(
            `[local-agent] MCP channel ${channelId}: discarded stdout line larger than ${maxStdoutLineBytes} bytes`
          );
        } else {
          processStdoutLine(Buffer.concat(stdoutParts, stdoutLineBytes));
        }
        stdoutParts = [];
        stdoutLineBytes = 0;
        droppingOversizedLine = false;
        offset = newline + 1;
      }
    });

    const emitStderrLine = (line: Buffer): void => {
      const withoutCr = line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
      const safe = channel.redactDiagnostic(withoutCr.toString('utf8'));
      channel.stderrTail = appendBufferTail(
        channel.stderrTail,
        Buffer.from(`${safe}\n`, 'utf8'),
        MAX_STDERR_TAIL_BYTES
      );
      if (safe.length > 0) console.error(`[local-agent] MCP channel ${channelId} stderr: ${safe}`);
    };

    const suppressFurtherStderr = (): void => {
      channel.stderrLine = Buffer.alloc(0);
      if (channel.stderrTruncated) return;
      channel.stderrTruncated = true;
      console.error(`[local-agent] MCP channel ${channelId}: further stderr suppressed after ${maxStderrBytes} bytes`);
    };

    const flushPendingStderr = (): void => {
      if (channel.stderrTruncated || channel.stderrLine.length === 0) return;
      channel.stderrBytesLogged += channel.stderrLine.length;
      emitStderrLine(channel.stderrLine);
      channel.stderrLine = Buffer.alloc(0);
    };

    child.stderr?.on('data', (rawChunk: Buffer | string) => {
      if (channel.stderrTruncated) return;
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      let offset = 0;

      while (offset < chunk.length && !channel.stderrTruncated) {
        const newline = chunk.indexOf(0x0a, offset);
        const end = newline === -1 ? chunk.length : newline;
        const segment = chunk.subarray(offset, end);
        const newlineBytes = newline === -1 ? 0 : 1;
        const projected = channel.stderrBytesLogged + channel.stderrLine.length + segment.length + newlineBytes;

        // Never log a partial line at the ceiling. Keeping the complete line
        // together prevents a credential split across process writes from
        // bypassing literal redaction.
        if (projected > maxStderrBytes) {
          suppressFurtherStderr();
          break;
        }

        if (segment.length > 0) channel.stderrLine = Buffer.concat([channel.stderrLine, segment]);
        if (newline === -1) break;

        channel.stderrBytesLogged += channel.stderrLine.length + 1;
        emitStderrLine(channel.stderrLine);
        channel.stderrLine = Buffer.alloc(0);
        offset = newline + 1;
      }
    });

    child.on('error', (error) => {
      // Spawn failure (e.g. ENOENT on POSIX). After a channel is ready, a
      // late stdio error must not contradict an already-sent ok:true.
      if (channels.get(channelId) !== channel) return;
      flushPendingStderr();
      removeChannel(channelId);
      if (!channel.ready) {
        const stderrTail = channel.stderrTail.toString('utf8');
        const sanitized = `${channel.redactDiagnostic(error.message)}${stderrTail ? `; stderr: ${stderrTail}` : ''}`
          .replace(/[\r\n]+/g, ' ')
          .slice(0, 500);
        options.send({ type: 'mcp_start_response', requestId, ok: false, error: sanitized });
      } else {
        console.warn(
          `[local-agent] MCP channel ${channelId} error after ready: ${channel.redactDiagnostic(error.message)}`
        );
      }
    });

    child.on('exit', (code) => {
      if (channels.get(channelId) !== channel) return;
      flushPendingStderr();
      removeChannel(channelId);
      if (!channel.ready) {
        const stderrTail = channel.stderrTail.toString('utf8').trim();
        options.send({
          type: 'mcp_start_response',
          requestId,
          ok: false,
          error: `MCP process exited before ready (code ${code})${stderrTail ? `; stderr: ${stderrTail}` : ''}`
            .replace(/[\r\n]+/g, ' ')
            .slice(0, 500),
        });
      } else {
        options.send({ type: 'mcp_exited', channelId, exitCode: code });
      }
    });
  }

  function handleMcpStopRequest(message: MCPStopRequestMessage): void {
    const { channelId, requestId } = message;
    const channel = channels.get(channelId);
    if (!channel) {
      // Idempotent: stopping an already-stopped/never-started channel is ok.
      options.send({ type: 'mcp_stop_response', requestId, ok: true });
      return;
    }
    removeChannel(channelId);
    killChild(channel.child);
    options.send({ type: 'mcp_stop_response', requestId, ok: true });
  }

  function handleMcpMessage(message: MCPMessageMessage): void {
    const channel = channels.get(message.channelId);
    if (!channel) {
      console.warn(
        `[local-agent] dropping mcp_message for unknown channel ${message.channelId} (backend will time out)`
      );
      return;
    }

    const rejectInbound = (reason: string): void => {
      const safeReason = reason.replace(/[\r\n]+/g, ' ').slice(0, 500);
      console.warn(`[local-agent] MCP channel ${message.channelId}: ${safeReason}`);
      const payload = message.payload;
      if (isRecord(payload) && Object.prototype.hasOwnProperty.call(payload, 'id')) {
        const candidateId = payload.id;
        const id =
          candidateId === null ||
          (typeof candidateId === 'string' && utf8Bytes(candidateId) <= 256) ||
          (typeof candidateId === 'number' && Number.isFinite(candidateId))
            ? candidateId
            : null;
        options.send({
          type: 'mcp_message',
          channelId: message.channelId,
          payload: { jsonrpc: '2.0', id, error: { code: -32600, message: safeReason } },
        });
      }
    };

    if (!isRecord(message.payload)) {
      rejectInbound('Rejected invalid JSON-RPC payload: expected an object');
      return;
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(message.payload);
    } catch (error) {
      rejectInbound(`Rejected unserializable JSON-RPC payload: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (typeof serialized !== 'string') {
      rejectInbound('Rejected unserializable JSON-RPC payload');
      return;
    }

    const serializedBytes = utf8Bytes(serialized);
    if (serializedBytes > maxInboundPayloadBytes) {
      rejectInbound(`Rejected JSON-RPC payload larger than ${maxInboundPayloadBytes} bytes`);
      return;
    }

    const stdin = channel.child.stdin;
    if (!stdin || stdin.destroyed || stdin.writableLength + serializedBytes + 1 > maxStdinBufferBytes) {
      rejectInbound(`Rejected JSON-RPC payload because the MCP process input buffer is full`);
      return;
    }

    try {
      stdin.write(serialized + '\n');
    } catch (error) {
      // stdin destroyed/EPIPE racing the child's exit — teardown handles it,
      // but a request still gets a deterministic local error when possible.
      rejectInbound(`Failed to write JSON-RPC payload to MCP process: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function handleDisconnect(): void {
    // Snapshot the keys: killChild is fire-and-forget on win32 (taskkill is
    // itself a spawned process); each channel's own 'exit' handler no-ops
    // once its map entry is gone.
    for (const channelId of [...channels.keys()]) {
      const channel = channels.get(channelId);
      if (!channel) continue;
      removeChannel(channelId);
      killChild(channel.child);
    }
  }

  return { handleMcpStartRequest, handleMcpStopRequest, handleMcpMessage, handleDisconnect };
}
