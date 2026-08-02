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
 * tick) and the "not recognized" cmd.exe path on win32 (shell exits before
 * any stdout) — so a dead-on-arrival server is reported as `ok:false` rather
 * than silently accepted. If the child is simply slow, the 100ms timer still
 * answers promptly and the backend's own request timeout backstops a server
 * that never talks at all.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentToBackendMessage, MCPMessageMessage, MCPStartRequestMessage, MCPStopRequestMessage } from './transport.js';

/** Window after spawn during which a silent child still gets answered ok:true. */
const READY_GRACE_MS = 100;
/** Ceiling on retained stderr per channel (used in failure messages). */
const MAX_STDERR_TAIL = 4_096;

export interface McpExecutorOptions {
  send: (message: AgentToBackendMessage) => void;
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
  stderrTail: string;
}

/**
 * Kills one MCP child. On win32 the immediate child of `spawn` with
 * `shell:true` is cmd.exe; SIGKILL-ing it alone would orphan the real MCP
 * server (e.g. `npx.cmd` -> `node.exe`), so we mirror `commandExecutor.ts`'s
 * `defaultKillTree` and use `taskkill /pid <pid> /t /f` to take the whole
 * tree down. Non-Windows keeps a plain SIGKILL (no grace period needed: the
 * stop/disconnect paths are deliberate teardowns, not cancellation races).
 */
function killChild(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f']);
    return;
  }
  child.kill('SIGKILL');
}

export function createMcpExecutor(options: McpExecutorOptions): McpExecutor {
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

    let child: ChildProcess;
    try {
      // `shell:true` on win32 only, so `npx` resolves via `npx.cmd` (same
      // philosophy as commandExecutor's cmd path). The args are then parsed
      // by cmd.exe, so test/real-world commands avoid quoting-sensitive
      // `-e` scripts; a plain `node <file>` argv survives fine.
      child = spawn(message.config.command, message.config.args ?? [], {
        env: { ...process.env, ...(message.config.env ?? {}) },
        cwd: message.config.cwd,
        shell: process.platform === 'win32',
      });
    } catch (error) {
      options.send({
        type: 'mcp_start_response',
        requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const channel: LiveChannel = { child, startRequestId: requestId, ready: false, stderrTail: '' };
    channels.set(channelId, channel);
    channel.readyTimer = setTimeout(() => markReady(channelId), READY_GRACE_MS);

    // Default stdio is piped, so stdout/stderr/stdin are guaranteed present.
    child.stdout!.on('error', () => {
      /* readline also observes stream end; nothing to do here */
    });
    child.stdin?.on('error', () => {
      // EPIPE (or a destroyed stream) after the child died: the channel map
      // teardown already happened via 'exit'; swallowing keeps relay messages
      // racing a dying child from crashing the agent.
    });

    // Newline-delimited JSON-RPC from the server's stdout -> relay.
    const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    lines.on('line', (line) => {
      markReady(channelId);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        console.warn(`[local-agent] MCP channel ${channelId}: ignoring non-JSON stdout line: ${line.slice(0, 200)}`);
        return;
      }
      if (typeof parsed !== 'object' || parsed === null) {
        console.warn(`[local-agent] MCP channel ${channelId}: ignoring non-object stdout line: ${line.slice(0, 200)}`);
        return;
      }
      options.send({ type: 'mcp_message', channelId, payload: parsed });
    });

    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      channel.stderrTail = (channel.stderrTail + text).slice(-MAX_STDERR_TAIL);
      console.error(`[local-agent] MCP channel ${channelId} stderr: ${text}`);
    });

    child.on('error', (error) => {
      // Spawn failure (e.g. ENOENT on POSIX). After a channel is ready, a
      // late stdio error must not contradict an already-sent ok:true.
      if (channels.get(channelId) !== channel) return;
      removeChannel(channelId);
      if (!channel.ready) {
        const sanitized = `${error.message}${channel.stderrTail ? `; stderr: ${channel.stderrTail}` : ''}`
          .replace(/[\r\n]+/g, ' ')
          .slice(0, 500);
        options.send({ type: 'mcp_start_response', requestId, ok: false, error: sanitized });
      } else {
        console.warn(`[local-agent] MCP channel ${channelId} error after ready: ${error.message}`);
      }
    });

    child.on('exit', (code) => {
      if (channels.get(channelId) !== channel) return;
      removeChannel(channelId);
      if (!channel.ready) {
        options.send({
          type: 'mcp_start_response',
          requestId,
          ok: false,
          error: `MCP process exited before ready (code ${code})`,
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
    try {
      channel.child.stdin!.write(JSON.stringify(message.payload) + '\n');
    } catch {
      // stdin destroyed/EPIPE racing the child's exit — teardown handles it.
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
