/**
 * WebSocket viability probe for a live Railway deployment (task-04).
 *
 * Run: node scripts/test-ws-probe.mjs <https-or-wss-url> [token]
 *   or: WS_PROBE_URL=... WS_PROBE_TOKEN=... node scripts/test-ws-probe.mjs
 *
 * <url> may be the plain https:// base URL of the deployment (e.g.
 * https://your-app.up.railway.app) — this script appends the
 * probe path and converts the scheme to ws(s):// itself — or a full
 * ws(s)://.../api/agent/ws-probe URL.
 *
 * This talks to a live, deployed URL and requires ENABLE_WS_PROBE=true plus
 * a matching WS_PROBE_TOKEN set on that deployment. It is intentionally not
 * part of the tsx-based "test" chain (npm test) since it needs network
 * access to a remote server, not local code.
 *
 * What it verifies:
 *  (a) idle survival — hold the connection open with ZERO traffic (no app
 *      messages, no ws-level ping/pong frames) for >2 minutes, then confirm
 *      it is still alive by sending one message and getting the echo back.
 *  (b) sustained-traffic survival — hold the connection open for >=5 minutes
 *      with a small echoed message every 20s, confirm zero unexpected drops.
 *  (c) round-trip latency for every exchanged message (min/avg/max).
 */

import WebSocket from 'ws';

const rawUrl = process.argv[2] || process.env.WS_PROBE_URL;
const token = process.argv[3] || process.env.WS_PROBE_TOKEN;

if (!rawUrl) {
  console.error('Usage: node scripts/test-ws-probe.mjs <https-or-wss-url> [token]');
  console.error('   or: WS_PROBE_URL=... WS_PROBE_TOKEN=... node scripts/test-ws-probe.mjs');
  process.exit(1);
}
if (!token) {
  console.error('Missing token: pass as CLI arg 2 or set WS_PROBE_TOKEN.');
  process.exit(1);
}

const IDLE_MS = 130_000; // >2 minutes of true silence
const SUSTAINED_MS = 5 * 60_000; // 5 minutes
const SUSTAINED_INTERVAL_MS = 20_000;
const OPEN_TIMEOUT_MS = 15_000;
const ECHO_TIMEOUT_MS = 15_000;

function toWsUrl(input) {
  let u;
  try {
    u = new URL(input);
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }
  if (u.protocol === 'http:') u.protocol = 'ws:';
  else if (u.protocol === 'https:') u.protocol = 'wss:';
  else if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
    throw new Error(`Unsupported protocol: ${u.protocol}`);
  }
  if (!u.pathname || u.pathname === '/') u.pathname = '/api/agent/ws-probe';
  u.searchParams.set('token', token);
  return u.toString();
}

const wsUrl = toWsUrl(rawUrl);
const latencies = [];
let closeInfo = null;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const openTimeout = setTimeout(() => {
      reject(new Error('Timed out waiting for WebSocket open (check ENABLE_WS_PROBE/WS_PROBE_TOKEN and that the deploy is live)'));
    }, OPEN_TIMEOUT_MS);
    ws.once('open', () => {
      clearTimeout(openTimeout);
      log('Connection opened');
      resolve(ws);
    });
    ws.once('unexpected-response', (_req, res) => {
      clearTimeout(openTimeout);
      reject(new Error(`Unexpected HTTP response during handshake: ${res.statusCode}`));
    });
    ws.once('error', (err) => {
      clearTimeout(openTimeout);
      reject(err);
    });
  });
}

