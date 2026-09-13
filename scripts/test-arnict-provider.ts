/**
 * Offline acceptance harness for the arnict.com provider (6th provider).
 *
 * Pure registry/cost/guard dynamic smoke: imports ONLY the pure
 * `server/providers/index.ts` module (zero db/network imports) and asserts the
 * GC-frozen literals (§§1-6):
 *
 *   routing/strip/persist, flags, catalog ids/contexts/prices, cost spots
 *   (§6), reasoning default (no arm, §4), guard message exact (§5),
 *   `isArnictLargeModel`/`buildArnictReasoning`/`ultracode`/`total_credits`
 *   absent (§4/§5/§11).
 *
 * Usage:
 *   npx tsx scripts/test-arnict-provider.ts
 *
 * Reads no source text, performs no network or DB I/O — offline-safe.
 */
import assert from 'node:assert/strict';
import {
  ARNICT_CATALOG,
  ARNICT_PREFIX,
  ARNICT_TOOLS_UNSUPPORTED_MESSAGE,
  arnictCachedTokens,
  assistantReasoningField,
  computeArnictCost,
  getProviderConfig,
  isArnictModel,
  persistedModelId,
  resolveProviderId,
  toUpstreamModelId,
} from '../server/providers/index.js';
import * as providersNs from '../server/providers/index.js';

let checks = 0;
function ok(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`ok ${checks} - ${name}`);
}

// ---------------------------------------------------------------------------
// Routing / strip / persist (GC §1 + §6 persistedModelId)
// ---------------------------------------------------------------------------

ok('resolveProviderId routes both namespaced ids to arnict', () => {
  assert.equal(resolveProviderId('arnict:zai/glm-5.3-flash-uncensored'), 'arnict');
  assert.equal(resolveProviderId('arnict:qwen/qwen3.8-27b'), 'arnict');
});

ok('resolveProviderId leaves bare/upstream ids off arnict (prefix is load-bearing)', () => {
  // Bare `author/slug` ids are OpenRouter-shaped without the prefix.
  assert.equal(resolveProviderId('zai/glm-5.3-flash-uncensored'), 'openrouter');
  assert.equal(resolveProviderId('qwen/qwen3.8-27b'), 'openrouter');
  assert.equal(resolveProviderId('openai/gpt-4o'), 'openrouter');
  assert.equal(resolveProviderId('deepseek:deepseek-chat'), 'deepseek');
  assert.equal(resolveProviderId('codex:gpt-5'), 'codex');
  assert.equal(resolveProviderId('llamacpp:Qwen3'), 'llamacpp');
  assert.equal(resolveProviderId('abliteration:abliterated-model'), 'abliteration');
});

ok('isArnictModel classifies both ways', () => {
  assert.equal(isArnictModel('arnict:zai/glm-5.3-flash-uncensored'), true);
  assert.equal(isArnictModel('arnict:qwen/qwen3.8-27b'), true);
  assert.equal(isArnictModel('zai/glm-5.3-flash-uncensored'), false);
  assert.equal(isArnictModel('openai/gpt-4o'), false);
  assert.equal(isArnictModel(null), false);
});

ok('toUpstreamModelId strips the arnict prefix', () => {
  assert.equal(toUpstreamModelId('arnict:zai/glm-5.3-flash-uncensored'), 'zai/glm-5.3-flash-uncensored');
  assert.equal(toUpstreamModelId('arnict:qwen/qwen3.8-27b'), 'qwen/qwen3.8-27b');
});

ok('persistedModelId keeps the namespaced id for arnict', () => {
  assert.equal(
    persistedModelId('arnict', 'arnict:zai/glm-5.3-flash-uncensored', 'zai/glm-5.3-flash-uncensored'),
    'arnict:zai/glm-5.3-flash-uncensored',
  );
  assert.equal(
    persistedModelId('arnict', 'arnict:qwen/qwen3.8-27b', null),
    'arnict:qwen/qwen3.8-27b',
  );
  // Contrast: openrouter records the echoed upstream variant.
  assert.equal(persistedModelId('openrouter', 'org/model', 'variant'), 'variant');
});

ok('ARNICT_PREFIX is the frozen namespaced prefix', () => {
  assert.equal(ARNICT_PREFIX, 'arnict:');
});

// ---------------------------------------------------------------------------
// Provider flags + endpoint + headers (GC §1 + §2)
// ---------------------------------------------------------------------------

ok('arnict capability flags are F,F,F,F', () => {
  const cfg = getProviderConfig('arnict');
  assert.equal(cfg.supportsProviderRouting, false);
  assert.equal(cfg.supportsPlugins, false);
  assert.equal(cfg.supportsReasoningParam, false);
  assert.equal(cfg.supportsJsonSchema, false);
});

ok('arnict endpoint + label + key setting are frozen', () => {
  const cfg = getProviderConfig('arnict');
  assert.equal(cfg.label, 'Arnict (Direct)');
  assert.equal(cfg.chatCompletionsUrl, 'https://api.arnict.com/v1/chat/completions');
  assert.equal(cfg.apiKeySetting, 'arnict_api_key');
});

