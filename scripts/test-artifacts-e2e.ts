import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-e2e-test-'));
const testDbPath = path.join(testDirectory, 'artifacts-e2e.db');
process.env.DATABASE_PATH = testDbPath;
const JWT_SECRET = `artifacts-e2e-${process.pid}`;
process.env.JWT_SECRET = JWT_SECRET;

const { default: db, migrate, ensureLocalUser } = await import('../server/db.js');
const { getBuiltinDefinition } = await import('../server/tools/registry.js');
const { buildResolvedBuiltinTool } = await import('../server/tools/resolve.js');
const { runTool } = await import('../server/tools/run.js');
const { getArtifact } = await import('../server/artifacts/storage.js');
const { MAX_ARTIFACT_CONTENT_CHARS } = await import('../shared/artifactTypes.js');
import type { ChatArtifact } from '../shared/artifactTypes.js';

let failures = 0;
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
    passed++;
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}${err instanceof Error && err.stack ? '\n' + err.stack : ''}`);
  }
}

function assertChatArtifactShape(art: Record<string, unknown>, label: string) {
  const expectedKeys = ['id', 'conversation_id', 'message_id', 'kind', 'title', 'language', 'content', 'version', 'created_at', 'updated_at'].sort();
  const actualKeys = Object.keys(art).sort();
  assert.deepEqual(actualKeys, expectedKeys, `${label}: ChatArtifact keys must match exactly — got ${actualKeys.join(',')}`);
  assert.equal(typeof art.id, 'string');
  assert.equal(typeof art.conversation_id, 'string');
  assert.ok(art.message_id === null || typeof art.message_id === 'string');
  assert.ok(['html', 'code', 'svg', 'mermaid'].includes(art.kind as string), `kind invalid: ${art.kind}`);
  assert.equal(typeof art.title, 'string');
  assert.ok(art.language === null || art.language === undefined || typeof art.language === 'string');
  assert.equal(typeof art.content, 'string');
  assert.equal(typeof art.version, 'number');
  assert.ok(!Number.isNaN(Date.parse(art.created_at as string)), 'created_at must be ISO');
  assert.ok(!Number.isNaN(Date.parse(art.updated_at as string)), 'updated_at must be ISO');
}

// 1. Bootstrap DB tmp + migrate + ensureLocalUser + conversation + tools seeded
migrate();
migrate();

const primaryUserId = ensureLocalUser();
assert.ok(primaryUserId, 'ensureLocalUser must return id');
const otherUserId = 'artifacts-e2e-other-user';
db.prepare("INSERT OR IGNORE INTO users (id, email, password_hash) VALUES (?, 'e2e-other@test.local', 'hash')").run(otherUserId);
migrate(); // seed tools for other user

await check('1 bootstrap: tools seeded for both users (create_artifact and update_artifact)', () => {
  for (const name of ['create_artifact', 'update_artifact']) {
    const def = getBuiltinDefinition(name);
    assert.ok(def, `${name} builtin definition must exist`);
    for (const uid of [primaryUserId, otherUserId]) {
      const row = db.prepare('SELECT description, parameters_schema FROM tools WHERE user_id = ? AND name = ?').get(uid, name) as { description: string; parameters_schema: string } | undefined;
      assert.ok(row, `${name} seed row for user ${uid} must exist`);
      assert.equal(row.description, def!.function.description);
      assert.deepEqual(JSON.parse(row!.parameters_schema), def!.function.parameters);
    }
  }
});

const agentId = 'artifacts-e2e-agent';
db.prepare(`INSERT OR IGNORE INTO agents (id, name, description, emoji, system_prompt, base_url, model, temperature, max_tokens, provider, user_id) VALUES (?, 'E2E', '', '🤖', 'sys', 'https://openrouter.ai/api/v1', 'openrouter/auto', 0.7, 4096, 'openrouter', ?)`).run(agentId, primaryUserId);
db.prepare(`INSERT OR IGNORE INTO agents (id, name, description, emoji, system_prompt, base_url, model, temperature, max_tokens, provider, user_id) VALUES (?, 'E2EOther', '', '🤖', 'sys', 'https://openrouter.ai/api/v1', 'openrouter/auto', 0.7, 4096, 'openrouter', ?)`).run('artifacts-e2e-agent-other', otherUserId);
const convId = 'artifacts-e2e-conv-main';
db.prepare('INSERT OR IGNORE INTO conversations (id, user_id, agent_id, title) VALUES (?, ?, ?, ?)').run(convId, primaryUserId, agentId, 'E2E Conv');
const otherConvId = 'artifacts-e2e-conv-other';
db.prepare('INSERT OR IGNORE INTO conversations (id, user_id, agent_id, title) VALUES (?, ?, ?, ?)').run(otherConvId, otherUserId, 'artifacts-e2e-agent-other', 'Other Conv');

// Build resolved tools for primary
function resolvedToolsFor(userId: string) {
  const tools: ReturnType<typeof buildResolvedBuiltinTool>[] = [];
  for (const name of ['create_artifact', 'update_artifact']) {
    const row = db.prepare('SELECT id, name, description, parameters_schema, type, config FROM tools WHERE user_id = ? AND name = ?').get(userId, name) as any;
    assert.ok(row, `tool row ${name} for ${userId}`);
    const resolved = buildResolvedBuiltinTool(row, userId);
    assert.ok(resolved, `resolved ${name}`);
    tools.push(resolved!);
  }
  return tools as NonNullable<ReturnType<typeof buildResolvedBuiltinTool>>[];
}

const primaryTools = resolvedToolsFor(primaryUserId);
const otherTools = resolvedToolsFor(otherUserId);

let artifactId = '';

// 2. Dispatch via runTool create_artifact
await check('2 runTool create_artifact -> ok:true version 1', async () => {
  const result = await runTool(primaryTools, 'create_artifact', { kind: 'html', title: 'Demo', content: '<h1>hi</h1>' }, undefined, primaryUserId, convId);
  assert.equal(result.source, 'builtin');
  assert.equal(result.isError, false, `expected isError false, got ${result.output}`);
  const out = JSON.parse(result.output) as { ok: boolean; artifactId: string; version: number; kind: string; error?: string };
  assert.equal(out.ok, true, `expected ok true, got ${result.output}`);
  assert.ok(typeof out.artifactId === 'string' && out.artifactId.length > 0);
  assert.equal(out.version, 1);
  assert.equal(out.kind, 'html');
  artifactId = out.artifactId;
  const art = getArtifact(artifactId, primaryUserId);
  assert.ok(art, 'artifact must be retrievable via storage');
  assert.equal(art!.content, '<h1>hi</h1>');
  assert.equal(art!.version, 1);
  assertChatArtifactShape(art as unknown as Record<string, unknown>, 'create artifact shape');
});

// 3. update_artifact -> version 2
await check('3 runTool update_artifact -> version 2', async () => {
  const result = await runTool(primaryTools, 'update_artifact', { artifact_id: artifactId, content: '<h1>v2</h1>' }, undefined, primaryUserId, convId);
  const out = JSON.parse(result.output) as { ok: boolean; artifactId: string; version: number; error?: string };
  assert.equal(out.ok, true, `expected ok true, got ${result.output}`);
  assert.equal(out.version, 2);
  assert.equal(out.artifactId, artifactId);
  const art = getArtifact(artifactId, primaryUserId)!;
  assert.equal(art.version, 2);
  assert.equal(art.content, '<h1>v2</h1>');
  assertChatArtifactShape(art as unknown as Record<string, unknown>, 'update artifact shape');
  const versions = db.prepare('SELECT version FROM artifact_versions WHERE artifact_id = ? ORDER BY version ASC').all(artifactId) as { version: number }[];
  assert.deepEqual(versions.map((r) => r.version), [1, 2]);
});

// 4. Tenant isolation: second user cannot update, GET cross-tenant 404
await check('4 tenant isolation: other user update -> ok:false soft error', async () => {
  const result = await runTool(otherTools, 'update_artifact', { artifact_id: artifactId, content: '<h1>hacked</h1>' }, undefined, otherUserId, otherConvId);
  const out = JSON.parse(result.output) as { ok: boolean; error?: string };
  assert.equal(out.ok, false);
  assert.match(out.error || '', /artifact not found/i);
});

// Prepare REST app for 4b and 5
const { authMiddleware } = await import('../server/middleware/auth.js');
const artifactsRouter = (await import('../server/routes/artifacts.js')).default;
const app = express();
app.use(express.json());
app.use('/api/artifacts', authMiddleware, artifactsRouter);
app.use('/api/conversations', authMiddleware, artifactsRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve, reject) => {
  server.once('listening', resolve);
  server.once('error', reject);
});
const address = server.address() as { port: number };
const base = `http://127.0.0.1:${address.port}`;
const ownerToken = jwt.sign({ sub: primaryUserId }, JWT_SECRET, { expiresIn: '1h' });
const otherToken = jwt.sign({ sub: otherUserId }, JWT_SECRET, { expiresIn: '1h' });

