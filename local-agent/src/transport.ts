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

export type AgentToBackendMessage =
  | { type: 'hello'; agentVersion: string; deviceName: string }
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
    };

export type BackendToAgentMessage =
  | { type: 'hello_ack'; agentId: string }
  | { type: 'heartbeat_ack' }
  | { type: 'command_request'; requestId: string; command: string; cwd?: string; timeoutMs: number }
  | { type: 'command_cancel'; requestId: string };

export type CommandRequestMessage = Extract<BackendToAgentMessage, { type: 'command_request' }>;

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
    socket.send(JSON.stringify({ type: 'hello', agentVersion: options.agentVersion, deviceName: options.deviceName }));
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
