import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_PATH = fileURLToPath(import.meta.url);

// --- scenario 9 runner: local-mode probe in a FRESH process -----------------
// auth.ts freezes DISABLE_AUTH/JWT_SECRET into module consts at import time
// (isLocalAuthMode() reads the consts, not process.env), so a runtime env flip
// in an already-loaded process can never reach it — observed RED: setting
// process.env.DISABLE_AUTH mid-run still returned kind:'created'. Local mode
// must be active from the FIRST import, which only a fresh process can do,
// while the main suite below needs a hosted-mode import (JWT_SECRET set) for
// scenarios 1–8. The suite re-invokes this file with --local-mode-probe.
if (process.argv.includes('--local-mode-probe')) {
  let probeFailures = 0;
  // MUST be set before importing db (db.ts resolves the path at import time).
  process.env.DATABASE_PATH = path.join(os.tmpdir(), `conversation-sharing-local-${process.pid}-${Date.now()}.db`);
  process.env.DISABLE_AUTH = 'true'; // frozen into auth.ts consts by the imports below
  try {
    const { default: probeDb, migrate: probeMigrate, ensureLocalUser: probeEnsureUser } = await import('../server/db.js');
    const { createShare: probeCreateShare } = await import('../server/shares/service.js');
    probeMigrate();
    const probeUserId = probeEnsureUser();
    assert.ok(probeUserId, 'ensureLocalUser should return a user id');
    probeDb.prepare(`
      INSERT INTO agents (id, name, description, emoji, system_prompt, base_url, model, temperature, max_tokens, provider, user_id)
      VALUES ('share-local-agent', 'Share Local', '', '🤖', 'sys', 'https://openrouter.ai/api/v1', 'openrouter/auto', 0.7, 4096, 'openrouter', ?)
    `).run(probeUserId);
    probeDb.prepare("INSERT INTO conversations (id, user_id, agent_id, title) VALUES ('share-conv-local', ?, 'share-local-agent', 'Local chat')").run(probeUserId);
    probeDb.prepare("INSERT INTO messages (id, conversation_id, role, content) VALUES ('lmu1', 'share-conv-local', 'user', 'hi')").run();

    const result = probeCreateShare('share-conv-local', probeUserId);
    assert.equal(result.kind, 'sharing-disabled-local-mode', `local host must refuse creation, got ${JSON.stringify(result)}`);
    const count = (probeDb.prepare('SELECT COUNT(*) AS n FROM conversation_shares WHERE conversation_id = ?').get('share-conv-local') as { n: number }).n;
    assert.equal(count, 0, 'refused create must not write a row');
    console.log('PASS local-mode probe: createShare refused and no row written');
  } catch (err) {
    probeFailures++;
    console.error(`FAIL local-mode probe: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    process.env.DISABLE_AUTH = ''; // restore per brief (process exits right after)
  }
  if (probeFailures > 0) process.exit(1);
  console.log('conversation-sharing local-mode probe: OK');
  process.exit(0);
}

// MUST be set before importing db (db.ts resolves the path at import time).
const testDbPath = path.join(os.tmpdir(), `conversation-sharing-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = testDbPath;
// JWT_SECRET must also be set before the service import: auth.ts freezes it
// into a module const at import time and isLocalAuthMode() is
// `DISABLE_AUTH || !JWT_SECRET`, so without it every createShare would be
// refused as local-mode and none of the hosted-lifecycle scenarios could run.
process.env.JWT_SECRET = `sharing-test-${process.pid}`;

const { default: db, migrate, ensureLocalUser } = await import('../server/db.js');
const {
  buildSnapshot,
  createShare,
  generateShareToken,
  getShareStatus,
  hashShareToken,
  resolveShareToken,
  revokeShare,
} = await import('../server/shares/service.js');
const { buildThreadIds } = await import('../server/messageTree.js');
import type { ShareSnapshot } from '../shared/shareTypes.js';

migrate();
const userId = ensureLocalUser();
assert.ok(userId, 'ensureLocalUser should return a user id');

const agentId = 'share-test-agent';
db.prepare(`
  INSERT INTO agents (id, name, description, emoji, system_prompt, base_url, model, temperature, max_tokens, provider, user_id)
  VALUES (?, 'Share Test', '', '🤖', 'sys', 'https://openrouter.ai/api/v1', 'openrouter/auto', 0.7, 4096, 'openrouter', ?)
`).run(agentId, userId);

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- fixtures (replicate the route/service insert logic) ---
const newConversation = (id: string, title: string) => {
  db.prepare('INSERT INTO conversations (id, user_id, agent_id, title) VALUES (?, ?, ?, ?)').run(id, userId, agentId, title);
};

type FixtureMessage = {
  id: string;
  convId: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  parentId: string | null;
  turnId: string | null;
  variantSeq?: number;
  createdAt: string; // SQLite datetime text — controls created_at ASC ordering
  model?: string | null;
};

// One inserter carrying EVERY non-allow-list column so the stripping test can
// prove none of them survive into the snapshot.
const insertRichMessage = (m: FixtureMessage) => {
  db.prepare(`
    INSERT INTO messages (
      id, conversation_id, role, content, provider_routing, tokens_used,
      prompt_tokens, completion_tokens, cost, annotations, reasoning_content,
      reasoning_tokens, cached_tokens, tool_call_id, tool_calls, attachments,
      model, processed_by_agent_id, processed_by_agent_name,
      parent_id, turn_id, variant_seq, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    m.id,
    m.convId,
    m.role,
    m.content,
    '{"order":["openrouter"]}',
    999,
    111,
    222,
    0.42,
    '[{"url":"https://example.com/a","title":"Example"}]',
    'SECRET-REASONING',
    7,
    3,
    m.role === 'tool' ? 'tc1' : null,
    m.role === 'assistant' ? '[{"name":"web_search"}]' : null,
    '[{"filename":"report.pdf","deliveredPath":"SECRET-UPLOAD-PATH"}]',
    m.model ?? null,
    'SECRET-AGENT-ID',
    'Secret Agent',
    m.parentId,
    m.turnId,
    m.variantSeq ?? 1,
    m.createdAt,
  );
};

const setLeaf = (convId: string, msgId: string) => {
  db.prepare('UPDATE conversations SET active_leaf_id = ? WHERE id = ?').run(msgId, convId);
};

// --- main conversation: user → tool → assistant (rich private fields) ---
const CONV_MAIN = 'share-conv-main';
newConversation(CONV_MAIN, 'Shared chat');
insertRichMessage({ id: 'su1', convId: CONV_MAIN, role: 'user', content: 'hello there', parentId: null, turnId: 'su1', createdAt: '2026-01-01 00:00:01' });
setLeaf(CONV_MAIN, 'su1');
insertRichMessage({ id: 'st1', convId: CONV_MAIN, role: 'tool', content: 'tool result payload', parentId: 'su1', turnId: 'su1', createdAt: '2026-01-01 00:00:02' });
insertRichMessage({ id: 'sa1', convId: CONV_MAIN, role: 'assistant', content: 'rich answer', parentId: 'st1', turnId: 'su1', model: 'openrouter/auto', createdAt: '2026-01-01 00:00:03' });
setLeaf(CONV_MAIN, 'sa1');

// --- branched conversation: two variants of turn 2 ---
const CONV_BRANCH = 'share-conv-branched';
newConversation(CONV_BRANCH, 'Branched chat');
insertRichMessage({ id: 'bu1', convId: CONV_BRANCH, role: 'user', content: 'q1', parentId: null, turnId: 't1', createdAt: '2026-01-01 00:01:01' });
setLeaf(CONV_BRANCH, 'bu1');
insertRichMessage({ id: 'ba1', convId: CONV_BRANCH, role: 'assistant', content: 'a1', parentId: 'bu1', turnId: 't1', createdAt: '2026-01-01 00:01:02' });
setLeaf(CONV_BRANCH, 'ba1');
insertRichMessage({ id: 'bu2', convId: CONV_BRANCH, role: 'user', content: 'q2 v1', parentId: 'ba1', turnId: 't2', variantSeq: 1, createdAt: '2026-01-01 00:01:03' });
setLeaf(CONV_BRANCH, 'bu2');
insertRichMessage({ id: 'ba2', convId: CONV_BRANCH, role: 'assistant', content: 'a2 v1', parentId: 'bu2', turnId: 't2', variantSeq: 1, createdAt: '2026-01-01 00:01:04' });
setLeaf(CONV_BRANCH, 'ba2');
insertRichMessage({ id: 'bv2', convId: CONV_BRANCH, role: 'user', content: 'q2 v2', parentId: 'ba1', turnId: 't2', variantSeq: 2, createdAt: '2026-01-01 00:01:05' });
setLeaf(CONV_BRANCH, 'bv2');
insertRichMessage({ id: 'bav2', convId: CONV_BRANCH, role: 'assistant', content: 'a2 v2', parentId: 'bv2', turnId: 't2', variantSeq: 2, createdAt: '2026-01-01 00:01:06' });
setLeaf(CONV_BRANCH, 'bav2');

// --- legacy linear conversation: pre-tree rows (NULL parents), leaf NULL ---
const CONV_LEGACY = 'share-conv-legacy';
newConversation(CONV_LEGACY, 'Legacy chat');
// inserted OUT of chronological order to prove ordering comes from created_at
insertRichMessage({ id: 'la2', convId: CONV_LEGACY, role: 'assistant', content: 'legacy final', parentId: 'lt1', turnId: 'lu1', createdAt: '2026-01-01 00:02:03' });
insertRichMessage({ id: 'lu1', convId: CONV_LEGACY, role: 'user', content: 'legacy hello', parentId: null, turnId: 'lu1', createdAt: '2026-01-01 00:02:01' });
insertRichMessage({ id: 'la1', convId: CONV_LEGACY, role: 'assistant', content: 'legacy answer', parentId: 'lu1', turnId: 'lu1', createdAt: '2026-01-01 00:02:02' });
// wipe tree metadata to simulate a pre-migration database (template convention)
db.prepare('UPDATE messages SET parent_id = NULL, turn_id = NULL WHERE conversation_id = ?').run(CONV_LEGACY);

// --- scenario 1: create → token returned once, hashed at rest ---
let token1: string;
let shareId1: string;
test('1 create returns token once; DB stores sha256(token) hex; raw token absent from every column', () => {
  const created = createShare(CONV_MAIN, userId);
  assert.equal(created.kind, 'created', `createShare should create, got ${JSON.stringify(created)}`);
  assert.ok(created.kind === 'created'); // narrow
  assert.equal(created.token.length, 48, 'token must be nanoid(48)');
  token1 = created.token;
  shareId1 = created.shareId;

  const row = db.prepare('SELECT * FROM conversation_shares WHERE id = ?').get(shareId1) as Record<string, unknown> | undefined;
  assert.ok(row, 'share row must exist');
  assert.equal(row.token_hash, hashShareToken(token1), 'token_hash must equal sha256(token) hex');
  assert.match(row.token_hash as string, /^[0-9a-f]{64}$/, 'token_hash must be lowercase sha256 hex');
  for (const [column, value] of Object.entries(row)) {
    if (typeof value === 'string') {
      assert.ok(!value.includes(token1), `raw token must not be persisted (leaked in column "${column}")`);
    }
  }
});

// --- scenario 2: resolve(valid) returns what buildSnapshot froze ---
test('2 resolveShareToken(valid) returns the frozen snapshot buildSnapshot produced', () => {
  const resolved = resolveShareToken(token1);
  assert.equal(resolved.kind, 'found', `resolve should find the share, got ${JSON.stringify(resolved)}`);
  assert.ok(resolved.kind === 'found'); // narrow

  const expected = buildSnapshot(CONV_MAIN);
  assert.ok(expected, 'buildSnapshot should build the live snapshot');
  // shared_at stamps each build individually — compare everything else exactly
  const withoutStamp = (s: ShareSnapshot) => ({ ...s, shared_at: '<timestamp>' });
  assert.deepEqual(withoutStamp(resolved.snapshot), withoutStamp(expected), 'resolved snapshot must equal the create-time snapshot');
  assert.ok(!Number.isNaN(Date.parse(resolved.snapshot.shared_at)), 'shared_at must be an ISO timestamp');
});

// --- scenario 3: immutability — later activity never leaks ---
test('3 immutability: messages inserted after create never appear in resolve output', () => {
  insertRichMessage({ id: 'su2', convId: CONV_MAIN, role: 'user', content: 'second question', parentId: 'sa1', turnId: 'su2', createdAt: '2026-01-01 00:00:04' });
  setLeaf(CONV_MAIN, 'su2');
  insertRichMessage({ id: 'sa2', convId: CONV_MAIN, role: 'assistant', content: 'second answer', parentId: 'su2', turnId: 'su2', createdAt: '2026-01-01 00:00:05' });
  setLeaf(CONV_MAIN, 'sa2');

  const resolvedBefore = resolveShareToken(token1);
  assert.ok(resolvedBefore.kind === 'found');
  const resolvedAfter = resolveShareToken(token1);
  assert.ok(resolvedAfter.kind === 'found');

  assert.deepEqual(resolvedAfter.snapshot, resolvedBefore.snapshot, 'stored snapshot must stay byte-for-byte equivalent');
  assert.deepEqual(
    resolvedAfter.snapshot.messages.map((m) => m.id),
    ['su1', 'sa1'],
    'snapshot must still contain exactly the create-time thread (tool rows filtered)',
  );
});

// --- scenario 4: wrong/garbage tokens and revoked links resolve not-found ---
test('4 wrong/garbage token → not-found; revoked token → not-found', () => {
  assert.equal(resolveShareToken('garbage').kind, 'not-found', 'garbage token must not resolve');
  assert.equal(resolveShareToken('').kind, 'not-found', 'empty token must not resolve');
  const fresh = generateShareToken(); // valid shape, never registered
  assert.equal(resolveShareToken(fresh).kind, 'not-found', 'unknown valid-shape token must not resolve');

  const branchShare = createShare(CONV_BRANCH, userId);
  assert.ok(branchShare.kind === 'created');
  assert.equal(revokeShare(CONV_BRANCH, userId).kind, 'revoked', 'owner revoke should succeed');
  assert.equal(resolveShareToken(branchShare.token).kind, 'not-found', 'revoked token must not resolve');
  assert.equal(getShareStatus(CONV_BRANCH, userId).kind, 'none', 'status after revoke must be none');
  assert.equal(revokeShare(CONV_BRANCH, userId).kind, 'none-active', 'second revoke must report none-active');
});

// --- scenario 5: foreign-owner rejection (uniform conversation-not-found) ---
test('5 foreign owner cannot create/status/revoke; unknown id behaves identically', () => {
  const foreignUserId = 'foreign-user-1';
  db.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, 'foreign@sharing.test', 'not-a-real-hash')").run(foreignUserId);

  assert.equal(createShare(CONV_MAIN, foreignUserId).kind, 'conversation-not-found', 'foreign create must be rejected');
  assert.equal(getShareStatus(CONV_MAIN, foreignUserId).kind, 'conversation-not-found', 'foreign status must be rejected');
  assert.equal(revokeShare(CONV_MAIN, foreignUserId).kind, 'conversation-not-found', 'foreign revoke must be rejected');

  assert.equal(createShare('conv-does-not-exist', userId).kind, 'conversation-not-found', 'unknown conversation must behave like foreign');

  assert.equal(resolveShareToken(token1).kind, 'found', 'rejected foreign calls must not disturb the existing share');
});

// --- scenario 6: rotation deletes the previous row ---
test('6 rotation: second create deletes the first share — old token dies, new one works', () => {
  const rotated = createShare(CONV_MAIN, userId);
  assert.ok(rotated.kind === 'created');
  assert.notEqual(rotated.shareId, shareId1, 'rotation must mint a new share id');
  assert.notEqual(rotated.token, token1, 'rotation must mint a new token');

  assert.equal(resolveShareToken(token1).kind, 'not-found', 'old token must die immediately after rotation');
  assert.equal(resolveShareToken(rotated.token).kind, 'found', 'new token must resolve');

  const rows = db.prepare('SELECT id FROM conversation_shares WHERE conversation_id = ?').all(CONV_MAIN) as { id: string }[];
  assert.equal(rows.length, 1, 'exactly one active share row must remain');
  assert.equal(getShareStatus(CONV_MAIN, userId).kind, 'active', 'status must be active after rotation');
});

// --- scenario 7: field stripping to the plan.md D6 allow-list ---
test('7 snapshot strips every non-allow-list field; tool rows absent; attachments reduced to filename', () => {
  const recreated = createShare(CONV_MAIN, userId); // re-freeze from current leaf
  assert.ok(recreated.kind === 'created');
  const resolved = resolveShareToken(recreated.token);
  assert.ok(resolved.kind === 'found');

  for (const message of resolved.snapshot.messages) {
    const allowedKeys = message.role === 'assistant'
      ? ['annotations', 'attachments', 'content', 'created_at', 'id', 'model', 'role'].sort()
      : ['annotations', 'attachments', 'content', 'created_at', 'id', 'role'].sort();
    assert.deepEqual(
      Object.keys(message).sort(),
      allowedKeys,
      `message ${message.id} keys must exactly match the D6 allow-list`,
    );
    if (message.attachments) {
      assert.deepEqual(message.attachments, [{ filename: 'report.pdf' }], `attachments of ${message.id} must reduce to {filename}`);
    }
  }

  assert.ok(resolved.snapshot.messages.every((m) => m.role !== 'tool'), 'tool-role rows must be absent');
  const assistant = resolved.snapshot.messages.find((m) => m.id === 'sa1');
  assert.ok(assistant, 'assistant message must be present');
  assert.equal(assistant.model, 'openrouter/auto', 'assistant model metadata must survive');

  const raw = JSON.stringify(resolved.snapshot);
  for (const forbidden of ['SECRET-REASONING', 'SECRET-UPLOAD-PATH', 'SECRET-AGENT-ID', 'Secret Agent', 'web_search', '"tc1"', 'deliveredPath', 'reasoning_content', 'provider_routing', 'processed_by_agent', 'turn_id', 'parent_id', 'variant_seq', 'conversation_id']) {
    assert.ok(!raw.includes(forbidden), `snapshot must not contain "${forbidden}"`);
  }
});

// --- scenario 8: leaf-walk fidelity (branched + legacy fallback) ---
test('8 branched snapshot follows buildThreadIds leaf-walk order; legacy falls back to created_at ASC', () => {
  const branched = buildSnapshot(CONV_BRANCH);
  assert.ok(branched, 'branched snapshot should build');
  const branchedThread = buildThreadIds(CONV_BRANCH, 'bav2');
  assert.deepEqual(branchedThread, ['bu1', 'ba1', 'bv2', 'bav2'], 'fixture sanity: variant 2 leaf walk');
  assert.deepEqual(branched.messages.map((m) => m.id), branchedThread, 'snapshot order must match buildThreadIds');

  const legacyChronological = (
    db.prepare('SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC').all(CONV_LEGACY) as { id: string }[]
  ).map((r) => r.id);
  assert.deepEqual(legacyChronological, ['lu1', 'la1', 'la2'], 'fixture sanity: legacy rows ordered by created_at despite insert order');
  assert.deepEqual(buildThreadIds(CONV_LEGACY, null), legacyChronological, 'buildThreadIds legacy fallback');
  const legacy = buildSnapshot(CONV_LEGACY);
  assert.ok(legacy, 'legacy snapshot should build');
  assert.deepEqual(legacy.messages.map((m) => m.id), legacyChronological, 'legacy snapshot must follow created_at ASC');
});

// --- scenario 9: local mode refuses share creation (fresh-process probe) ---
test('9 local mode: createShare refused and no row written (fresh-process probe)', () => {
  const tsxCli = path.join(path.dirname(SELF_PATH), '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
  assert.ok(fs.existsSync(tsxCli), `tsx cli missing at ${tsxCli}`);
  // The child gets an env COPY with JWT_SECRET cleared so its first import
  // lands in local mode; the parent's own process.env is never mutated
  // (named risk: no later scenario can flip because nothing is restored).
  const child = spawnSync(process.execPath, [tsxCli, SELF_PATH, '--local-mode-probe'], {
    encoding: 'utf8',
    env: { ...process.env, JWT_SECRET: '', DISABLE_AUTH: '' },
    timeout: 120000,
  });
  assert.equal(
    child.status,
    0,
    `local-mode probe exited ${child.status}\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`,
  );
  assert.match(child.stdout ?? '', /PASS local-mode/, 'probe must report its own PASS line');
});

if (failures > 0) {
  console.error(`${failures} test(s) FAILED`);
  process.exit(1);
}
console.log('conversation-sharing: OK');
