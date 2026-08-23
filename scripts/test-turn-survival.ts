import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path, { resolve } from 'node:path';

// MUST be set before importing db (db.ts resolves the path at import time).
const testDbPath = path.join(os.tmpdir(), `turn-survival-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = testDbPath;

const { default: db, migrate, ensureLocalUser } = await import('../server/db.js');
const {
  registerTurn,
  markTurnDisconnected,
  findTurnByConversation,
  abortTurn,
  clearTurn,
  abortAllTurns,
  setOrphanTimeoutForTests,
} = await import('../server/chatTurnRegistry.js');
import type { ActiveTurn } from '../server/chatTurnRegistry.js';

migrate();
const userId = ensureLocalUser();
assert.ok(userId, 'ensureLocalUser should return a user id');

const agentId = 'turn-survival-agent';
db.prepare(`
  INSERT INTO agents (id, name, description, emoji, system_prompt, base_url, model, temperature, max_tokens, provider, user_id)
  VALUES (?, 'Turn Survival', '', '🤖', 'sys', 'https://openrouter.ai/api/v1', 'openrouter/auto', 0.7, 4096, 'openrouter', ?)
`).run(agentId, userId);

let failures = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// --- fixtures ---
const newConversation = (id: string) => {
  db.prepare('INSERT INTO conversations (id, user_id, agent_id, title) VALUES (?, ?, ?, ?)').run(id, userId, agentId, 'Turn survival');
};

type AbortReason = 'stop' | 'orphan-timeout' | 'shutdown';
function recorder() {
  const reasons: AbortReason[] = [];
  return {
    reasons,
    onAbort: (reason: AbortReason) => {
      reasons.push(reason);
    },
  };
}

let turnSeq = 0;
function makeTurn(conversationId: string, onAbort: ActiveTurn['onAbort']): ActiveTurn {
  turnSeq += 1;
  return {
    turnId: `turn-${turnSeq}`,
    userId: 'user-1',
    conversationId,
    controller: new AbortController(),
    onAbort,
  };
}

// --- 1. Fresh temp DB -> both turn-tracking columns exist ---
await test('migrate() adds conversations.active_turn_id + messages.generation_status on a fresh DB', () => {
  const convCols = db.prepare('PRAGMA table_info(conversations)').all() as { name: string; type: string }[];
  const convActiveTurn = convCols.find((c) => c.name === 'active_turn_id');
  assert.ok(convActiveTurn, 'conversations.active_turn_id column missing after migrate()');
  assert.equal(convActiveTurn.type, 'TEXT');

  const msgCols = db.prepare('PRAGMA table_info(messages)').all() as { name: string; type: string }[];
  const msgGenerationStatus = msgCols.find((c) => c.name === 'generation_status');
  assert.ok(msgGenerationStatus, 'messages.generation_status column missing after migrate()');
  assert.equal(msgGenerationStatus.type, 'TEXT');

  // Re-running migrate() against the existing DB must stay a no-op (idempotent).
  assert.doesNotThrow(() => migrate());
});

// --- 2. Legacy-shaped rows are swept on re-migrate ---
await test('re-running migrate() sweeps legacy streaming rows to error and clears active_turn_id', () => {
  const convId = 'sweep-conv';
  newConversation(convId);

  // Seed pre-sweep leftovers by raw SQL: an interrupted 'streaming' draft,
  // rows whose terminal/NULL statuses must survive untouched, and a claimed
  // active_turn_id left behind by a dead process.
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, parent_id, turn_id, variant_seq, generation_status)
    VALUES ('sweep-draft', ?, 'assistant', 'partial answer', 'sweep-user', 't-sweep', 1, 'streaming')
  `).run(convId);
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, generation_status)
    VALUES ('sweep-complete', ?, 'assistant', 'done answer', 'complete')
  `).run(convId);
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content)
    VALUES ('sweep-legacy-null', ?, 'user', 'legacy question')
  `).run(convId);
  db.prepare('UPDATE conversations SET active_turn_id = ? WHERE id = ?').run('t-sweep', convId);

  // Sanity: seeds really are in their pre-sweep shape.
  const statusOf = (id: string) =>
    (db.prepare('SELECT generation_status FROM messages WHERE id = ?').get(id) as { generation_status: string | null }).generation_status;
  assert.equal(statusOf('sweep-draft'), 'streaming');
  assert.equal(statusOf('sweep-complete'), 'complete');
  assert.equal(statusOf('sweep-legacy-null'), null);

  migrate();

  assert.equal(statusOf('sweep-draft'), 'error', "leftover 'streaming' draft must be normalized to 'error'");
  assert.equal(statusOf('sweep-complete'), 'complete', 'terminal status must not be touched by the sweep');
  assert.equal(statusOf('sweep-legacy-null'), null, 'legacy NULL status must not be touched by the sweep');
  const streamingLeft = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE generation_status = 'streaming'").get() as { c: number };
  assert.equal(streamingLeft.c, 0, "no 'streaming' rows may survive migrate()");
  const claimed = db.prepare('SELECT active_turn_id FROM conversations WHERE id = ?').get(convId) as { active_turn_id: string | null };
  assert.equal(claimed.active_turn_id, null, 'non-NULL active_turn_id must be cleared by the sweep');
});

