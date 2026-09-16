/**
 * Codex-style user-message retention (compact-retain).
 *
 * Pins the port of `openai/codex@main` `codex-rs/core/src/compact.rs`
 * `build_compacted_history_with_limit()`: newest→oldest walk under a 20 000
 * token budget, the message that does not fit is MIDDLE-truncated to the
 * remainder and ends the walk, result is chronological, only user messages are
 * eligible, and a stored summary is never re-collected.
 */
import assert from 'node:assert/strict';

import {
  RETAINED_USER_MAX_TOKENS,
  retentionBudgetFor,
  selectRetainedUserMessages,
  truncateMiddleToTokens,
} from '../server/compaction/retain.js';
import { SUMMARY_PREFIX } from '../server/compaction/prompt.js';
import { estimateTokens } from '../server/compaction/serialize.js';

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

const u = (content: string) => ({ role: 'user', content });
const a = (content: string) => ({ role: 'assistant', content });
const t = (content: string) => ({ role: 'tool', content });
const c = (content: string) => ({ role: 'compaction', content });
const texts = (rows: { content: string }[]) => rows.map((r) => r.content);

test('budget constant matches Codex COMPACT_USER_MESSAGE_MAX_TOKENS', () => {
  assert.equal(RETAINED_USER_MAX_TOKENS, 20_000);
});

test('only user messages are eligible', () => {
  const out = selectRetainedUserMessages([u('one'), a('assistant prose'), t('tool output'), u('two')]);
  assert.deepEqual(texts(out), ['one', 'two']);
});

test('result is chronological (newest walk is reversed back)', () => {
  const out = selectRetainedUserMessages([u('first'), u('second'), u('third')]);
  assert.deepEqual(texts(out), ['first', 'second', 'third']);
});

test('a stored checkpoint is never re-collected', () => {
  const out = selectRetainedUserMessages([
    u('real ask'),
    { role: 'user', content: `${SUMMARY_PREFIX}## Objective\n- something` },
    c('checkpoint row'),
    u('later ask'),
  ]);
  assert.deepEqual(texts(out), ['real ask', 'later ask']);
});

test('blank and non-string content is skipped', () => {
  const out = selectRetainedUserMessages([
    u('   '),
    { role: 'user', content: null },
    { role: 'user', content: 42 },
    u('kept'),
  ]);
  assert.deepEqual(texts(out), ['kept']);
});

test('array content keeps its text parts only', () => {
  const out = selectRetainedUserMessages([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'file', file: { filename: 'a.pdf' } },
      ],
    },
  ]);
  assert.deepEqual(texts(out), ['look at this']);
});

test('budget drops the OLDEST messages, keeps the newest', () => {
  // 1000 tokens each (4000 chars); budget fits exactly two.
  const msg = (mark: string) => mark.repeat(4000);
  const out = selectRetainedUserMessages([u(msg('a')), u(msg('b')), u(msg('c'))], 2000);
  assert.equal(out.length, 2);
  assert.deepEqual(texts(out), [msg('b'), msg('c')]);
});

test('the message that does not fit is middle-truncated, then the walk stops', () => {
  const newest = 'n'.repeat(4000); // 1000 tokens
  const older = 'o'.repeat(8000); // 2000 tokens, only 500 left
  const oldest = 'x'.repeat(400);
  const out = selectRetainedUserMessages([u(oldest), u(older), u(newest)], 1500);
  assert.equal(out.length, 2, 'the walk stops right after the partial message');
  assert.equal(out[1]!.content, newest, 'newest survives whole');
  const partial = out[0]!.content;
  assert.ok(partial.includes('tokens truncated…'), `expected a truncation marker, got ${partial.slice(0, 40)}`);
  assert.ok(partial.startsWith('o'), 'keeps the beginning');
  assert.ok(partial.endsWith('o'), 'keeps the end');
  assert.ok(!texts(out).includes(oldest), 'nothing older is collected after the cut');
});

test('zero budget retains nothing', () => {
  assert.deepEqual(selectRetainedUserMessages([u('anything')], 0), []);
});

test('default budget keeps a normal conversation whole', () => {
  const rows = Array.from({ length: 40 }, (_, i) => u(`question number ${i}`));
  const out = selectRetainedUserMessages(rows);
  assert.equal(out.length, 40);
});

// --- truncateMiddleToTokens (Codex truncate_middle_with_token_budget) ---

