import assert from 'node:assert/strict';

import {
  estimateTokens,
  selectTail,
  serializeHead,
  validateSummaryTemplate,
  type CompactRow,
} from '../server/compaction/serialize.js';

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

// --- fixtures ---
const row = (over: Partial<CompactRow> & { id: string; role: string }): CompactRow => ({
  content: '',
  ...over,
});
const userRow = (id: string, content: unknown, turnId: string | null = null): CompactRow =>
  row({ id, role: 'user', content, turn_id: turnId });
const assistantRow = (
  id: string,
  content: unknown,
  turnId: string | null = null,
  extra: Partial<CompactRow> = {},
): CompactRow => row({ id, role: 'assistant', content, turn_id: turnId, ...extra });
const toolRow = (id: string, content: string, turnId: string | null = null): CompactRow =>
  row({ id, role: 'tool', content, turn_id: turnId });

const TOOL_CALLS_JSON = JSON.stringify([
  { id: 'tc1', type: 'function', function: { name: 'run_command', arguments: '{"cmd":"ls"}' } },
]);

// --- estimateTokens ---
test('estimateTokens is ceil(chars/4)', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens('x'.repeat(2000)), 500);
});

// --- serializeHead: basic line mapping ---
test('user row maps to [User] line', () => {
  assert.equal(serializeHead([userRow('u1', 'hello')]), '[User] hello');
});

test('assistant row maps to [Assistant] line', () => {
  assert.equal(serializeHead([assistantRow('a1', 'hi there')]), '[Assistant] hi there');
});

test('reasoning_content maps to [Assistant reasoning] line before text', () => {
  const head = serializeHead([assistantRow('a1', 'answer', null, { reasoning_content: 'thinking' })]);
  assert.equal(head, '[Assistant reasoning] thinking\n[Assistant] answer');
});

test('assistant tool_calls serialize to [Assistant tool call] lines', () => {
  const head = serializeHead([assistantRow('a1', 'checking', null, { tool_calls: TOOL_CALLS_JSON })]);
  assert.equal(head, '[Assistant] checking\n[Assistant tool call]: run_command({"cmd":"ls"})');
});

test('assistant with tool_calls AND empty content emits no [Assistant] text line', () => {
  const head = serializeHead([assistantRow('a1', '', null, { tool_calls: TOOL_CALLS_JSON })]);
  assert.equal(head, '[Assistant tool call]: run_command({"cmd":"ls"})');
});

test('tool row maps to [Tool result] line', () => {
  assert.equal(serializeHead([toolRow('t1', 'file contents here')]), '[Tool result] file contents here');
});

test('tool row starting with [Tool execution error] maps to [Tool error]', () => {
  const head = serializeHead([toolRow('t1', '[Tool execution error] boom')]);
  assert.equal(head, '[Tool error] [Tool execution error] boom');
});

test('tool row whose content JSON parses to {ok:false} maps to [Tool error]', () => {
  const content = JSON.stringify({ ok: false, result: 'command failed' });
  const head = serializeHead([toolRow('t1', content)]);
  assert.ok(head.startsWith('[Tool error] '), `got: ${head}`);
});

test('tool row with JSON content without ok:false maps to [Tool result]', () => {
  const content = JSON.stringify({ results: [{ url: 'https://example.com' }] });
  assert.ok(serializeHead([toolRow('t1', content)]).startsWith('[Tool result] '));
});

test('compaction rows are skipped by serializeHead', () => {
  const head = serializeHead([
    userRow('u1', 'before'),
    row({ id: 'c1', role: 'compaction', content: 'Summary:\n## Objective' }),
    userRow('u2', 'after'),
  ]);
  assert.equal(head, '[User] before\n[User] after');
});

// --- serializeHead: truncation ---
test('tool output cut at 2000 chars with correct N marker', () => {
  const head = serializeHead([toolRow('t1', 'x'.repeat(2500))]);
  assert.equal(head, `[Tool result] ${'x'.repeat(2000)} [truncated 500 chars]`);
});

test('tool output of exactly 2000 chars has no marker', () => {
  assert.equal(serializeHead([toolRow('t1', 'y'.repeat(2000))]), `[Tool result] ${'y'.repeat(2000)}`);
});