// --- 3a. Registry basics: register / find / abort / double-abort ---
await test('register/find/abort: onAbort(stop) fires once, double abort is single-fire', () => {
  const rec = recorder();
  const turn = makeTurn('reg-basic-conv', rec.onAbort);

  assert.equal(registerTurn(turn), true, 'first registration must succeed');
  assert.equal(registerTurn({ ...turn }), false, 'duplicate turnId registration must be rejected');

  const found = findTurnByConversation('reg-basic-conv');
  assert.equal(found?.turnId, turn.turnId, 'findTurnByConversation must return the registered turn');
  assert.equal(findTurnByConversation('reg-unknown-conv'), undefined);

  assert.equal(abortTurn(turn.turnId, 'stop'), true);
  assert.deepEqual(rec.reasons, ['stop'], 'onAbort must receive exactly reason stop');
  assert.equal(turn.controller.signal.aborted, true, 'abortTurn must abort the turn controller');

  assert.equal(abortTurn(turn.turnId, 'stop'), false, 'second abort must report not-found');
  assert.equal(abortTurn('missing-turn', 'stop'), false, 'aborting an unknown turn reports not-found');
  assert.deepEqual(rec.reasons, ['stop'], 'onAbort fired exactly once across double abort');
});

// --- 3b. clearTurn removes the turn and cancels its pending orphan timer ---
await test('clearTurn removes the turn and cancels a pending orphan timer', async () => {
  setOrphanTimeoutForTests(40);
  const rec = recorder();
  const turn = makeTurn('reg-clear-conv', rec.onAbort);

  assert.equal(registerTurn(turn), true);
  markTurnDisconnected(turn.turnId);
  clearTurn(turn.turnId);
  markTurnDisconnected('missing-turn'); // unknown ids are a silent no-op

  assert.equal(findTurnByConversation('reg-clear-conv'), undefined, 'clearTurn must remove the turn');
  await sleep(200);
  assert.deepEqual(rec.reasons, [], 'cancelled orphan timer must never fire onAbort');
  assert.equal(abortTurn(turn.turnId, 'orphan-timeout'), false, 'cleared turn is gone from the registry');
});

// --- 4. Orphan timer fires with 'orphan-timeout'; re-mark never double-schedules ---
await test('orphan timeout fires onAbort(orphan-timeout) once; marking twice does not double-schedule', async () => {
  setOrphanTimeoutForTests(30);
  const rec = recorder();
  const turn = makeTurn('reg-orphan-conv', rec.onAbort);

  assert.equal(registerTurn(turn), true);
  markTurnDisconnected(turn.turnId);
  markTurnDisconnected(turn.turnId); // re-mark cancels + reschedules, never duplicates

  await sleep(300);
  assert.deepEqual(rec.reasons, ['orphan-timeout'], 'exactly one orphan-timeout abort must fire');
  assert.equal(turn.controller.signal.aborted, true, 'orphan timeout aborts the turn controller');
  assert.equal(findTurnByConversation('reg-orphan-conv'), undefined, 'fired orphan timer detaches the turn');
});

