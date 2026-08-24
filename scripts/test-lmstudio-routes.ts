/**
 * OFFLINE acceptance harness for the LM Studio model routes
 * (GET /api/models/lmstudio, GET /api/models/lmstudio/status,
 *  POST /api/models/lmstudio/load, POST /api/models/lmstudio/compliance,
 *  POST /api/models/lmstudio/unload).
 *
 * No live LM Studio is required: every scenario exercises the §8 fail-soft
 * contracts against a deliberately dead backend (127.0.0.1:9 refuses instantly),
 * which is a fully supported runtime state ("unreachable is a valid payload").
 * The happy-path catalog/status shapes need a real LM Studio and stay with the
 * manual E2E pass, per task-6-brief.
 *
 * db-touching: needs a Linux-built better-sqlite3 (shadow tree under WSL).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Offline harness: temp DATABASE_PATH must be set BEFORE importing server/db.js.
const testDbPath = path.join(os.tmpdir(), `lmstudio-routes-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = testDbPath;
// Dead backend so direct probes refuse instantly regardless of a real LM Studio.
process.env.LMSTUDIO_BASE_URL = 'http://127.0.0.1:9';
process.env.JWT_SECRET = 'test-secret';

const express = (await import('express')).default;
const { migrate } = await import('../server/db.js');
const modelsRouter = (await import('../server/routes/models.js')).default;

let checks = 0;
function ok(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`ok ${checks} - ${name}`);
}

await migrate();

const USER_A = '00000000-0000-4000-8000-00000000000a';

/** Auth stub that mirrors the real middleware contract but leaves userId unset
 *  without credentials, so each route's own `req.userId` 401 guard is exercised. */
function fakeAuth(req: any, res: import('express').Response, next: () => void): void {
  const user = req.headers['x-test-user'];
  if (typeof user === 'string' && user) {
    req.userId = user;
  }
  next();
}

