import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';

const testDbPath = path.join(os.tmpdir(), `artifacts-routes-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = testDbPath;
const JWT_SECRET = `artifacts-routes-${process.pid}`;
process.env.JWT_SECRET = JWT_SECRET;

const { default: db, migrate } = await import('../server/db.js');
const { authMiddleware } = await import('../server/middleware/auth.js');
const artifactsRouter = (await import('../server/routes/artifacts.js')).default;
const { createArtifact, appendArtifactVersion } = await import('../server/artifacts/storage.js');

migrate();

const userId = 'artifacts-routes-user-1';
const otherUserId = 'artifacts-routes-user-2';
db.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, 'artifacts-a@test.local', 'hash')").run(userId);
db.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, 'artifacts-b@test.local', 'hash')").run(otherUserId);
const agentId = 'artifacts-routes-agent';
db.prepare(`INSERT INTO agents (id, name, description, emoji, system_prompt, base_url, model, temperature, max_tokens, provider, user_id) VALUES (?, 'R', '', '🤖', 'sys', 'https://openrouter.ai/api/v1', 'openrouter/auto', 0.7, 4096, 'openrouter', ?)`).run(agentId, userId);
db.prepare(`INSERT INTO agents (id, name, description, emoji, system_prompt, base_url, model, temperature, max_tokens, provider, user_id) VALUES (?, 'R2', '', '🤖', 'sys', 'https://openrouter.ai/api/v1', 'openrouter/auto', 0.7, 4096, 'openrouter', ?)`).run('artifacts-routes-agent-2', otherUserId);
const convId = 'artifacts-routes-conv-1';
db.prepare("INSERT INTO conversations (id, user_id, agent_id, title) VALUES (?, ?, ?, ?)").run(convId, userId, agentId, 'C1');
const otherConvId = 'artifacts-routes-conv-other';
db.prepare("INSERT INTO conversations (id, user_id, agent_id, title) VALUES (?, ?, ?, ?)").run(otherConvId, otherUserId, 'artifacts-routes-agent-2', 'Other C');

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const art1 = createArtifact({ userId, conversationId: convId, kind: 'html', title: 'A1', content: '<p>one</p>' });
sleepSync(12);
const art2 = createArtifact({ userId, conversationId: convId, kind: 'code', title: 'A2', language: 'ts', content: 'const x=1' });
sleepSync(12);
appendArtifactVersion({ userId, artifactId: art1.id, content: '<p>one v2</p>' });

const app = express();
app.use(express.json());
app.use('/api/artifacts', authMiddleware, artifactsRouter);
app.use('/api/conversations', authMiddleware, artifactsRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
const address = server.address() as { port: number };
const base = `http://127.0.0.1:${address.port}`;
const token = jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '1h' });
const otherToken = jwt.sign({ sub: otherUserId }, JWT_SECRET, { expiresIn: '1h' });

let failures = 0;
function pass(name: string) { console.log(`PASS ${name}`); }
function fail(name: string, err: unknown) { failures++; console.error(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`); }

try {
  // 200 list ASC
  try {
    const res = await fetch(`${base}/api/conversations/${convId}/artifacts`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const body = await res.json() as { artifacts: { id: string }[] };
    assert.equal(body.artifacts.length, 2);
    // art2 created after art1 v1 but before art1 v2 -> order art2, art1
    assert.equal(body.artifacts[0].id, art2.id);
    assert.equal(body.artifacts[1].id, art1.id);
    pass('200 list ASC');
  } catch (e) { fail('200 list ASC', e); }

  // 404 non-existent conversation
  try {
    const res = await fetch(`${base}/api/conversations/does-not-exist/artifacts`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 404);
    pass('404 conversation not found');
  } catch (e) { fail('404 conversation not found', e); }

  // 404 other user's conversation
  try {
    const res = await fetch(`${base}/api/conversations/${otherConvId}/artifacts`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 404);
    pass('404 other user conversation');
  } catch (e) { fail('404 other user conversation', e); }

  // 200 GET individual owner
  try {
    const res = await fetch(`${base}/api/artifacts/${art1.id}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const body = await res.json() as { id: string };
    assert.equal(body.id, art1.id);
    pass('200 GET individual');
  } catch (e) { fail('200 GET individual', e); }

  // 404 cross-tenant GET
  try {
    const res = await fetch(`${base}/api/artifacts/${art1.id}`, { headers: { Authorization: `Bearer ${otherToken}` } });
    assert.equal(res.status, 404);
    pass('404 cross-tenant GET');
  } catch (e) { fail('404 cross-tenant GET', e); }

  // 401 without token
  try {
    const res = await fetch(`${base}/api/artifacts/${art1.id}`);
    assert.equal(res.status, 401);
    const res2 = await fetch(`${base}/api/conversations/${convId}/artifacts`);
    assert.equal(res2.status, 401);
    pass('401 without token');
  } catch (e) { fail('401 without token', e); }

} finally {
  await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  db.close();
  fs.rmSync(testDbPath, { force: true });
  try { fs.rmSync(testDbPath + '-wal', { force: true }); } catch {}
  try { fs.rmSync(testDbPath + '-shm', { force: true }); } catch {}
}

if (failures > 0) { console.error(`${failures} test(s) FAILED`); process.exit(1); }
console.log('artifacts-routes: OK');