test('tool-call args truncated to 500 chars', () => {
  const longArgs = 'a'.repeat(600);
  const calls = JSON.stringify([
    { id: 'tc1', type: 'function', function: { name: 'read_file', arguments: longArgs } },
  ]);
  const head = serializeHead([assistantRow('a1', '', null, { tool_calls: calls })]);
  assert.equal(head, `[Assistant tool call]: read_file(${'a'.repeat(500)}...)`);
});

// --- serializeHead: attachments + array content ---
test('attachment without mime uses unknown', () => {
  const head = serializeHead([
    userRow('u1', 'see attached', null),
  ]);
  assert.equal(head, '[User] see attached');
  const withAttach = serializeHead([
    row({ id: 'u1', role: 'user', content: 'see attached', attachments: JSON.stringify([{ filename: 'a.pdf' }]) }),
  ]);
  assert.equal(withAttach, '[User] see attached\n[Attached unknown: a.pdf]');
});

test('attachment with mime uses it', () => {
  const withAttach = serializeHead([
    row({
      id: 'u1',
      role: 'user',
      content: 'doc',
      attachments: JSON.stringify([{ filename: 'b.pdf', mime: 'application/pdf' }]),
    }),
  ]);
  assert.equal(withAttach, '[User] doc\n[Attached application/pdf: b.pdf]');
});

test('array content flattens to text parts with file/image descriptors', () => {
  const content = [
    { type: 'text', text: 'hi' },
    { type: 'file', file: { filename: 'd.pdf', file_data: 'DATA' } },
    { type: 'image_url', image_url: { url: 'https://example.com/i.png' } },
  ];
  const head = serializeHead([userRow('u1', content)]);
  assert.equal(head, '[User] hi\n[file: d.pdf]\n[image]');
});

test('null content contributes no text line', () => {
  assert.equal(serializeHead([userRow('u1', null)]), '');
});

// --- selectTail ---
test('newest turn always kept whole even when over a tiny (clamped) budget', () => {
  const rows = [
    userRow('u1', 'old question', 't1'),
    assistantRow('a1', 'old answer', 't1'),
    userRow('u2', 'n'.repeat(9000), 't2'),
    assistantRow('a2', 'new answer', 't2'),
  ];
  const sel = selectTail(rows, 100); // clamps to 2000; newest turn alone is ~2250+ tokens
  assert.deepEqual(sel.tailIds, ['u2', 'a2']);
  assert.deepEqual(
    sel.tailRows.map((r) => r.id),
    ['u2', 'a2'],
  );
  assert.ok(sel.estimatedTokens > 2000, `expected over-budget tail, got ${sel.estimatedTokens}`);
});

test('assistant tool_calls + tool rows in one turn travel together (included)', () => {
  const rows = [
    userRow('u0', 'o'.repeat(9000), 't0'), // ~2250t, too old to fit
    assistantRow('a1', '', 't1', { tool_calls: TOOL_CALLS_JSON }),
    toolRow('t1r', 'tool says hi', 't1'),
    userRow('u2', 'new q', 't2'),
    assistantRow('a2', 'new a', 't2'),
  ];
  const sel = selectTail(rows, 2000);
  assert.deepEqual(sel.tailIds, ['a1', 't1r', 'u2', 'a2']);
});

test('oversized tool pair excluded as a unit (never half a pair)', () => {
  const rows = [
    assistantRow('a1', '', 't1', { tool_calls: TOOL_CALLS_JSON }),
    toolRow('t1r', 'z'.repeat(9000), 't1'), // pair alone ~2250t
    userRow('u2', 'new q', 't2'),
  ];
  const sel = selectTail(rows, 2000);
  assert.deepEqual(sel.tailIds, ['u2']);
});

test('oversized newest tool pair kept whole via the newest-turn floor', () => {
  const rows = [
    userRow('u0', 'old', 't0'),
    assistantRow('a1', '', 't1', { tool_calls: TOOL_CALLS_JSON }),
    toolRow('t1r', 'z'.repeat(9000), 't1'),
  ];
  const sel = selectTail(rows, 2000);
  assert.deepEqual(sel.tailIds, ['a1', 't1r']);
});

