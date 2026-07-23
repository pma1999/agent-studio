import crypto from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import db from '../db.js';
import { authMiddleware, type AuthRequest } from '../middleware/auth.js';
import { registerShutdownHook } from '../shutdown.js';
import {
  AgentToBackendMessageSchema,
  BackendToAgentMessageSchema,
  generatePairingCode,
  hashToken,
  validateAgentToken,
  type AgentToBackendMessage,
  type BackendToAgentMessage,
} from '../agentRelay/protocol.js';
import {
  registerAgentConnection,
  unregisterAgentConnection,
  type AgentConnection,
} from '../agentRelay/registry.js';

const PAIRING_CODE_TTL_MS = 10 * 60 * 1_000;
const HEARTBEAT_TIMEOUT_MS = 60_000;
const pairingCodes = new Map<string, { userId: string; expiresAt: number }>();

class PairingError extends Error {
  constructor(message: string, readonly status: 400 | 401) {
    super(message);
  }
}

class WebSocketAgentConnection implements AgentConnection {
  private callbacks: Array<(message: AgentToBackendMessage) => void> = [];
  private identity: { platform?: string; shell?: { kind: string; execPath: string } } | undefined;

  constructor(private readonly socket: WebSocket) {
    socket.on('message', (raw: RawData, isBinary: boolean) => {
      if (isBinary) {
        console.warn('[agent-relay] Dropped binary agent message');
        return;
      }
      try {
        const parsedJson: unknown = JSON.parse(raw.toString());
        const parsed = AgentToBackendMessageSchema.safeParse(parsedJson);
        if (!parsed.success) {
          console.warn('[agent-relay] Dropped malformed agent message:', parsed.error.message);
          return;
        }
        for (const callback of this.callbacks) callback(parsed.data);
      } catch (error) {
        console.warn('[agent-relay] Dropped unreadable agent message:', error);
      }
    });
  }

  isConnected(): boolean {
    return this.socket.readyState === this.socket.OPEN;
  }

  send(message: BackendToAgentMessage): void {
    const parsed = BackendToAgentMessageSchema.safeParse(message);
    if (!parsed.success) {
      console.warn('[agent-relay] Dropped malformed backend message:', parsed.error.message);
      return;
    }
    if (this.isConnected()) this.socket.send(JSON.stringify(parsed.data));
  }

  onMessage(callback: (message: AgentToBackendMessage) => void): void {
    this.callbacks.push(callback);
  }

  setIdentity(message: Extract<AgentToBackendMessage, { type: 'hello' }>): void {
    this.identity = message.platform !== undefined || message.shell !== undefined
      ? { platform: message.platform, shell: message.shell }
      : undefined;
  }

  getIdentity() {
    return this.identity;
  }

  close(reason = 'connection closed'): void {
    if (this.socket.readyState === this.socket.OPEN || this.socket.readyState === this.socket.CONNECTING) {
      this.socket.close(1000, reason.slice(0, 123));
    }
  }
}

type ActivePairing = { userId: string; agentId: string; connection: AgentConnection };
const activePairings = new Map<string, ActivePairing>();

export function issuePairingCode(userId: string): { code: string; expires_at: string } {
  let code = generatePairingCode();
  while (pairingCodes.has(code)) code = generatePairingCode();
  const expiresAt = Date.now() + PAIRING_CODE_TTL_MS;
  pairingCodes.set(code, { userId, expiresAt });
  setTimeout(() => {
    if (pairingCodes.get(code)?.expiresAt === expiresAt) pairingCodes.delete(code);
  }, PAIRING_CODE_TTL_MS).unref();
  return { code, expires_at: new Date(expiresAt).toISOString() };
}

export function exchangePairingCode(
  code: string,
  deviceName: unknown,
): { agent_id: string; token: string } {
  const pairing = pairingCodes.get(code);
  if (pairing) pairingCodes.delete(code);
  if (!pairing) throw new PairingError('Invalid or already-used pairing code', 401);
  if (pairing.expiresAt <= Date.now()) throw new PairingError('Pairing code has expired', 400);
  if (typeof deviceName !== 'string' || !deviceName.trim() || deviceName.trim().length > 120) {
    throw new PairingError('device_name must be a non-empty string of at most 120 characters', 400);
  }

  const agentId = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`
    INSERT INTO paired_agents (id, user_id, device_name, token_hash)
    VALUES (?, ?, ?, ?)
  `).run(agentId, pairing.userId, deviceName.trim(), hashToken(token));
  return { agent_id: agentId, token };
}

const agentRouter = express.Router();

