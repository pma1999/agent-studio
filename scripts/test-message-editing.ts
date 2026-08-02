import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

// MUST be set before importing db (db.ts resolves the path at import time).
const testDbPath = path.join(os.tmpdir(), `message-editing-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = testDbPath;

const { default: db, migrate, ensureLocalUser } = await import('../server/db.js');
const {
  backfillMessageTree,
  buildThreadIds,
  getTurnVariants,
  findVariantLeaf,
} = await import('../server/messageTree.js');

migrate();
const userId = ensureLocalUser();
assert.ok(userId, 'ensureLocalUser should return a user id');

const agentId = 'tree-test-agent';
db.prepare(`
  INSERT INTO agents (id, name, description, emoji, system_prompt, base_url, model, temperature, max_tokens, provider, user_id)
  VALUES (?, 'Tree Test', '', '🤖', 'sys', 'https://openrouter.ai/api/v1', 'openrouter/auto', 0.7, 4096, 'openrouter', ?)
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

// --- fixtures (replicate the insert logic of the chat handler) ---
const newConversation = (id: string) => {
  db.prepare('INSERT INTO conversations (id, user_id, agent_id, title) VALUES (?, ?, ?, ?)').run(id, userId, agentId, 'Tree');
};
const insertUser = (id: string, convId: string, content: string, parentId: string | null, turnId: string, variantSeq: number, model: string | null = null) => {
  db.prepare(`INSERT INTO messages (id, conversation_id, role, content, parent_id, turn_id, variant_seq, model) VALUES (?, ?, 'user', ?, ?, ?, ?, ?)`).run(id, convId, content, parentId, turnId, variantSeq, model);
};
const insertAssistant = (id: string, convId: string, content: string, parentId: string, turnId: string, variantSeq: number) => {
  db.prepare(`INSERT INTO messages (id, conversation_id, role, content, parent_id, turn_id, variant_seq) VALUES (?, ?, 'assistant', ?, ?, ?, ?)`).run(id, convId, content, parentId, turnId, variantSeq);
};
const insertTool = (id: string, convId: string, content: string, parentId: string, turnId: string, variantSeq: number) => {
  db.prepare(`INSERT INTO messages (id, conversation_id, role, content, tool_call_id, parent_id, turn_id, variant_seq) VALUES (?, ?, 'tool', ?, 'tc1', ?, ?, ?)`).run(id, convId, content, parentId, turnId, variantSeq);
};
const setLeaf = (convId: string, msgId: string) => {
  db.prepare('UPDATE conversations SET active_leaf_id = ? WHERE id = ?').run(msgId, convId);
};
const getLeaf = (convId: string) => (db.prepare('SELECT active_leaf_id FROM conversations WHERE id = ?').get(convId) as { active_leaf_id: string | null }).active_leaf_id;
const getMsg = (id: string) => db.prepare('SELECT parent_id, turn_id, variant_seq FROM messages WHERE id = ?').get(id) as { parent_id: string | null; turn_id: string | null; variant_seq: number };

// --- (a) legacy fixture: linear messages without tree columns → backfill ---
const convLegacy = 'tree-conv-legacy';
newConversation(convLegacy);
insertUser('lu1', convLegacy, 'legacy hello', null, 'lu1', 1);      // no tree info (NULLs) — legacy
insertAssistant('la1', convLegacy, 'legacy answer', 'lu1', 'lu1', 1); // same
insertTool('lt1', convLegacy, 'legacy tool result', 'la1', 'lu1', 1);
insertAssistant('la2', convLegacy, 'legacy final', 'lt1', 'lu1', 1);
// wipe any tree metadata to truly simulate a pre-migration database
db.prepare(`UPDATE messages SET parent_id = NULL, turn_id = NULL, variant_seq = 1 WHERE conversation_id = ?`).run(convLegacy);

backfillMessageTree();

test('(a) backfill chains parent_id correctly', () => {
  assert.equal(getMsg('lu1').parent_id, null);
  assert.equal(getMsg('la1').parent_id, 'lu1');
  assert.equal(getMsg('lt1').parent_id, 'la1');
  assert.equal(getMsg('la2').parent_id, 'lt1');
});

test('(a) backfill assigns turn_id/variant_seq', () => {
  for (const id of ['lu1', 'la1', 'lt1', 'la2']) {
    assert.equal(getMsg(id).turn_id, 'lu1');
    assert.equal(getMsg(id).variant_seq, 1);
  }
});

test('(a) backfill sets active_leaf_id to the last message', () => {
  assert.equal(getLeaf(convLegacy), 'la2');
});

test('(a) buildThreadIds from backfilled leaf returns root→leaf chain', () => {
  assert.deepEqual(buildThreadIds(convLegacy, 'la2'), ['lu1', 'la1', 'lt1', 'la2']);
});

// --- (b) normal chat fixture (replicates handler inserts: parent/turn/variant + active leaf) ---
const convNormal = 'tree-conv-normal';
newConversation(convNormal);

const m1 = 'm1';
insertUser(m1, convNormal, 'first question', null, m1, 1, 'openrouter/auto');
setLeaf(convNormal, m1);
const a1 = 'a1';
insertAssistant(a1, convNormal, 'answer 1', m1, m1, 1);
setLeaf(convNormal, a1);
const m2 = 'm2';
insertUser(m2, convNormal, 'second question', a1, m2, 1);
setLeaf(convNormal, m2);
const a2 = 'a2';
insertAssistant(a2, convNormal, 'answer 2', m2, m2, 1);
setLeaf(convNormal, a2);

test('(b) buildThreadIds follows parent chain, not created_at', () => {
  assert.deepEqual(buildThreadIds(convNormal, a2), ['m1', 'a1', 'm2', 'a2']);
});

test('(b) buildThreadIds falls back to chronological order for invalid leaf', () => {
  assert.deepEqual(buildThreadIds(convNormal, 'does-not-exist'), ['m1', 'a1', 'm2', 'a2']);
  assert.deepEqual(buildThreadIds(convNormal, null), ['m1', 'a1', 'm2', 'a2']);
});

test('(b) active_leaf_id tracks the latest insert', () => {
  assert.equal(getLeaf(convNormal), a2);
});

// --- (c) editing / retry: new variants of turn m2 ---
const v2 = 'v2';
insertUser(v2, convNormal, 'edited question', a1, m2, 2, 'anthropic/claude-3.5-sonnet');
setLeaf(convNormal, v2);
const a2v2 = 'a2v2';
insertAssistant(a2v2, convNormal, 'edited answer', v2, m2, 2);
setLeaf(convNormal, a2v2);

const v3 = 'v3'; // retry of the original (same content) → variant 3
insertUser(v3, convNormal, 'second question', a1, m2, 3);
setLeaf(convNormal, v3);
const a2v3 = 'a2v3';
insertAssistant(a2v3, convNormal, 'retried answer', v3, m2, 3);
setLeaf(convNormal, a2v3);

test('(c) getTurnVariants lists variants 1..3 in seq order', () => {
  const variants = getTurnVariants(convNormal, m2);
  assert.equal(variants.length, 3);
  assert.deepEqual(variants.map((v) => v.variant_seq), [1, 2, 3]);
  assert.deepEqual(variants.map((v) => v.content), ['second question', 'edited question', 'second question']);
  assert.equal(variants[1].model, 'anthropic/claude-3.5-sonnet'); // model saved on the variant
});

test('(c) buildThreadIds from variant 3 leaf excludes variants 1/2 messages', () => {
  assert.deepEqual(buildThreadIds(convNormal, a2v3), ['m1', 'a1', v3, a2v3]);
  assert.deepEqual(buildThreadIds(convNormal, a2v2), ['m1', 'a1', v2, a2v2]);
  assert.ok(!buildThreadIds(convNormal, a2v3).includes(m2));
  assert.ok(!buildThreadIds(convNormal, a2v3).includes(a2));
  assert.ok(!buildThreadIds(convNormal, a2v3).includes(v2));
});

test('(c) findVariantLeaf returns the deepest descendant (continuation incl. later turns)', () => {
  assert.equal(findVariantLeaf(convNormal, v2), a2v2);
  assert.equal(findVariantLeaf(convNormal, v3), a2v3);
  assert.equal(findVariantLeaf(convNormal, m2), a2); // variant 1 leaf
  // turn 1's tail follows its continuation into later turns (ties resolve to
  // the earlier branch): m1 → a1 → m2 → a2, not a1.
  assert.equal(findVariantLeaf(convNormal, m1), a2);
  assert.equal(findVariantLeaf(convNormal, a1), null); // assistant roots are not variants
});

// --- (d) active_leaf_id reflects the last created variant ---
test('(d) active_leaf_id points at the newest variant tail', () => {
  assert.equal(getLeaf(convNormal), a2v3);
});

// --- (e) idempotence: re-running migrate() must not break or duplicate the tree ---
test('(e) migrate() re-run does not throw and keeps the tree intact', () => {
  migrate();
  const cols = (db.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map((c) => c.name);
  const convCols = (db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes('parent_id') && cols.includes('turn_id') && cols.includes('variant_seq'));
  assert.ok(convCols.includes('active_leaf_id'));
  assert.deepEqual(buildThreadIds(convNormal, a2v3), ['m1', 'a1', v3, a2v3]);
  assert.equal(getTurnVariants(convNormal, m2).length, 3);
  assert.equal(getLeaf(convNormal), a2v3);
  assert.equal(getLeaf(convLegacy), 'la2');
});

if (failures > 0) {
  console.error(`${failures} test(s) FAILED`);
  process.exit(1);
}
console.log('message-editing: OK');
