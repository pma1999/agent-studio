import assert from 'node:assert/strict';
import {
  COMPACTION_PROMPT_VERSION,
  SUMMARY_PREFIX,
  SUMMARY_REASK_INSTRUCTION,
  buildCompactionPrompt,
} from '../server/compaction/prompt.js';
import {
  COMPACTION_BUFFER,
  TOOL_OUTPUT_MAX_CHARS,
  SUMMARY_MAX_TOKENS,
  SUGGEST_PCT,
  AUTO_FIRE_PCT,
  AUTO_COMPACT_ENABLED,
  MODEL_WINDOWS,
  resolveWindow,
  estimateContextUsage,
  shouldSuggest,
  thrashStatus,
  needsAccuracyWarning,
} from '../server/compaction/policy.js';

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

// Byte-identical to openai/codex@main
// `codex-rs/prompts/templates/compact/prompt.md` (425 bytes without the
// trailing newline). The bullet list keeps its line breaks on purpose: a
// previous version flattened it to one line and appended a full stop.
const CODEX_CORE = [
  'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.',
  '',
  'Include:',
  '- Current progress and key decisions made',
  '- Important context, constraints, or user preferences',
  '- What remains to be done (clear next steps)',
  '- Any critical data, examples, or references needed to continue',
  '',
  'Be concise, structured, and focused on helping the next LLM seamlessly continue the work.',
].join('\n');

// Byte-identical to sst/opencode@dev `packages/core/src/session/compaction.ts`
// (`SUMMARY_TEMPLATE` head + `Rules:` tail, and `SUMMARY_UPDATE_INSTRUCTIONS`).
const OPENCODE_TEMPLATE_LEAD =
  'Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.';
const OPENCODE_RULES = [
  'Rules:',
  '- Keep every section, even when empty.',
  '- Use terse bullets, not prose paragraphs.',
  '- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.',
  '- Do not mention the summary process or that context was compacted.',
].join('\n');
const OPENCODE_MERGE_LEAD =
  'The <prior-summary> summarizes everything that happened before the <conversation>. Construct a new summary that combines both. The <prior-summary> is discarded after this: anything you do not carry into the new summary is lost.';

const EXPECTED_PREFIX =
  'Another language model summarized this conversation so it could continue in a smaller context. Use the summary as prior state; the verbatim tail after it is newest. Do not duplicate completed work. Summary:\n';

const EXPECTED_REASK =
  'Your previous response did not follow the required template. Output exactly the Markdown structure with all nine headings in order, keeping every section (write "(none)" when empty).';

const HEADINGS = [
  '## Objective',
  '## Important Details',
  '## Work State',
  '### Completed',
  '### Active',
  '### Blocked',
  '## Next Move',
  '## Relevant Files',
  '## Session Facts',
];

const baseVars = {
  serializedHead: '[User] hello\n[Assistant] world',
  priorSummary: null as string | null,
  focus: null as string | null,
  conversationId: 'conv-123',
  modelId: 'openrouter/auto',
  provider: 'openrouter',
  compactedAtIso: '2026-09-14T00:00:00.000Z',
  messagesCompacted: 42,
  tokensBefore: 12345,
};

// --- prompt constants ---
test('COMPACTION_PROMPT_VERSION is v2 (verbatim Codex core + OpenCode template)', () => {
  assert.equal(COMPACTION_PROMPT_VERSION, 'v2');
});

test('SUMMARY_PREFIX matches G2 verbatim', () => {
  assert.equal(SUMMARY_PREFIX, EXPECTED_PREFIX);
});

test('SUMMARY_REASK_INSTRUCTION matches contract', () => {
  assert.equal(SUMMARY_REASK_INSTRUCTION, EXPECTED_REASK);
});

// --- buildCompactionPrompt ---
test('Codex core present verbatim', () => {
  const out = buildCompactionPrompt(baseVars);
  assert.ok(out.includes(CODEX_CORE), 'missing verbatim Codex core paragraph');
});

