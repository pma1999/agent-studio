/**
 * Guardrail for task 5 (LM Studio goes live in chat.ts / councilExecutor.ts).
 *
 * chat.ts is the hot path for EVERY provider (context-map risk R1), so the
 * integration is guarded by source-regex assertions (same idiom as
 * test-tool-call-budget.ts): each enumerated edit site must exist verbatim,
 * and the old deepseek-only persisted-id ternaries must stay deleted.
 *
 * Plus a dynamic-import smoke of the PURE exports chat.ts consumes
 * (server/providers/index.ts and server/providers/lmstudio.ts import nothing
 * db/network-related, so this stays offline-safe).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const chatSource = readFileSync(resolve(process.cwd(), 'server/routes/chat.ts'), 'utf8');

// (a) Key gate: lmstudio is exempt beside codex — requests WITHOUT a token are valid.
assert.match(
  chatSource,
  /!apiKey\?\.trim\(\) && !isCodexModel\(effectiveModel\) && !isLmStudioModel\(effectiveModel\)/,
  '(a) lmstudio key-gate exemption missing beside isCodexModel',
);

// (b) Fetch seam: the streaming request goes through lmstudioFetch for lmstudio.
assert.match(
  chatSource,
  /apiResponse = provider\.id === 'lmstudio'\s*\?\s*await lmstudioFetch\(userId, '\/v1\/chat\/completions', \{/,
  '(b) lmstudioFetch missing at the streaming fetch seam',
);

// (c) Persisted ids: the shared helper replaces ALL THREE ternary copies.
const persistedUses = chatSource.match(/persistedModelId\(provider\.id, effectiveModel, actualModelFromResponse\)/g) ?? [];
assert.ok(
  persistedUses.length >= 3,
  `(c) expected >=3 persistedModelId( uses, found ${persistedUses.length}`,
);
assert.doesNotMatch(
  chatSource,
  /provider\.id === 'deepseek' \? effectiveModel/,
  '(c) literal deepseek persisted-id ternary must stay replaced by persistedModelId',
);

// (d) Effort-max retry excludes lmstudio alongside codex.
assert.match(
  chatSource,
  /requestedMaxEffort = reasoningEnabled && reasoningEffort === 'max' && provider\.id !== 'codex' && provider\.id !== 'lmstudio'/,
  '(d) effort-max retry condition does not exclude lmstudio',
);

// (g) Response-healing path excludes lmstudio alongside codex: LM Studio takes
// response_format json_schema natively and the OpenRouter 'response-healing'
// plugin must never ride an lmstudio request body.
assert.match(
  chatSource,
  /useResponseHealing = !!agent\.response_healing_enabled && !!responseFormat && provider\.id !== 'codex' && provider\.id !== 'lmstudio'/,
  '(g) response-healing condition does not exclude lmstudio',
);

// (e) Sampling: top_p assignment guarded on lmstudio.
assert.match(
  chatSource,
  /if \(isLmStudioModel\(effectiveModel\)\) \{(?:\s*\/\/[^\n]*)*\s*requestBody\.top_p = resolveLmStudioSampling\(agent\.temperature, 'general'\)\.top_p;/,
  '(e) top_p assignment not guarded on lmstudio',
);

// (f) Reasoning normalization: a per-segment <think> splitter is created and
// wired into the delta content branch (push + post-stream flush).
assert.match(
  chatSource,
  /= provider\.id === 'lmstudio' \? createThinkStreamSplitter\(\) : null;/,
  '(f) think splitter not instantiated per segment',
);
assert.match(
  chatSource,
  /emitThinkSplit\(thinkSplitter\.push\(delta\.content\)\)/,
  '(f) delta.content not routed through the think splitter',
);
assert.match(
  chatSource,
  /emitThinkSplit\(thinkSplitter\.flush\(\)\)/,
  '(f) think splitter flush missing after the read loop',
);

// Dynamic-import smoke of the PURE exports consumed by chat.ts.
const { isLmStudioModel, persistedModelId } = await import('../server/providers/index.js');
const { createThinkStreamSplitter, resolveLmStudioSampling } = await import('../server/providers/lmstudio.js');

assert.equal(isLmStudioModel('lmstudio:qwen/qwen3-coder-30b'), true);
assert.equal(isLmStudioModel('openrouter/auto'), false);
assert.equal(persistedModelId('lmstudio', 'lmstudio:key@q4', 'key@q4'), 'lmstudio:key@q4');
assert.equal(persistedModelId('deepseek', 'deepseek:m', 'm'), 'deepseek:m');
assert.equal(persistedModelId('openrouter', 'org/model', 'variant'), 'variant');
assert.deepEqual(resolveLmStudioSampling(null), { temperature: 0.65, top_p: 0.9 });
assert.deepEqual(resolveLmStudioSampling(0.42), { temperature: 0.42, top_p: 0.9 });

// Splitter smoke: partial tags are held back; think bodies land in reasoning.
const splitter = createThinkStreamSplitter();
assert.deepEqual(splitter.push('<th'), { reasoning: '', content: '' });
assert.deepEqual(splitter.push('ink>why'), { reasoning: 'why', content: '' });
assert.deepEqual(splitter.push('</think>ans'), { reasoning: '', content: 'ans' });
assert.deepEqual(splitter.flush(), { reasoning: '', content: '' });

console.log('lmstudio chat gates guardrail: OK');
