import crypto from 'crypto';
import type { Server } from 'http';
import { WebSocketServer, type WebSocket } from 'ws';

/**
 * Temporary diagnostic-only WebSocket echo probe.
 *
 * Purpose: empirically determine whether Railway's proxy sustains a
 * long-lived / idle WebSocket connection for the local-agent transport
 * (task-07). This is NOT the real transport — no reconnection, no message
 * queuing, nothing production-relevant. See plans/agent-terminal-tooling
 * task-04 brief.
 *
 * Mounted only when ENABLE_WS_PROBE=true (default off). Requires a shared
 * secret (WS_PROBE_TOKEN) on the upgrade request — either as a `token` query
 * param or an `x-ws-probe-token` header. This is intentionally NOT wired
 * into authMiddleware/JWT; it is infra-diagnostic, not user-facing.
 */

export const WS_PROBE_PATH = '/api/agent/ws-probe';

/** Constant-time string compare that tolerates unequal lengths (crypto.timingSafeEqual throws on those). */
function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still do a timingSafeEqual of equal-length buffers so the failure path
    // takes comparable time to the equal-length case, then report unequal.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Attach the probe's WebSocket server to the given shared http.Server via an
 * `upgrade` listener (not a second http.createServer()) so it coexists with
 * Express's normal request handling on the same port/instance.
 */
export function mountWsProbe(server: Server): void {
  const token = process.env.WS_PROBE_TOKEN;
  if (!token) {
    console.warn('[ws-probe] ENABLE_WS_PROBE=true but WS_PROBE_TOKEN is not set — probe endpoint will reject all connections.');
  }

  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws: WebSocket) => {
    const connectedAt = Date.now();
    console.log(`[ws-probe] connection opened at ${new Date(connectedAt).toISOString()}`);

    ws.on('message', (data, isBinary) => {
      // Minimal echo: send back exactly what was received.
      ws.send(data, { binary: isBinary });
    });

    ws.on('close', (code, reason) => {
      const durationMs = Date.now() - connectedAt;
      console.log(`[ws-probe] connection closed after ${durationMs}ms code=${code} reason=${reason?.toString() || ''}`);
    });

    ws.on('error', (err) => {
      console.error('[ws-probe] connection error:', err);
    });
  });

  server.on('upgrade', (req, socket, head) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '', 'http://internal').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== WS_PROBE_PATH) {
      // Not ours — leave the socket alone in case another handler wants it.
      return;
    }

    const url = new URL(req.url ?? '', 'http://internal');
    const provided = url.searchParams.get('token') ?? req.headers['x-ws-probe-token'];
    const providedStr = Array.isArray(provided) ? provided[0] : provided;

    if (!token || !constantTimeEqual(providedStr ?? '', token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  console.log(`[ws-probe] mounted at ${WS_PROBE_PATH} (diagnostic probe, ENABLE_WS_PROBE=true)`);
}