test('all 9 headings present in order', () => {
  const out = buildCompactionPrompt({ ...baseVars, priorSummary: 'prior', focus: 'auth bug' });
  let idx = -1;
  for (const h of HEADINGS) {
    const at = out.indexOf(h);
    assert.ok(at > idx, `heading ${h} missing or out of order`);
    idx = at;
  }
});

test('no {{ template variable left unsubstituted', () => {
  const withAll = buildCompactionPrompt({ ...baseVars, priorSummary: 'prior text', focus: 'focus text' });
  assert.ok(!withAll.includes('{{'), 'found unsubstituted {{ in full-vars output');
  const minimal = buildCompactionPrompt(baseVars);
  assert.ok(!minimal.includes('{{'), 'found unsubstituted {{ in minimal output');
});

test('OpenCode template travels verbatim, tags included', () => {
  const out = buildCompactionPrompt(baseVars);
  assert.ok(out.includes(OPENCODE_TEMPLATE_LEAD), 'template lead sentence not verbatim');
  assert.ok(out.includes('<template>') && out.includes('</template>'), 'template tags missing');
  assert.ok(out.includes(OPENCODE_RULES), 'Rules block not verbatim');
  // The agent-studio section lives INSIDE the template, so the model emits it.
  assert.ok(out.indexOf('## Session Facts') < out.indexOf('</template>'), 'Session Facts must sit inside <template>');
  assert.ok(out.includes('- Reproduce the "## Session Facts" line exactly as given.'), 'Session Facts rule missing');
});

test('Codex core is not flattened and gains no full stop', () => {
  const out = buildCompactionPrompt(baseVars);
  assert.ok(!out.includes('task. Include: -'), 'bullet list was flattened onto one line');
  assert.ok(!out.includes('references needed to continue.'), 'a full stop was appended to the last bullet');
  assert.ok(out.includes('Include:\n- Current progress and key decisions made'), 'bullets lost their line breaks');
});

test('prior block absent when null', () => {
  const out = buildCompactionPrompt(baseVars);
  assert.ok(!out.includes('<prior-summary>'), 'prior block should be absent when null');
  assert.ok(!out.includes(OPENCODE_MERGE_LEAD), 'merge instructions should be absent when prior null');
});

test('prior block + merge rules present when set', () => {
  const out = buildCompactionPrompt({ ...baseVars, priorSummary: 'EARLIER-DECISION-XYZ' });
  assert.ok(out.includes('EARLIER-DECISION-XYZ'), 'prior summary text missing');
  assert.ok(out.includes('<prior-summary>'), 'prior-summary wrapper missing');
  assert.ok(out.includes(OPENCODE_MERGE_LEAD), 'OpenCode merge instructions missing when prior set');
  assert.ok(out.includes('Move completed work from "Active" to "Completed".'), 'merge instructions not verbatim');
});

test('focus line absent when null, present when set', () => {
  const absent = buildCompactionPrompt(baseVars);
  assert.ok(!absent.includes('Operator focus'), 'focus line should be absent when null');
  const present = buildCompactionPrompt({ ...baseVars, focus: 'FOCUS-AUTH-BUG-123' });
  assert.ok(present.includes('FOCUS-AUTH-BUG-123'), 'focus text missing');
  assert.ok(present.includes('Operator focus'), 'focus label missing');
});

test('Session Facts line contains all vars', () => {
  const out = buildCompactionPrompt(baseVars);
  for (const needle of [
    'conv-123',
    'openrouter/auto',
    'openrouter',
    '2026-09-14T00:00:00.000Z',
    '42',
    '12345',
  ]) {
    assert.ok(out.includes(needle), `Session Facts missing ${needle}`);
  }
  assert.ok(out.includes('conversation_id:'), 'Session Facts label missing');
});

test('serialized head is embedded', () => {
  const out = buildCompactionPrompt(baseVars);
  assert.ok(out.includes('[User] hello'), 'serialized head missing');
});