// --- 5. abortAllTurns fires every onAbort('shutdown') exactly once ---
await test('abortAllTurns fires every registered onAbort(shutdown) exactly once', async () => {
  setOrphanTimeoutForTests(30);
  const recA = recorder();
  const recB = recorder();
  const recC = recorder();
  const turnA = makeTurn('shutdown-conv-a', recA.onAbort);
  const turnB = makeTurn('shutdown-conv-b', recB.onAbort);
  const turnC = makeTurn('shutdown-conv-c', recC.onAbort);

  assert.equal(registerTurn(turnA), true);
  assert.equal(registerTurn(turnB), true);
  assert.equal(registerTurn(turnC), true);
  markTurnDisconnected(turnC.turnId); // pending orphan timer must die with the shutdown abort

  abortAllTurns();

  assert.deepEqual(recA.reasons, ['shutdown']);
  assert.deepEqual(recB.reasons, ['shutdown']);
  assert.deepEqual(recC.reasons, ['shutdown']);
  assert.equal(turnA.controller.signal.aborted, true);
  assert.equal(turnB.controller.signal.aborted, true);
  assert.equal(turnC.controller.signal.aborted, true);
  assert.equal(findTurnByConversation('shutdown-conv-a'), undefined, 'registry is empty after abortAllTurns');
  assert.equal(abortTurn(turnA.turnId, 'stop'), false, 'aborted turns cannot be aborted again');

  await sleep(150);
  assert.deepEqual(recC.reasons, ['shutdown'], 'no late orphan-timeout may follow the shutdown abort');
});

// ---------------------------------------------------------------------------
// Part B (T6): draft lifecycle against the real schema, duplicate-row guard,
// boot-sweep idempotence mid-script, and source contracts on chat.ts.
// ---------------------------------------------------------------------------

console.log('--- Part B (T6): draft lifecycle + chat.ts source contracts ---');

const chatSource = readFileSync(resolve(process.cwd(), 'server/routes/chat.ts'), 'utf8');

function sourceRegion(startMarker: string, endMarker: string): string {
  const start = chatSource.indexOf(startMarker);
  assert.ok(start >= 0, `source anchor not found: ${startMarker}`);
  const end = chatSource.indexOf(endMarker, start);
  assert.ok(end > start, `end anchor not found after: ${startMarker}`);
  return chatSource.slice(start, end);
}

// Extract the production SQL so the simulated lifecycle below runs chat.ts's
// EXACT statements against the real migrated temp DB — not paraphrases that
// could silently drift from what the route actually executes.
const ensureBlock = sourceRegion('const ensureDraftRow', 'const flushDraft');
const flushBlock = sourceRegion('const flushDraft', 'const finalizeDraft');
const finalizeBlock = sourceRegion('const finalizeDraft', 'forceFlushOpenDraft = () =>');

const draftInsertSql = ensureBlock.match(/`(\s*INSERT INTO messages[\s\S]*?)`/)?.[1]?.trim();
assert.ok(draftInsertSql, 'ensureDraftRow INSERT statement not found in chat.ts source');

const flushUpdateSql = flushBlock.match(/'(UPDATE messages[^']*)'/)?.[1];
assert.ok(flushUpdateSql, 'flushDraft UPDATE statement not found in chat.ts source');

