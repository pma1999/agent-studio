/**
 * Thin WebSocket client for the agent relay protocol defined by
 * `server/agentRelay/protocol.ts` (task-07).
 *
 * The message shapes below are hand-mirrored from that module rather than
 * imported directly: `protocol.ts` imports `server/db.js`, which opens a
 * SQLite connection and runs migrations as a side effect of import — pulling
 * that into this standalone process would drag in the entire backend runtime
 * (better-sqlite3, Express) for a client that only needs the wire shapes.
 * `shared/commandSafety.ts` is different (zero-dependency by design) and is
 * imported directly by `commandExecutor.ts`.
 *
 * Keep these types in exact sync with `server/agentRelay/protocol.ts` if that
 * module's schemas ever change.
 */

import WebSocket from 'ws';
import type { DetectedShell } from './shellDetection.js';

export type AgentToBackendMessage =
  | { type: 'hello'; agentVersion: string; deviceName: string; platform?: string; shell?: DetectedShell }
  | { type: 'heartbeat' }
  | { type: 'command_awaiting_confirmation'; requestId: string }
  | {
      type: 'command_output_chunk';
      requestId: string;
      stream: 'stdout' | 'stderr';
      text: string;
      seq: number;
    }
  | {
      type: 'command_response';
      requestId: string;
      exitCode: number | null;
      stdout: string;
      stderr: string;
      durationMs: number;
      blockedPattern?: string;
      confirmation?: 'approved' | 'declined' | 'timeout';
    }
  | {
      type: 'read_file_response';
      requestId: string;
      ok: boolean;
      error?: string;
      content?: string;
      totalLines?: number;
      startLine?: number;
      endLine?: number;
      truncated?: boolean;
    }
  | {
      type: 'write_file_response';
      requestId: string;
      ok: boolean;
      error?: string;
      bytesWritten?: number;
      created?: boolean;
    }
  | {
      type: 'edit_file_response';
      requestId: string;
      ok: boolean;
      error?: string;
      replacementsMade?: number;
    }
  | {
      type: 'delete_file_response';
      requestId: string;
      ok: boolean;
      error?: string;
      kind?: 'file' | 'directory';
      confirmation?: 'declined' | 'timeout';
    }
  | {
      type: 'list_directory_response';
      requestId: string;
      ok: boolean;
      error?: string;
      entries?: Array<{ name: string; type: 'file' | 'directory' | 'symlink' | 'other'; sizeBytes?: number }>;
      truncated?: boolean;
      totalEntries?: number;
    };

export type BackendToAgentMessage =
  | { type: 'hello_ack'; agentId: string }
  | { type: 'heartbeat_ack' }
  | { type: 'command_request'; requestId: string; command: string; cwd?: string; timeoutMs: number }
  | { type: 'command_cancel'; requestId: string }
  | { type: 'read_file_request'; requestId: string; path: string; offset?: number; limit?: number }
  | { type: 'write_file_request'; requestId: string; path: string; content: string; hasBeenRead: boolean }
  | {
      type: 'edit_file_request';
      requestId: string;
      path: string;
      oldString: string;
      newString: string;
      replaceAll?: boolean;
      hasBeenRead: boolean;
    }
  | { type: 'delete_file_request'; requestId: string; path: string; recursive?: boolean }
  | { type: 'list_directory_request'; requestId: string; path: string };

export type CommandRequestMessage = Extract<BackendToAgentMessage, { type: 'command_request' }>;
export type ReadFileRequestMessage = Extract<BackendToAgentMessage, { type: 'read_file_request' }>;
export type WriteFileRequestMessage = Extract<BackendToAgentMessage, { type: 'write_file_request' }>;
export type EditFileRequestMessage = Extract<BackendToAgentMessage, { type: 'edit_file_request' }>;
export type DeleteFileRequestMessage = Extract<BackendToAgentMessage, { type: 'delete_file_request' }>;
export type ListDirectoryRequestMessage = Extract<BackendToAgentMessage, { type: 'list_directory_request' }>;

/** Matches the 20s heartbeat / 60s backend-timeout pair fixed in `global-constraints.md`. */
export const HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * Best-effort runtime validation of an inbound backend message. Manual
 * (rather than a Zod schema) to avoid adding a dependency purely to mirror
 * `protocol.ts`'s validation on the client side; the backend is the
 * authoritative validator for what it accepts from us, and we only need to
 * defend ourselves against a malformed/unexpected frame here.
 */