test('rows with null turn_id are never selected', () => {
  const rows = [
    row({ id: 's1', role: 'system', content: 'orphan system row', turn_id: null }),
    userRow('u1', 'hello', 't1'),
    assistantRow('a1', 'hi', 't1'),
  ];
  const sel = selectTail(rows, 99999);
  assert.deepEqual(sel.tailIds, ['u1', 'a1']);
});

test('compaction rows are skipped by selectTail', () => {
  const rows = [
    row({ id: 'c1', role: 'compaction', content: 'old summary', turn_id: 'tc' }),
    userRow('u1', 'hello', 't1'),
  ];
  const sel = selectTail(rows, 8000);
  assert.deepEqual(sel.tailIds, ['u1']);
});

test('clamp floor: 1500 behaves as 2000', () => {
  const rows = [
    userRow('u1', 'm'.repeat(7000), 't1'), // ~1752t
    userRow('u2', 'new q', 't2'), // ~27t; 1779 total fits 2000 but not 1500
    assistantRow('a2', 'new a', 't2'),
  ];
  const sel = selectTail(rows, 1500);
  assert.deepEqual(sel.tailIds, ['u1', 'u2', 'a2']);
});

test('clamp ceiling: 99999 behaves as 15000', () => {
  const rows: CompactRow[] = [];
  for (let i = 0; i < 10; i++) {
    rows.push(userRow(`u${i}`, 'q'.repeat(3500), `t${i}`));
    rows.push(assistantRow(`a${i}`, 'a'.repeat(3500), `t${i}`));
  }
  const sel = selectTail(rows, 99999);
  // ~1750 tokens/turn raw: newest 8 turns = ~14000 fit, 9th would exceed 15000
  assert.equal(sel.tailIds.length, 16);
  assert.deepEqual(sel.tailIds.slice(0, 2), ['u2', 'a2']);
  assert.deepEqual(sel.tailIds.slice(-2), ['u9', 'a9']);
  const perTurn = 2 * Math.ceil(3500 / 4);
  assert.equal(sel.estimatedTokens, 8 * perTurn);
});

test('empty input selects nothing', () => {
  assert.deepEqual(selectTail([], 8000), { tailRows: [], tailIds: [], estimatedTokens: 0 });
});

test('tailIds are root-to-leaf with matching rows and token sum', () => {
  const rows = [userRow('u1', 'hello', 't1'), assistantRow('a1', 'hi', 't1')];
  const sel = selectTail(rows, 8000);
  assert.deepEqual(sel.tailIds, ['u1', 'a1']);
  assert.deepEqual(
    sel.tailRows.map((r) => r.id),
    sel.tailIds,
  );
  assert.equal(sel.estimatedTokens, estimateTokens('hello') + estimateTokens('hi'));
});

// --- validateSummaryTemplate ---
const FULL_TEMPLATE = [
  '## Objective',
  'do things',
  '## Important Details',
  '- x',
  '## Work State',
  '### Completed',
  '- done',
  '### Active',
  '- doing',
  '### Blocked',
  '(none)',
  '## Next Move',
  'ship it',
  '## Relevant Files',
  '- server/x.ts',
  '## Session Facts',
  '- model: test',
].join('\n');

test('validator accepts a full template', () => {
  assert.deepEqual(validateSummaryTemplate(FULL_TEMPLATE), { ok: true });
});

test('validator reports exactly the missing headings', () => {
  const text = FULL_TEMPLATE.split('\n')
    .filter((l) => l !== '### Active' && l !== '## Next Move')
    .join('\n');
  assert.deepEqual(validateSummaryTemplate(text), { ok: false, missing: ['### Active', '## Next Move'] });
});

test('validator is case-sensitive (## objective rejected)', () => {
  const text = FULL_TEMPLATE.replace('## Objective', '## objective');
  const res = validateSummaryTemplate(text);
  assert.deepEqual(res, { ok: false, missing: ['## Objective'] });
});

test('validator requires line-anchored headings with a space', () => {
  assert.deepEqual(validateSummaryTemplate('##Objective\n'), {
    ok: false,
    missing: [
      '## Objective',
      '## Important Details',
      '## Work State',
      '### Completed',
      '### Active',
      '### Blocked',
      '## Next Move',
      '## Relevant Files',
      '## Session Facts',
    ],
  });
});

if (failures > 0) {
  console.error(`${failures} test(s) FAILED`);
  process.exit(1);
}
console.log('compact-serialize: OK');
