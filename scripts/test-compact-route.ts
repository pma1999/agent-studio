import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const testDbPath = path.join(os.tmpdir(), `compact-route-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = testDbPath;
process.env.JWT_SECRET = 'test-secret';

const express = (await import('express')).default;
const { default: db, migrate } = await import('../server/db.js');
const compactRouter = (await import('../server/routes/compact.js')).default;
const { setSummarizeFetchImplForTests } = await import('../server/compaction/summarize.js');
const { SUMMARY_PREFIX } = await import('../server/compaction/prompt.js');

migrate();

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return (async () => {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (err) {
      failures++;
      console.error(`FAIL ${name}: ${err instanceof Error ? err.message + '\n' + (err.stack ?? '') : String(err)}`);
    }
  })();
}

function fakeAuth(req: any, _res: any, next: () => void): void {
  const user = req.headers['x-test-user'];
  if (typeof user === 'string' && user) req.userId = user;
  next();
}

const app = express();
app.use(express.json());
app.use('/api/conversations', fakeAuth as never, compactRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((r) => server.once('listening', r));
const addr = server.address();
if (!addr || typeof addr === 'string') throw new Error('no listen address');
const base = `http://127.0.0.1:${(addr as any).port}/api/conversations`;

async function call(method: string, url: string, opts: { user?: string; body?: unknown } = {}): Promise<{ status: number; json: any; text: string; contentType: string; headers: Headers }> {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.user ? { 'x-test-user': opts.user } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* SSE */ }
  return { status: res.status, json, text, contentType: res.headers.get('content-type') ?? '', headers: res.headers };
}

function parseSSE(text: string): Array<{ event: string; data: any; raw: string }> {
  const out: Array<{ event: string; data: any; raw: string }> = [];
  for (const chunk of text.split('\n\n')) {
    const t = chunk.trim();
    if (!t) continue;
    const lines = t.split('\n');
    let event = '';
    let dataStr = '';
    for (const l of lines) {
      if (l.startsWith('event:')) event = l.slice(6).trim();
      else if (l.startsWith('data:')) dataStr += (dataStr ? '\n' : '') + l.slice(5).trim();
    }
    if (!event && !dataStr) continue;
    // Support data-only form {type:...}
    let data: any = null;
    try { data = JSON.parse(dataStr); } catch { data = dataStr; }
    if (!event && data && typeof data.type === 'string') event = data.type;
    out.push({ event, data, raw: chunk });
  }
  return out;
}

const USER_A = 'compact-user-a';
const USER_B = 'compact-user-b';
db.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, 'a@test', 'x')").run(USER_A);
db.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, 'b@test', 'x')").run(USER_B);
const AGENT_A = 'compact-agent-a';
db.prepare(`INSERT INTO agents (id, name, description, emoji, system_prompt, base_url, model, temperature, max_tokens, provider, user_id) VALUES (?, 'A', '', 'x', 'You are a test assistant.', 'https://openrouter.ai/api/v1', 'openrouter/auto', 0.7, 4096, 'openrouter', ?)`).run(AGENT_A, USER_A);
function setKey(userId: string, key: string, value: string) {
  db.prepare('INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value=excluded.value').run(userId, key, value);
}
setKey(USER_A, 'openrouter_api_key', 'dummy-key');

/** Local mirror of the frozen G5 estimator (server module is ESM-imported above). */
const estimateTokensLocal = (t: string): number => Math.ceil(t.length / 4);

const VALID_SUMMARY = [
  '## Objective', '- goal', '## Important Details', '- d', '## Work State',
  '### Completed', '- c', '### Active', '- a', '### Blocked', '- (none)',
  '## Next Move', '1. next', '## Relevant Files', '- (none)', '## Session Facts', '- f',
].join('\n');

