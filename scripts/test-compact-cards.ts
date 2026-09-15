/**
 * Compaction card placement (client util) — compact-indicator.
 *
 * Covers the two UI regressions this suite exists for:
 *  1. a checkpoint renders AT the point it happened (bottom of the thread right
 *     after compacting), never above the last turns;
 *  2. every checkpoint of the thread keeps its own card — a newer compaction
 *     never replaces the older cards.
 */
import assert from 'node:assert/strict';

import {
  placeCheckpoints,
  readCompactionMeta,
  checkpointSummaryText,
  SUMMARY_PREFIX_LOCAL,
} from '../src/utils/compactCards.js';
import type { Message } from '../src/types/index.js';

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

let seq = 0;
function msg(role: Message['role'], id?: string, extra: Partial<Message> = {}): Message {
  seq++;
  return {
    id: id ?? `${role}-${seq}`,
    conversation_id: 'c1',
    role,
    content: '',
    created_at: '2026-01-01T00:00:00.000Z',
    ...extra,
  } as Message;
}

const displayIds = (thread: Message[]) =>
  thread.filter((m) => m.role !== 'tool' && m.role !== 'compaction').map((m) => m.id);

test('no checkpoint -> nothing placed', () => {
  const thread = [msg('user', 'u1'), msg('assistant', 'a1')];
  const p = placeCheckpoints(thread);
  assert.equal(p.before.size, 0);
  assert.deepEqual(p.trailing, []);
});

test('fresh compaction renders at the BOTTOM, after the last turn', () => {
  // The exact reported bug: checkpoint created after "hazlo tu" / "si" must not
  // render above them.
  const thread = [
    msg('user', 'u1'), msg('assistant', 'a1'),
    msg('user', 'hazlo-tu'), msg('assistant', 'a2'),
    msg('user', 'si'), msg('assistant', 'a3'),
    msg('compaction', 'c1'),
  ];
  const p = placeCheckpoints(thread);
  assert.equal(p.before.size, 0, 'nothing may be anchored above a displayed row');
  assert.deepEqual(p.trailing.map((m) => m.id), ['c1']);
  assert.deepEqual(displayIds(thread), ['u1', 'a1', 'hazlo-tu', 'a2', 'si', 'a3']);
});

test('checkpoint followed by new turns renders above the first of them', () => {
  const thread = [
    msg('user', 'u1'), msg('assistant', 'a1'),
    msg('compaction', 'c1'),
    msg('user', 'u2'), msg('assistant', 'a2'),
  ];
  const p = placeCheckpoints(thread);
  assert.deepEqual([...p.before.keys()], [2]);
  assert.deepEqual(p.before.get(2)!.map((m) => m.id), ['c1']);
  assert.deepEqual(p.trailing, []);
  // Index 2 of the displayed rows is `u2` — the card sits right above it.
  assert.equal(displayIds(thread)[2], 'u2');
});

test('several checkpoints coexist, each at its own position', () => {
  const thread = [
    msg('user', 'u1'), msg('assistant', 'a1'),
    msg('compaction', 'c1'),
    msg('user', 'u2'), msg('assistant', 'a2'),
    msg('compaction', 'c2'),
    msg('user', 'u3'), msg('assistant', 'a3'),
    msg('compaction', 'c3'),
  ];
  const p = placeCheckpoints(thread);
  assert.deepEqual([...p.before.keys()].sort((x, y) => x - y), [2, 4]);
  assert.deepEqual(p.before.get(2)!.map((m) => m.id), ['c1']);
  assert.deepEqual(p.before.get(4)!.map((m) => m.id), ['c2']);
  assert.deepEqual(p.trailing.map((m) => m.id), ['c3']);
  const placed = [...p.before.values()].flat().length + p.trailing.length;
  assert.equal(placed, 3, 'every checkpoint on the thread must render');
});

test('tool rows never consume an index (they render in the activity timeline)', () => {
  const thread = [
    msg('user', 'u1'),
    msg('assistant', 'a1'),
    msg('tool', 't1'),
    msg('compaction', 'c1'),
    msg('user', 'u2'),
  ];
  const p = placeCheckpoints(thread);
  assert.deepEqual([...p.before.keys()], [2]);
  assert.equal(displayIds(thread)[2], 'u2');
});

test('back-to-back checkpoints stack in thread order at the same slot', () => {
  const thread = [
    msg('user', 'u1'),
    msg('compaction', 'c1'),
    msg('compaction', 'c2'),
    msg('user', 'u2'),
  ];
  const p = placeCheckpoints(thread);
  assert.deepEqual(p.before.get(1)!.map((m) => m.id), ['c1', 'c2']);
});

test('checkpoint-only thread renders its card', () => {
  const p = placeCheckpoints([msg('compaction', 'c1')]);
  assert.equal(p.before.size, 0);
  assert.deepEqual(p.trailing.map((m) => m.id), ['c1']);
});

test('readCompactionMeta parses the raw TEXT column and fails soft', () => {
  assert.deepEqual(readCompactionMeta('{"tokens_before":12369,"keep_tokens":0}'), {
    tokens_before: 12369,
    keep_tokens: 0,
  });
  assert.deepEqual(readCompactionMeta({ tokens_after: 5239 }), { tokens_after: 5239 });
  assert.deepEqual(readCompactionMeta('not json'), {});
  assert.deepEqual(readCompactionMeta('[1,2]'), {});
  assert.deepEqual(readCompactionMeta(null), {});
  assert.deepEqual(readCompactionMeta(undefined), {});
  assert.deepEqual(readCompactionMeta(''), {});
});

test('checkpointSummaryText strips the model-facing prefix', () => {
  assert.equal(checkpointSummaryText(`${SUMMARY_PREFIX_LOCAL}## Objective`), '## Objective');
  assert.equal(checkpointSummaryText('## Objective'), '## Objective');
  assert.equal(checkpointSummaryText(''), null);
  assert.equal(checkpointSummaryText(null), null);
});

if (failures > 0) {
  console.error(`${failures} compact-cards test(s) failed`);
  process.exit(1);
} else {
  console.log('compact-cards: OK');
}