// finalizeDraft composes its SET clause at runtime from an array literal;
// mirror that composition using the exact entries present in the source's
// base literal (the conditional tool_calls/annotations pushes are handled
// separately below, exactly like the production code does).
const finalizeSetsLiteral = finalizeBlock.match(/const sets = \[([^\]]*)\]/)?.[1];
assert.ok(finalizeSetsLiteral, 'finalizeDraft sets array not found in chat.ts source');
const finalizeBaseSets = [...finalizeSetsLiteral.matchAll(/'([a-z_]+ = \?)'/g)].map((m) => m[1]);
assert.ok(
  finalizeBaseSets.includes('generation_status = ?') && finalizeBaseSets.includes('content = ?'),
  'finalizeDraft sets array must contain content and generation_status assignments',
);
assert.equal(finalizeBaseSets[finalizeBaseSets.length - 1], 'generation_status = ?', 'generation_status must be the last base SET entry');

interface DraftSimState {
  convId: string;
  turnId: string;
  variantSeq: number;
  chainTailStartId: string;
  model: string | null;
}

// Re-creation of the per-segment draft machinery from chat.ts (plan S2),
// executing the SQL extracted above. Only the closure state is replicated;
// every statement is byte-identical to production.
function createDraftSim(state: DraftSimState) {
  let segmentSeq = 0;
  let openDraftId: string | null = null;
  let chainTailId = state.chainTailStartId;
  let fullContent = '';
  let fullReasoning = '';
  let draftLastFlushAt = 0;
  let draftFlushedContent = '';
  let draftFlushedReasoning = '';

  const updateActiveLeaf = (msgId: string) => {
    db.prepare("UPDATE conversations SET active_leaf_id = ?, updated_at = datetime('now') WHERE id = ?").run(msgId, state.convId);
  };

  // Per-iteration reset (chat.ts loop top): new segment → new draft row.
  const resetForNewSegment = () => {
    openDraftId = null;
    fullContent = '';
    fullReasoning = '';
    draftLastFlushAt = 0;
    draftFlushedContent = '';
    draftFlushedReasoning = '';
  };

  const ensureDraftRow = (): string => {
    if (openDraftId) return openDraftId;
    segmentSeq += 1;
    const draftId = `${state.convId}-draft-${segmentSeq}`;
    db.prepare(draftInsertSql!).run(
      draftId,
      state.convId,
      null,          // provider_routing
      0, 0, 0, 0,    // tokens_used, prompt_tokens, completion_tokens, cost
      0, 0,          // reasoning_tokens, cached_tokens
      state.model,   // model
      null,          // processed_by_agent_id
      chainTailId,
      state.turnId,
      state.variantSeq,
    );
    openDraftId = draftId;
    chainTailId = draftId;
    updateActiveLeaf(draftId);
    return draftId;
  };

  const flushDraft = (force = false): void => {
    if (!openDraftId) return;
    if (fullContent === draftFlushedContent && fullReasoning === draftFlushedReasoning) return;
    // GC8 throttle: ≥1000 ms since previous write unless forced.
    if (!force && Date.now() - draftLastFlushAt < 1000) return;
    db.prepare(flushUpdateSql!).run(fullContent || '', fullReasoning || null, openDraftId);
    draftLastFlushAt = Date.now();
    draftFlushedContent = fullContent;
    draftFlushedReasoning = fullReasoning;
  };

  type FinalizeStatus = 'complete' | 'error' | 'stopped';
  const finalizeDraft = (status: FinalizeStatus, opts?: { toolCallsJson?: string | null; anns?: unknown[] }): void => {
    const toolCallsJson = opts?.toolCallsJson ?? null;
    // TR3-01 guard, verbatim semantics: no open draft and nothing warranting a
    // row ⇒ deliberate no-op (degenerate empty codex result persists nothing).
    if (!openDraftId && !toolCallsJson) return;
    const draftId = openDraftId ?? ensureDraftRow();
    const sets = [...finalizeBaseSets];
    const vals: Array<string | number | null> = [
      fullContent || '',
      fullReasoning || null,
      state.model,
      0, 0, 0, 0, 0, 0,
      status,
    ];
    if (toolCallsJson !== null) {
      sets.push('tool_calls = ?');
      vals.push(toolCallsJson);
    }
    if (opts?.anns !== undefined) {
      sets.push('annotations = ?');
      vals.push(opts.anns.length > 0 ? JSON.stringify(opts.anns) : null);
    }
    vals.push(draftId);
    db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  };

  return {
    ensureDraftRow,
    flushDraft,
    finalizeDraft,
    resetForNewSegment,
    appendDelta(chunk: string) {
      fullContent += chunk;
      ensureDraftRow();
      flushDraft();
    },
    get openDraftId() {
      return openDraftId;
    },
  };
}

