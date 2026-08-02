/**
 * MCP relay sessions: MCP servers hosted by the user's paired local agent.
 *
 * Instead of spawning the MCP server on the backend, the backend asks the
 * user's local agent (connected over the per-user WebSocket relay) to spawn
 * the server as a stdio child process and bridges JSON-RPC messages back and
 * forth. This is how Playwright MCP opens a browser on the user's own PC.
 *
 * Sessions are pooled per (userId, serverId) key with reference counting:
 * every acquire returns the SAME Client instance and increments the refcount;
 * the returned close() is a release that decrements it. When the refcount
 * reaches zero an idle timer starts (RELAY_IDLE_MS, default 15 min) and then
 * the session is torn down, keeping the remote process (and e.g. an open
 * browser) alive between chat turns.
 */

import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { deserializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import {
  getAgentConnection,
  isAgentConnected,
  registerDisconnectHook,
  registerMessageHook,
  sendFileOpRequest,
} from '../agentRelay/registry.js';
import type { AgentToBackendMessage } from '../agentRelay/protocol.js';
import type { McpConnection } from './client.js';
import { invalidateMcpToolCache } from './client.js';
import type { McpConfigStdio } from './types.js';

const MCP_CLIENT_NAME = 'agent-studio';
const MCP_CLIENT_VERSION = '1.0.0';

// First `npx` run may download packages on the user's machine, so be generous.
const RELAY_START_TIMEOUT_MS = Number.parseInt(process.env.RELAY_START_TIMEOUT_MS ?? '', 10) || 120_000;
const RELAY_IDLE_MS = Number.parseInt(process.env.RELAY_IDLE_MS ?? '', 10) || 15 * 60_000;
const RELAY_STOP_TIMEOUT_MS = 5_000;
const RELAY_DISCONNECT_ERROR = 'local agent disconnected';

interface RelaySession {
  userId: string;
  serverId: string;
  client: Client;
  transport: RelayTransport;
  refCount: number;
  idleTimer: NodeJS.Timeout | null;
}

/** Live sessions, keyed by `${userId}:${serverId}`. */
const sessions = new Map<string, RelaySession>();
/** Single-flight map: an in-progress create for a key shares one promise. */
const pendingCreates = new Map<string, Promise<RelaySession>>();
/** channelId (mcp_servers.id) -> transport, for routing inbound relay messages. */
const channelRoutes = new Map<string, RelayTransport>();

function sessionKey(userId: string, serverId: string): string {
  return `${userId}:${serverId}`;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: () => Promise<void> | void
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      void Promise.resolve(onTimeout?.()).finally(() => reject(new Error(message)));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
    // Avoid unhandled rejections if the underlying operation finishes after the timeout.
    if (timedOut) promise.catch(() => undefined);
  }
}

