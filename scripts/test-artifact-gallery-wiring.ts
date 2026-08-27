import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  sortArtifactsByUpdatedAt,
  filterArtifactsByKind,
  searchArtifactsByTitle,
  truncateTitle,
  formatRelativeTime,
} from '../src/utils/artifactWiring.ts';
import type { ChatArtifact } from '../src/types/index.ts';

function makeArtifact(overrides: Partial<ChatArtifact> & Pick<ChatArtifact, 'id' | 'conversation_id'>): ChatArtifact {
  return {
    kind: 'html',
    title: 'Test',
    language: null,
    content: '<html></html>',
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    message_id: null,
    ...overrides,
  };
}

let failures = 0;
let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
    passed++;
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof assert.AssertionError) console.error(err.stack);
  }
}

// sort asc estable
test('sort asc estable (updated_at ASC, timestamps iguales preserva input order)', () => {
  const t1 = '2024-01-01T10:00:00.000Z';
  const t2 = '2024-01-01T11:00:00.000Z';
  const a = makeArtifact({ id: 'a', conversation_id: 'c1', updated_at: t2 });
  const b = makeArtifact({ id: 'b', conversation_id: 'c1', updated_at: t1 });
  const c = makeArtifact({ id: 'c', conversation_id: 'c1', updated_at: t1 });
  const input = [a, b, c];
  const sorted = sortArtifactsByUpdatedAt(input, 'asc');
  // asc: b(t1), c(t1), a(t2) — b before c preserves original order among equals (b idx1, c idx2)
  assert.deepEqual(sorted.map((x) => x.id), ['b', 'c', 'a']);
  // default dir is asc
  const sortedDefault = sortArtifactsByUpdatedAt(input);
  assert.deepEqual(sortedDefault.map((x) => x.id), ['b', 'c', 'a']);
});

test('sort desc (reverse)', () => {
  const t1 = '2024-01-01T10:00:00.000Z';
  const t2 = '2024-01-01T11:00:00.000Z';
  const a = makeArtifact({ id: 'a', conversation_id: 'c1', updated_at: t1 });
  const b = makeArtifact({ id: 'b', conversation_id: 'c1', updated_at: t2 });
  const sorted = sortArtifactsByUpdatedAt([a, b], 'desc');
  assert.deepEqual(sorted.map((x) => x.id), ['b', 'a']);
  // stable desc: equal timestamps preserve input order
  const c = makeArtifact({ id: 'c', conversation_id: 'c1', updated_at: t1 });
  const d = makeArtifact({ id: 'd', conversation_id: 'c1', updated_at: t1 });
  const sorted2 = sortArtifactsByUpdatedAt([c, d], 'desc');
  assert.deepEqual(sorted2.map((x) => x.id), ['c', 'd']);
});

test('sort no muta input (Object.is check)', () => {
  const t1 = '2024-01-01T10:00:00.000Z';
  const t2 = '2024-01-01T11:00:00.000Z';
  const a = makeArtifact({ id: 'a', conversation_id: 'c1', updated_at: t2 });
  const b = makeArtifact({ id: 'b', conversation_id: 'c1', updated_at: t1 });
  const input = [a, b];
  const inputCopy = [...input];
  const sorted = sortArtifactsByUpdatedAt(input, 'asc');
  // input not mutated (order unchanged)
  assert.deepEqual(input.map((x) => x.id), inputCopy.map((x) => x.id));
  // returned copy is not same reference
  assert.notEqual(sorted, input);
  // sorted content correct
  assert.deepEqual(sorted.map((x) => x.id), ['b', 'a']);
});

test('sort maneja ISO invalido como menor (no throw)', () => {
  const tValid = '2024-01-01T10:00:00.000Z';
  const a = makeArtifact({ id: 'a', conversation_id: 'c1', updated_at: 'not-a-date' });
  const b = makeArtifact({ id: 'b', conversation_id: 'c1', updated_at: tValid });
  const c = makeArtifact({ id: 'c', conversation_id: 'c1', updated_at: '' });
  // invalid should sort before valid in asc
  const sortedAsc = sortArtifactsByUpdatedAt([b, a, c], 'asc');
  // a and c both invalid (-Infinity), stable order: a before c, then b
  assert.deepEqual(sortedAsc.map((x) => x.id), ['a', 'c', 'b']);
  // desc: valid first, then invalids stable
  const sortedDesc = sortArtifactsByUpdatedAt([a, b, c], 'desc');
  assert.deepEqual(sortedDesc.map((x) => x.id), ['b', 'a', 'c']);
  // also invalid string should not throw
  assert.doesNotThrow(() => sortArtifactsByUpdatedAt([a], 'asc'));
});

