/**
 * The frozen reasoning vocabulary: `shared/reasoningEfforts.ts`.
 *
 * Every layer — UI copy, capability descriptors, the send-time planner, the
 * zod import enum — sits on this order and these two functions, so the
 * contract is asserted on its own here. Capability descriptors and the
 * planner live in scripts/test-reasoning-capability.ts; wire bodies in
 * scripts/test-reasoning-wire.ts.
 *
 * Usage:
 *   npx tsx scripts/test-reasoning-effort.ts
 *
 * Offline: no network, no DB.
 */
import assert from 'node:assert/strict';
import {
  REASONING_EFFORT_ORDER,
  clampReasoningEffort,
  filterSupportedEfforts,
  isReasoningEffort,
} from '../shared/reasoningEfforts.js';
import { REASONING_LEVEL_COPY } from '../src/components/reasoning/reasoningCopy.js';

let checks = 0;
function ok(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`ok ${checks} - ${name}`);
}

// ---------------------------------------------------------------------------
// Vocabulary and order
// ---------------------------------------------------------------------------

ok('REASONING_EFFORT_ORDER is [minimal,low,medium,high,xhigh,max]', () => {
  assert.deepEqual([...REASONING_EFFORT_ORDER], ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.ok(!([...REASONING_EFFORT_ORDER] as string[]).includes('ultra'), "'ultra' is not in the order");
  assert.ok(!([...REASONING_EFFORT_ORDER] as string[]).includes('none'), "'none' is off, not a level");
});

ok("isReasoningEffort accepts the six levels plus 'none' and nothing else", () => {
  for (const value of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'none']) {
    assert.equal(isReasoningEffort(value), true, value);
  }
  for (const value of ['ultra', 'ULTRA', 'ultracode', 'Max', '', 'auto', 'default', 123, null, undefined, {}, []]) {
    assert.equal(isReasoningEffort(value), false, JSON.stringify(value));
  }
});

ok('every level has user-facing copy, in coherent English', () => {
  assert.deepEqual(
    REASONING_EFFORT_ORDER.map((level) => REASONING_LEVEL_COPY[level].label),
    ['Minimal', 'Low', 'Medium', 'High', 'Extra high', 'Max'],
  );
  for (const level of REASONING_EFFORT_ORDER) {
    const copy = REASONING_LEVEL_COPY[level];
    assert.ok(copy.description.length > 0, `${level} description`);
    assert.doesNotMatch(copy.label, /ultra/i, level);
  }
});

// ---------------------------------------------------------------------------
// filterSupportedEfforts: what a host publishes → canonical levels
// ---------------------------------------------------------------------------

ok("filterSupportedEfforts sorts into canonical order (['max','high'] → ['high','max'])", () => {
  assert.deepEqual(filterSupportedEfforts(['max', 'high']), ['high', 'max']);
});

ok('filterSupportedEfforts: unpublished is null, published-but-empty is []', () => {
  assert.equal(filterSupportedEfforts(null), null);
  assert.equal(filterSupportedEfforts(undefined), null);
  assert.deepEqual(filterSupportedEfforts([]), []);
});

ok('filterSupportedEfforts drops anything outside the vocabulary', () => {
  assert.deepEqual(filterSupportedEfforts(['ultra', 'high', 'bogus', '']), ['high']);
  assert.deepEqual(filterSupportedEfforts(['ultra']), []);
  assert.deepEqual(filterSupportedEfforts(['max', 'ultra', 'xhigh', 'nope']), ['xhigh', 'max']);
});

ok('filterSupportedEfforts dedupes and returns a fresh array', () => {
  const input = ['high', 'high', 'max'];
  const out = filterSupportedEfforts(input)!;
  assert.deepEqual(out, ['high', 'max']);
  assert.notStrictEqual(out, input);
});

// ---------------------------------------------------------------------------
// clampReasoningEffort: never spend more than asked
// ---------------------------------------------------------------------------

ok("clampReasoningEffort passes 'none' and null straight through", () => {
  assert.equal(clampReasoningEffort('none', ['high', 'max']), 'none');
  assert.equal(clampReasoningEffort('none', null), 'none');
  assert.equal(clampReasoningEffort(null, ['high', 'max']), null);
  assert.equal(clampReasoningEffort(null, null), null);
});

ok('clampReasoningEffort fails open when the host publishes no list', () => {
  assert.equal(clampReasoningEffort('max', null), 'max');
  assert.equal(clampReasoningEffort('max', undefined), 'max');
  assert.equal(clampReasoningEffort('high', null), 'high');
});

ok('clampReasoningEffort returns null for a model with no gradation', () => {
  assert.equal(clampReasoningEffort('high', []), null);
});

ok('clampReasoningEffort falls to the nearest lower level, and climbs only when there is none', () => {
  assert.equal(clampReasoningEffort('max', ['minimal', 'low']), 'low');
  assert.equal(clampReasoningEffort('medium', ['low', 'high', 'max']), 'low');
  assert.equal(clampReasoningEffort('minimal', ['high', 'max']), 'high');
});

ok('clampReasoningEffort keeps a supported level untouched', () => {
  assert.equal(clampReasoningEffort('high', ['high', 'max']), 'high');
  assert.equal(clampReasoningEffort('low', ['minimal', 'low', 'medium']), 'low');
});

ok('clampReasoningEffort resolves garbage to a deterministic middle level', () => {
  assert.equal(clampReasoningEffort('ultra', ['low', 'medium', 'high']), 'medium');
  assert.equal(clampReasoningEffort('ultra', ['high', 'max']), 'high');
  assert.equal(clampReasoningEffort('bogus', ['max']), 'max');
  assert.equal(clampReasoningEffort('ultra', ['minimal', 'low', 'high', 'max']), 'low');
  // Order of the published list never changes the answer.
  assert.equal(
    clampReasoningEffort('ultra', ['minimal', 'low', 'high', 'max']),
    clampReasoningEffort('ultra', ['max', 'minimal', 'high', 'low']),
  );
});

console.log(`reasoning effort vocabulary tests passed (${checks} checks)`);