function createRelayClient(label: string): Client {
  const client = new Client(
    { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
    {
      listChanged: {
        tools: {
          onChanged: (error: Error | null) => {
            invalidateMcpToolCache(client);
            if (error) {
              console.warn(`[mcp] Failed to refresh changed tool list for ${label}:`, error.message);
            } else {
              console.log(`[mcp] Tool list changed for ${label}; cache invalidated`);
            }
          },
        },
      },
    }
  );
  return client;
}

/**
 * Get (or create) the relay session for (userId, serverId).
 * Pooled and single-flight: concurrent callers share one in-flight create.
 */
export async function getOrCreateRelaySession(
  userId: string,
  serverId: string,
  config: McpConfigStdio,
): Promise<McpConnection> {
  const key = sessionKey(userId, serverId);

  const existing = sessions.get(key);
  if (existing) {
    existing.refCount += 1;
    resetIdleTimer(existing);
    return makeConnection(existing);
  }

  const inFlight = pendingCreates.get(key);
  if (inFlight) {
    const session = await inFlight;
    session.refCount += 1;
    resetIdleTimer(session);
    return makeConnection(session);
  }

  const createPromise = createSession(userId, serverId, config);
  pendingCreates.set(key, createPromise);
  try {
    const session = await createPromise;
    pendingCreates.delete(key);
    return makeConnection(session);
  } catch (err) {
    pendingCreates.delete(key);
    throw err;
  }
}

async function createSession(userId: string, serverId: string, config: McpConfigStdio): Promise<RelaySession> {
  const transport = new RelayTransport(userId, serverId, config);
  const client = createRelayClient(`${config.command || 'relay'} (relay)`);
  const session: RelaySession = {
    userId,
    serverId,
    client,
    transport,
    refCount: 1,
    idleTimer: null,
  };
  sessions.set(sessionKey(userId, serverId), session);
  try {
    await withTimeout(
      client.connect(transport),
      RELAY_START_TIMEOUT_MS,
      `MCP relay connection timed out after ${RELAY_START_TIMEOUT_MS}ms`,
      () => transport.close()
    );
  } catch (err) {
    await teardownRelaySession(userId, serverId);
    throw err;
  }
  console.log(`[mcp] Relay session started for ${serverId} (${config.command || 'mcp'})`);
  return session;
}

/** Wrap a session as an McpConnection whose close() is a refcount release. */
function makeConnection(session: RelaySession): McpConnection {
  return {
    client: session.client,
    close: createRelease(session),
  };
}

function createRelease(session: RelaySession): () => Promise<void> {
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    if (sessions.get(sessionKey(session.userId, session.serverId)) !== session) return; // already torn down
    session.refCount -= 1;
    if (session.refCount <= 0) {
      startIdleTimer(session);
    }
  };
}

function clearIdleTimer(session: RelaySession): void {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
}

function resetIdleTimer(session: RelaySession): void {
  clearIdleTimer(session);
}

function startIdleTimer(session: RelaySession): void {
  clearIdleTimer(session);
  session.idleTimer = setTimeout(() => {
    session.idleTimer = null;
    void teardownRelaySession(session.userId, session.serverId).catch(() => {});
  }, RELAY_IDLE_MS);
}

/**
 * Tear down a relay session. Idempotent: removes it from the pool, rejects any
 * in-flight transport-level pending, sends mcp_stop_request (fire-and-forget)
 * unless the remote already exited, and closes client + transport.
 */
export async function teardownRelaySession(userId: string, serverId: string): Promise<void> {
  const key = sessionKey(userId, serverId);
  const session = sessions.get(key);
  if (!session) return;
  sessions.delete(key);
  clearIdleTimer(session);

  // Fail fast any in-flight tool calls instead of letting them hang.
  session.transport.rejectInFlight(new Error(RELAY_DISCONNECT_ERROR));

  await session.transport.close();
  try {
    await session.client.close();
  } catch (err) {
    console.error(`[mcp] Error closing relay client for ${serverId}:`, err);
  }
}

/** Tear down every relay session belonging to a user (e.g. agent disconnected). */
export async function closeRelaySessionsForUser(userId: string): Promise<void> {
  const prefix = `${userId}:`;
  const keys = [...sessions.keys()].filter((key) => key.startsWith(prefix));
  await Promise.allSettled(keys.map((key) => teardownRelaySession(userId, key.slice(prefix.length))));
}

/**
 * MCP SDK Transport that bridges JSON-RPC messages over the per-user agent
 * relay: start() asks the local agent to spawn the server, send() forwards
 * JSON-RPC messages, and inbound mcp_message / mcp_exited frames are routed
 * here by the module-level message hook.
 */
class RelayTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;

  private readonly userId: string;
  private readonly serverId: string;
  private readonly config: McpConfigStdio;
  private started = false;
  private closed = false;
  private stopSent = false;
  private oncloseInvoked = false;
  /** JSON-RPC request ids awaiting a response from the remote server. */
  private readonly inFlightIds = new Set<string>();

  constructor(userId: string, serverId: string, config: McpConfigStdio) {
    this.userId = userId;
    this.serverId = serverId;
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (!isAgentConnected(this.userId)) {
      throw new Error('local agent is not connected');
    }
    channelRoutes.set(this.serverId, this);
    this.started = true;
    try {
      const response = await sendFileOpRequest<{ ok: boolean; error?: string }>(
        this.userId,
        {
          type: 'mcp_start_request',
          requestId: randomUUID(),
          channelId: this.serverId,
          config: {
            command: this.config.command,
            args: this.config.args,
            env: this.config.env,
            cwd: this.config.cwd,
          },
        },
        RELAY_START_TIMEOUT_MS
      );
      if (response.ok !== true) {
        throw new Error(response.error || 'MCP relay start failed');
      }
    } catch (err) {
      if (channelRoutes.get(this.serverId) === this) {
        channelRoutes.delete(this.serverId);
      }
      this.started = false;
      const message = (err as { error?: string })?.error ?? (err instanceof Error ? err.message : String(err));
      throw new Error(message);
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error('relay transport is closed');
    const connection = getAgentConnection(this.userId);
    if (!connection) throw new Error('local agent is not connected');
    // Track client -> server requests so exit/disconnect can fail them fast.
    if ('id' in message && 'method' in message) {
      this.inFlightIds.add(String(message.id));
    }
    try {
      connection.send({ type: 'mcp_message', channelId: this.serverId, payload: message });
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Only send stop if we still own the channel route: after an exit or a
    // restart the route belongs to a newer transport and stopping would kill
    // the wrong process.
    if (this.started && !this.stopSent && channelRoutes.get(this.serverId) === this) {
      this.stopSent = true;
      void sendFileOpRequest<{ ok: boolean }>(
        this.userId,
        { type: 'mcp_stop_request', requestId: randomUUID(), channelId: this.serverId },
        RELAY_STOP_TIMEOUT_MS
      ).catch(() => {});
    }
    if (channelRoutes.get(this.serverId) === this) {
      channelRoutes.delete(this.serverId);
    }
    this.invokeOnclose();
  }

  /**
   * Called when the local agent reports the remote process exited
   * (mcp_exited). Fails in-flight calls with a clear error and tears down.
   */
  handleExited(exitCode: number | null): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectInFlight(new Error(RELAY_DISCONNECT_ERROR));
    if (channelRoutes.get(this.serverId) === this) {
      channelRoutes.delete(this.serverId);
    }
    void teardownRelaySession(this.userId, this.serverId).catch(() => {});
    this.invokeOnclose();
    console.log(`[mcp] Relay session ${this.serverId} exited (code ${exitCode ?? 'unknown'})`);
  }

  /** Forget an id whose response just arrived. */
  handleResponse(message: JSONRPCMessage): void {
    if ('id' in message && ('result' in message || 'error' in message)) {
      this.inFlightIds.delete(String(message.id));
    }
  }

  /**
   * Deliver fabricated JSON-RPC error responses for every request still
   * awaiting a response, so the MCP client resolves them with a clear error
   * instead of hanging until its own timeout.
   */
  rejectInFlight(reason: Error): void {
    if (this.inFlightIds.size === 0) return;
    const ids = [...this.inFlightIds];
    this.inFlightIds.clear();
    for (const id of ids) {
      try {
        const errorMessage: JSONRPCMessage = {
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: reason.message },
        };
        this.onmessage?.(errorMessage);
      } catch {
        // ignore per-message delivery errors
      }
    }
  }

  private invokeOnclose(): void {
    if (this.oncloseInvoked) return;
    this.oncloseInvoked = true;
    this.onclose?.();
  }
}

// --- Module init: route inbound relay messages and agent disconnects ---

function routeRelayMessage(message: AgentToBackendMessage): void {
  if (message.type === 'mcp_message') {
    const transport = channelRoutes.get(message.channelId);
    if (!transport) return;
    try {
      const jsonRpcMessage = typeof message.payload === 'string'
        ? deserializeMessage(message.payload)
        : deserializeMessage(JSON.stringify(message.payload));
      transport.handleResponse(jsonRpcMessage);
      transport.onmessage?.(jsonRpcMessage);
    } catch (err) {
      transport.onerror?.(err instanceof Error ? err : new Error(String(err)));
    }
    return;
  }
  if (message.type === 'mcp_exited') {
    const transport = channelRoutes.get(message.channelId);
    if (!transport) return;
    transport.handleExited(message.exitCode);
  }
}

registerMessageHook(routeRelayMessage);

registerDisconnectHook((userId) => {
  void closeRelaySessionsForUser(userId);
});