function stubFetchOk(counter: { n: number }, summary: string = VALID_SUMMARY) {
  return (async (_url: any, _init: any) => {
    counter.n++;
    return new Response(JSON.stringify({ choices: [{ message: { content: summary } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

let seq = 0;
function newConv(userId: string, agentId: string | null, title = 'T'): string {
  seq++;
  const id = `conv-${seq}-${Date.now()}`;
  db.prepare('INSERT INTO conversations (id, user_id, agent_id, title, model) VALUES (?, ?, ?, ?, ?)').run(id, userId, agentId, title, 'openrouter/auto');
  return id;
}
function insertUser(convId: string, id: string, content: string, parent: string | null, turnId: string) {
  db.prepare(`INSERT INTO messages (id, conversation_id, role, content, parent_id, turn_id, variant_seq) VALUES (?, ?, 'user', ?, ?, ?, 1)`).run(id, convId, content, parent, turnId);
}
function insertAsst(convId: string, id: string, content: string, parent: string, turnId: string) {
  db.prepare(`INSERT INTO messages (id, conversation_id, role, content, parent_id, turn_id, variant_seq) VALUES (?, ?, 'assistant', ?, ?, ?, 1)`).run(id, convId, content, parent, turnId);
}
function setLeaf(convId: string, leaf: string | null) {
  db.prepare('UPDATE conversations SET active_leaf_id=? WHERE id=?').run(leaf, convId);
}
function seedTwoTurns(convId: string) {
  insertUser(convId, `${convId}-u1`, 'hello world, this is a longer user message for tokens', null, `${convId}-u1`);
  insertAsst(convId, `${convId}-a1`, 'reply one', `${convId}-u1`, `${convId}-u1`);
  insertUser(convId, `${convId}-u2`, 'second question about auth bug', `${convId}-a1`, `${convId}-u2`);
  insertAsst(convId, `${convId}-a2`, 'second reply', `${convId}-u2`, `${convId}-u2`);
  setLeaf(convId, `${convId}-a2`);
}
function seedGenuineTurns(convId: string) {
  // Four large turns (~2.5k tokens each, ceil(chars/4)). Since a checkpoint
  // archives the WHOLE visible slice, size no longer decides whether a compact
  // is vacuous (any slice with a user turn archives) — these fixtures stay big
  // only to keep the token assertions meaningful.
  const big = (marker: string) => `${marker} ` + 'x'.repeat(5000) + ` ${marker}-tail`;
  let parent: string | null = null;
  ['GEN-A', 'GEN-B', 'GEN-C', 'GEN-D'].forEach((m, i) => {
    const u = `${convId}-g${i}u`;
    const a = `${convId}-g${i}a`;
    insertUser(convId, u, big(m), parent, u);
    insertAsst(convId, a, big(`${m}-A`), u, u);
    parent = a;
  });
  setLeaf(convId, parent);
}

try {
  await test('401 without user', async () => {
    const r = await call('POST', '/nope/compact', { body: {} });
    assert.equal(r.status, 401);
  });

  await test('404 foreign id uniform', async () => {
    const conv = newConv(USER_A, AGENT_A);
    seedTwoTurns(conv);
    const r = await call('POST', `/${conv}/compact`, { user: USER_B, body: {} });
    assert.equal(r.status, 404);
  });

  await test('400 nothing_to_compact on empty conversation', async () => {
    const conv = newConv(USER_A, AGENT_A);
    setLeaf(conv, null);
    const counter = { n: 0 };
    setSummarizeFetchImplForTests(stubFetchOk(counter));
    try {
      const r = await call('POST', `/${conv}/compact`, { user: USER_A, body: {} });
      assert.equal(r.status, 400);
      assert.equal(r.json?.code, 'nothing_to_compact');
      assert.equal(counter.n, 0);
    } finally { setSummarizeFetchImplForTests(null); }
  });

  await test('tiny thread archives the WHOLE slice (last turn + its answer included)', async () => {
    const conv = newConv(USER_A, AGENT_A);
    seedTwoTurns(conv);
    const preLeaf = (db.prepare('SELECT active_leaf_id FROM conversations WHERE id=?').get(conv) as any).active_leaf_id;
    const counter = { n: 0 };
    const prompts: string[] = [];
    const capture = (async (_u: any, init: any) => {
      counter.n++;
      try {
        const body = JSON.parse(String((init as any)?.body ?? '{}'));
        const um = Array.isArray(body?.messages) ? body.messages.find((m: any) => m?.role === 'user') : null;
        if (um?.content) prompts.push(String(um.content));
      } catch { /* ignore */ }
      return new Response(JSON.stringify({ choices: [{ message: { content: VALID_SUMMARY } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    setSummarizeFetchImplForTests(capture);
    try {
      const r = await call('POST', `/${conv}/compact`, { user: USER_A, body: {} });
      assert.equal(r.status, 200);
      const ended = parseSSE(r.text).at(-1)!.data;
      assert.equal(parseSSE(r.text).at(-1)!.event, 'compaction.ended');
      assert.equal(counter.n, 1);
      // All four rows archived, nothing kept verbatim.
      assert.equal(ended.messages_compacted, 4);
      assert.deepEqual(ended.tail_message_ids, []);
      const meta = JSON.parse((db.prepare('SELECT compaction_meta FROM messages WHERE id=?').get(ended.compaction_id) as any).compaction_meta);
      assert.deepEqual(meta.archived_message_ids, [`${conv}-u1`, `${conv}-a1`, `${conv}-u2`, `${conv}-a2`]);
      assert.equal(meta.keep_tokens, 0);
      // The LAST user turn and its answer are in the summarized head.
      const prompt = prompts.at(-1) ?? '';
      assert.ok(prompt.includes('second question about auth bug'), 'last user message must be summarized');
      assert.ok(prompt.includes('second reply'), 'last assistant answer must be summarized');
      // Checkpoint lands at the END of the thread (card renders where it happened).
      const row = db.prepare('SELECT parent_id FROM messages WHERE id=?').get(ended.compaction_id) as any;
      assert.equal(row.parent_id, preLeaf);
      assert.equal((db.prepare('SELECT active_leaf_id FROM conversations WHERE id=?').get(conv) as any).active_leaf_id, ended.compaction_id);
    } finally { setSummarizeFetchImplForTests(null); }
  });

  await test('400 nothing_to_compact with no new turn after a checkpoint (prior checkpoint, leaf and count untouched)', async () => {
    const conv = newConv(USER_A, AGENT_A);
    seedGenuineTurns(conv);
    const counter = { n: 0 };
    setSummarizeFetchImplForTests(stubFetchOk(counter));
    let firstId = '';
    try {
      const r1 = await call('POST', `/${conv}/compact`, { user: USER_A, body: {} });
      assert.equal(r1.status, 200);
      assert.equal(parseSSE(r1.text).at(-1)!.event, 'compaction.ended');
      firstId = parseSSE(r1.text).at(-1)!.data.compaction_id;
    } finally { setSummarizeFetchImplForTests(null); }
    // Compacting again with nothing new: no user turn since the checkpoint.
    const c2 = { n: 0 };
    setSummarizeFetchImplForTests(stubFetchOk(c2));
    try {
      const r2 = await call('POST', `/${conv}/compact`, { user: USER_A, body: {} });
      assert.equal(r2.status, 400);
      assert.equal(r2.json?.code, 'nothing_to_compact');
      assert.equal(r2.json?.error, 'Nothing new to compact — no messages since the last checkpoint.');
      assert.equal(c2.n, 0);
      const compactions = (db.prepare(`SELECT id FROM messages WHERE conversation_id=? AND role='compaction'`).all(conv) as any[]);
      assert.equal(compactions.length, 1);
      assert.equal(compactions[0]!.id, firstId);
      assert.equal((db.prepare('SELECT active_leaf_id FROM conversations WHERE id=?').get(conv) as any).active_leaf_id, firstId);
    } finally { setSummarizeFetchImplForTests(null); }
    // A single tiny follow-up turn IS archivable now (no keep budget).
    insertUser(conv, `${conv}-t-u`, 'tiny follow-up', firstId, `${conv}-t-u`);
    insertAsst(conv, `${conv}-t-a`, 'tiny answer', `${conv}-t-u`, `${conv}-t-u`);
    db.prepare('UPDATE conversations SET active_leaf_id=? WHERE id=?').run(`${conv}-t-a`, conv);
    const c3 = { n: 0 };
    setSummarizeFetchImplForTests(stubFetchOk(c3));
    try {
      const r3 = await call('POST', `/${conv}/compact`, { user: USER_A, body: {} });
      assert.equal(r3.status, 200);
      const e3 = parseSSE(r3.text).at(-1)!.data;
      assert.equal(parseSSE(r3.text).at(-1)!.event, 'compaction.ended');
      assert.equal(e3.messages_compacted, 2);
      assert.deepEqual(e3.tail_message_ids, []);
      const m3 = JSON.parse((db.prepare('SELECT compaction_meta FROM messages WHERE id=?').get(e3.compaction_id) as any).compaction_meta);
      assert.deepEqual(m3.archived_message_ids, [`${conv}-t-u`, `${conv}-t-a`]);
      assert.equal(m3.supersedes, firstId);
    } finally { setSummarizeFetchImplForTests(null); }
  });

  await test('409 turn_live when active_turn_id preset', async () => {
    const conv = newConv(USER_A, AGENT_A);
    seedTwoTurns(conv);
    db.prepare('UPDATE conversations SET active_turn_id=? WHERE id=?').run('live-turn', conv);
    const counter = { n: 0 };
    setSummarizeFetchImplForTests(stubFetchOk(counter));
    try {
      const r = await call('POST', `/${conv}/compact`, { user: USER_A, body: {} });
      assert.equal(r.status, 409);
      assert.equal(r.json?.code, 'turn_live');
      assert.equal(counter.n, 0);
    } finally {
      setSummarizeFetchImplForTests(null);
      db.prepare('UPDATE conversations SET active_turn_id=NULL WHERE id=?').run(conv);
    }
  });

  await test('SSE started->ended order + DB persist shape', async () => {
    const conv = newConv(USER_A, AGENT_A, 'Orig title');
    db.prepare('UPDATE conversations SET codex_thread_id=? WHERE id=?').run('thread-123', conv);
    seedGenuineTurns(conv);
    const preLeaf = (db.prepare('SELECT active_leaf_id FROM conversations WHERE id=?').get(conv) as any).active_leaf_id;
    const counter = { n: 0 };
    setSummarizeFetchImplForTests(stubFetchOk(counter));
    try {
      const r = await call('POST', `/${conv}/compact`, { user: USER_A, body: { focus: 'auth' } });
      assert.equal(r.status, 200);
      assert.match(r.contentType, /text\/event-stream/);
      assert.equal(r.headers.get('cache-control'), 'no-cache');
      assert.match(r.headers.get('connection') ?? '', /keep-alive/i);
      assert.equal(r.headers.get('x-accel-buffering'), 'no');
      const evts = parseSSE(r.text);
      assert.ok(evts.length >= 2, `expected >=2 SSE events, got ${JSON.stringify(evts)}`);
      assert.equal(evts[0]!.event, 'compaction.started');
      assert.equal(evts[evts.length - 1]!.event, 'compaction.ended');
      assert.ok(evts[0]!.data.compaction_id);
      assert.equal(evts[0]!.data.conversation_id, conv);
      const ended = evts[evts.length - 1]!.data;
      for (const k of ['compaction_id', 'conversation_id', 'tail_message_ids', 'tokens_before', 'tokens_after', 'messages_compacted', 'pre_compact_leaf_id', 'model', 'focus']) {
        assert.ok(k in ended, `ended missing ${k}`);
      }
      assert.equal(ended.conversation_id, conv);
      assert.equal(ended.pre_compact_leaf_id, preLeaf);
      assert.equal(ended.focus, 'auth');
      assert.equal(ended.compaction_id, evts[0]!.data.compaction_id);
      // No verbatim tail survives a checkpoint any more.
      assert.deepEqual(ended.tail_message_ids, []);
      assert.equal(typeof ended.messages_compacted, 'number');
      assert.ok(Number.isFinite(ended.messages_compacted));
      assert.ok(ended.messages_compacted > 0, 'compact must archive something (vacuous compacts are 400)');
      assert.equal(counter.n, 1);
      // DB asserts
      const row = db.prepare('SELECT * FROM messages WHERE id=?').get(ended.compaction_id) as any;
      assert.ok(row, 'compaction row exists');
      assert.equal(row.role, 'compaction');
      assert.ok(String(row.content).startsWith(SUMMARY_PREFIX));
      assert.equal(row.parent_id, preLeaf);
      assert.equal(row.turn_id, ended.compaction_id);
      assert.equal(row.variant_seq, 1);
      const meta = JSON.parse(row.compaction_meta);
      for (const k of ['v', 'model', 'provider', 'focus', 'keep_tokens', 'tokens_before', 'tokens_after', 'messages_compacted', 'tail_message_ids', 'archived_message_ids', 'pre_compact_leaf_id', 'supersedes', 'compacted_at']) {
        assert.ok(k in meta, `meta missing ${k}`);
      }
      assert.equal(meta.v, 1);
      assert.deepEqual(meta.tail_message_ids, ended.tail_message_ids);
      assert.equal(meta.keep_tokens, 0);
      // Codex-style retention: the checkpoint records how many user messages
      // the chat builder replays verbatim after it, and tokens_after counts
      // them (the summary alone would under-report the next turn's cost).
      assert.equal(typeof meta.retained_user_messages, 'number');
      assert.ok(meta.retained_user_messages > 0, 'user turns must be retained for replay');
      assert.ok(meta.tokens_after > estimateTokensLocal(SUMMARY_PREFIX + 'x'), 'tokens_after must include the retained messages');
      // Whole visible slice archived: every non-checkpoint row of the thread.
      assert.equal(meta.archived_message_ids.length, ended.messages_compacted);
      assert.equal(ended.messages_compacted, meta.messages_compacted);
      assert.equal(meta.pre_compact_leaf_id, preLeaf);
      assert.equal(meta.supersedes, null);
      const convRow = db.prepare('SELECT active_leaf_id, codex_thread_id, active_turn_id FROM conversations WHERE id=?').get(conv) as any;
      assert.equal(convRow.active_leaf_id, ended.compaction_id);
      assert.equal(convRow.codex_thread_id, null);
      assert.equal(convRow.active_turn_id, null);
    } finally { setSummarizeFetchImplForTests(null); }
  });

  await test('failure stub leaves history untouched', async () => {
    const conv = newConv(USER_A, AGENT_A);
    seedGenuineTurns(conv);
    const preLeaf = (db.prepare('SELECT active_leaf_id FROM conversations WHERE id=?').get(conv) as any).active_leaf_id;
    const beforeCount = (db.prepare('SELECT COUNT(*) as c FROM messages WHERE conversation_id=?').get(conv) as any).c;
    const failFetch = (async () => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    setSummarizeFetchImplForTests(failFetch);
    try {
      const r = await call('POST', `/${conv}/compact`, { user: USER_A, body: {} });
      assert.equal(r.status, 200);
      const evts = parseSSE(r.text);
      assert.equal(evts[0]!.event, 'compaction.started');
      assert.equal(evts[evts.length - 1]!.event, 'compaction.failed');
      assert.ok(evts[evts.length - 1]!.data.code);
      const afterCount = (db.prepare('SELECT COUNT(*) as c FROM messages WHERE conversation_id=?').get(conv) as any).c;
      assert.equal(afterCount, beforeCount);
      const leaf = (db.prepare('SELECT active_leaf_id, active_turn_id FROM conversations WHERE id=?').get(conv) as any);
      assert.equal(leaf.active_leaf_id, preLeaf);
      assert.equal(leaf.active_turn_id, null);
    } finally { setSummarizeFetchImplForTests(null); }
  });

  await test('same request_id in-flight coalesces to one execution', async () => {
    const conv = newConv(USER_A, AGENT_A);
    seedGenuineTurns(conv);
    const counter = { n: 0 };
    const slow = (async (_u: any, _i: any) => {
      counter.n++;
      await new Promise((r) => setTimeout(r, 400));
      return new Response(JSON.stringify({ choices: [{ message: { content: VALID_SUMMARY } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    setSummarizeFetchImplForTests(slow);
    try {
      const p1 = call('POST', `/${conv}/compact`, { user: USER_A, body: { request_id: 'req-coal-1' } });
      await new Promise((r) => setTimeout(r, 80));
      const p2 = await call('POST', `/${conv}/compact`, { user: USER_A, body: { request_id: 'req-coal-1' } });
      const r1 = await p1;
      assert.equal(r1.status, 200);
      assert.equal(p2.status, 200);
      const e1 = parseSSE(r1.text).at(-1)!.data;
      const e2 = parseSSE(p2.text).at(-1)!.data;
      assert.equal(e1.compaction_id, e2.compaction_id);
      assert.equal(counter.n, 1);
    } finally { setSummarizeFetchImplForTests(null); }
  });

  await test('completed request_id replays without LLM', async () => {
    const conv = newConv(USER_A, AGENT_A);
    seedGenuineTurns(conv);
    const counter = { n: 0 };
    setSummarizeFetchImplForTests(stubFetchOk(counter));
    const first = await call('POST', `/${conv}/compact`, { user: USER_A, body: { request_id: 'req-replay-1' } });
    assert.equal(first.status, 200);
    const firstEnded = parseSSE(first.text).at(-1)!.data;
    assert.equal(parseSSE(first.text).at(-1)!.event, 'compaction.ended');
    assert.ok('messages_compacted' in firstEnded, 'fresh ended missing messages_compacted');
    assert.equal(counter.n, 1);
    counter.n = 0;
    setSummarizeFetchImplForTests(stubFetchOk(counter));
    try {
      const second = await call('POST', `/${conv}/compact`, { user: USER_A, body: { request_id: 'req-replay-1' } });
      assert.equal(second.status, 200);
      const secondEnded = parseSSE(second.text).at(-1)!.data;
      assert.equal(secondEnded.compaction_id, firstEnded.compaction_id);
      assert.ok('messages_compacted' in secondEnded, 'replay ended missing messages_compacted');
      assert.equal(secondEnded.messages_compacted, firstEnded.messages_compacted);
      assert.equal(counter.n, 0);
    } finally { setSummarizeFetchImplForTests(null); }
  });

  await test('fork copies summary+tail as fresh chain', async () => {
    const conv = newConv(USER_A, AGENT_A, 'Orig title');
    seedGenuineTurns(conv);
    // need a checkpoint first
    const counter = { n: 0 };
    setSummarizeFetchImplForTests(stubFetchOk(counter));
    let compactionId: string;
    try {
      const r = await call('POST', `/${conv}/compact`, { user: USER_A, body: {} });
      compactionId = parseSSE(r.text).at(-1)!.data.compaction_id;
    } finally { setSummarizeFetchImplForTests(null); }
    // add a post-compact turn so tail is non-trivial
    const leafNow = (db.prepare('SELECT active_leaf_id FROM conversations WHERE id=?').get(conv) as any).active_leaf_id;
    const pu = `${conv}-post-u`;
    const pa = `${conv}-post-a`;
    insertUser(conv, pu, 'post compact q', leafNow, pu);
    db.prepare('UPDATE conversations SET active_leaf_id=? WHERE id=?').run(pu, conv);
    insertAsst(conv, pa, 'post compact a', pu, pu);
    db.prepare('UPDATE conversations SET active_leaf_id=? WHERE id=?').run(pa, conv);

    const fr = await call('POST', `/${conv}/fork`, { user: USER_A, body: { label: 'Branch 1' } });
    assert.equal(fr.status, 201);
    assert.equal(fr.json?.title, 'Branch 1');
    const newId = fr.json?.id;
    assert.ok(newId && newId !== conv);
    assert.equal(fr.json?.user_id ?? USER_A, USER_A);
    const rows = db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY rowid ASC').all(newId) as any[];
    assert.ok(rows.length >= 2);
    // fresh ids
    const origIds = new Set((db.prepare('SELECT id FROM messages WHERE conversation_id=?').all(conv) as any[]).map((r) => r.id));
    for (const r of rows) assert.ok(!origIds.has(r.id), 'fork ids must be fresh');
    // first fork row is compaction copy with meta copied
    assert.equal(rows[0]!.role, 'compaction');
    assert.ok(JSON.parse(rows[0]!.compaction_meta));
    assert.equal(rows[0]!.turn_id, rows[0]!.id);
    // parent chain
    assert.equal(rows[0]!.parent_id, null);
    for (let i = 1; i < rows.length; i++) assert.equal(rows[i]!.parent_id, rows[i - 1]!.id);
    // generation_status NOT copied
    for (const r of rows) assert.equal(r.generation_status, null);
    const forkConv = db.prepare('SELECT active_leaf_id FROM conversations WHERE id=?').get(newId) as any;
    assert.equal(forkConv.active_leaf_id, rows[rows.length - 1]!.id);
    // original compaction still there
    assert.ok((db.prepare('SELECT id FROM messages WHERE id=?').get(compactionId) as any));
  });

  await test('fork nothing_to_fork pre-compact', async () => {
    const conv = newConv(USER_A, AGENT_A);
    seedTwoTurns(conv);
    const r = await call('POST', `/${conv}/fork`, { user: USER_A, body: {} });
    assert.equal(r.status, 400);
    assert.equal(r.json?.code, 'nothing_to_fork');
  });

  await test('409 compact_in_progress for different request while one runs', async () => {
    const conv = newConv(USER_A, AGENT_A);
    seedGenuineTurns(conv);
    const slow = (async () => {
      await new Promise((r) => setTimeout(r, 500));
      return new Response(JSON.stringify({ choices: [{ message: { content: VALID_SUMMARY } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    setSummarizeFetchImplForTests(slow);
    try {
      const p1 = call('POST', `/${conv}/compact`, { user: USER_A, body: { request_id: 'req-A' } });
      await new Promise((r) => setTimeout(r, 80));
      const r2 = await call('POST', `/${conv}/compact`, { user: USER_A, body: { request_id: 'req-B' } });
      assert.equal(r2.status, 409);
      assert.equal(r2.json?.code, 'compact_in_progress');
      const r1 = await p1;
      assert.equal(r1.status, 200);
    } finally { setSummarizeFetchImplForTests(null); }
  });

  await test('409 turn_live via registry hit', async () => {
    const conv = newConv(USER_A, AGENT_A);
    seedTwoTurns(conv);
    const { registerTurn, clearTurn } = await import('../server/chatTurnRegistry.js');
    const ctrl = new AbortController();
    registerTurn({ turnId: 'ext-live', userId: USER_A, conversationId: conv, controller: ctrl, onAbort: () => {} });
    try {
      const counter = { n: 0 };
      setSummarizeFetchImplForTests(stubFetchOk(counter));
      try {
        const r = await call('POST', `/${conv}/compact`, { user: USER_A, body: {} });
        assert.equal(r.status, 409);
        assert.equal(r.json?.code, 'turn_live');
        assert.equal(counter.n, 0);
      } finally { setSummarizeFetchImplForTests(null); }
    } finally { clearTurn('ext-live'); }
  });

  await test('template_invalid after two bad summaries leaves history untouched', async () => {
    const conv = newConv(USER_A, AGENT_A);
    seedGenuineTurns(conv);
    const preLeaf = (db.prepare('SELECT active_leaf_id FROM conversations WHERE id=?').get(conv) as any).active_leaf_id;
    const before = (db.prepare('SELECT COUNT(*) as c FROM messages WHERE conversation_id=?').get(conv) as any).c;
    const counter = { n: 0 };
    const bad = (async () => {
      counter.n++;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'no headings here' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    setSummarizeFetchImplForTests(bad);
    try {
      const r = await call('POST', `/${conv}/compact`, { user: USER_A, body: {} });
      assert.equal(r.status, 200);
      const evts = parseSSE(r.text);
      assert.equal(evts.at(-1)!.event, 'compaction.failed');
      assert.equal(evts.at(-1)!.data.code, 'template_invalid');
      assert.equal(counter.n, 2);
      assert.equal((db.prepare('SELECT COUNT(*) as c FROM messages WHERE conversation_id=?').get(conv) as any).c, before);
      assert.equal((db.prepare('SELECT active_leaf_id FROM conversations WHERE id=?').get(conv) as any).active_leaf_id, preLeaf);
    } finally { setSummarizeFetchImplForTests(null); }
  });

  await test('re-ask success: first invalid then valid persists', async () => {
    const conv = newConv(USER_A, AGENT_A);
    seedGenuineTurns(conv);
    const counter = { n: 0 };
    const seq = (async () => {
      counter.n++;
      const content = counter.n === 1 ? 'junk' : VALID_SUMMARY;
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    setSummarizeFetchImplForTests(seq);
    try {
      const r = await call('POST', `/${conv}/compact`, { user: USER_A, body: {} });
      assert.equal(r.status, 200);
      assert.equal(parseSSE(r.text).at(-1)!.event, 'compaction.ended');
      assert.equal(counter.n, 2);
    } finally { setSummarizeFetchImplForTests(null); }
  });

  await test('context-exceeded halves head and retries once', async () => {
    const conv = newConv(USER_A, AGENT_A);
    seedGenuineTurns(conv);
    const counter = { n: 0 };
    const flaky = (async () => {
      counter.n++;
      if (counter.n === 1) {
        return new Response(JSON.stringify({ error: { message: 'maximum context length exceeded' } }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: VALID_SUMMARY } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    setSummarizeFetchImplForTests(flaky);
    try {
      const r = await call('POST', `/${conv}/compact`, { user: USER_A, body: {} });
      assert.equal(r.status, 200);
      assert.equal(parseSSE(r.text).at(-1)!.event, 'compaction.ended');
      assert.equal(counter.n, 2);
    } finally { setSummarizeFetchImplForTests(null); }
  });

  await test('second compaction supersedes first', async () => {
    const conv = newConv(USER_A, AGENT_A);
    seedGenuineTurns(conv);
    const counter = { n: 0 };
    setSummarizeFetchImplForTests(stubFetchOk(counter));
    let firstId = '';
    try {
      const r1 = await call('POST', `/${conv}/compact`, { user: USER_A, body: {} });
      firstId = parseSSE(r1.text).at(-1)!.data.compaction_id;
    } finally { setSummarizeFetchImplForTests(null); }
    // post-compact turns: FOUR large turns (~10k tokens). One would be enough
    // now (the whole slice is archived), but the bigger fixture also exercises
    // the token math.
    const leaf = (db.prepare('SELECT active_leaf_id FROM conversations WHERE id=?').get(conv) as any).active_leaf_id;
    const big2 = (marker: string) => `${marker} ` + 'x'.repeat(5000) + ` ${marker}-tail`;
    let parent2: string | null = leaf;
    ['FOLLOW-A', 'FOLLOW-B', 'FOLLOW-C', 'FOLLOW-D'].forEach((m, i) => {
      const u = `${conv}-s2-u${i}`;
      const a = `${conv}-s2-a${i}`;
      insertUser(conv, u, big2(m), parent2, u);
      insertAsst(conv, a, big2(`${m}-A`), u, u);
      parent2 = a;
    });
    db.prepare('UPDATE conversations SET active_leaf_id=? WHERE id=?').run(parent2, conv);
    const c2 = { n: 0 };
    setSummarizeFetchImplForTests(stubFetchOk(c2));
    try {
      const r2 = await call('POST', `/${conv}/compact`, { user: USER_A, body: {} });
      const ended = parseSSE(r2.text).at(-1)!.data;
      assert.equal(parseSSE(r2.text).at(-1)!.event, 'compaction.ended');
      const row = db.prepare('SELECT compaction_meta FROM messages WHERE id=?').get(ended.compaction_id) as any;
      assert.equal(JSON.parse(row.compaction_meta).supersedes, firstId);
    } finally { setSummarizeFetchImplForTests(null); }
  });

  await test('Undo + new turn + compact re-archives what the Undo made live again', async () => {
    // Undo moves the leaf before a checkpoint, so that checkpoint is OFF the
    // thread: its summary is no longer injected and the rows it had archived
    // are live in the model view again. The next compact must therefore
    // re-summarize them — skipping them (the old cross-branch exclusion) drops
    // their content from the model view entirely.
    const conv = newConv(USER_A, AGENT_A);
    const big = (marker: string) => `${marker} ` + 'x'.repeat(5000) + ` ${marker}-tail`;
    const prompts: string[] = [];
    const capture = (async (_u: any, init: any) => {
      try {
        const body = JSON.parse(String((init as any)?.body ?? '{}'));
        const msgs = (body as any)?.messages;
        const um = Array.isArray(msgs) ? msgs.find((m: any) => m?.role === 'user') : null;
        if (um?.content) prompts.push(String(um.content));
      } catch { /* ignore */ }
      return new Response(JSON.stringify({ choices: [{ message: { content: VALID_SUMMARY } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    // PRE epoch: 2 large turns
    insertUser(conv, `${conv}-p1u`, big('QUINOA-ALPHA'), null, `${conv}-p1u`);
    insertAsst(conv, `${conv}-p1a`, big('QUINOA-ALPHA-A'), `${conv}-p1u`, `${conv}-p1u`);
    insertUser(conv, `${conv}-p2u`, big('TUNGSTEN-BETA'), `${conv}-p1a`, `${conv}-p2u`);
    insertAsst(conv, `${conv}-p2a`, big('TUNGSTEN-BETA-A'), `${conv}-p2u`, `${conv}-p2u`);
    setLeaf(conv, `${conv}-p2a`);
    setSummarizeFetchImplForTests(capture);
    let c1id = '';
    try {
      const r1 = await call('POST', `/${conv}/compact`, { user: USER_A, body: {} });
      const e1 = parseSSE(r1.text).at(-1)!.data;
      assert.equal(parseSSE(r1.text).at(-1)!.event, 'compaction.ended');
      assert.equal(e1.messages_compacted, 4);
      assert.deepEqual(e1.tail_message_ids, []);
      c1id = e1.compaction_id;
      const m1 = JSON.parse((db.prepare('SELECT compaction_meta FROM messages WHERE id=?').get(c1id) as any).compaction_meta);
      assert.deepEqual(m1.archived_message_ids, [`${conv}-p1u`, `${conv}-p1a`, `${conv}-p2u`, `${conv}-p2a`]);
      assert.ok((prompts.at(-1) ?? '').includes('TUNGSTEN-BETA'), 'head#1 must include the newest turn');
    } finally { setSummarizeFetchImplForTests(null); }
    // POST epoch: 2 large turns on top of comp#1
    const leaf1 = (db.prepare('SELECT active_leaf_id FROM conversations WHERE id=?').get(conv) as any).active_leaf_id;
    assert.equal(leaf1, c1id);
    insertUser(conv, `${conv}-q1u`, big('OBSIDIAN-GAMMA'), leaf1, `${conv}-q1u`);
    insertAsst(conv, `${conv}-q1a`, big('OBSIDIAN-GAMMA-A'), `${conv}-q1u`, `${conv}-q1u`);
    insertUser(conv, `${conv}-q2u`, big('VANADIUM-DELTA'), `${conv}-q1a`, `${conv}-q2u`);
    insertAsst(conv, `${conv}-q2a`, big('VANADIUM-DELTA-A'), `${conv}-q2u`, `${conv}-q2u`);
    db.prepare('UPDATE conversations SET active_leaf_id=? WHERE id=?').run(`${conv}-q2a`, conv);
    prompts.length = 0;
    setSummarizeFetchImplForTests(capture);
    let c2id = '';
    let pre2 = '';
    try {
      const r2 = await call('POST', `/${conv}/compact`, { user: USER_A, body: {} });
      const e2 = parseSSE(r2.text).at(-1)!.data;
      assert.equal(e2.messages_compacted, 4);
      assert.deepEqual(e2.tail_message_ids, []);
      c2id = e2.compaction_id;
      pre2 = e2.pre_compact_leaf_id;
      assert.equal(pre2, `${conv}-q2a`);
      const m2 = JSON.parse((db.prepare('SELECT compaction_meta FROM messages WHERE id=?').get(c2id) as any).compaction_meta);
      assert.deepEqual(m2.archived_message_ids, [`${conv}-q1u`, `${conv}-q1a`, `${conv}-q2u`, `${conv}-q2a`]);
      assert.equal(m2.supersedes, c1id);
      // Head#2 starts AFTER checkpoint#1; #1's own summary travels as prior.
      const p2 = prompts.at(-1) ?? '';
      assert.ok(p2.includes('OBSIDIAN-GAMMA') && p2.includes('VANADIUM-DELTA'), 'head#2 is its own epoch');
      assert.ok(!p2.includes('QUINOA-ALPHA'), 'head#2 must not re-read rows already behind checkpoint#1');
    } finally { setSummarizeFetchImplForTests(null); }
    // Undo to pre#2 (checkpoint#2 abandoned) + one new large turn (R1)
    db.prepare('UPDATE conversations SET active_leaf_id=? WHERE id=?').run(pre2, conv);
    insertUser(conv, `${conv}-r1u`, big('RADON-EPSILON'), pre2, `${conv}-r1u`);
    insertAsst(conv, `${conv}-r1a`, big('RADON-EPSILON-A'), `${conv}-r1u`, `${conv}-r1u`);
    db.prepare('UPDATE conversations SET active_leaf_id=? WHERE id=?').run(`${conv}-r1a`, conv);
    prompts.length = 0;
    setSummarizeFetchImplForTests(capture);
    try {
      const r3 = await call('POST', `/${conv}/compact`, { user: USER_A, body: {} });
      assert.equal(r3.status, 200, `Undo must not brick compaction: ${r3.text.slice(0, 200)}`);
      const e3 = parseSSE(r3.text).at(-1)!.data;
      assert.equal(parseSSE(r3.text).at(-1)!.event, 'compaction.ended');
      // Slice = everything after checkpoint#1 on THIS branch: q1, q2 (live
      // again after the Undo) + r1.
      assert.equal(e3.messages_compacted, 6);
      const m3 = JSON.parse((db.prepare('SELECT compaction_meta FROM messages WHERE id=?').get(e3.compaction_id) as any).compaction_meta);
      assert.deepEqual(m3.archived_message_ids, [
        `${conv}-q1u`, `${conv}-q1a`, `${conv}-q2u`, `${conv}-q2a`, `${conv}-r1u`, `${conv}-r1a`,
      ]);
      // Supersedes the ON-THREAD checkpoint (#1), not the abandoned #2.
      assert.equal(m3.supersedes, c1id);
      const p3 = prompts.at(-1) ?? '';
      assert.ok(p3.includes('OBSIDIAN-GAMMA'), 'rows the Undo made live again must be re-summarized');
      assert.ok(p3.includes('RADON-EPSILON'), 'summary#3 must cover the newest turn');
      assert.ok(!p3.includes('QUINOA-ALPHA'), 'rows behind checkpoint#1 stay behind it');
      void c2id;
    } finally { setSummarizeFetchImplForTests(null); }
  });

  await test('fork default title + same agent/model + 404 foreign', async () => {
    const conv = newConv(USER_A, AGENT_A, 'My chat');
    seedGenuineTurns(conv);
    const counter = { n: 0 };
    setSummarizeFetchImplForTests(stubFetchOk(counter));
    try { await call('POST', `/${conv}/compact`, { user: USER_A, body: {} }); }
    finally { setSummarizeFetchImplForTests(null); }
    const fr = await call('POST', `/${conv}/fork`, { user: USER_A, body: {} });
    assert.equal(fr.status, 201);
    assert.equal(fr.json?.title, 'My chat (branch)');
    assert.equal(fr.json?.agent_id, AGENT_A);
    assert.equal(fr.json?.model, 'openrouter/auto');
    const foreign = await call('POST', `/${conv}/fork`, { user: USER_B, body: {} });
    assert.equal(foreign.status, 404);
  });

  await test('request_id invalid rejected 400', async () => {
    const conv = newConv(USER_A, AGENT_A);
    seedTwoTurns(conv);
    const r = await call('POST', `/${conv}/compact`, { user: USER_A, body: { request_id: 'bad id!' } });
    assert.equal(r.status, 400);
  });

  await test('keep_tokens invalid rejected 400', async () => {
    const conv = newConv(USER_A, AGENT_A);
    seedTwoTurns(conv);
    const r = await call('POST', `/${conv}/compact`, { user: USER_A, body: { keep_tokens: 'lots' } });
    assert.equal(r.status, 400);
  });
} finally {
  server.close();
  setSummarizeFetchImplForTests(null);
  try { fs.rmSync(testDbPath, { force: true }); } catch {}
  try { fs.rmSync(testDbPath + '-wal', { force: true }); } catch {}
  try { fs.rmSync(testDbPath + '-shm', { force: true }); } catch {}
}

if (failures > 0) {
  console.error(`${failures} compact-route test(s) failed`);
  process.exit(1);
} else {
  console.log('compact-route: OK');
}
