import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

// MUST be set before importing db (db.ts resolves the path at import time).
const testDbPath = path.join(os.tmpdir(), `compact-migration-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = testDbPath;

const { default: db, migrate, ensureLocalUser } = await import('../server/db.js');

migrate();
const userId = ensureLocalUser();
assert.ok(userId, 'ensureLocalUser should return a user id');

const agentId = 'compact-test-agent';
db.prepare(`
  INSERT INTO agents (id, name, description, emoji, system_prompt, base_url, model, temperature, max_tokens, provider, user_id)
  VALUES (?, 'Compact Test', '', '🤖', 'sys', 'https://openrouter.ai/api/v1', 'openrouter/auto', 0.7, 4096, 'openrouter', ?)
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

type PragmaCol = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number };
type FkRow = { id: number; seq: number; table: string; from: string; to: string; on_update: string; on_delete: string };

const allMsgCols = () =>
  (db.prepare('PRAGMA table_info(messages)').all() as PragmaCol[]).map((c) => c.name);
const messagesSql = () =>
  (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'").get() as { sql: string }).sql;

// --- fixtures: every column populated (incl. tree columns), like the chat handler ---
const newConversation = (id: string) => {
  db.prepare('INSERT INTO conversations (id, user_id, agent_id, title) VALUES (?, ?, ?, ?)').run(id, userId, agentId, 'Compact');
};
const insertFullRow = (id: string, convId: string, role: string, parentId: string | null) => {
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, provider_routing, tokens_used,
      prompt_tokens, completion_tokens, cost, annotations, reasoning_content, reasoning_tokens,
      cached_tokens, tool_call_id, tool_calls, created_at, attachments, model,
      processed_by_agent_id, processed_by_agent_name, parent_id, turn_id, variant_seq, generation_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, convId, role, `content-${id}`, '{"route":"r"}', 10,
    6, 4, 0.001, '{"a":1}', 'reasoning', 2,
    1, role === 'tool' ? 'tc1' : null, role === 'assistant' ? '[{"id":"tc1"}]' : null,
    '2026-01-01 00:00:00', '{"files":[]}', 'openrouter/auto',
    null, null, parentId, 'turn-1', 1, 'complete',
  );
};
const snapshot = (convId: string) =>
  db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(convId);

// --- (a) fresh migrate: CHECK allows compaction + meta round-trip ---
test('(a) role CHECK allows system|user|assistant|tool|compaction', () => {
  for (const role of ['system', 'user', 'assistant', 'tool', 'compaction']) {
    assert.ok(messagesSql().includes(`'${role}'`), `CHECK should list '${role}'`);
  }
});

test('(a) compaction_meta column exists and is nullable TEXT', () => {
  const col = (db.prepare('PRAGMA table_info(messages)').all() as PragmaCol[]).find((c) => c.name === 'compaction_meta');
  assert.ok(col, 'compaction_meta should exist');
  assert.equal(col.type, 'TEXT');
  assert.equal(col.notnull, 0);
});

const convFresh = 'compact-conv-fresh';
newConversation(convFresh);
insertFullRow('cf-u1', convFresh, 'user', null);
insertFullRow('cf-a1', convFresh, 'assistant', 'cf-u1');

