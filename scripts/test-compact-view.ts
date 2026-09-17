import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

// MUST be set before importing db (db.ts resolves the path at import time).
const testDbPath = path.join(os.tmpdir(), `compact-view-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = testDbPath;

const { default: db, migrate, ensureLocalUser } = await import('../server/db.js');
const { setModelCatalogForTests } = await import('../server/catalog/index.js');
const { stubModelCatalog } = await import('./helpers/catalogStub.js');
// Context windows come from the catalog; describe the agent's model offline.
setModelCatalogForTests(stubModelCatalog({ 'deepseek:deepseek-v4-flash': { contextLength: 1_000_000, lifecycle: 'active' } }));
const { buildThreadIds } = await import('../server/messageTree.js');
const { selectModelView } = await import('../server/routes/chat.js');
const {
  default: messagesRouter,
  parseCompactionMeta,
  selectVisibleCompaction,
  buildContextEstimate,
} = await import('../server/routes/messages.js');

migrate();
const userId = ensureLocalUser();
assert.ok(userId, 'ensureLocalUser should return a user id');

const agentId = 'compact-view-agent';
db.prepare(`
  INSERT INTO agents (id, name, description, emoji, system_prompt, base_url, model, temperature, max_tokens, provider, user_id)
  VALUES (?, 'Compact View', '', '🤖', 'SYS-MARKER', 'https://openrouter.ai/api/v1', 'deepseek:deepseek-v4-flash', 0.7, 4096, 'openrouter', ?)
`).run(agentId, userId);

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return (async () => {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (err) {
      failures++;
      console.error(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
}
const results: Promise<void>[] = [];
const t = (name: string, fn: () => void | Promise<void>) => results.push(test(name, fn));

// --- pure cut fixtures (mapped history shape: tool_calls already parsed) ---
const u = (content: string) => ({ role: 'user', content });
const a = (content: string) => ({ role: 'assistant', content });
const comp = (content: string) => ({ role: 'compaction', content });
const aTool = (id: string, name: string) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }],
});
const toolRow = (id: string) => ({ role: 'tool', tool_call_id: id, content: 'result' });

// --- DB fixtures (mirror chat-handler inserts: parent/turn/variant + leaf) ---
const newConversation = (id: string, model: string | null = null) => {
  db.prepare('INSERT INTO conversations (id, user_id, agent_id, title, model) VALUES (?, ?, ?, ?, ?)').run(id, userId, agentId, 'CV', model);
};
const insertMsg = (opts: {
  id: string; conv: string; role: string; content: string | null; parent: string | null;
  turn: string; toolCalls?: string | null; meta?: string | null; model?: string | null;
}) => {
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, tool_call_id, tool_calls, parent_id, turn_id, variant_seq, compaction_meta, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    opts.id, opts.conv, opts.role, opts.content,
    opts.role === 'tool' ? 'tc1' : null, opts.toolCalls ?? null,
    opts.parent, opts.turn, opts.meta ?? null, opts.model ?? null,
  );
};
const setLeaf = (conv: string, leaf: string) => {
  db.prepare('UPDATE conversations SET active_leaf_id = ? WHERE id = ?').run(leaf, conv);
};
const META = (over: Record<string, unknown> = {}) => JSON.stringify({
  v: 1, model: 'deepseek:deepseek-v4-flash', provider: 'deepseek', focus: 'test focus',
  keep_tokens: 8000, tokens_before: 100, tokens_after: 50, messages_compacted: 2,
  tail_message_ids: [], pre_compact_leaf_id: 'u1', supersedes: null,
  compacted_at: new Date().toISOString(), request_id: null, ...over,
});
const SUMMARY = 'Another language model summarized this conversation so it could continue in a smaller context. '
  + 'Use the summary as prior state; the verbatim tail after it is newest. Do not duplicate completed work. Summary:\n## Objective\n- x';

// Seed: 3 turns + tool pair, then a mid-thread checkpoint + post-compact turn.
const conv = 'cv-conv-1';
newConversation(conv);
insertMsg({ id: 'u1', conv, role: 'user', content: `first ask ${'q'.repeat(600)}`, parent: null, turn: 'u1' });
insertMsg({ id: 'a1', conv, role: 'assistant', content: 'ans1', parent: 'u1', turn: 'u1' });
insertMsg({ id: 'u2', conv, role: 'user', content: `second ask ${'q'.repeat(600)}`, parent: 'a1', turn: 'u2' });
insertMsg({
  id: 'a2t', conv, role: 'assistant', content: '', parent: 'u2', turn: 'u2',
  toolCalls: JSON.stringify([{ id: 'tc1', type: 'function', function: { name: 'lookup', arguments: '{}' } }]),
});
insertMsg({ id: 't2', conv, role: 'tool', content: 'tool-out', parent: 'a2t', turn: 'u2' });
insertMsg({ id: 'a2b', conv, role: 'assistant', content: 'done2', parent: 't2', turn: 'u2' });
insertMsg({ id: 'u3', conv, role: 'user', content: `third ask ${'q'.repeat(600)}`, parent: 'a2b', turn: 'u3' });
insertMsg({ id: 'a3', conv, role: 'assistant', content: 'ans3', parent: 'u3', turn: 'u3' });
insertMsg({ id: 'c1', conv, role: 'compaction', content: SUMMARY, parent: 'a3', turn: 'c1', meta: META(), model: 'deepseek:deepseek-v4-flash' });
insertMsg({ id: 'u4', conv, role: 'user', content: 'fourth', parent: 'c1', turn: 'u4' });
insertMsg({ id: 'a4', conv, role: 'assistant', content: 'ans4', parent: 'u4', turn: 'u4' });
setLeaf(conv, 'a4');

// --- selectModelView: passthrough ---
t('no compaction rows -> prefixRow null, viewRows identical', () => {
  const items = [u('hi'), a('yo'), u('again')];
  const { prefixRow, viewRows } = selectModelView(items as never[]);
  assert.equal(prefixRow, null);
  assert.deepEqual(viewRows, items);
});

t('system string passes through byte-identical with prefix at index 1', () => {
  const system = 'SYS-MARKER';
  const items = [u('old'), comp(SUMMARY), u('new')];
  const { prefixRow, viewRows } = selectModelView(items as never[]);
  assert.ok(prefixRow && (prefixRow as { role: string }).role === 'user');
  const messages = [{ role: 'system', content: system }, ...(prefixRow ? [prefixRow] : []), ...viewRows];
  assert.equal(messages[0]!.content, system);
  assert.equal((messages[1] as { content: string }).content, SUMMARY);
  assert.equal(messages.length, 3);
});

// --- selectModelView: Codex-style retention ---
t('retained user messages come back verbatim, before the summary', () => {
  // Sized like a real compaction: the archived turns outweigh the summary, so
  // the headroom cap is inert and plain Codex retention applies.
  const ask1 = `first ask ${'q'.repeat(600)}`;
  const ask2 = `second ask ${'q'.repeat(600)}`;
  // Assistant/tool bulk dominates, as in any real thread, so the headroom is
  // far larger than the user text and both asks survive whole.
  const items = [u(ask1), a('A'.repeat(8000)), u(ask2), comp(SUMMARY), u('new')];
  const { retainedRows, prefixRow, viewRows } = selectModelView(items as never[]);
  assert.deepEqual(
    retainedRows.map((r: { content: string }) => r.content),
    [ask1, ask2],
    'both user asks are replayed, assistant prose is not',
  );
  // Codex ordering: recent asks -> summary -> new material.
  const messages = [
    { role: 'system', content: 'SYS' },
    ...retainedRows,
    ...(prefixRow ? [prefixRow] : []),
    ...viewRows,
  ];
  assert.deepEqual(
    messages.map((m: { role: string; content: unknown }) => `${m.role}:${String(m.content).slice(0, 10)}`),
    ['system:SYS', 'user:first ask ', 'user:second ask', `user:${SUMMARY.slice(0, 10)}`, 'user:new'],
  );
});

t('a thread with no checkpoint retains nothing (nothing was cut)', () => {
  const { retainedRows } = selectModelView([u('hi'), a('yo')] as never[]);
  assert.deepEqual(retainedRows, []);
});

t('an older checkpoint is not replayed as a retained user message', () => {
  const one = `one ${'q'.repeat(600)}`;
  const two = `two ${'q'.repeat(600)}`;
  const items = [u(one), a('A'.repeat(8000)), comp('OLD-SUMMARY'), u(two), comp(SUMMARY), u('three')];
  const { retainedRows } = selectModelView(items as never[]);
  assert.deepEqual(
    retainedRows.map((r: { content: string }) => r.content),
    [one, two],
  );
});

t('headroom cap: a thread too small to be worth compacting retains nothing', () => {
  // The template summary alone outweighs what it archived, so replaying on top
  // of it would only add cost. The cap is inert on real (large) threads.
  const { retainedRows } = selectModelView([u('hi'), a('yo'), comp(SUMMARY), u('next')] as never[]);
  assert.deepEqual(retainedRows, []);
});

// --- selectModelView: cut rule ---
t('cut drops everything up to AND including the LAST compaction row', () => {
  const items = [u('u1'), comp('SUMMARY-ONE'), u('u2'), comp(SUMMARY), u('u3')];
  const { prefixRow, viewRows } = selectModelView(items as never[]);
  assert.equal((prefixRow as { content: string } | null)?.content, SUMMARY);
  assert.deepEqual(viewRows, [u('u3')]);
});

t('synthetic prefix content is the stored compaction content verbatim', () => {
  const items = [u('old'), comp(SUMMARY)];
  const { prefixRow, viewRows } = selectModelView(items as never[]);
  assert.equal((prefixRow as { content: string } | null)?.content, SUMMARY);
  assert.deepEqual(viewRows, []);
});

// --- selectModelView: dangling-head guard ---
t('leading tool row after the cut is dropped', () => {
  const { prefixRow, viewRows } = selectModelView([comp(SUMMARY), toolRow('tc1'), u('next')] as never[]);
  assert.ok(prefixRow);
  assert.deepEqual(viewRows, [u('next')]);
});

t('orphaned tool-calling assistant (no tool rows left) is dropped', () => {
  const { viewRows } = selectModelView([comp(SUMMARY), aTool('tc1', 'lookup'), u('next')] as never[]);
  assert.deepEqual(viewRows, [u('next')]);
});

t('healthy assistant tool pair after the cut is kept', () => {
  const tail = [aTool('tc1', 'lookup'), toolRow('tc1'), u('next')];
  const { prefixRow, viewRows } = selectModelView([comp(SUMMARY), ...tail] as never[]);
  assert.ok(prefixRow);
  assert.deepEqual(viewRows, tail);
});

t('stacked dangle (tool + orphan assistant) drops both via the repeat check', () => {
  const { viewRows } = selectModelView([comp(SUMMARY), toolRow('tc0'), aTool('tc1', 'lookup')] as never[]);
  assert.deepEqual(viewRows, []);
});

t('plain assistant text head without tool_calls is kept', () => {
  const { viewRows } = selectModelView([comp(SUMMARY), a('tail answer')] as never[]);
  assert.deepEqual(viewRows, [a('tail answer')]);
});

// --- DB-backed: thread cut + undo ---
t('db thread after compact exposes summary+tail only via the cut', () => {
  const ids = buildThreadIds(conv, 'a4');
  const byId = new Map(
    (db.prepare('SELECT * FROM messages WHERE conversation_id = ?').all(conv) as Record<string, unknown>[])
      .map((r) => [String(r.id), r]),
  );
  const threadRoles = ids.map((id) => String(byId.get(id)!.role));
  assert.deepEqual(threadRoles, ['user', 'assistant', 'user', 'assistant', 'tool', 'assistant', 'user', 'assistant', 'compaction', 'user', 'assistant']);
  const mapped = ids.map((id) => {
    const r = byId.get(id)!;
    return r.role === 'compaction' ? comp(String(r.content)) : { role: String(r.role), content: r.content as string | null };
  });
  const { retainedRows, prefixRow, viewRows } = selectModelView(mapped as never[]);
  assert.equal((prefixRow as { content: string } | null)?.content, SUMMARY);
  assert.deepEqual(viewRows.map((m) => (m as { content: string }).content), ['fourth', 'ans4']);
  // Codex retention over a real DB thread: every pre-checkpoint user turn is
  // replayed verbatim; assistant prose and tool rows stay cut.
  assert.deepEqual(
    retainedRows.map((r: { content: string }) => r.content.slice(0, 10)),
    ['first ask ', 'second ask', 'third ask '],
  );
});

// --- call sites: the composed model view must keep Codex's order ---
t('chat.ts spreads retained rows BEFORE the summary prefix row', () => {
  const src = readFileSync(resolve(process.cwd(), 'server/routes/chat.ts'), 'utf8');
  const assembly = src.slice(src.indexOf("{ role: 'system', content: agent.system_prompt },"));
  const retained = assembly.indexOf('...compactRetainedRows,');
  const prefix = assembly.indexOf('...(compactionPrefixRow ? [compactionPrefixRow] : []),');
  const view = assembly.indexOf('...compactViewRows,');
  assert.ok(retained > 0, 'chat.ts no longer spreads compactRetainedRows');
  assert.ok(retained < prefix && prefix < view, 'order must be retained -> summary -> new material');
});

t('chatCouncil.ts applies the same compact view in the same order', () => {
  const src = readFileSync(resolve(process.cwd(), 'server/routes/chatCouncil.ts'), 'utf8');
  assert.ok(src.includes('selectModelView(history)'), 'council must cut the compacted history');
  const assembly = src.slice(src.indexOf('const councilHistory = ['));
  const retained = assembly.indexOf('...councilRetainedRows,');
  const prefix = assembly.indexOf('...(councilPrefixRow ? [councilPrefixRow] : []),');
  const view = assembly.indexOf('...councilViewRows,');
  assert.ok(retained >= 0 && retained < prefix && prefix < view, 'council order must match chat');
  assert.ok(src.includes('messageHistory: councilHistory'), 'council must send the cut history');
});

t('undo: moving active_leaf_id back to pre_compact_leaf_id restores the full pre-compact view', () => {
  db.prepare('UPDATE conversations SET active_leaf_id = ? WHERE id = ?').run('a3', conv);
  try {
    const ids = buildThreadIds(conv, 'a3');
    assert.deepEqual(ids, ['u1', 'a1', 'u2', 'a2t', 't2', 'a2b', 'u3', 'a3']);
    const mapped = ids.map((id) => {
      const r = db.prepare('SELECT role, content FROM messages WHERE id = ?').get(id) as { role: string; content: string | null };
      return { role: r.role, content: r.content };
    });
    const { prefixRow, viewRows } = selectModelView(mapped as never[]);
    assert.equal(prefixRow, null);
    assert.equal(viewRows.length, 8);
  } finally {
    db.prepare('UPDATE conversations SET active_leaf_id = ? WHERE id = ?').run('a4', conv);
  }
});

// --- messages.ts helpers ---
t('parseCompactionMeta parses valid JSON and returns {} on failure without throwing', () => {
  const parsed = parseCompactionMeta(META({ focus: 'f' })) as Record<string, unknown>;
  assert.equal(parsed.focus, 'f');
  assert.deepEqual(parseCompactionMeta('not-json'), {});
  assert.deepEqual(parseCompactionMeta(null), {});
  assert.deepEqual(parseCompactionMeta(undefined), {});
});

t('selectVisibleCompaction picks the newest checkpoint in the visible thread with total count', () => {
  const rows = [
    { id: 'c-old', created_at: '2026-01-01', role: 'compaction', content: 'S1', model: 'm', compaction_meta: META({ focus: 'old' }) },
    { id: 'u9', created_at: '2026-01-02', role: 'user', content: 'hi', model: null, compaction_meta: null },
    { id: 'c-new', created_at: '2026-01-03', role: 'compaction', content: 'S2', model: 'm', compaction_meta: META({ focus: 'new', tokens_before: 7 }) },
  ];
  const desc = selectVisibleCompaction(rows, 5) as Record<string, unknown>;
  assert.equal(desc.id, 'c-new');
  assert.equal(desc.focus, 'new');
  assert.equal(desc.tokens_before, 7);
  assert.equal(desc.pre_compact_leaf_id, 'u1');
  assert.equal(desc.messages_compacted, 2);
  assert.deepEqual(desc.tail_message_ids, []);
  assert.equal(desc.count, 5);
});

t('selectVisibleCompaction returns null when the visible thread has no checkpoint', () => {
  assert.equal(selectVisibleCompaction([{ id: 'u1', role: 'user', content: 'x' }], 0), null);
});

t('selectVisibleCompaction survives corrupt meta (fields null, never throws)', () => {
  const desc = selectVisibleCompaction(
    [{ id: 'c1', created_at: 't', role: 'compaction', content: 'S', model: 'm', compaction_meta: '[[bad' }], 1,
  ) as Record<string, unknown>;
  assert.equal(desc.id, 'c1');
  assert.equal(desc.model, 'm');
  assert.equal(desc.tokens_before, null);
  assert.equal(desc.focus, null);
  assert.equal(desc.messages_compacted, null);
  assert.equal(desc.tail_message_ids, null);
});

t('selectVisibleCompaction with legacy meta (keys absent) degrades to null without throwing', () => {
  const legacyMeta = JSON.stringify({ v: 1, model: 'm', focus: 'old', tokens_before: 5, tokens_after: 3 });
  const desc = selectVisibleCompaction(
    [{ id: 'c-old', created_at: 't', role: 'compaction', content: 'S', model: 'm', compaction_meta: legacyMeta }], 1,
  ) as Record<string, unknown>;
  assert.equal(desc.id, 'c-old');
  assert.equal(desc.messages_compacted, null);
  assert.equal(desc.tail_message_ids, null);
});

t('buildContextEstimate: unknown window -> limit/pct null, advisory off', () => {
  const est = buildContextEstimate({
    systemPrompt: 'sys', summaryContent: SUMMARY, tailRows: [{ content: 'tail' }], toolsJson: '[]', contextLength: null,
  }) as Record<string, unknown>;
  assert.equal(est.limit, null);
  assert.equal(est.pct, null);
  assert.equal(est.suggest_compact, false);
  assert.ok(typeof est.tokens === 'number' && (est.tokens as number) > 0);
});

t('buildContextEstimate: known window -> pct math + 60% advisory on', () => {
  const bigTail = 'x'.repeat(630_000);
  const est = buildContextEstimate({
    systemPrompt: 'sys', summaryContent: null, tailRows: [{ content: bigTail }], toolsJson: '[]',
    contextLength: 262144,
  }) as Record<string, unknown>;
  assert.equal(est.limit, 262144);
  assert.ok(Math.abs((est.pct as number) - (est.tokens as number) / 262144) < 1e-9);
  assert.equal(est.suggest_compact, true);
});

t('buildContextEstimate: small usage stays below the advisory threshold', () => {
  const est = buildContextEstimate({
    systemPrompt: 'sys', summaryContent: null, tailRows: [{ content: 'hi' }], toolsJson: '[]',
    contextLength: 1_000_000,
  }) as Record<string, unknown>;
  assert.equal(est.limit, 1_000_000);
  assert.equal(est.suggest_compact, false);
});

// --- GET /:id/messages view contract over HTTP ---
t('GET messages keeps flat array + cursors and adds compaction + context_estimate', async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as Record<string, unknown>).userId = userId;
    next();
  });
  app.use('/api/conversations', messagesRouter);
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const port = (server.address() as import('node:net').AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/conversations/${conv}/messages`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      messages: unknown[]; active_leaf_id: string; active_turn_id: unknown;
      compaction: Record<string, unknown> | null;
      context_estimate: Record<string, unknown>;
    };
    assert.ok(Array.isArray(body.messages));
    assert.equal(body.messages.length, 11);
    assert.equal(body.active_leaf_id, 'a4');
    assert.ok('active_turn_id' in body);
    assert.ok(body.compaction);
    assert.equal(body.compaction.id, 'c1');
    assert.equal(body.compaction.focus, 'test focus');
    assert.equal(body.compaction.tokens_before, 100);
    assert.equal(body.compaction.tokens_after, 50);
    assert.equal(body.compaction.pre_compact_leaf_id, 'u1');
    assert.equal(body.compaction.messages_compacted, 2);
    assert.deepEqual(body.compaction.tail_message_ids, []);
    assert.equal(body.compaction.count, 1);
    assert.ok(body.context_estimate);
    assert.ok(typeof body.context_estimate.tokens === 'number');
    // conversation has no model override -> agent model deepseek:deepseek-v4-flash
    assert.equal(body.context_estimate.limit, 1_000_000);
    assert.equal(body.context_estimate.suggest_compact, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

t('GET messages with no checkpoint -> compaction null, estimate still present', async () => {
  const conv2 = 'cv-conv-nocompact';
  newConversation(conv2);
  insertMsg({ id: 'n-u1', conv: conv2, role: 'user', content: 'hello', parent: null, turn: 'n-u1' });
  insertMsg({ id: 'n-a1', conv: conv2, role: 'assistant', content: 'hi', parent: 'n-u1', turn: 'n-u1' });
  setLeaf(conv2, 'n-a1');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as Record<string, unknown>).userId = userId;
    next();
  });
  app.use('/api/conversations', messagesRouter);
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const port = (server.address() as import('node:net').AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/conversations/${conv2}/messages`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { compaction: unknown; context_estimate: Record<string, unknown> };
    assert.equal(body.compaction, null);
    assert.ok(typeof body.context_estimate.tokens === 'number');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

await Promise.all(results);
if (failures > 0) {
  console.error(`${failures} test(s) FAILED`);
  process.exit(1);
}
console.log('compact-view: OK');