export function parseBackendMessage(raw: string): BackendToAgentMessage | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null || !('type' in json)) return null;
  const message = json as Record<string, unknown>;
  switch (message.type) {
    case 'hello_ack':
      return typeof message.agentId === 'string' ? { type: 'hello_ack', agentId: message.agentId } : null;
    case 'heartbeat_ack':
      return { type: 'heartbeat_ack' };
    case 'command_request':
      if (
        typeof message.requestId === 'string' &&
        typeof message.command === 'string' &&
        typeof message.timeoutMs === 'number' &&
        (message.cwd === undefined || typeof message.cwd === 'string')
      ) {
        return {
          type: 'command_request',
          requestId: message.requestId,
          command: message.command,
          cwd: message.cwd as string | undefined,
          timeoutMs: message.timeoutMs,
        };
      }
      return null;
    case 'command_cancel':
      return typeof message.requestId === 'string' ? { type: 'command_cancel', requestId: message.requestId } : null;
    case 'read_file_request':
      if (
        typeof message.requestId === 'string' &&
        typeof message.path === 'string' &&
        (message.offset === undefined || typeof message.offset === 'number') &&
        (message.limit === undefined || typeof message.limit === 'number')
      ) {
        return {
          type: 'read_file_request',
          requestId: message.requestId,
          path: message.path,
          offset: message.offset as number | undefined,
          limit: message.limit as number | undefined,
        };
      }
      return null;
    case 'write_file_request':
      if (
        typeof message.requestId === 'string' &&
        typeof message.path === 'string' &&
        typeof message.content === 'string' &&
        typeof message.hasBeenRead === 'boolean'
      ) {
        return {
          type: 'write_file_request',
          requestId: message.requestId,
          path: message.path,
          content: message.content,
          hasBeenRead: message.hasBeenRead,
        };
      }
      return null;
    case 'edit_file_request':
      if (
        typeof message.requestId === 'string' &&
        typeof message.path === 'string' &&
        typeof message.oldString === 'string' &&
        typeof message.newString === 'string' &&
        (message.replaceAll === undefined || typeof message.replaceAll === 'boolean') &&
        typeof message.hasBeenRead === 'boolean'
      ) {
        return {
          type: 'edit_file_request',
          requestId: message.requestId,
          path: message.path,
          oldString: message.oldString,
          newString: message.newString,
          replaceAll: message.replaceAll as boolean | undefined,
          hasBeenRead: message.hasBeenRead,
        };
      }
      return null;
    case 'delete_file_request':
      if (
        typeof message.requestId === 'string' &&
        typeof message.path === 'string' &&
        (message.recursive === undefined || typeof message.recursive === 'boolean')
      ) {
        return {
          type: 'delete_file_request',
          requestId: message.requestId,
          path: message.path,
          recursive: message.recursive as boolean | undefined,
        };
      }
      return null;
    case 'list_directory_request':
      if (typeof message.requestId === 'string' && typeof message.path === 'string') {
        return { type: 'list_directory_request', requestId: message.requestId, path: message.path };
      }
      return null;
    default:
      return null;
  }
}

function toWebSocketUrl(backendUrl: string): string {
  const url = new URL(backendUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/api/agent/connect';
  url.search = '';
  return url.toString();
}

export interface AgentTransportHandle {
  send(message: AgentToBackendMessage): void;
  close(reason?: string): void;
}

export interface ConnectAgentOptions {
  backendUrl: string;
  token: string;
  agentVersion: string;
  deviceName: string;
  /**
   * Detected once at startup (`createShellDetector()`) and passed to every
   * `connectAgent()` call across reconnects — never re-detected per
   * connection attempt. Optional here only to mirror the wire schema's own
   * optionality (`global-constraints.md`); the real local agent always
   * supplies both.
   */
  platform?: string;
  shell?: DetectedShell;
  onMessage(message: BackendToAgentMessage): void;
  /** Fired once, right after the socket physically opens and `hello` is sent. */
  onOpen?(): void;
  onClose(reason: string): void;
}

/**
 * Opens one WebSocket connection: sends `hello` on open, a `heartbeat` every
 * `HEARTBEAT_INTERVAL_MS`, and forwards parsed inbound messages to
 * `onMessage`. Does not reconnect on its own — the caller (`index.ts`) owns
 * the reconnect-with-backoff loop, one `connectAgent` call per attempt.
 */
export function connectAgent(options: ConnectAgentOptions): AgentTransportHandle {
  const socket = new WebSocket(toWebSocketUrl(options.backendUrl), {
    headers: { Authorization: `Bearer ${options.token}` },
  });
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let closed = false;

  const stopHeartbeat = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  };

  socket.on('open', () => {
    socket.send(
      JSON.stringify({
        type: 'hello',
        agentVersion: options.agentVersion,
        deviceName: options.deviceName,
        // JSON.stringify drops undefined-valued properties, so this stays a
        // no-op extension when platform/shell are omitted (matching the
        // wire schema's optionality) and always present in what the real
        // local agent actually sends (index.ts always supplies both).
        platform: options.platform,
        shell: options.shell,
      })
    );
    heartbeatTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'heartbeat' }));
      }
    }, HEARTBEAT_INTERVAL_MS);
    options.onOpen?.();
  });

  socket.on('message', (raw, isBinary) => {
    if (isBinary) return;
    const message = parseBackendMessage(raw.toString());
    if (message) options.onMessage(message);
  });

  const handleClose = (reason: string) => {
    if (closed) return;
    closed = true;
    stopHeartbeat();
    options.onClose(reason);
  };

  socket.on('close', (code, reasonBuf) => {
    const reasonText = reasonBuf.toString() || `connection closed (code ${code})`;
    handleClose(reasonText);
  });

  socket.on('error', (error) => {
    console.error('[local-agent] transport error:', error.message);
    // 'close' always follows 'error' for a ws client socket; do not resolve
    // twice here.
  });

  return {
    send(message) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
      }
    },
    close(reason = 'client closing') {
      stopHeartbeat();
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, reason.slice(0, 123));
      }
      handleClose(reason);
    },
  };
}