const app = express();
app.use(express.json());
app.use('/api/models', fakeAuth as never, modelsRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('no listen address');
const base = `http://127.0.0.1:${address.port}/api/models`;

async function call(
  method: 'GET' | 'POST',
  url: string,
  opts: { user?: string; body?: unknown } = {},
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.user ? { 'x-test-user': opts.user } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

try {
  // ---------------------------------------------------------------------
  // Section 1: auth guards — every route rejects anonymous callers (401)
  // ---------------------------------------------------------------------
  for (const [method, url] of [
    ['GET', '/lmstudio'],
    ['GET', '/lmstudio/status'],
    ['POST', '/lmstudio/load'],
    ['POST', '/lmstudio/compliance'],
    ['POST', '/lmstudio/unload'],
  ] as const) {
    const r = await call(method, url, { body: method === 'POST' ? { model: 'm' } : undefined });
    ok(`${method} ${url} without credentials -> 401`, () => {
      assert.equal(r.status, 401);
      assert.equal(r.json?.error, 'Unauthorized');
    });
  }

  // ---------------------------------------------------------------------
  // Section 2: body validation for the POST routes
  // ---------------------------------------------------------------------
  for (const bad of [undefined, '', '   ', 5, null]) {
    const r = await call('POST', '/lmstudio/load', { user: USER_A, body: { model: bad } });
    ok(`load rejects invalid model (${JSON.stringify(bad) ?? 'missing'}) -> 400`, () => {
      assert.equal(r.status, 400);
      assert.equal(typeof r.json?.error, 'string');
    });
  }
  {
    const r = await call('POST', '/lmstudio/compliance', { user: USER_A, body: {} });
    ok('compliance rejects missing model -> 400', () => {
      assert.equal(r.status, 400);
      assert.equal(typeof r.json?.error, 'string');
    });
  }
  for (const bad of [undefined, '', '   ', 5, null]) {
    const r = await call('POST', '/lmstudio/unload', { user: USER_A, body: { model: bad } });
    ok(`unload rejects invalid model (${JSON.stringify(bad) ?? 'missing'}) -> 400`, () => {
      assert.equal(r.status, 400);
      assert.equal(typeof r.json?.error, 'string');
    });
  }

  // ---------------------------------------------------------------------
  // Section 3: GET /lmstudio/status — pinned §8 shape, unreachable is 200
  // ---------------------------------------------------------------------
  {
    const r = await call('GET', '/lmstudio/status', { user: USER_A });
    ok('status returns pinned §8 JSON with reachable:false (200)', () => {
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, {
        reachable: false,
        transport: null,
        apiSurface: null,
        agentConnected: false,
        baseUrl: 'http://127.0.0.1:9',
        profile: 'equilibrado',
      });
    });
  }

  // ---------------------------------------------------------------------
  // Section 4: GET /lmstudio — fail-soft 503 envelope when unreachable
  // ---------------------------------------------------------------------
  {
    const r = await call('GET', '/lmstudio', { user: USER_A });
    ok('catalog unreachable -> 503 {error} fail-soft envelope', () => {
      assert.equal(r.status, 503);
      assert.equal(typeof r.json?.error, 'string');
      assert.ok((r.json.error as string).length > 0);
    });
  }

  // ---------------------------------------------------------------------
  // Section 5: POST /lmstudio/load — failed/unreachable maps to 502 {error}
  // ---------------------------------------------------------------------
  {
    const r = await call('POST', '/lmstudio/load', { user: USER_A, body: { model: 'qwen/qwen3' } });
    ok('load with unreachable backend -> 502 {error}', () => {
      assert.equal(r.status, 502);
      assert.equal(typeof r.json?.error, 'string');
      assert.ok((r.json.error as string).length > 0);
    });
  }

  // ---------------------------------------------------------------------
  // Section 6: POST /lmstudio/compliance — total §8 envelope even offline
  // (openai-only/degraded surface still yields knobs with met:null + apiSurface)
  // ---------------------------------------------------------------------
  {
    const r = await call('POST', '/lmstudio/compliance', {
      user: USER_A,
      body: { model: 'qwen/qwen3' },
    });
    ok('compliance returns §8 ok envelope with all met:null knobs offline', () => {
      assert.equal(r.status, 200);
      assert.equal(r.json?.ok, true);
      assert.deepEqual(r.json.profile, { id: 'equilibrado', label: 'EQUILIBRADO' });
      assert.equal(r.json.apiSurface, null);
      assert.ok(Array.isArray(r.json.knobs) && r.json.knobs.length === 10);
      for (const knob of r.json.knobs) {
        assert.equal(knob.met, null);
        assert.equal(knob.actual, null);
        assert.ok(typeof knob.key === 'string' && typeof knob.expected === 'string');
      }
      const restKeys = r.json.knobs.slice(0, 4).map((k: any) => k.key);
      assert.deepEqual(restKeys, [
        'context_length',
        'flash_attention',
        'offload_kv_cache_to_gpu',
        'eval_batch_size',
      ]);
      for (const knob of r.json.knobs.slice(0, 4)) assert.equal(knob.how, 'rest');
      for (const knob of r.json.knobs.slice(4)) {
        assert.equal(knob.how, 'gui');
        assert.ok(typeof knob.guidance === 'string' && knob.guidance.length > 0);
      }
    });
  }

  // ---------------------------------------------------------------------
  // Section 7: POST /lmstudio/unload — §11 frozen envelope, dead-backend
  // premise: unreachable LM Studio is a valid state ⇒ 5xx fail-soft {error}
  // (502 per §11: catalog/unload exchange failures), never a hang or throw.
  // ---------------------------------------------------------------------
  {
    const r = await call('POST', '/lmstudio/unload', { user: USER_A, body: { model: 'qwen/qwen3' } });
    ok('unload with unreachable backend -> fail-soft 5xx {error}', () => {
      assert.ok(r.status >= 500 && r.status < 600, `expected 5xx family, got ${r.status}`);
      assert.equal(typeof r.json?.error, 'string');
      assert.ok((r.json.error as string).length > 0);
    });
  }

  console.log(`\nlmstudio route tests passed (${checks} checks)`);
} finally {
  server.close();
  try {
    fs.rmSync(testDbPath, { force: true });
  } catch {
    /* best effort */
  }
}