const countAssistantRows = (convId: string) =>
  (db.prepare("SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ? AND role = 'assistant'").get(convId) as { c: number }).c;

const getRow = (id: string) =>
  db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as
    | (Record<string, unknown> & { generation_status: string | null; parent_id: string | null; turn_id: string | null; variant_seq: number; content: string; reasoning_content: string | null; tool_calls: string | null })
    | undefined;

const insertUserRow = (convId: string, userId2: string, msgId: string) => {
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, attachments, parent_id, turn_id, variant_seq, model)
    VALUES (?, ?, 'user', ?, NULL, NULL, ?, 1, NULL)
  `).run(msgId, convId, `question for ${convId}`, msgId);
  db.prepare("UPDATE conversations SET active_leaf_id = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(msgId, convId, userId2);
};

const toolCallsFixture = JSON.stringify([
  { id: 'call_t6_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"turn survival"}' } },
]);

// --- B1. Draft lifecycle vs real schema: complete + tool_calls ---
await test('B1: streaming draft → throttled flushes → finalize complete+tool_calls leaves exactly one correct row', async () => {
  const convId = 'b-complete-conv';
  newConversation(convId);
  insertUserRow(convId, userId, 'b-user-1');

  const sim = createDraftSim({ convId, turnId: 'b-user-1', variantSeq: 1, chainTailStartId: 'b-user-1', model: 'openrouter/auto' });

  // First delta lazily creates the draft row with generation_status='streaming'.
  sim.appendDelta('Hel');
  const draftId = sim.openDraftId!;
  const draft = getRow(draftId);
  assert.ok(draft, 'draft row must exist after first delta');
  assert.equal(draft.generation_status, 'streaming', "fresh draft must be 'streaming'");
  assert.equal(draft.content, 'Hel');
  assert.equal(draft.parent_id, 'b-user-1', 'draft chains to the user row');
  assert.equal(draft.turn_id, 'b-user-1');
  assert.equal(draft.variant_seq, 1);

  // Second delta within the 1000 ms window is throttled (GC8): unchanged row.
  sim.appendDelta('lo, wor');
  assert.equal(getRow(draftId)!.content, 'Hel', 'second immediate flush must be throttled');

  // Throttle window elapses → next flush writes the accumulated text.
  await sleep(1100);
  sim.appendDelta('ld.');
  assert.equal(getRow(draftId)!.content, 'Hello, world.', 'post-window flush must persist accumulated content');

  // Segment end: terminal write carries final content + tool_calls.
  sim.finalizeDraft('complete', { toolCallsJson: toolCallsFixture });

  assert.equal(countAssistantRows(convId), 1, 'exactly one assistant row for the segment');
  const finalRow = getRow(draftId)!;
  assert.equal(finalRow.generation_status, 'complete');
  assert.deepEqual(JSON.parse(finalRow.tool_calls!), JSON.parse(toolCallsFixture));
  assert.equal(finalRow.parent_id, 'b-user-1', 'parent chain to user row intact after finalize');
  const leaf = (db.prepare('SELECT active_leaf_id FROM conversations WHERE id = ?').get(convId) as { active_leaf_id: string }).active_leaf_id;
  assert.equal(leaf, draftId, 'active leaf points at the finalized draft');
});

// --- B1 (repeat). Terminal 'stopped' and 'error' lifecycles ---
await test("B1b: same lifecycle finalizes 'stopped' and 'error' rows correctly", async () => {
  for (const status of ['stopped', 'error'] as const) {
    const convId = `b-${status}-conv`;
    newConversation(convId);
    insertUserRow(convId, userId, `b-user-${status}`);
    const sim = createDraftSim({ convId, turnId: `b-user-${status}`, variantSeq: 1, chainTailStartId: `b-user-${status}`, model: null });
    sim.appendDelta(`partial text (${status})`);
    await sleep(1100); // let the second flush through the throttle window
    sim.appendDelta(' + more');
    sim.finalizeDraft(status);
    assert.equal(countAssistantRows(convId), 1, `${status}: exactly one assistant row`);
    const row = getRow(sim.openDraftId!)!;
    assert.equal(row.generation_status, status, `row finalized '${status}'`);
    assert.equal(row.tool_calls, null, `${status}: no tool_calls on plain text segment`);
    assert.equal(row.parent_id, `b-user-${status}`, `${status}: parent chain intact`);
  }
});

// --- B2. Duplicate-row guard (+ TR3-03 stop-during-tools flip) ---
await test('B2: repeated finalize never duplicates rows; stop-after-milestone flips complete→stopped (TR3-03)', () => {
  const convId = 'b-dup-guard-conv';
  newConversation(convId);
  insertUserRow(convId, userId, 'b-user-dup');
  const sim = createDraftSim({ convId, turnId: 'b-user-dup', variantSeq: 1, chainTailStartId: 'b-user-dup', model: 'm' });

  sim.appendDelta('pre-tool text');
  // Milestone shape (chat.ts): ensure + finalize('complete', {toolCallsJson}).
  sim.finalizeDraft('complete', { toolCallsJson: toolCallsFixture });
  assert.equal(countAssistantRows(convId), 1, 'one row after milestone finalize');

  // Stop/orphan arrives DURING tool execution: the outer-catch hook re-finalizes
  // the still-open draft. TR3-03 expects the SAME row flipped to 'stopped'.
  sim.finalizeDraft('stopped');
  assert.equal(countAssistantRows(convId), 1, 'repeated finalize must NOT duplicate the row');
  assert.equal(getRow(sim.openDraftId!)!.generation_status, 'stopped', "milestone-finalized row flips to 'stopped'");

  sim.finalizeDraft('stopped'); // idempotent under repetition
  assert.equal(countAssistantRows(convId), 1);
});

await test('B2b: degenerate empty codex result persists NO assistant row (TR3-01); tool-calls-only result keeps the legacy empty row', () => {
  // New deliberate behavior: zero deltas + zero tool calls ⇒ finalize no-op ⇒ 0 rows.
  const emptyConvId = 'b-codex-empty-conv';
  newConversation(emptyConvId);
  insertUserRow(emptyConvId, userId, 'b-user-empty');
  const emptySim = createDraftSim({ convId: emptyConvId, turnId: 'b-user-empty', variantSeq: 1, chainTailStartId: 'b-user-empty', model: null });
  emptySim.resetForNewSegment();
  emptySim.finalizeDraft('complete'); // no draft opened, no toolCallsJson
  assert.equal(countAssistantRows(emptyConvId), 0, 'fully-empty codex result must persist no assistant row (baseline inserted an empty one)');

  // Tool calls without streamed text: create-then-finalize preserves today's
  // empty-content assistant-with-tool_calls row exactly (GC3).
  const toolsConvId = 'b-codex-toolsonly-conv';
  newConversation(toolsConvId);
  insertUserRow(toolsConvId, userId, 'b-user-toolsonly');
  const toolsSim = createDraftSim({ convId: toolsConvId, turnId: 'b-user-toolsonly', variantSeq: 1, chainTailStartId: 'b-user-toolsonly', model: null });
  toolsSim.resetForNewSegment();
  toolsSim.finalizeDraft('complete', { toolCallsJson: toolCallsFixture });
  assert.equal(countAssistantRows(toolsConvId), 1, 'create-if-missing fires exactly once when tool_calls warrant a row');
  const row = db.prepare(`SELECT content, generation_status, tool_calls FROM messages WHERE conversation_id = ? AND role = 'assistant'`).get(toolsConvId) as { content: string; generation_status: string; tool_calls: string };
  assert.equal(row.content, '', 'legacy shape: empty content');
  assert.equal(row.generation_status, 'complete');
  assert.deepEqual(JSON.parse(row.tool_calls!), JSON.parse(toolCallsFixture));
});

// --- B4. Boot-sweep idempotence re-check mid-script ---
await test('B4: boot sweep normalizes freshly seeded stale rows, stays idempotent across repeated migrate(), spares terminal rows', () => {
  const convId = 'b-sweep-conv';
  newConversation(convId);
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, parent_id, turn_id, variant_seq, generation_status)
    VALUES ('b-sweep-stale', ?, 'assistant', 'orphaned partial', 'b-sweep-user', 't-b-sweep', 1, 'streaming')
  `).run(convId);
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, generation_status)
    VALUES ('b-sweep-terminal', ?, 'assistant', 'finished answer', 'complete')
  `).run(convId);
  db.prepare('UPDATE conversations SET active_turn_id = ? WHERE id = ?').run('t-b-sweep', convId);

  migrate(); // first sweep pass
  assert.equal(getRow('b-sweep-stale')!.generation_status, 'error', "stale 'streaming' swept to 'error'");
  assert.equal(getRow('b-sweep-terminal')!.generation_status, 'complete', 'terminal row untouched by sweep');
  let claim = (db.prepare('SELECT active_turn_id FROM conversations WHERE id = ?').get(convId) as { active_turn_id: string | null }).active_turn_id;
  assert.equal(claim, null, 'claimed active_turn_id cleared');

  migrate(); // idempotence: second sweep pass is a clean no-op
  assert.equal(getRow('b-sweep-stale')!.generation_status, 'error');
  assert.equal(getRow('b-sweep-terminal')!.generation_status, 'complete');
  claim = (db.prepare('SELECT active_turn_id FROM conversations WHERE id = ?').get(convId) as { active_turn_id: string | null }).active_turn_id;
  assert.equal(claim, null);

  const streamingLeft = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE generation_status = 'streaming'").get() as { c: number };
  assert.equal(streamingLeft.c, 0, "no 'streaming' rows may survive anywhere after sweep");
  assert.doesNotThrow(() => migrate(), 'third migrate() stays throw-free (idempotent)');
});

// --- B3. Source contracts on server/routes/chat.ts (regex style of
// scripts/test-tool-call-budget.ts). Strings below are copied verbatim from
// the current code (brief constraint: never paraphrase into the regexes). ---
await test('B3: close handler flags + marks disconnected + force-flushes; NEVER aborts or cancels (GC4)', () => {
  const closeRegion = sourceRegion("res.on('close'", '\n  try {');
  assert.doesNotMatch(closeRegion, /abortController\.abort\(\)/, 'close handler must not abort upstream');
  assert.doesNotMatch(closeRegion, /\.cancel\(\)/, 'close handler must not cancel the reader');
  assert.doesNotMatch(closeRegion, /upstreamReader/, 'upstreamReader mechanism must stay deleted');
  assert.match(closeRegion, /clientDisconnected = true;/);
  assert.match(closeRegion, /markTurnDisconnected\(userMsgId\);/, 'disconnect must start the orphan timer');
  assert.match(closeRegion, /forceFlushOpenDraft\?\.\(\);/, 'disconnect must force-flush the open draft');
  // GC4 file-wide: streams are read to completion; the only abort sites left
  // are the two legitimate 120s fetch-timeout closures.
  assert.doesNotMatch(chatSource, /clientDisconnected\) break/, 'read-loop disconnect breaks must stay removed');
  const abortSites = chatSource.match(/abortController\.abort\(\)/g) ?? [];
  assert.equal(abortSites.length, 2, 'exactly the two fetch-timeout abort closures may remain');
});

await test('B3: atomic claim + exact 409 message (GC7)', () => {
  assert.match(chatSource, /UPDATE conversations SET active_turn_id = \? WHERE id = \? AND user_id = \? AND active_turn_id IS NULL/);
  assert.match(chatSource, /claim\.changes === 0/);
  assert.match(chatSource, /A response is already being generated in this conversation/);
});

await test('B3: draft helper set + lazy streaming INSERT + GC8 throttle present', () => {
  assert.match(chatSource, /const ensureDraftRow = \(\): string => \{/);
  assert.match(chatSource, /const flushDraft = \(force = false\): void => \{/);
  assert.match(chatSource, /const finalizeDraft = \(/);
  assert.match(chatSource, /status: 'complete' \| 'error' \| 'stopped'/);
  assert.match(ensureBlock, /INSERT INTO messages \(id, conversation_id, role, content, provider_routing/);
  assert.match(ensureBlock, /VALUES \(\?, \?, 'assistant', '', [^)]*'streaming'\)/, "lazy INSERT must land as empty-content 'streaming' assistant row");
  assert.match(chatSource, /DRAFT_FLUSH_INTERVAL_MS = 1000;/);
  assert.match(chatSource, /if \(fullContent === draftFlushedContent && fullReasoning === draftFlushedReasoning\) return;/);
  assert.match(flushBlock, /'UPDATE messages SET content = \?, reasoning_content = \? WHERE id = \?'/);
  // Per-iteration reset so each while(true) segment gets its own draft (GC3).
  assert.match(chatSource, /openDraftId = null;\s*\n\s*draftLastFlushAt = 0;/);
});

await test('B3: explicit Stop route with uniform owner-scoped 404 (GC6/GC10)', () => {
  assert.match(chatSource, /router\.post\('\/stop'/);
  assert.match(chatSource, /error: 'Turn not found'/);
  assert.match(chatSource, /abortTurn\(turn\.turnId, 'stop'\)/);
  assert.match(chatSource, /turn\.userId !== userId/, 'foreign users must hit the same uniform 404');
});

await test('B3: authorizeMcpCall region has no clientDisconnected deny (GC9/S7)', () => {
  const mcpRegion = sourceRegion('const authorizeMcpCall', '\n    };');
  assert.doesNotMatch(mcpRegion, /clientDisconnected/, 'disconnect-based deny must be gone from authorizeMcpCall');
  assert.match(mcpRegion, /if \(res\.writableEnded\) return;/, 'emit skips silently when nobody is listening');
});

await test('B3: every-exit finalize near outer catch + guarded finally release (GC5)', () => {
  const catchRegion = sourceRegion('} catch (err: unknown) {', '} finally {');
  assert.match(catchRegion, /finalizeOpenDraftHook\?\.\(terminalStatusForCurrentAbort\(\)\)/, 'AbortError exit finalizes by mapped reason');
  assert.match(catchRegion, /finalizeOpenDraftHook\?\.\('error'\);/, 'unexpected exception finalizes error');
  // TR3-03 reason mapping: stop/orphan-timeout → 'stopped'.
  assert.match(chatSource, /abortReason === 'stop' \|\| abortReason === 'orphan-timeout' \? 'stopped' : 'error'/);
  const finallyRegion = sourceRegion('} finally {', '// Close MCP connections');
  assert.match(finallyRegion, /clearTurn\(userMsgId\);/);
  assert.match(finallyRegion, /UPDATE conversations SET active_turn_id = NULL WHERE id = \? AND active_turn_id = \?/, 'release only matches our own turnId');
});

await test('B3: TR3-01/TR3-03 anchors — codex authoritative overwrite + degenerate-empty guard', () => {
  assert.match(chatSource, /if \(!openDraftId && !toolCallsJson\) return;/, 'degenerate-empty guard (TR3-01)');
  assert.match(chatSource, /finalizeDraft\('complete', \{ toolCallsJson, anns: \[\] \}\);/, 'codex authoritative overwrite site');
});

if (failures > 0) {
  console.error(`${failures} turn-survival test(s) failed`);
  process.exitCode = 1;
} else {
  console.log('turn survival tests passed');
}