test('filter kind html / code / all', () => {
  const a = makeArtifact({ id: 'a', conversation_id: 'c1', kind: 'html' });
  const b = makeArtifact({ id: 'b', conversation_id: 'c1', kind: 'code' });
  const c = makeArtifact({ id: 'c', conversation_id: 'c1', kind: 'svg' });
  const d = makeArtifact({ id: 'd', conversation_id: 'c1', kind: 'mermaid' });
  const list = [a, b, c, d];
  assert.deepEqual(filterArtifactsByKind(list, 'html').map((x) => x.id), ['a']);
  assert.deepEqual(filterArtifactsByKind(list, 'code').map((x) => x.id), ['b']);
  assert.deepEqual(filterArtifactsByKind(list, 'svg').map((x) => x.id), ['c']);
  assert.deepEqual(filterArtifactsByKind(list, 'mermaid').map((x) => x.id), ['d']);
  // 'all' returns copy without filter
  const all = filterArtifactsByKind(list, 'all');
  assert.deepEqual(all.map((x) => x.id), ['a', 'b', 'c', 'd']);
  assert.notEqual(all, list);
  assert.equal(all.length, list.length);
  // input not mutated
  assert.deepEqual(list.map((x) => x.id), ['a', 'b', 'c', 'd']);
  // filtered array is new instance
  const htmlFiltered = filterArtifactsByKind(list, 'html');
  assert.notEqual(htmlFiltered, list);
  // exact kind — case not matching (should yield empty)
  const none = filterArtifactsByKind(list, 'HTML' as any);
  assert.equal(none.length, 0);
});

test('search empty query => copia', () => {
  const a = makeArtifact({ id: 'a', conversation_id: 'c1', title: 'Landing demo' });
  const b = makeArtifact({ id: 'b', conversation_id: 'c1', title: 'Code snippet' });
  const list = [a, b];
  const r1 = searchArtifactsByTitle(list, '');
  assert.deepEqual(r1.map((x) => x.id), ['a', 'b']);
  assert.notEqual(r1, list);
  const r2 = searchArtifactsByTitle(list, '   ');
  assert.deepEqual(r2.map((x) => x.id), ['a', 'b']);
  assert.notEqual(r2, list);
  const r3 = searchArtifactsByTitle(list, '\t\n ');
  assert.deepEqual(r3.map((x) => x.id), ['a', 'b']);
  // not mutated
  assert.deepEqual(list.map((x) => x.id), ['a', 'b']);
});

test('search case-insensitive substring "LAND" matches "Landing demo"', () => {
  const a = makeArtifact({ id: 'a', conversation_id: 'c1', title: 'Landing demo' });
  const b = makeArtifact({ id: 'b', conversation_id: 'c1', title: 'landing page' });
  const c = makeArtifact({ id: 'c', conversation_id: 'c1', title: 'Code' });
  const list = [a, b, c];
  const r = searchArtifactsByTitle(list, 'LAND');
  assert.deepEqual(r.map((x) => x.id), ['a', 'b']);
  const r2 = searchArtifactsByTitle(list, '  land  ');
  assert.deepEqual(r2.map((x) => x.id), ['a', 'b']);
  const r3 = searchArtifactsByTitle(list, 'Demo');
  assert.deepEqual(r3.map((x) => x.id), ['a']);
});

test('search special chars no throw ".*+?"', () => {
  const a = makeArtifact({ id: 'a', conversation_id: 'c1', title: 'hello .*+? world' });
  const b = makeArtifact({ id: 'b', conversation_id: 'c1', title: 'normal' });
  const list = [a, b];
  // special regex chars should be treated literally, no throw
  assert.doesNotThrow(() => searchArtifactsByTitle(list, '.*+?'));
  const r = searchArtifactsByTitle(list, '.*+?');
  assert.deepEqual(r.map((x) => x.id), ['a']);
  // query with brackets etc
  assert.doesNotThrow(() => searchArtifactsByTitle(list, '[test] (foo)'));
  const r2 = searchArtifactsByTitle(list, '[test]');
  assert.equal(r2.length, 0);
  // title containing special chars searchable
  const r3 = searchArtifactsByTitle(list, 'hello');
  assert.deepEqual(r3.map((x) => x.id), ['a']);
});

test('truncate 64 default y custom max, con ellipsis, empty, exactly max', () => {
  // empty
  assert.equal(truncateTitle('', 64), '');
  assert.equal(truncateTitle('', 10), '');
  // exactly max => no ellipsis
  const exactly64 = 'a'.repeat(64);
  assert.equal(truncateTitle(exactly64), exactly64);
  assert.equal(truncateTitle(exactly64, 64), exactly64);
  // one over max => ellipsis with slice to max
  const over = 'a'.repeat(65);
  assert.equal(truncateTitle(over), 'a'.repeat(64) + '…');
  assert.equal(truncateTitle(over).length, 65);
  // custom max
  assert.equal(truncateTitle('hello world', 5), 'hello' + '…');
  assert.equal(truncateTitle('hello', 5), 'hello');
  assert.equal(truncateTitle('hello!', 5), 'hello' + '…');
  // short title unchanged
  assert.equal(truncateTitle('short', 64), 'short');
  assert.equal(truncateTitle('short', 10), 'short');
  // does not mutate (string immutable, just check return new)
  const t = 'abcdefghij';
  const truncated = truncateTitle(t, 5);
  assert.equal(t, 'abcdefghij');
  assert.notEqual(truncated, t);
  // default max is 64
  const long70 = 'x'.repeat(70);
  assert.equal(truncateTitle(long70).length, 65);
  assert.ok(truncateTitle(long70).endsWith('…'));
});