const meta = {
  v: 1, model: 'openrouter/auto', provider: 'openrouter', focus: null, keep_tokens: 8000,
  tokens_before: 9000, tokens_after: 1000, messages_compacted: 2, tail_message_ids: ['cf-u1', 'cf-a1'],
  pre_compact_leaf_id: 'cf-a1', supersedes: null, compacted_at: '2026-01-01T00:00:00.000Z', request_id: null,
};
test('(a) compaction row inserts and meta round-trips', () => {
  db.prepare(`INSERT INTO messages (id, conversation_id, role, content, parent_id, turn_id, variant_seq, compaction_meta)
    VALUES (?, ?, 'compaction', ?, ?, ?, 1, ?)`).run('cf-c1', convFresh, 'summary body', 'cf-a1', 'cf-c1', JSON.stringify(meta));
  const row = db.prepare('SELECT content, parent_id, turn_id, variant_seq, compaction_meta FROM messages WHERE id = ?').get('cf-c1') as {
    content: string; parent_id: string; turn_id: string; variant_seq: number; compaction_meta: string;
  };
  assert.equal(row.content, 'summary body');
  assert.equal(row.parent_id, 'cf-a1');
  assert.equal(row.turn_id, 'cf-c1');
  assert.equal(row.variant_seq, 1);
  assert.deepEqual(JSON.parse(row.compaction_meta), meta);
});

// --- (b) legacy simulation: downgrade CHECK + drop column, then migrate() ---
// Build a legacy-shaped table (narrow CHECK, no compaction_meta) from live
// PRAGMA so the fixture keeps every current column, then verify migrate()
// restores the new shape with every row/column value byte-identical.
const convLegacy = 'compact-conv-legacy';
newConversation(convLegacy);
insertFullRow('cl-u1', convLegacy, 'user', null);
insertFullRow('cl-a1', convLegacy, 'assistant', 'cl-u1');
insertFullRow('cl-t1', convLegacy, 'tool', 'cl-a1');
insertFullRow('cl-s1', convLegacy, 'system', 'cl-t1');
db.prepare('UPDATE conversations SET active_leaf_id = ? WHERE id = ?').run('cl-s1', convLegacy);
const beforeRows = snapshot(convLegacy);
const beforeIndexes = (
  db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='messages' AND sql IS NOT NULL").all() as { name: string; sql: string }[]
).map((r) => r.name).sort();

function downgradeToLegacy() {
  // A legacy DB by definition contains no compaction rows (the role did not
  // exist), so drop them before rebuilding with the narrow CHECK.
  db.prepare("DELETE FROM messages WHERE role = 'compaction'").run();
  const cols = db.prepare('PRAGMA table_info(messages)').all() as PragmaCol[];
  const fks = db.prepare('PRAGMA foreign_key_list(messages)').all() as FkRow[];
  const fkByFrom = new Map(fks.map((f) => [f.from, f]));
  const defs = cols
    .filter((c) => c.name !== 'compaction_meta')
    .map((c) => {
      let def = `"${c.name}" ${c.type}`;
      if (c.pk) def += ' PRIMARY KEY';
      if (c.notnull) def += ' NOT NULL';
      // PRAGMA strips the parens from expression defaults (e.g. created_at
      // reports `datetime('now')`), but SQLite only accepts a bare function
      // call inside DEFAULT when parenthesized — so re-wrap unless the
      // default is a plain literal or already parenthesized.
      if (c.dflt_value !== null && c.dflt_value !== undefined) {
        const dv = c.dflt_value.trim();
        const isLiteral = /^-?(\d+(\.\d+)?|'.*')$/s.test(dv) || /^(NULL|TRUE|FALSE|CURRENT_TIME|CURRENT_DATE|CURRENT_TIMESTAMP)$/i.test(dv);
        def += isLiteral || dv.startsWith('(') ? ` DEFAULT ${dv}` : ` DEFAULT (${dv})`;
      }
      const fk = fkByFrom.get(c.name);
      if (fk) {
        def += ` REFERENCES "${fk.table}"("${fk.to}")`;
        if (fk.on_delete !== 'NO ACTION') def += ` ON DELETE ${fk.on_delete}`;
        if (fk.on_update !== 'NO ACTION') def += ` ON UPDATE ${fk.on_update}`;
      }
      if (c.name === 'role') def += ` CHECK(role IN ('system', 'user', 'assistant', 'tool'))`;
      return def;
    });
  const keepCols = cols.filter((c) => c.name !== 'compaction_meta').map((c) => `"${c.name}"`).join(', ');
  const oldIndexes = (
    db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='messages' AND sql IS NOT NULL AND name != 'idx_messages_compaction_conv_created'").all() as { sql: string }[]
  ).map((r) => r.sql);
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`CREATE TABLE messages_legacy (${defs.join(', ')})`);
      db.exec(`INSERT INTO messages_legacy (${keepCols}) SELECT ${keepCols} FROM messages`);
      db.exec('DROP TABLE messages');
      db.exec('ALTER TABLE messages_legacy RENAME TO messages');
    })();
    for (const sql of oldIndexes) db.exec(sql);
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

