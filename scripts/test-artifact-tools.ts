import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-tools-test-'));
const testDbPath = path.join(testDirectory, 'artifacts-tools.db');
process.env.DATABASE_PATH = testDbPath;
process.env.JWT_SECRET = 'artifacts-tools-test-jwt-secret';

const { default: db, migrate, ensureLocalUser } = await import('../server/db.js');
const { getBuiltinDefinition, getBuiltinExecutor } = await import('../server/tools/registry.js');
const { buildResolvedBuiltinTool } = await import('../server/tools/resolve.js');
const { runTool } = await import('../server/tools/run.js');
const { createArtifactTool, updateArtifactTool, CREATE_ARTIFACT_DESCRIPTION, CREATE_ARTIFACT_SCHEMA, UPDATE_ARTIFACT_DESCRIPTION, UPDATE_ARTIFACT_SCHEMA } = await import('../server/tools/artifactsTool.js');
const { MAX_ARTIFACT_CONTENT_CHARS } = await import('../shared/artifactTypes.js');
const { getArtifact } = await import('../server/artifacts/storage.js');

let failures = 0;
async function runTest(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); } catch (err) { failures++; console.error(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}${err instanceof Error && err.stack ? '\n' + err.stack : ''}`); }
}

migrate();
migrate();

let primaryUserId = ensureLocalUser()!;
assert.ok(primaryUserId);
// Insert other user BEFORE creating any test conversations, then seed it via migrate
const otherUserId = 'artifacts-tools-other-user';
db.prepare("INSERT OR IGNORE INTO users (id, email, password_hash) VALUES (?, 'other-tools@test.local', 'hash')").run(otherUserId);
migrate(); // seed tools for otherUserId (and keep primary intact since conv not yet created)

const primaryDefCheck1 = getBuiltinDefinition('create_artifact')!;
assert.ok(primaryDefCheck1);

// 1. Seed equality byte-identical
await runTest('seed equality create_artifact description', () => {
  const def = getBuiltinDefinition('create_artifact')!;
  assert.ok(def, 'create_artifact definition exists');
  const row = db.prepare("SELECT description, parameters_schema FROM tools WHERE user_id = ? AND name = 'create_artifact'").get(primaryUserId) as { description: string; parameters_schema: string } | undefined;
  assert.ok(row, 'create_artifact seed row exists');
  assert.equal(row.description, def.function.description);
  assert.equal(row.description, CREATE_ARTIFACT_DESCRIPTION);
  assert.deepEqual(JSON.parse(row.parameters_schema), def.function.parameters);
  assert.deepEqual(JSON.parse(row.parameters_schema), CREATE_ARTIFACT_SCHEMA);
});

await runTest('seed equality update_artifact description', () => {
  const def = getBuiltinDefinition('update_artifact')!;
  assert.ok(def);
  const row = db.prepare("SELECT description, parameters_schema FROM tools WHERE user_id = ? AND name = 'update_artifact'").get(primaryUserId) as { description: string; parameters_schema: string } | undefined;
  assert.ok(row);
  assert.equal(row.description, def.function.description);
  assert.equal(row.description, UPDATE_ARTIFACT_DESCRIPTION);
  assert.deepEqual(JSON.parse(row.parameters_schema), def.function.parameters);
  assert.deepEqual(JSON.parse(row.parameters_schema), UPDATE_ARTIFACT_SCHEMA);
});

// also check other user seed equality
await runTest('seed equality other user create_artifact', () => {
  const def = getBuiltinDefinition('create_artifact')!;
  const row = db.prepare("SELECT description, parameters_schema FROM tools WHERE user_id = ? AND name = 'create_artifact'").get(otherUserId) as { description: string; parameters_schema: string } | undefined;
  assert.ok(row);
  assert.equal(row.description, def.function.description);
});

// 2. Registration
await runTest('getBuiltinExecutor both non-null', () => {
  assert.ok(getBuiltinExecutor('create_artifact'));
  assert.ok(getBuiltinExecutor('update_artifact'));
});

await runTest('buildResolvedBuiltinTool resolves both', () => {
  for (const name of ['create_artifact', 'update_artifact']) {
    const row = db.prepare('SELECT id, name, description, parameters_schema, type, config FROM tools WHERE user_id = ? AND name = ?').get(primaryUserId, name) as any;
    assert.ok(row);
    const resolved = buildResolvedBuiltinTool(row, primaryUserId);
    assert.ok(resolved, `${name} should resolve`);
    assert.equal(resolved.name, name);
    assert.equal(resolved.type, 'builtin');
  }
});

// Prepare conversations AFTER all migrates so they are not moved by the admin reassign step
const agentId = 'artifacts-tools-test-agent';
db.prepare(`INSERT OR IGNORE INTO agents (id, name, description, emoji, system_prompt, base_url, model, temperature, max_tokens, provider, user_id) VALUES (?, 'Test', '', '🤖', 'sys', 'https://openrouter.ai/api/v1', 'openrouter/auto', 0.7, 4096, 'openrouter', ?)`).run(agentId, primaryUserId);
const convId = 'artifacts-tools-conv-1';
db.prepare('INSERT OR IGNORE INTO conversations (id, user_id, agent_id, title) VALUES (?, ?, ?, ?)').run(convId, primaryUserId, agentId, 'Test Conv');
const otherConv = 'other-conv-1';
db.prepare('INSERT OR IGNORE INTO conversations (id, user_id, agent_id, title) VALUES (?, ?, ?, ?)').run(otherConv, otherUserId, agentId, 'Other Conv');

// Ensure other user has an agent row owned by them for FK sanity (optional)
db.prepare(`INSERT OR IGNORE INTO agents (id, name, description, emoji, system_prompt, base_url, model, temperature, max_tokens, provider, user_id) VALUES (?, 'OtherAgent', '', '🤖', 'sys', 'https://openrouter.ai/api/v1', 'openrouter/auto', 0.7, 4096, 'openrouter', ?)`).run('other-agent-1', otherUserId);

// Happy create
let artifactId = '';
await runTest('create happy returns ok:true version:1', async () => {
  const raw = await createArtifactTool({ kind: 'html', title: 'T', content: '<h1>hi</h1>' }, primaryUserId, convId);
  const out = JSON.parse(raw) as { ok: boolean; artifactId: string; version: number; kind: string; error?: string };
  assert.equal(out.ok, true, `expected ok true but got ${raw}`);
  assert.ok(typeof out.artifactId === 'string' && out.artifactId.length > 0);
  assert.equal(out.version, 1);
  assert.equal(out.kind, 'html');
  artifactId = out.artifactId;
  const art = getArtifact(artifactId, primaryUserId);
  assert.ok(art);
  assert.equal(art!.content, '<h1>hi</h1>');
  assert.equal(art!.version, 1);
});

await runTest('update happy version:2 and versions count=2', async () => {
  const raw = await updateArtifactTool({ artifact_id: artifactId, content: '<h1>v2</h1>' }, primaryUserId, convId);
  const out = JSON.parse(raw) as { ok: boolean; artifactId: string; version: number; error?: string };
  assert.equal(out.ok, true, `expected ok true got ${raw}`);
  assert.equal(out.version, 2);
  const count = (db.prepare('SELECT COUNT(*) as cnt FROM artifact_versions WHERE artifact_id = ?').get(artifactId) as { cnt: number }).cnt;
  assert.equal(count, 2);
  const art = getArtifact(artifactId, primaryUserId)!;
  assert.equal(art.version, 2);
  assert.equal(art.content, '<h1>v2</h1>');
});

// Cross-tenant: other user cannot update
await runTest('cross-tenant update denied soft error', async () => {
  const raw = await updateArtifactTool({ artifact_id: artifactId, content: '<h1>hacked</h1>' }, otherUserId, otherConv);
  const out = JSON.parse(raw) as { ok: boolean; error?: string };
  assert.equal(out.ok, false);
  assert.match(out.error || '', /artifact not found/i);
});

// Missing conversationId
await runTest('missing conversationId -> soft error with artifact context unavailable', async () => {
  const raw = await createArtifactTool({ kind: 'html', title: 'T', content: 'hi' }, primaryUserId, undefined);
  const out = JSON.parse(raw) as { ok: boolean; error?: string };
  assert.equal(out.ok, false);
  assert.match(out.error || '', /artifact context unavailable/i);
});

await runTest('missing conversationId update -> soft error', async () => {
  const raw = await updateArtifactTool({ artifact_id: artifactId, content: 'hi' }, primaryUserId, undefined);
  const out = JSON.parse(raw) as { ok: boolean; error?: string };
  assert.equal(out.ok, false);
  assert.match(out.error || '', /artifact context unavailable/i);
});

// Invalid kind / empty title / oversized
await runTest('invalid kind -> soft error', async () => {
  const raw = await createArtifactTool({ kind: 'pdf', title: 'T', content: 'hi' }, primaryUserId, convId);
  const out = JSON.parse(raw) as { ok: boolean; error?: string };
  assert.equal(out.ok, false);
  assert.match(out.error || '', /Invalid create_artifact arguments/i);
});

await runTest('empty title -> soft error', async () => {
  const raw = await createArtifactTool({ kind: 'html', title: '   ', content: 'hi' }, primaryUserId, convId);
  const out = JSON.parse(raw) as { ok: boolean; error?: string };
  assert.equal(out.ok, false);
});

await runTest('oversized content -> soft error', async () => {
  const raw = await createArtifactTool({ kind: 'html', title: 'T', content: 'x'.repeat(MAX_ARTIFACT_CONTENT_CHARS + 1) }, primaryUserId, convId);
  const out = JSON.parse(raw) as { ok: boolean; error?: string };
  assert.equal(out.ok, false);
  assert.match(out.error || '', /content must be at most/i);
});

await runTest('update missing artifact -> soft error', async () => {
  const raw = await updateArtifactTool({ artifact_id: 'nonexistent-id', content: 'hi' }, primaryUserId, convId);
  const out = JSON.parse(raw) as { ok: boolean; error?: string };
  assert.equal(out.ok, false);
  assert.match(out.error || '', /artifact not found/i);
});

await runTest('create with conversation not found -> soft error', async () => {
  const raw = await createArtifactTool({ kind: 'html', title: 'T', content: 'hi' }, primaryUserId, 'no-such-conv');
  const out = JSON.parse(raw) as { ok: boolean; error?: string };
  assert.equal(out.ok, false);
  assert.match(out.error || '', /conversation not found/i);
});

// runTool dispatch universal path
await runTest('runTool dispatch via builtin', async () => {
  const row = db.prepare('SELECT id, name, description, parameters_schema, type, config FROM tools WHERE user_id = ? AND name = ?').get(primaryUserId, 'create_artifact') as any;
  const resolved = buildResolvedBuiltinTool(row, primaryUserId)!;
  const result = await runTool([resolved], 'create_artifact', { kind: 'svg', title: 'Icon', content: '<svg></svg>' }, undefined, primaryUserId, convId);
  const out = JSON.parse(result.output) as { ok: boolean; artifactId: string; version: number; error?: string };
  assert.equal(result.source, 'builtin');
  assert.equal(result.isError, false, `expected isError false got ${result.output}`);
  assert.equal(out.ok, true);
  assert.equal(out.version, 1);
});

// SSE ordering via fake res recorder
await runTest('SSE ordering artifact after tool_result only when ok', async () => {
  const writes: string[] = [];
  const fakeRes: any = {
    writableEnded: false,
    write: (chunk: string) => { writes.push(chunk); },
  };
  let clientDisconnected = false;
  const row = db.prepare('SELECT id, name, description, parameters_schema, type, config FROM tools WHERE user_id = ? AND name = ?').get(primaryUserId, 'create_artifact') as any;
  const resolved = buildResolvedBuiltinTool(row, primaryUserId)!;
  const result = await runTool([resolved], 'create_artifact', { kind: 'code', title: 'Script', content: 'console.log(1)' }, undefined, primaryUserId, convId);
  const name = 'create_artifact';
  const { buildToolResultEvent } = await import('../server/routes/chat.js');
  const evt = buildToolResultEvent('call_1', name, result, 10);
  if (!clientDisconnected && !fakeRes.writableEnded) {
    fakeRes.write(`data: ${JSON.stringify(evt)}\n\n`);
  }
  if ((name === 'create_artifact' || name === 'update_artifact') && !clientDisconnected && !fakeRes.writableEnded) {
    const out = JSON.parse(result.output) as { ok?: boolean; artifactId?: string };
    if (out?.ok === true && typeof out.artifactId === 'string') {
      const art = getArtifact(out.artifactId, primaryUserId);
      if (art) {
        fakeRes.write(`data: ${JSON.stringify({ artifact: art })}\n\n`);
      }
    }
  }
  const failResult = await runTool([resolved], 'create_artifact', { kind: 'pdf', title: 'bad', content: 'hi' } as any, undefined, primaryUserId, convId);
  const failEvt = buildToolResultEvent('call_2', name, failResult, 5);
  fakeRes.write(`data: ${JSON.stringify(failEvt)}\n\n`);
  if ((name === 'create_artifact' || name === 'update_artifact') && !clientDisconnected && !fakeRes.writableEnded) {
    try {
      const out = JSON.parse(failResult.output) as { ok?: boolean; artifactId?: string };
      if (out?.ok === true && typeof out.artifactId === 'string') {
        const art = getArtifact(out.artifactId, primaryUserId);
        if (art) fakeRes.write(`data: ${JSON.stringify({ artifact: art })}\n\n`);
      }
    } catch {}
  }
  assert.equal(writes.length, 3, `expected 3 frames, got ${writes.length}: ${writes.join('---')}`);
  const first = JSON.parse(writes[0].slice(6).trim());
  assert.ok(first.tool_result, 'first frame should be tool_result');
  const second = JSON.parse(writes[1].slice(6).trim());
  assert.ok(second.artifact, 'second frame should be artifact');
  assert.equal(second.artifact.title, 'Script');
  const third = JSON.parse(writes[2].slice(6).trim());
  assert.ok(third.tool_result, 'third frame should be failing tool_result, no artifact after it');
});

// Confirm createArtifact strict: extra prop rejected
await runTest('extra prop strict rejected', async () => {
  const raw = await createArtifactTool({ kind: 'html', title: 'T', content: 'hi', extra: 'nope' } as any, primaryUserId, convId);
  const out = JSON.parse(raw) as { ok: boolean; error?: string };
  assert.equal(out.ok, false);
  assert.match(out.error || '', /Invalid create_artifact arguments/i);
});

if (failures > 0) { console.error(`${failures} test(s) FAILED`); process.exit(1); }
console.log('artifact-tools: OK');
db.close();
fs.rmSync(testDirectory, { recursive: true, force: true });
