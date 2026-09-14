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
    seedTwoTurns(conv);
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
      for (const k of ['compaction_id', 'conversation_id', 'tail_message_ids', 'tokens_before', 'tokens_after', 'pre_compact_leaf_id', 'model', 'focus']) {
        assert.ok(k in ended, `ended missing ${k}`);
      }
      assert.equal(ended.conversation_id, conv);
      assert.equal(ended.pre_compact_leaf_id, preLeaf);
      assert.equal(ended.focus, 'auth');
      assert.equal(ended.compaction_id, evts[0]!.data.compaction_id);
      assert.ok(Array.isArray(ended.tail_message_ids) && ended.tail_message_ids.length > 0);
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
      for (const k of ['v', 'model', 'provider', 'focus', 'keep_tokens', 'tokens_before', 'tokens_after', 'messages_compacted', 'tail_message_ids', 'pre_compact_leaf_id', 'supersedes', 'compacted_at']) {
        assert.ok(k in meta, `meta missing ${k}`);
      }
      assert.equal(meta.v, 1);
      assert.deepEqual(meta.tail_message_ids, ended.tail_message_ids);
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
    seedTwoTurns(conv);
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
    seedTwoTurns(conv);
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
    seedTwoTurns(conv);
    const counter = { n: 0 };
    setSummarizeFetchImplForTests(stubFetchOk(counter));
    const first = await call('POST', `/${conv}/compact`, { user: USER_A, body: { request_id: 'req-replay-1' } });
    assert.equal(first.status, 200);
    const firstEnded = parseSSE(first.text).at(-1)!.data;
    assert.equal(counter.n, 1);
    counter.n = 0;
    setSummarizeFetchImplForTests(stubFetchOk(counter));
    try {
      const second = await call('POST', `/${conv}/compact`, { user: USER_A, body: { request_id: 'req-replay-1' } });
      assert.equal(second.status, 200);
      const secondEnded = parseSSE(second.text).at(-1)!.data;
      assert.equal(secondEnded.compaction_id, firstEnded.compaction_id);
      assert.equal(counter.n, 0);
    } finally { setSummarizeFetchImplForTests(null); }
  });

  await test('fork copies summary+tail as fresh chain', async () => {
    const conv = newConv(USER_A, AGENT_A, 'Orig title');
    seedTwoTurns(conv);
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
    seedTwoTurns(conv);
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
    seedTwoTurns(conv);
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
    seedTwoTurns(conv);
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
    seedTwoTurns(conv);
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
    seedTwoTurns(conv);
    const counter = { n: 0 };
    setSummarizeFetchImplForTests(stubFetchOk(counter));
    let firstId = '';
    try {
      const r1 = await call('POST', `/${conv}/compact`, { user: USER_A, body: {} });
      firstId = parseSSE(r1.text).at(-1)!.data.compaction_id;
    } finally { setSummarizeFetchImplForTests(null); }
    // post-compact turn
    const leaf = (db.prepare('SELECT active_leaf_id FROM conversations WHERE id=?').get(conv) as any).active_leaf_id;
    const nu = `${conv}-s2-u`;
    const na = `${conv}-s2-a`;
    insertUser(conv, nu, 'follow-up question after first compact', leaf, nu);
    db.prepare('UPDATE conversations SET active_leaf_id=? WHERE id=?').run(nu, conv);
    insertAsst(conv, na, 'follow-up answer', nu, nu);
    db.prepare('UPDATE conversations SET active_leaf_id=? WHERE id=?').run(na, conv);
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

  await test('fork default title + same agent/model + 404 foreign', async () => {
    const conv = newConv(USER_A, AGENT_A, 'My chat');
    seedTwoTurns(conv);
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