await check('4b tenant isolation: GET cross-tenant individual 404', async () => {
  const res = await fetch(`${base}/api/artifacts/${artifactId}`, { headers: { Authorization: `Bearer ${otherToken}` } });
  assert.equal(res.status, 404);
});
await check('4c tenant isolation: GET cross-tenant list 404', async () => {
  const res = await fetch(`${base}/api/conversations/${convId}/artifacts`, { headers: { Authorization: `Bearer ${otherToken}` } });
  assert.equal(res.status, 404);
});

// Create a second artifact to verify ordering for REST hydration
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
sleepSync(12);
let secondArtifactId = '';
{
  const result = await runTool(primaryTools, 'create_artifact', { kind: 'code', title: 'Second', content: 'print(1)', language: 'python' }, undefined, primaryUserId, convId);
  const out = JSON.parse(result.output) as { ok: boolean; artifactId: string };
  assert.equal(out.ok, true);
  secondArtifactId = out.artifactId;
  sleepSync(12);
  // bump first artifact to be newest
  const upd = await runTool(primaryTools, 'update_artifact', { artifact_id: artifactId, content: '<h1>v3 latest</h1>' }, undefined, primaryUserId, convId);
  const updOut = JSON.parse(upd.output) as { ok: boolean; version: number };
  assert.equal(updOut.ok, true);
  assert.equal(updOut.version, 3);
  sleepSync(5);
}

