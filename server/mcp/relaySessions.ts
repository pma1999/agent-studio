/**
 * Pooled MCP sessions hosted by the authenticated user's paired local agent.
 *
 * Every route is keyed by (userId, channelId), creation is single-flight and
 * unpublished until negotiation succeeds, and the custom transport performs a
 * disposable era probe so legacy servers that exit before `initialize` still
 * receive a fresh process for the real connection.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  Client,
  deserializeMessage,
  SdkError,
  SdkErrorCode,
  type JSONRPCMessage,
  type PriorDiscovery,
  type RequestId,
  type Transport,
  type TransportSendOptions,
} from '@modelcontextprotocol/client';
import {
  getAgentConnection,
  isAgentConnected,
  registerDisconnectHook,
  registerMessageHook,
  sendFileOpRequest,
} from '../agentRelay/registry.js';
import type { AgentToBackendMessage } from '../agentRelay/protocol.js';
import type { McpConnection, McpConnectionInfo } from './client.js';
import { createConfiguredMcpClient } from './client.js';
import type { McpConfigStdio } from './types.js';

const RELAY_START_TIMEOUT_MS = Number.parseInt(process.env.RELAY_START_TIMEOUT_MS ?? '', 10) || 120_000;
const RELAY_PROBE_TIMEOUT_MS = Number.parseInt(process.env.RELAY_PROBE_TIMEOUT_MS ?? '', 10) || 5_000;
const RELAY_IDLE_MS = Number.parseInt(process.env.RELAY_IDLE_MS ?? '', 10) || 15 * 60_000;
const RELAY_STOP_TIMEOUT_MS = 5_000;
const RELAY_ERA_CACHE_MS = 5 * 60_000;
const RELAY_DISCONNECT_ERROR = 'local agent disconnected';
const MAX_RELAY_MESSAGE_CHARS = 10 * 1024 * 1024;

interface RelaySession {
  userId: string;
  serverId: string;
  configFingerprint: string;
  client: Client;
  transport: RelayTransport;
  info: McpConnectionInfo;
  refCount: number;
  idleTimer: NodeJS.Timeout | null;
}

interface PendingCreate {
  configFingerprint: string;
  promise: Promise<RelaySession>;
}

interface EraCacheEntry {
  prior: PriorDiscovery;
  expiresAt: number;
}

const sessions = new Map<string, RelaySession>();
const pendingCreates = new Map<string, PendingCreate>();
const sessionEpochs = new Map<string, number>();
const channelRoutes = new Map<string, RelayTransport>();
const eraCache = new Map<string, EraCacheEntry>();

function sessionKey(userId: string, serverId: string): string {
  return `${userId}:${serverId}`;
}

function routeKey(userId: string, channelId: string): string {
  return `${userId}:${channelId}`;
}

function sessionEpoch(key: string): number {
  return sessionEpochs.get(key) ?? 0;
}

function fingerprint(config: McpConfigStdio): string {
  return createHash('sha256').update(JSON.stringify({
    command: config.command,
    args: config.args ?? [],
    env: Object.fromEntries(Object.entries(config.env ?? {}).sort(([a], [b]) => a.localeCompare(b))),
    cwd: config.cwd ?? null,
  })).digest('hex');
}

function connectionInfo(client: Client): McpConnectionInfo {
  const era = client.getProtocolEra();
  if (era !== 'modern' && era !== 'legacy') throw new Error('MCP relay connected without a negotiated protocol era');
  const serverInfo = client.getServerVersion();
  return {
    protocolEra: era,
    protocolVersion: client.getNegotiatedProtocolVersion(),
    ...(serverInfo ? { serverInfo } : {}),
    capabilities: client.getServerCapabilities(),
    instructions: client.getInstructions(),
    transport: 'relay',
  };
}

function isLegacyProbeTermination(error: unknown): boolean {
  return error instanceof SdkError && (
    error.code === SdkErrorCode.ConnectionClosed
    || error.code === SdkErrorCode.SendFailed
    || error.code === SdkErrorCode.EraNegotiationFailed
  );
}

async function probeEra(
  userId: string,
  serverId: string,
  config: McpConfigStdio,
  configFingerprint: string
): Promise<PriorDiscovery> {
  const cacheKey = `${sessionKey(userId, serverId)}:${configFingerprint}`;
  const cached = eraCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.prior;
  eraCache.delete(cacheKey);

  const channelId = `${serverId}:probe:${randomUUID()}`;
  const transport = new RelayTransport(userId, serverId, channelId, config);
  const client = createConfiguredMcpClient(
    `${config.command} (relay probe)`,
    `relay-probe:${cacheKey}`,
    userId
  );
  let prior: PriorDiscovery;
  try {
    await client.connect(transport, {
      timeout: RELAY_PROBE_TIMEOUT_MS,
      maxTotalTimeout: RELAY_PROBE_TIMEOUT_MS,
    });
    if (client.getProtocolEra() === 'modern') {
      const discover = client.getDiscoverResult();
      if (!discover) throw new Error('Modern relay probe returned no discovery advertisement');
      prior = { kind: 'modern', discover };
    } else {
      prior = { kind: 'legacy' };
    }
  } catch (error) {
    // Some strict legacy SDKs exit on any request before initialize. Because
    // this is a disposable process, that close is a safe legacy verdict; the
    // real process below will start fresh and run initialize immediately.
    if (!isLegacyProbeTermination(error)) throw error;
    prior = { kind: 'legacy' };
  } finally {
    try {
      await client.close();
    } catch {
      await transport.close().catch(() => undefined);
    }
  }
  eraCache.set(cacheKey, { prior, expiresAt: Date.now() + RELAY_ERA_CACHE_MS });
  return prior;
}

export async function getOrCreateRelaySession(
  userId: string,
  serverId: string,
  config: McpConfigStdio,
): Promise<McpConnection> {
  const key = sessionKey(userId, serverId);
  const configFingerprint = fingerprint(config);

  const existing = sessions.get(key);
  if (existing) {
    if (existing.configFingerprint !== configFingerprint) {
      await teardownRelaySession(userId, serverId);
    } else {
      existing.refCount += 1;
      clearIdleTimer(existing);
      return makeConnection(existing);
    }
  }

  const pending = pendingCreates.get(key);
  if (pending) {
    const session = await pending.promise;
    if (pending.configFingerprint !== configFingerprint) {
      await teardownRelaySession(userId, serverId);
      return getOrCreateRelaySession(userId, serverId, config);
    }
    session.refCount += 1;
    clearIdleTimer(session);
    return makeConnection(session);
  }

  const promise = createSession(
    userId,
    serverId,
    config,
    configFingerprint,
    sessionEpoch(key),
  );
  pendingCreates.set(key, { configFingerprint, promise });
  try {
    return makeConnection(await promise);
  } finally {
    if (pendingCreates.get(key)?.promise === promise) pendingCreates.delete(key);
  }
}

async function createSession(
  userId: string,
  serverId: string,
  config: McpConfigStdio,
  configFingerprint: string,
  epoch: number,
): Promise<RelaySession> {
  const prior = await probeEra(userId, serverId, config, configFingerprint);
  const key = sessionKey(userId, serverId);
  if (sessionEpoch(key) !== epoch) throw new Error('MCP relay session creation was superseded');
  const transport = new RelayTransport(userId, serverId, serverId, config);
  const client = createConfiguredMcpClient(
    `${config.command} (relay)`,
    `relay:${sessionKey(userId, serverId)}:${configFingerprint}`,
    userId
  );
  try {
    await client.connect(transport, {
      prior,
      timeout: RELAY_START_TIMEOUT_MS,
      maxTotalTimeout: RELAY_START_TIMEOUT_MS,
    });
  } catch (error) {
    try {
      await client.close();
    } catch {
      await transport.close().catch(() => undefined);
    }
    throw error;
  }

  if (sessionEpoch(key) !== epoch) {
    try {
      await client.close();
    } catch {
      await transport.close().catch(() => undefined);
    }
    throw new Error('MCP relay session creation was superseded');
  }

  const session: RelaySession = {
    userId,
    serverId,
    configFingerprint,
    client,
    transport,
    info: connectionInfo(client),
    refCount: 1,
    idleTimer: null,
  };
  sessions.set(key, session);
  console.log(`[mcp] Relay session started for ${serverId} (${session.info.protocolEra})`);
  return session;
}

function makeConnection(session: RelaySession): McpConnection {
  return {
    client: session.client,
    info: session.info,
    close: createRelease(session),
  };
}

function createRelease(session: RelaySession): () => Promise<void> {
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    if (sessions.get(sessionKey(session.userId, session.serverId)) !== session) return;
    session.refCount = Math.max(0, session.refCount - 1);
    if (session.refCount === 0) startIdleTimer(session);
  };
}

function clearIdleTimer(session: RelaySession): void {
  if (!session.idleTimer) return;
  clearTimeout(session.idleTimer);
  session.idleTimer = null;
}

function startIdleTimer(session: RelaySession): void {
  clearIdleTimer(session);
  session.idleTimer = setTimeout(() => {
    session.idleTimer = null;
    void teardownRelaySession(session.userId, session.serverId).catch(() => undefined);
  }, RELAY_IDLE_MS);
}

export async function teardownRelaySession(userId: string, serverId: string): Promise<void> {
  const key = sessionKey(userId, serverId);
  sessionEpochs.set(key, sessionEpoch(key) + 1);
  const pending = pendingCreates.get(key);
  if (pending) pendingCreates.delete(key);
  const session = sessions.get(key);
  if (session) {
    sessions.delete(key);
    clearIdleTimer(session);
    session.transport.rejectInFlight(new Error(RELAY_DISCONNECT_ERROR));
    try {
      await session.client.close();
    } catch (error) {
      console.error(`[mcp] Error closing relay client for ${serverId}:`, error);
    } finally {
      await session.transport.close().catch(() => undefined);
    }
  }
  // A config mutation must not race a still-starting process. Invalidating the
  // epoch makes createSession close instead of publishing; awaiting it ensures
  // the old channel is gone before a replacement can reuse the server id.
  if (pending) await pending.promise.catch(() => undefined);
}

export async function closeRelaySessionsForUser(userId: string): Promise<void> {
  const prefix = `${userId}:`;
  const serverIds = [...new Set([...sessions.keys(), ...pendingCreates.keys()])]
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));
  await Promise.allSettled(serverIds.map((serverId) => teardownRelaySession(userId, serverId)));
}

class RelayTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;

  private started = false;
  private closed = false;
  private stopSent = false;
  private oncloseInvoked = false;
  private readonly inFlightIds = new Map<string, RequestId>();

  constructor(
    private readonly userId: string,
    private readonly serverId: string,
    private readonly channelId: string,
    private readonly config: McpConfigStdio,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    if (!isAgentConnected(this.userId)) throw new Error('local agent is not connected');
    const key = routeKey(this.userId, this.channelId);
    channelRoutes.set(key, this);
    this.started = true;
    try {
      const response = await sendFileOpRequest<{ ok: boolean; error?: string }>(
        this.userId,
        {
          type: 'mcp_start_request',
          requestId: randomUUID(),
          channelId: this.channelId,
          config: {
            command: this.config.command,
            args: this.config.args,
            env: this.config.env,
            cwd: this.config.cwd,
          },
        },
        RELAY_START_TIMEOUT_MS
      );
      if (response.ok !== true) throw new Error(response.error || 'MCP relay start failed');
    } catch (error) {
      if (channelRoutes.get(key) === this) channelRoutes.delete(key);
      this.started = false;
      const message = (error as { error?: string })?.error ?? (error instanceof Error ? error.message : String(error));
      throw new Error(message);
    }
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (this.closed) throw new Error('relay transport is closed');
    const connection = getAgentConnection(this.userId);
    if (!connection) throw new Error('local agent is not connected');
    const serialized = JSON.stringify(message);
    if (serialized.length > MAX_RELAY_MESSAGE_CHARS) throw new Error('MCP relay message exceeds the size limit');
    if ('id' in message && 'method' in message && (typeof message.id === 'string' || typeof message.id === 'number')) {
      this.inFlightIds.set(String(message.id), message.id);
    }
    connection.send({ type: 'mcp_message', channelId: this.channelId, payload: message });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const key = routeKey(this.userId, this.channelId);
    if (this.started && !this.stopSent && channelRoutes.get(key) === this) {
      this.stopSent = true;
      await sendFileOpRequest<{ ok: boolean }>(
        this.userId,
        { type: 'mcp_stop_request', requestId: randomUUID(), channelId: this.channelId },
        RELAY_STOP_TIMEOUT_MS
      ).catch(() => undefined);
    }
    if (channelRoutes.get(key) === this) channelRoutes.delete(key);
    this.invokeOnclose();
  }

  handleExited(exitCode: number | null): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectInFlight(new Error(RELAY_DISCONNECT_ERROR));
    const key = routeKey(this.userId, this.channelId);
    if (channelRoutes.get(key) === this) channelRoutes.delete(key);
    if (this.channelId === this.serverId) {
      void teardownRelaySession(this.userId, this.serverId).catch(() => undefined);
    }
    this.invokeOnclose();
    console.log(`[mcp] Relay channel ${this.channelId} exited (code ${exitCode ?? 'unknown'})`);
  }

  handleResponse(message: JSONRPCMessage): void {
    if ('id' in message && ('result' in message || 'error' in message)) this.inFlightIds.delete(String(message.id));
  }

  rejectInFlight(reason: Error): void {
    if (this.inFlightIds.size === 0) return;
    const ids = [...this.inFlightIds.values()];
    this.inFlightIds.clear();
    for (const id of ids) {
      this.onmessage?.({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: reason.message },
      });
    }
  }

  private invokeOnclose(): void {
    if (this.oncloseInvoked) return;
    this.oncloseInvoked = true;
    this.onclose?.();
  }
}

function routeRelayMessage(userId: string, message: AgentToBackendMessage): void {
  if (message.type !== 'mcp_message' && message.type !== 'mcp_exited') return;
  const transport = channelRoutes.get(routeKey(userId, message.channelId));
  if (!transport) return;
  if (message.type === 'mcp_exited') {
    transport.handleExited(message.exitCode);
    return;
  }
  try {
    const serialized = typeof message.payload === 'string' ? message.payload : JSON.stringify(message.payload);
    if (serialized.length > MAX_RELAY_MESSAGE_CHARS) throw new Error('MCP relay response exceeds the size limit');
    const jsonRpcMessage = deserializeMessage(serialized);
    transport.handleResponse(jsonRpcMessage);
    transport.onmessage?.(jsonRpcMessage);
  } catch (error) {
    transport.onerror?.(error instanceof Error ? error : new Error(String(error)));
  }
}

registerMessageHook(routeRelayMessage);

registerDisconnectHook((userId) => {
  void closeRelaySessionsForUser(userId);
});