// --- policy constants ---
test('policy budget constants', () => {
  // No keep-budget constants: a checkpoint archives the whole visible slice.
  assert.equal(COMPACTION_BUFFER, 20000);
  assert.equal(TOOL_OUTPUT_MAX_CHARS, 2000);
  assert.equal(SUMMARY_MAX_TOKENS, 4096);
  assert.equal(SUGGEST_PCT, 0.6);
  assert.equal(AUTO_FIRE_PCT, 0.9);
  assert.equal(AUTO_COMPACT_ENABLED, false);
});

test('MODEL_WINDOWS known values mirror provider catalogs', () => {
  assert.equal(MODEL_WINDOWS['deepseek:deepseek-v4-flash'], 1_000_000);
  assert.equal(MODEL_WINDOWS['deepseek:deepseek-v4-pro'], 1_000_000);
  assert.equal(MODEL_WINDOWS['abliteration:abliterated-model'], 262144);
  assert.equal(MODEL_WINDOWS['abliteration:abliterated-model-large'], 1_000_000);
  assert.equal(MODEL_WINDOWS['abliteration:abliterated-model-large-v2'], 1_000_000);
  assert.equal(MODEL_WINDOWS['arnict:zai/glm-5.3-flash-uncensored'], 1048576);
  assert.equal(MODEL_WINDOWS['arnict:qwen/qwen3.8-27b'], 262144);
});

test('resolveWindow known + unknown null', () => {
  assert.equal(resolveWindow('deepseek:deepseek-v4-flash'), 1_000_000);
  assert.equal(resolveWindow('abliteration:abliterated-model'), 262144);
  assert.equal(resolveWindow('arnict:qwen/qwen3.8-27b'), 262144);
  assert.equal(resolveWindow('openrouter/auto'), null);
  assert.equal(resolveWindow('codex:gpt-5.1-codex'), null);
  assert.equal(resolveWindow('llamacpp:Qwen3.6-35B-A3B-UD-Q4_K_M'), null);
  assert.equal(resolveWindow('some-unknown-model'), null);
});

test('estimateContextUsage ceil(chars/4) math', () => {
  assert.equal(estimateContextUsage(100, 100, 100, 100), 100);
  assert.equal(estimateContextUsage(1, 1, 1, 0), 1); // ceil(3/4)
  assert.equal(estimateContextUsage(0, 0, 0, 0), 0);
  assert.equal(estimateContextUsage(4, 0, 0, 0), 1);
  assert.equal(estimateContextUsage(5, 0, 0, 0), 2);
});

test('shouldSuggest silent on null limit', () => {
  assert.equal(shouldSuggest(1_000_000, null), false);
});

test('shouldSuggest fires at limit-20000, silent below (formula, not 60%)', () => {
  // 32K conservative fallback: fires at 12K, silent at 11999
  assert.equal(shouldSuggest(12000, 32000), true);
  assert.equal(shouldSuggest(11999, 32000), false);
  // 1M window: fires at 980000
  assert.equal(shouldSuggest(980000, 1_000_000), true);
  assert.equal(shouldSuggest(979999, 1_000_000), false);
});

test('shouldSuggest honors larger modelOutputHint', () => {
  assert.equal(shouldSuggest(70000, 100000, 30000), true);
  assert.equal(shouldSuggest(69999, 100000, 30000), false);
});

test('thrashStatus thresholds', () => {
  assert.equal(thrashStatus(0), 'ok');
  assert.equal(thrashStatus(1), 'ok');
  assert.equal(thrashStatus(2), 'warn');
  assert.equal(thrashStatus(3), 'stop');
  assert.equal(thrashStatus(4), 'stop');
});

test('needsAccuracyWarning from 2nd checkpoint on', () => {
  assert.equal(needsAccuracyWarning(0), false);
  assert.equal(needsAccuracyWarning(1), false);
  assert.equal(needsAccuracyWarning(2), true);
  assert.equal(needsAccuracyWarning(3), true);
});

if (failures > 0) {
  console.error(`${failures} test(s) FAILED`);
  process.exit(1);
}
console.log('compact-prompt: OK');