function pingOnce(ws, label) {
  return new Promise((resolve, reject) => {
    const payload = `${label}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const sentAt = Date.now();
    const timeout = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`Timed out waiting for echo of "${label}" after ${ECHO_TIMEOUT_MS}ms`));
    }, ECHO_TIMEOUT_MS);
    const onMessage = (data) => {
      const text = data.toString();
      if (text !== payload) return; // not our message; keep waiting
      clearTimeout(timeout);
      ws.off('message', onMessage);
      const rtt = Date.now() - sentAt;
      latencies.push(rtt);
      log(`Echo received for "${label}" — round-trip ${rtt}ms`);
      resolve(rtt);
    };
    ws.on('message', onMessage);
    ws.send(payload);
  });
}

async function main() {
  log(`Target: ${wsUrl.replace(/token=[^&]+/, 'token=***')}`);
  const ws = await connect();

  ws.on('close', (code, reason) => {
    closeInfo = { code, reason: reason?.toString() || '' };
    log(`Connection closed. code=${code} reason=${closeInfo.reason}`);
  });
  ws.on('error', (err) => {
    log(`Socket error: ${err.message}`);
  });

  log('--- Sanity check: immediate echo ---');
  await pingOnce(ws, 'sanity');

  log(`--- Phase A: idle for ${Math.round(IDLE_MS / 1000)}s with ZERO traffic (no app messages, no ws-level pings) ---`);
  const idleStart = Date.now();
  await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
  const idleElapsed = Date.now() - idleStart;

  if (ws.readyState !== WebSocket.OPEN || closeInfo) {
    console.error(`Phase A FAILED: connection is NOT open after ${idleElapsed}ms idle. readyState=${ws.readyState} closeInfo=${JSON.stringify(closeInfo)}`);
    console.log('\n=== VERDICT INPUT ===');
    console.log(`idle_survival: false (dropped at/before ${idleElapsed}ms)`);
    process.exitCode = 1;
    return;
  }
  log(`Phase A: connection still OPEN after ${idleElapsed}ms idle. Verifying liveness with one echo...`);
  await pingOnce(ws, 'post-idle');
  log('Phase A PASSED: idle survival confirmed.');

  log(`--- Phase B: sustained traffic for ${Math.round(SUSTAINED_MS / 1000)}s, one message every ${SUSTAINED_INTERVAL_MS / 1000}s ---`);
  const sustainedStart = Date.now();
  let seq = 0;
  let drops = 0;
  while (Date.now() - sustainedStart < SUSTAINED_MS) {
    await new Promise((resolve) => setTimeout(resolve, SUSTAINED_INTERVAL_MS));
    seq += 1;
    if (ws.readyState !== WebSocket.OPEN || closeInfo) {
      console.error(`Phase B: connection dropped before message #${seq}. closeInfo=${JSON.stringify(closeInfo)}`);
      drops += 1;
      break;
    }
    try {
      await pingOnce(ws, `sustained-${seq}`);
    } catch (e) {
      console.error(`Phase B: message #${seq} failed: ${e.message}`);
      drops += 1;
      break;
    }
  }
  const sustainedElapsed = Date.now() - sustainedStart;

  if (drops > 0) {
    console.error(`Phase B FAILED after ${sustainedElapsed}ms with ${drops} drop(s) (${seq} messages attempted).`);
  } else {
    log(`Phase B PASSED: ${seq} messages exchanged over ${sustainedElapsed}ms with zero drops.`);
  }

  const min = Math.min(...latencies);
  const max = Math.max(...latencies);
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  log('--- Summary ---');
  log(`Round-trips recorded: ${latencies.length}`);
  log(`Latency min/avg/max: ${min}ms / ${avg.toFixed(1)}ms / ${max}ms`);

  console.log('\n=== VERDICT INPUT ===');
  console.log(`idle_survival: true (>=${idleElapsed}ms with zero traffic)`);
  console.log(`sustained_survival: ${drops === 0} (${seq} messages / ${sustainedElapsed}ms, ${drops} drop(s))`);
  console.log(`latency_ms: min=${min} avg=${avg.toFixed(1)} max=${max} n=${latencies.length}`);

  if (drops > 0) {
    process.exitCode = 1;
  }

  ws.close(1000, 'probe complete');
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  process.exitCode = 1;
});