// 5. REST hydration: GET /api/conversations/:id/artifacts with owner token -> {artifacts:[...]} ASC orden, shape EXACTA
await check('5 REST hydration: GET list returns {artifacts:[...]} ASC with exact ChatArtifact shapes', async () => {
  const res = await fetch(`${base}/api/conversations/${convId}/artifacts`, { headers: { Authorization: `Bearer ${ownerToken}` } });
  assert.equal(res.status, 200, `expected 200, got ${res.status} body ${await res.clone().text()}`);
  const body = await res.json() as { artifacts: Record<string, unknown>[] };
  assert.ok(Array.isArray(body.artifacts), 'artifacts must be array');
  assert.equal(body.artifacts.length, 2, `expected 2 artifacts, got ${body.artifacts.length}`);
  // ASC by updated_at: secondArtifact was before bump of first, so secondArtifact first, artifactId second
  assert.equal(body.artifacts[0].id, secondArtifactId);
  assert.equal(body.artifacts[1].id, artifactId);
  for (const art of body.artifacts) {
    assertChatArtifactShape(art, `list artifact ${art.id}`);
  }
  // Also verify GET individual returns exact shape
  const res2 = await fetch(`${base}/api/artifacts/${artifactId}`, { headers: { Authorization: `Bearer ${ownerToken}` } });
  assert.equal(res2.status, 200);
  const single = await res2.json() as Record<string, unknown>;
  assertChatArtifactShape(single, 'single artifact shape');
  assert.equal(single.id, artifactId);
  assert.equal(single.version, 3);
  assert.equal(single.content, '<h1>v3 latest</h1>');
});

