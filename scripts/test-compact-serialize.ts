import assert from 'node:assert/strict';

import {
  estimateTokens,
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
