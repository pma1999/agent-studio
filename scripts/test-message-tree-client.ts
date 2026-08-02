/**
 * Tests for the pure message-tree helpers in src/utils/threads.ts
 * (buildThread / getTurnVariants / findVariantLeaf / getCurrentVariant).
 * Run with: npx tsx scripts/test-message-tree-client.ts
 * Exits non-zero when any test fails. NOT wired into package.json "test".
 */
import assert from 'node:assert/strict';
import type { Message } from '../src/types';
import {
  buildThread,
  getTurnVariants,
  findVariantLeaf,
  getCurrentVariant,
} from '../src/utils/threads';

let passed = 0;
let failures = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
  }
}

function make(partial: Partial<Message> & { id: string; role: Message['role'] }): Message {
  return {
    conversation_id: 'conv-1',
    content: '',
    created_at: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

const ids = (messages: Message[]): string[] => messages.map((m) => m.id);

const t = (s: string) => `2026-01-01T00:00:${s}Z`;

// ---------------------------------------------------------------- (a) linear chain
const linear = [
  make({ id: 'm1', role: 'user', content: 'hi', created_at: t('01') }),
  make({ id: 'm2', role: 'assistant', content: 'hello', parent_id: 'm1', turn_id: 'T1', created_at: t('02') }),
  make({ id: 'm3', role: 'user', content: 'more', parent_id: 'm2', turn_id: 'T2', created_at: t('03') }),
  make({ id: 'm4', role: 'assistant', content: 'sure', parent_id: 'm3', turn_id: 'T2', created_at: t('04') }),
];

test('buildThread: linear parent chain returns root→leaf', () => {
  assert.deepEqual(ids(buildThread(linear, 'm4')), ['m1', 'm2', 'm3', 'm4']);
});

test('buildThread: partial walk from a mid-chain leaf', () => {
  assert.deepEqual(ids(buildThread(linear, 'm2')), ['m1', 'm2']);
});

test('buildThread: leaf that IS the root returns just the root', () => {
  assert.deepEqual(ids(buildThread(linear, 'm1')), ['m1']);
});

// ---------------------------------------------------------------- (b) legacy data
const legacy = [
  make({ id: 'm3', role: 'user', content: 'more', created_at: t('03') }),
  make({ id: 'm1', role: 'user', content: 'hi', created_at: t('01') }),
  make({ id: 'm4', role: 'assistant', content: 'sure', created_at: t('04') }),
  make({ id: 'm2', role: 'assistant', content: 'hello', created_at: t('02') }),
];

test('buildThread: legacy (no parent_id) orders by created_at ASC', () => {
  assert.deepEqual(ids(buildThread(legacy, 'm4')), ['m1', 'm2', 'm3', 'm4']);
});

test('buildThread: null leaf falls back to created_at ASC', () => {
  assert.deepEqual(ids(buildThread(legacy, null)), ['m1', 'm2', 'm3', 'm4']);
});

test('buildThread: unknown leaf falls back to created_at ASC', () => {
  assert.deepEqual(ids(buildThread(legacy, 'nope')), ['m1', 'm2', 'm3', 'm4']);
});

test('buildThread: created_at ties keep insertion order (stable)', () => {
  const tied = [
    make({ id: 'x1', role: 'user', content: 'a', created_at: t('10') }),
    make({ id: 'x2', role: 'user', content: 'b', created_at: t('10') }),
  ];
  assert.deepEqual(ids(buildThread(tied, null)), ['x1', 'x2']);
});

// ---------------------------------------------------------------- (c) variant turn
const variants = [
  make({ id: 'u1', role: 'user', content: 'v1', turn_id: 'T1', variant_seq: 1, parent_id: null, created_at: t('01') }),
  make({ id: 'a1', role: 'assistant', content: 'r1', turn_id: 'T1', parent_id: 'u1', created_at: t('02') }),
  make({ id: 'u2', role: 'user', content: 'v2', turn_id: 'T1', variant_seq: 2, parent_id: null, created_at: t('03') }),
  make({ id: 'a2', role: 'assistant', content: 'r2', turn_id: 'T1', parent_id: 'u2', created_at: t('04') }),
  make({ id: 'u3', role: 'user', content: 'v3', turn_id: 'T1', variant_seq: 3, parent_id: null, created_at: t('05') }),
  make({ id: 'a3', role: 'assistant', content: 'r3', turn_id: 'T1', parent_id: 'u3', created_at: t('06') }),
  make({ id: 'u4', role: 'user', content: 'next turn', turn_id: 'T2', variant_seq: 1, parent_id: 'a3', created_at: t('07') }),
  make({ id: 'a4', role: 'assistant', content: 'r4', turn_id: 'T2', parent_id: 'u4', created_at: t('08') }),
];

test('getTurnVariants: all 3 variants of the turn, sorted by variant_seq', () => {
  assert.deepEqual(ids(getTurnVariants(variants, 'u2')), ['u1', 'u2', 'u3']);
  assert.deepEqual(ids(getTurnVariants(variants, 'u1')), ['u1', 'u2', 'u3']);
  assert.deepEqual(ids(getTurnVariants(variants, 'u3')), ['u1', 'u2', 'u3']);
});

test('getTurnVariants: single-variant turn returns itself', () => {
  assert.deepEqual(ids(getTurnVariants(variants, 'u4')), ['u4']);
});

test('getTurnVariants: non-user message returns [message]', () => {
  assert.deepEqual(ids(getTurnVariants(variants, 'a2')), ['a2']);
});

test('getTurnVariants: legacy message without turn_id returns [message]', () => {
  const legacyMsg = make({ id: 'lm1', role: 'user', content: 'x' });
  assert.deepEqual(ids(getTurnVariants([legacyMsg], 'lm1')), ['lm1']);
});

test('getTurnVariants: unknown id returns []', () => {
  assert.deepEqual(getTurnVariants(variants, 'missing'), []);
});

test('findVariantLeaf: each variant root resolves to its own assistant leaf', () => {
  assert.equal(findVariantLeaf(variants, 'u1'), 'a1');
  assert.equal(findVariantLeaf(variants, 'u2'), 'a2');
});

test('findVariantLeaf: variant 3 excludes the next turn (different turn_id)', () => {
  assert.equal(findVariantLeaf(variants, 'u3'), 'a3');
});

test('findVariantLeaf: root without descendants resolves to itself', () => {
  const lone = make({ id: 'u9', role: 'user', content: 'lone', turn_id: 'T9', variant_seq: 1 });
  assert.equal(findVariantLeaf([...variants, lone], 'u9'), 'u9');
});

test('findVariantLeaf: unknown id returns null', () => {
  assert.equal(findVariantLeaf(variants, 'missing'), null);
});

test('getCurrentVariant: index/total per leaf', () => {
  assert.deepEqual(getCurrentVariant(variants, 'a1'), { userMessageId: 'u1', turnId: 'T1', index: 1, total: 3 });
  assert.deepEqual(getCurrentVariant(variants, 'a2'), { userMessageId: 'u2', turnId: 'T1', index: 2, total: 3 });
  assert.deepEqual(getCurrentVariant(variants, 'a3'), { userMessageId: 'u3', turnId: 'T1', index: 3, total: 3 });
});

test('getCurrentVariant: leaf in a single-variant turn', () => {
  assert.deepEqual(getCurrentVariant(variants, 'a4'), { userMessageId: 'u4', turnId: 'T2', index: 1, total: 1 });
});

test('getCurrentVariant: leaf that IS a user message', () => {
  assert.deepEqual(getCurrentVariant(variants, 'u2'), { userMessageId: 'u2', turnId: 'T1', index: 2, total: 3 });
});

test('getCurrentVariant: null/unknown leaf returns null', () => {
  assert.equal(getCurrentVariant(variants, null), null);
  assert.equal(getCurrentVariant(variants, 'missing'), null);
});

test('getCurrentVariant: legacy chain without parent links returns null', () => {
  assert.equal(getCurrentVariant(legacy, 'm4'), null);
});

test('getCurrentVariant: parent-linked single-variant turn falls back to index 1 / total 1', () => {
  assert.deepEqual(getCurrentVariant(linear, 'm4'), { userMessageId: 'm3', turnId: 'T2', index: 1, total: 1 });
});

// ------------------------------------------------ (d) visible thread = active variant
test('buildThread: leaf in variant 2 excludes variants 1 and 3', () => {
  assert.deepEqual(ids(buildThread(variants, 'a2')), ['u2', 'a2']);
});

test('buildThread: leaf in variant 3 includes the follow-up turn, excludes other variants', () => {
  assert.deepEqual(ids(buildThread(variants, 'a4')), ['u3', 'a3', 'u4', 'a4']);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED, ${passed} passed`);
  process.exit(1);
}
console.log(`\nAll message-tree client tests passed (${passed})`);