downgradeToLegacy();

test('(b) legacy fixture: narrow CHECK rejects compaction before migrate()', () => {
  assert.ok(!messagesSql().includes("'compaction'"), 'downgraded CHECK should lack compaction');
  assert.ok(!allMsgCols().includes('compaction_meta'), 'downgraded table should lack compaction_meta');
  assert.throws(() =>
    db.prepare(`INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, 'compaction', ?)`).run('cl-x', convLegacy, 'nope'),
  );
});

migrate();

test('(b) migrate() restores widened CHECK + compaction_meta column', () => {
  assert.ok(messagesSql().includes("'compaction'"));
  assert.ok(allMsgCols().includes('compaction_meta'));
});

test('(b) every legacy row and column value is byte-identical after migrate()', () => {
  const afterRows = snapshot(convLegacy);
  assert.deepEqual(afterRows, beforeRows.map((r) => ({ ...(r as object), compaction_meta: null })));
});

test('(b) pre-existing messages indexes survive the rebuild', () => {
  const afterIndexes = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='messages' AND sql IS NOT NULL").all() as { name: string }[]
  ).map((r) => r.name).sort();
  for (const name of beforeIndexes) assert.ok(afterIndexes.includes(name), `index ${name} should survive`);
});

test('(b) compaction row inserts into the upgraded legacy conversation', () => {
  db.prepare(`INSERT INTO messages (id, conversation_id, role, content, parent_id, turn_id, variant_seq, compaction_meta)
    VALUES (?, ?, 'compaction', ?, ?, ?, 1, ?)`).run('cl-c1', convLegacy, 'legacy summary', 'cl-s1', 'cl-c1', JSON.stringify(meta));
  const row = db.prepare('SELECT compaction_meta FROM messages WHERE id = ?').get('cl-c1') as { compaction_meta: string };
  assert.deepEqual(JSON.parse(row.compaction_meta), meta);
});

// --- (c) double migrate() is a no-op ---
test('(c) re-running migrate() is a no-op', () => {
  const beforeAll = db.prepare('SELECT * FROM messages ORDER BY id').all();
  const beforeSql = messagesSql();
  migrate();
  migrate();
  assert.equal(messagesSql(), beforeSql);
  assert.deepEqual(db.prepare('SELECT * FROM messages ORDER BY id').all(), beforeAll);
});

// --- (d) FK cascade still works ---
test('(d) DELETE conversations cascades to messages', () => {
  const convGone = 'compact-conv-gone';
  newConversation(convGone);
  insertFullRow('cg-u1', convGone, 'user', null);
  db.prepare('DELETE FROM conversations WHERE id = ?').run(convGone);
  assert.equal((db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ?').get(convGone) as { cnt: number }).cnt, 0);
});

// --- (e) new composite index exists ---
test('(e) idx_messages_compaction_conv_created exists on (conversation_id, created_at)', () => {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_messages_compaction_conv_created'").get() as { sql: string } | undefined;
  assert.ok(row, 'composite index should exist');
  assert.ok(row.sql.includes('conversation_id') && row.sql.includes('created_at'), `unexpected index DDL: ${row.sql}`);
});

if (failures > 0) {
  console.error(`${failures} test(s) FAILED`);
  process.exit(1);
}
console.log('compact-migration: OK');