// 6. SSE helper ordering: fake res recorder -> write contains single `data: {"artifact":` prefix JSON-parseable with ChatArtifact completo
await check('6 SSE helper ordering: artifact frame after tool_result is JSON-parseable ChatArtifact', async () => {
  const writes: string[] = [];
  const fakeRes: { writableEnded: boolean; write: (chunk: string) => void } = {
    writableEnded: false,
    write: (chunk: string) => { writes.push(chunk); },
  };
  const clientDisconnected = false;
  const { buildToolResultEvent } = await import('../server/routes/chat.js');
  // Simulate a create_artifact tool_result + artifact frame
  const toolName = 'create_artifact';
  const result = await runTool(primaryTools, 'create_artifact', { kind: 'svg', title: 'SSE Test', content: '<svg><circle r="10"/></svg>' }, undefined, primaryUserId, convId);
  const out = JSON.parse(result.output) as { ok: boolean; artifactId: string };
  assert.equal(out.ok, true);
  const evt = buildToolResultEvent('call_sse_1', toolName, result, 10);
  if (!clientDisconnected && !fakeRes.writableEnded) {
    fakeRes.write(`data: ${JSON.stringify(evt)}\n\n`);
  }
  if ((toolName === 'create_artifact' || toolName === 'update_artifact') && !clientDisconnected && !fakeRes.writableEnded) {
    const parsed = JSON.parse(result.output) as { ok?: boolean; artifactId?: string };
    if (parsed?.ok === true && typeof parsed.artifactId === 'string') {
      const art = getArtifact(parsed.artifactId, primaryUserId);
      if (art) {
        fakeRes.write(`data: ${JSON.stringify({ artifact: art })}\n\n`);
      }
    }
  }
  // Expect exactly 2 frames
  assert.equal(writes.length, 2, `expected 2 frames, got ${writes.length}`);
  assert.ok(writes[0].startsWith('data: '), 'first frame must start with data: ');
  const first = JSON.parse(writes[0].slice(6).trim());
  assert.ok(first.tool_result, 'first frame must be tool_result');
  assert.ok(writes[1].startsWith('data: '), 'second frame must start with data: ');
  // Must be parseable and contain artifact key
  const secondPrefix = writes[1].slice(0, writes[1].indexOf('{'));
  assert.equal(secondPrefix.trim(), 'data:', 'second frame prefix must be data:');
  const secondBody = writes[1].slice(writes[1].indexOf('{')).trim();
  // after stripping "data: " and trailing \n\n, it should be {"artifact": {...}}
  const secondParsed = JSON.parse(writes[1].slice(6).trim()) as { artifact?: Record<string, unknown> };
  assert.ok(secondParsed.artifact, 'second frame must contain artifact key');
  assertChatArtifactShape(secondParsed.artifact!, 'SSE artifact shape');
  assert.equal(secondParsed.artifact!.title, 'SSE Test');
  // Ensure single artifact prefix: exactly one occurrence of '"artifact":'
  const count = (writes[1].match(/"artifact"/g) || []).length;
  assert.equal(count, 1, 'second frame must contain exactly one artifact key');

  // Failure case: do NOT emit artifact when tool failed
  const writesFail: string[] = [];
  const fakeResFail = { writableEnded: false, write: (c: string) => { writesFail.push(c); } };
  const failResult = await runTool(primaryTools, 'create_artifact', { kind: 'pdf' as unknown as string, title: 'bad', content: 'hi' } as any, undefined, primaryUserId, convId);
  const failEvt = buildToolResultEvent('call_sse_2', toolName, failResult, 5);
  fakeResFail.write(`data: ${JSON.stringify(failEvt)}\n\n`);
  if ((toolName === 'create_artifact' || toolName === 'update_artifact') && !fakeResFail.writableEnded) {
    try {
      const parsed = JSON.parse(failResult.output) as { ok?: boolean; artifactId?: string };
      if (parsed?.ok === true && typeof parsed.artifactId === 'string') {
        const art = getArtifact(parsed.artifactId, primaryUserId);
        if (art) fakeResFail.write(`data: ${JSON.stringify({ artifact: art })}\n\n`);
      }
    } catch {}
  }
  assert.equal(writesFail.length, 1, 'failing tool must emit only one frame (no artifact)');
});

// 7. Cap enforcement e2e: content >400k via tool -> ok:false error mentions size
await check('7 cap enforcement e2e: oversized content via runTool -> ok:false with size error', async () => {
  const huge = 'x'.repeat(MAX_ARTIFACT_CONTENT_CHARS + 1);
  const result = await runTool(primaryTools, 'create_artifact', { kind: 'html', title: 'Huge', content: huge }, undefined, primaryUserId, convId);
  assert.equal(result.isError, true, 'oversized must be isError');
  const out = JSON.parse(result.output) as { ok: boolean; error?: string };
  assert.equal(out.ok, false);
  assert.match(out.error || '', /content must be at most/i);
});

// Cleanup REST server and DB
await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
db.close();
fs.rmSync(testDirectory, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED, ${passed} passed`);
  process.exit(1);
}
console.log(`\nartifacts-e2e: ${passed} passed, 0 failed — OK`);
console.log('Note: Codex/council live streaming requires external providers and is covered at unit-level (T2) + manual QA checklist; not exercised in this automated e2e.');