ok('arnict headers are Bearer-only (no x-api-key/Referer/Title)', () => {
  const headers = getProviderConfig('arnict').buildHeaders('k123');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(headers['Authorization'], 'Bearer k123');
  assert.equal('x-api-key' in headers, false);
  assert.equal('HTTP-Referer' in headers, false);
  assert.equal('X-Title' in headers, false);
});

// ---------------------------------------------------------------------------
// Catalog (GC §3 frozen static table)
// ---------------------------------------------------------------------------

ok('catalog carries exactly the two frozen ids in order', () => {
  assert.deepEqual(
    ARNICT_CATALOG.map((m) => m.id),
    [
      'arnict:zai/glm-5.3-flash-uncensored',
      'arnict:qwen/qwen3.8-27b',
    ],
  );
});

ok('catalog names are frozen', () => {
  assert.deepEqual(
    ARNICT_CATALOG.map((m) => m.name),
    ['GLM 5.3 Flash Uncensored', 'Qwen 3.8 27B'],
  );
});

ok('catalog contexts are frozen (1M / 256K)', () => {
  assert.deepEqual(
    ARNICT_CATALOG.map((m) => m.context_length),
    [1048576, 262144],
  );
});

ok('catalog pricing is frozen ($0.125/$0.50 GLM, free Qwen)', () => {
  assert.deepEqual(
    ARNICT_CATALOG.map((m) => m.pricing),
    [
      { prompt: '0.000000125', completion: '0.0000005' },
      { prompt: '0', completion: '0' },
    ],
  );
});

ok('catalog descriptions promise no tools/structured-output/reasoning controls', () => {
  for (const m of ARNICT_CATALOG) {
    assert.doesNotMatch(m.description, /tool call|structured output|json_schema|reasoning_effort|include_reasoning|thinking/i);
  }
});

// ---------------------------------------------------------------------------
// Cost (GC §6 frozen table + hit rule)
// ---------------------------------------------------------------------------

ok('cost spot: GLM 1M prompt + 1M completion = $0.625', () => {
  const cost = computeArnictCost(
    { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } as never,
    'zai/glm-5.3-flash-uncensored',
  );
  assert.equal(cost, 0.625);
});

ok('cost spot: GLM 1M prompt (250k cached) + 1M completion = $0.60625', () => {
  const cost = computeArnictCost(
    {
      prompt_tokens: 1_000_000,
      prompt_tokens_details: { cached_tokens: 250_000 },
      completion_tokens: 1_000_000,
    } as never,
    'zai/glm-5.3-flash-uncensored',
  );
  assert.equal(cost, 0.60625);
});

ok('cost spot: Qwen is $0 regardless of tokens (launch-week free)', () => {
  const cost = computeArnictCost(
    { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } as never,
    'qwen/qwen3.8-27b',
  );
  assert.equal(cost, 0);
});

ok('cost hit rule reads details.cached_tokens with fallback cached=0', () => {
  assert.equal(arnictCachedTokens({ prompt_tokens_details: { cached_tokens: 7 } } as never), 7);
  assert.equal(arnictCachedTokens({} as never), 0);
  assert.equal(arnictCachedTokens(null), 0);
  assert.equal(arnictCachedTokens(undefined), 0);
  // Miss clamps at zero when hit exceeds prompt_tokens.
  const clamped = computeArnictCost(
    { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 50 }, completion_tokens: 0 } as never,
    'zai/glm-5.3-flash-uncensored',
  );
  assert.equal(clamped, (50 * 0.05) / 1_000_000);
});

ok('cost is 0 for unknown models and missing usage', () => {
  assert.equal(
    computeArnictCost({ prompt_tokens: 100, completion_tokens: 100 } as never, 'nope'),
    0,
  );
  assert.equal(computeArnictCost(null, 'zai/glm-5.3-flash-uncensored'), 0);
  assert.equal(computeArnictCost(undefined, 'zai/glm-5.3-flash-uncensored'), 0);
});

// ---------------------------------------------------------------------------
// Reasoning default + guard message (GC §4 + §5)
// ---------------------------------------------------------------------------

ok("assistantReasoningField(arnict) is the default reasoning field (no arm)", () => {
  assert.equal(assistantReasoningField('arnict'), 'reasoning');
});

ok('tools-unsupported guard message is the exact frozen string', () => {
  assert.equal(
    ARNICT_TOOLS_UNSUPPORTED_MESSAGE,
    'Tool calls are currently supported only with OpenRouter models, not Arnict (Direct).',
  );
});

// ---------------------------------------------------------------------------
// Forbidden (§4/§5/§11: no image guard, no reasoning arm, no ultracode)
// ---------------------------------------------------------------------------

ok('no Arnict large-model guard or reasoning builder is exported', () => {
  const ns = providersNs as unknown as Record<string, unknown>;
  assert.equal(ns['isArnictLargeModel'], undefined);
  assert.equal(ns['buildArnictReasoning'], undefined);
});

ok('ultracode and total_credits never appear in the catalog', () => {
  assert.doesNotMatch(JSON.stringify(ARNICT_CATALOG), /ultracode/);
  assert.doesNotMatch(JSON.stringify(ARNICT_CATALOG), /total_credits/);
  for (const m of ARNICT_CATALOG) {
    assert.doesNotMatch(m.id, /ultracode/);
  }
});

console.log(`arnict provider tests passed (${checks} checks)`);