test('middle truncation keeps both ends and reports removed tokens', () => {
  const text = 'A'.repeat(100) + 'B'.repeat(100);
  const out = truncateMiddleToTokens(text, 10); // 40 chars budget
  assert.ok(out.startsWith('A'.repeat(20)), 'left half kept');
  assert.ok(out.endsWith('B'.repeat(20)), 'right half kept');
  assert.equal(out.includes(`…${Math.ceil((200 - 40) / 4)} tokens truncated…`), true);
});

test('text within budget is returned untouched', () => {
  const text = 'short enough';
  assert.equal(truncateMiddleToTokens(text, 1000), text);
});

test('zero-token budget yields the marker alone', () => {
  const out = truncateMiddleToTokens('x'.repeat(40), 0);
  assert.equal(out, '…10 tokens truncated…');
});

test('surrogate pairs are never split', () => {
  const emoji = '👨‍👩‍👧‍👦';
  const text = emoji.repeat(50);
  const out = truncateMiddleToTokens(text, 10);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out), 'lone high surrogate found');
  assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out), 'lone low surrogate found');
});

test('retained selection stays within budget + one truncation marker', () => {
  // Codex quirk, faithfully inherited: the `…N tokens truncated…` marker is
  // appended on top of the budget (its left+right slices already spend it), so
  // the ceiling is budget + marker, not budget.
  const MARKER_ALLOWANCE = estimateTokens('…999999 tokens truncated…');
  const rows = Array.from({ length: 50 }, (_, i) => u(`${i}`.repeat(1200)));
  const budget = 5000;
  const out = selectRetainedUserMessages(rows, budget);
  const total = out.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  assert.ok(total <= budget + MARKER_ALLOWANCE, `retained ${total} tokens over a ${budget} budget`);
  assert.ok(total > budget - 1200, `retained only ${total} tokens — budget under-used`);
});

// --- retentionBudgetFor: compaction can never grow the view ---

test('a thread dominated by long user pastes cannot invert the compaction', () => {
  // 10k + 5k tokens of pasted user text: under a flat 20 000 budget everything
  // would be replayed and `summary + retained` would exceed the archived view.
  const rows = [
    u('P'.repeat(40000)),
    a('ok'),
    u('Q'.repeat(20000)),
    a('ok'),
  ];
  const summary = `${SUMMARY_PREFIX}${'S'.repeat(4800)}`; // ~1.2k tokens
  const archived = rows.reduce((sum, r) => sum + estimateTokens(String(r.content)), 0);
  const budget = retentionBudgetFor(rows, summary);
  const retained = selectRetainedUserMessages(rows, budget);
  const retainedTokens = retained.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  assert.ok(budget < RETAINED_USER_MAX_TOKENS, 'the cap must engage here');
  assert.ok(
    estimateTokens(summary) + retainedTokens <= archived,
    `compaction grew the view: ${estimateTokens(summary) + retainedTokens} > ${archived}`,
  );
  assert.ok(retained.length > 0, 'the cap must not disable retention entirely');
});

test('a normal conversation keeps plain Codex behaviour (ceiling, not cap)', () => {
  // Tool output and assistant prose dominate: plenty of headroom, so the budget
  // is Codex's flat ceiling and every user ask is replayed whole.
  const rows = [
    u('short ask one'),
    a('X'.repeat(400000)),
    t('Y'.repeat(400000)),
    u('short ask two'),
  ];
  const summary = `${SUMMARY_PREFIX}${'S'.repeat(4800)}`;
  assert.equal(retentionBudgetFor(rows, summary), RETAINED_USER_MAX_TOKENS);
  const retained = selectRetainedUserMessages(rows, retentionBudgetFor(rows, summary));
  assert.deepEqual(texts(retained), ['short ask one', 'short ask two']);
});

test('a summary larger than what it archived retains nothing', () => {
  const rows = [u('hi')];
  const summary = `${SUMMARY_PREFIX}${'S'.repeat(40000)}`;
  assert.equal(retentionBudgetFor(rows, summary), 0);
  assert.deepEqual(selectRetainedUserMessages(rows, retentionBudgetFor(rows, summary)), []);
});

if (failures > 0) {
  console.error(`${failures} compact-retain test(s) failed`);
  process.exit(1);
} else {
  console.log('compact-retain: OK');
}