agentRouter.post('/pair', (req, res) => {
  const pairingCode = req.body?.pairing_code;
  if (typeof pairingCode !== 'string') {
    res.status(400).json({ error: 'pairing_code is required' });
    return;
  }
  try {
    res.status(201).json(exchangePairingCode(pairingCode, req.body?.device_name));
  } catch (error) {
    if (error instanceof PairingError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    console.error('[agent-relay] Pairing exchange failed:', error);
    res.status(500).json({ error: 'Failed to pair local agent' });
  }
});

agentRouter.use(authMiddleware);

agentRouter.post('/pairing-codes', (req: AuthRequest, res) => {
  if (!req.userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  res.status(201).json(issuePairingCode(req.userId));
});

agentRouter.get('/pairings', (req: AuthRequest, res) => {
  const rows = db.prepare(`
    SELECT id, device_name, created_at, last_seen_at, revoked_at
    FROM paired_agents
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(req.userId) as Array<{
    id: string;
    device_name: string;
    created_at: string;
    last_seen_at: string | null;
    revoked_at: string | null;
  }>;
  res.json(rows.map((row) => ({
    ...row,
    connected: activePairings.get(row.id)?.connection.isConnected() === true,
  })));
});

agentRouter.delete('/pairings/:id', (req: AuthRequest, res) => {
  const result = db.prepare(`
    UPDATE paired_agents
    SET revoked_at = COALESCE(revoked_at, datetime('now'))
    WHERE id = ? AND user_id = ?
  `).run(req.params.id, req.userId);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Pairing not found' });
    return;
  }
  const active = activePairings.get(req.params.id);
  if (active) {
    unregisterAgentConnection(active.userId, active.connection, 'pairing revoked');
    active.connection.close('pairing revoked');
    activePairings.delete(req.params.id);
  }
  res.json({ ok: true });
});

export function mountAgentTransport(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });
  const connectionIdentities = new WeakMap<WebSocket, { userId: string; agentId: string }>();

  wss.on('connection', (socket: WebSocket) => {
    const identity = connectionIdentities.get(socket);
    if (!identity) {
      socket.close(1008, 'missing authenticated identity');
      return;
    }
    const connection = new WebSocketAgentConnection(socket);
    const active: ActivePairing = { ...identity, connection };
    activePairings.set(identity.agentId, active);
    registerAgentConnection(identity.userId, connection);

    const heartbeatExpired = () => {
      unregisterAgentConnection(identity.userId, connection, 'heartbeat timeout');
      connection.close('heartbeat timeout');
    };
    let heartbeatTimeout = setTimeout(heartbeatExpired, HEARTBEAT_TIMEOUT_MS);
    heartbeatTimeout.unref();

    connection.onMessage((message) => {
      if (message.type === 'hello') {
        connection.setIdentity(message);
        connection.send({ type: 'hello_ack', agentId: identity.agentId });
        return;
      }
      if (message.type !== 'heartbeat') return;
      const stillValid = db.prepare(
        'SELECT 1 FROM paired_agents WHERE id = ? AND revoked_at IS NULL',
      ).get(identity.agentId);
      if (!stillValid) {
        unregisterAgentConnection(identity.userId, connection, 'pairing revoked');
        connection.close('pairing revoked');
        return;
      }
      clearTimeout(heartbeatTimeout);
      heartbeatTimeout = setTimeout(heartbeatExpired, HEARTBEAT_TIMEOUT_MS);
      heartbeatTimeout.unref();
      db.prepare("UPDATE paired_agents SET last_seen_at = datetime('now') WHERE id = ?").run(identity.agentId);
      connection.send({ type: 'heartbeat_ack' });
    });

    socket.on('close', () => {
      clearTimeout(heartbeatTimeout);
      if (activePairings.get(identity.agentId)?.connection === connection) {
        activePairings.delete(identity.agentId);
      }
      unregisterAgentConnection(identity.userId, connection);
    });
    socket.on('error', (error) => console.warn('[agent-relay] WebSocket error:', error));
  });

  server.on('upgrade', (request, socket, head) => {
    let url: URL;
    try {
      url = new URL(request.url ?? '', 'http://internal');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/api/agent/connect') return;

    const authorization = request.headers.authorization;
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    const identity = validateAgentToken(token);
    if (!identity) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (webSocket) => {
      connectionIdentities.set(webSocket, identity);
      wss.emit('connection', webSocket, request);
    });
  });

  registerShutdownHook(() => {
    for (const active of activePairings.values()) {
      unregisterAgentConnection(active.userId, active.connection, 'server restarting');
      active.connection.close('server restarting');
    }
    activePairings.clear();
  });
}

export default agentRouter;
