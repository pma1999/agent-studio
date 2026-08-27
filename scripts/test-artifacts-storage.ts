import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-storage-test-'));
const testDbPath = path.join(testDirectory, 'artifacts-storage.db');
process.env.DATABASE_PATH = testDbPath;
process.env.JWT_SECRET = 'artifacts-storage-test-jwt-secret';

const { default: db, migrate, ensureLocalUser } = await import('../server/db.js');
const { createArtifact, appendArtifactVersion, getArtifact, listConversationArtifacts, mapArtifactRow } = await import('../server/artifacts/storage.js');
const { MAX_ARTIFACT_CONTENT_CHARS } = await import('../shared/artifactTypes.js');

let failures = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS ${name}`); } catch (err) { failures++; console.error(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`); }
}
function expectThrows(name: string, fn: () => void) {
  try { fn(); failures++; console.error(`FAIL ${name}: expected throw but none`); } catch { console.log(`PASS ${name}`); }
}

// idempotent migrate x2
migrate();
migrate();
test('migrate idempotent - tables exist', () => {
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='artifacts'").get() as { name: string } | undefined;
  assert.ok(t);
  const v = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='artifact_versions'").get() as { name: string } | undefined;
  assert.ok(v);
});

const userId = ensureLocalUser();
assert.ok(userId);
const otherUserId = 'artifacts-other-user-1';
db.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, 'artifacts-other@test.local', 'hash')").run(otherUserId);
const agentId = 'artifacts-test-agent';
db.prepare(`INSERT INTO agents (id, name, description, emoji, system_prompt, base_url, model, temperature, max_tokens, provider, user_id) VALUES (?, 'Test', '', '🤖', 'sys', 'https://openrouter.ai/api/v1', 'openrouter/auto', 0.7, 4096, 'openrouter', ?)`).run(agentId, userId);
const convId = 'artifacts-conv-1';
db.prepare("INSERT INTO conversations (id, user_id, agent_id, title) VALUES (?, ?, ?, ?)").run(convId, userId, agentId, 'Test Conv');

// create -> get roundtrip
let artId = '';
test('create -> get roundtrip', () => {
  const art = createArtifact({ userId, conversationId: convId, kind: 'html', title: ' My Demo ', language: null, content: '<html>hi</html>' });
  artId = art.id;
  assert.equal(art.kind, 'html');
  assert.equal(art.title, 'My Demo');
  assert.equal(art.version, 1);
  assert.equal(art.content, '<html>hi</html>');
  assert.equal(art.language, null);
  assert.ok(!Number.isNaN(Date.parse(art.created_at)));
  assert.ok(!Number.isNaN(Date.parse(art.updated_at)));
  const fetched = getArtifact(artId, userId);
  assert.deepEqual(fetched, art);
  // mapper sanity
  const row = db.prepare('SELECT * FROM artifacts WHERE id=?').get(artId) as never;
  const mapped = mapArtifactRow(row as unknown as Parameters<typeof mapArtifactRow>[0]);
  assert.deepEqual(mapped, art);
});

test('owner isolation: other user sees undefined', () => {
  const other = getArtifact(artId, otherUserId);
  assert.equal(other, undefined);
});

test('appendVersion increments and updates live row', () => {
  const updated = appendArtifactVersion({ userId, artifactId: artId, content: '<html>v2</html>', title: 'V2 title' });
  assert.equal(updated.version, 2);
  assert.equal(updated.content, '<html>v2</html>');
  assert.equal(updated.title, 'V2 title');
  const versions = db.prepare('SELECT version FROM artifact_versions WHERE artifact_id=? ORDER BY version ASC').all(artId) as { version: number }[];
  assert.deepEqual(versions.map(r=>r.version), [1,2]);
  const live = getArtifact(artId, userId)!;
  assert.equal(live.version, 2);
});

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
test('listConversationArtifacts ordering ASC by updated_at', () => {
  sleepSync(12);
  const art2 = createArtifact({ userId, conversationId: convId, kind: 'code', title: 'Second', language: 'python', content: 'print(1)' });
  sleepSync(12);
  // bump first artifact to be newest
  appendArtifactVersion({ userId, artifactId: artId, content: '<html>v3</html>' });
  sleepSync(5);
  const list = listConversationArtifacts(convId, userId);
  assert.equal(list.length, 2);
  // art2 created after art1 v2 but before art1 v3 -> order should be art2, artId
  assert.equal(list[0].id, art2.id);
  assert.equal(list[1].id, artId);
  // filtered by user
  expectThrows('list foreign conv throws', () => { listConversationArtifacts('nope', userId); });
});

expectThrows('cap reject 400001', () => {
  createArtifact({ userId, conversationId: convId, kind: 'html', title: 'big', content: 'x'.repeat(MAX_ARTIFACT_CONTENT_CHARS + 1) });
});

expectThrows('title empty -> throw', () => {
  createArtifact({ userId, conversationId: convId, kind: 'html', title: '   ', content: 'hi' });
});

expectThrows('title too long -> throw', () => {
  createArtifact({ userId, conversationId: convId, kind: 'html', title: 'a'.repeat(121), content: 'hi' });
});

expectThrows('kind invalid -> throw', () => {
  // @ts-expect-error testing invalid
  createArtifact({ userId, conversationId: convId, kind: 'pdf', title: 't', content: 'hi' });
});

expectThrows('language invalid -> throw', () => {
  createArtifact({ userId, conversationId: convId, kind: 'code', title: 't', language: 'bad language!', content: 'hi' });
});

expectThrows('append cross-tenant -> throw', () => {
  appendArtifactVersion({ userId: otherUserId, artifactId: artId, content: 'hacked' });
});

test('list same user other conv empty (not error)', () => {
  const conv2 = 'artifacts-conv-2';
  db.prepare("INSERT INTO conversations (id, user_id, agent_id, title) VALUES (?, ?, ?, ?)").run(conv2, userId, agentId, 'Empty Conv');
  const list = listConversationArtifacts(conv2, userId);
  assert.deepEqual(list, []);
});

if (failures > 0) { console.error(`${failures} test(s) FAILED`); process.exit(1); }
console.log('artifacts-storage: OK');
db.close();
fs.rmSync(testDirectory, { recursive: true, force: true });