test('formatRelativeTime <60s just now, 2m, 1h, 25h=>1d, invalid=>"", future=>just now, injectable now', () => {
  const now = Date.parse('2024-01-01T12:00:00.000Z');
  // <60s => just now
  assert.equal(formatRelativeTime('2024-01-01T11:59:45.000Z', now), 'just now'); // 15s ago
  assert.equal(formatRelativeTime('2024-01-01T11:59:01.000Z', now), 'just now'); // 59s
  assert.equal(formatRelativeTime('2024-01-01T12:00:00.000Z', now), 'just now'); // 0s
  // exactly 60s => hace 1m
  assert.equal(formatRelativeTime('2024-01-01T11:59:00.000Z', now), 'hace 1m');
  // 2m
  assert.equal(formatRelativeTime('2024-01-01T11:58:00.000Z', now), 'hace 2m');
  assert.equal(formatRelativeTime(new Date(now - 2 * 60 * 1000).toISOString(), now), 'hace 2m');
  // 1h
  assert.equal(formatRelativeTime('2024-01-01T11:00:00.000Z', now), 'hace 1h');
  // 3h
  assert.equal(formatRelativeTime('2024-01-01T09:00:00.000Z', now), 'hace 3h');
  // boundary 59m => hace 59m ; 60m => hace 1h
  assert.equal(formatRelativeTime(new Date(now - 59 * 60 * 1000).toISOString(), now), 'hace 59m');
  assert.equal(formatRelativeTime(new Date(now - 60 * 60 * 1000).toISOString(), now), 'hace 1h');
  // 25h => 1d
  assert.equal(formatRelativeTime('2023-12-31T11:00:00.000Z', now), 'hace 1d'); // 25h
  assert.equal(formatRelativeTime(new Date(now - 25 * 60 * 60 * 1000).toISOString(), now), 'hace 1d');
  // 2d
  assert.equal(formatRelativeTime(new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(), now), 'hace 2d');
  // invalid => ""
  assert.equal(formatRelativeTime('not-a-date', now), '');
  assert.equal(formatRelativeTime('', now), '');
  assert.equal(formatRelativeTime('2024-13-99', now), '');
  // future => just now
  assert.equal(formatRelativeTime('2024-01-01T13:00:00.000Z', now), 'just now');
  assert.equal(formatRelativeTime(new Date(now + 1000).toISOString(), now), 'just now');
  // injectable now deterministic (same iso, different now => different result)
  const iso = '2024-01-01T10:00:00.000Z';
  const now2 = Date.parse('2024-01-01T10:00:30.000Z');
  const now3 = Date.parse('2024-01-01T10:05:00.000Z');
  assert.equal(formatRelativeTime(iso, now2), 'just now');
  assert.equal(formatRelativeTime(iso, now3), 'hace 5m');
  // default now (no second arg) should not throw and produce string (just now or hace)
  assert.doesNotThrow(() => formatRelativeTime(new Date().toISOString()));
  const defaultResult = formatRelativeTime(new Date(Date.now() - 5000).toISOString());
  assert.equal(defaultResult, 'just now');
});

test('import type only guard (fs.readFileSync artifactWiring.ts no contiene runtime shared import)', () => {
  const src = fs.readFileSync('src/utils/artifactWiring.ts', 'utf8');
  // Must use `import type` and not runtime import from shared or types without type
  assert.ok(!src.includes("from '../../shared/artifactTypes.js'"), 'must not have runtime import from shared artifactTypes.js');
  assert.ok(!src.includes('from "../../shared/artifactTypes.js"'), 'must not have runtime import from shared');
  assert.ok(!src.includes("from '../shared/artifactTypes"), 'must not have runtime import from shared');
  // Every import line must be `import type` (no runtime `import {`)
  const importLines = src.split('\n').filter((l) => l.trim().startsWith('import'));
  for (const line of importLines) {
    assert.ok(line.trim().startsWith('import type'), `each import must be type-only, found: ${line}`);
  }
  assert.ok(src.includes('import type'), 'should have at least one import type');
  // No runtime store/fetch/DOM deps: check for actual import or usage, ignoring comments that document the constraint
  // Strip comments before checking for forbidden runtime patterns
  const srcNoComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!srcNoComments.includes("from 'zustand'") && !srcNoComments.includes('from "zustand"'), 'no zustand import');
  assert.ok(!srcNoComments.includes("from 'zustand'") && !srcNoComments.includes('zustand'), 'no zustand runtime reference');
  // More precise zustand check: look for import line containing zustand (already covered by import type guard, but explicit)
  assert.ok(!srcNoComments.match(/import\s+.*from\s+['"]zustand['"]/ ), 'no zustand import');
  assert.ok(!srcNoComments.includes('fetch('), 'no fetch');
  assert.ok(!srcNoComments.includes('window.'), 'no window');
  assert.ok(!srcNoComments.includes('document.'), 'no document');
});

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED, ${passed} passed`);
  process.exit(1);
}
console.log(`\nartifact-gallery-wiring: ${passed} passed, 0 failed — OK`);
