/**
 * Offline acceptance harness for the abliteration.ai provider (5th provider).
 *
 * Pure registry/cost/effort/guard dynamic smoke: imports ONLY the pure
 * `server/providers/index.ts` module (zero db/network imports) and asserts the
 * GC-frozen literals (§§1-6):
 *
 *   routing/strip/persist, flags, catalog ids/contexts/prices, cost spots
 *   (§6), effort matrix (§4), guard message exact, `ultracode` absent.
 *
 * Usage:
 *   npx tsx scripts/test-abliteration-provider.ts
 *
 * Reads no source text, performs no network or DB I/O — offline-safe.
 */
import assert from 'node:assert/strict';
import {
  ABLITERATION_CATALOG,
  ABLITERATION_LARGE_TEXT_ONLY_MESSAGE,
  ABLITERATION_PREFIX,
  abliterationCachedTokens,
  assistantReasoningField,
  buildAbliterationReasoning,
  computeAbliterationCost,
  getProviderConfig,
  isAbliterationLargeModel,
  isAbliterationModel,
  persistedModelId,
  resolveProviderId,
  toUpstreamModelId,
} from '../server/providers/index.js';

let checks = 0;
function ok(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`ok ${checks} - ${name}`);
}

// ---------------------------------------------------------------------------
// Routing / strip / persist (GC §1 + §6 persistedModelId)
// ---------------------------------------------------------------------------

ok('resolveProviderId routes all three namespaced ids to abliteration', () => {
  assert.equal(resolveProviderId('abliteration:abliterated-model'), 'abliteration');
  assert.equal(resolveProviderId('abliteration:abliterated-model-large'), 'abliteration');
  assert.equal(resolveProviderId('abliteration:abliterated-model-large-v2'), 'abliteration');
});

ok('resolveProviderId leaves bare/other ids off abliteration', () => {
  assert.equal(resolveProviderId('abliterated-model'), 'openrouter');
  assert.equal(resolveProviderId('openai/gpt-4o'), 'openrouter');
  assert.equal(resolveProviderId('deepseek:deepseek-chat'), 'deepseek');
  assert.equal(resolveProviderId('codex:gpt-5'), 'codex');
  assert.equal(resolveProviderId('llamacpp:Qwen3'), 'llamacpp');
});

ok('isAbliterationModel classifies both ways', () => {
  assert.equal(isAbliterationModel('abliteration:abliterated-model'), true);
  assert.equal(isAbliterationModel('abliteration:abliterated-model-large-v2'), true);
  assert.equal(isAbliterationModel('abliterated-model'), false);
  assert.equal(isAbliterationModel('openai/gpt-4o'), false);
  assert.equal(isAbliterationModel(null), false);
});

ok('toUpstreamModelId strips the abliteration prefix', () => {
  assert.equal(toUpstreamModelId('abliteration:abliterated-model'), 'abliterated-model');
  assert.equal(toUpstreamModelId('abliteration:abliterated-model-large'), 'abliterated-model-large');
  assert.equal(toUpstreamModelId('abliteration:abliterated-model-large-v2'), 'abliterated-model-large-v2');
});

ok('persistedModelId keeps the namespaced id for abliteration', () => {
  assert.equal(
    persistedModelId('abliteration', 'abliteration:abliterated-model', 'abliterated-model'),
    'abliteration:abliterated-model',
  );
  assert.equal(
    persistedModelId('abliteration', 'abliteration:abliterated-model-large-v2', null),
    'abliteration:abliterated-model-large-v2',
  );
  // Contrast: openrouter records the echoed upstream variant.
  assert.equal(persistedModelId('openrouter', 'org/model', 'variant'), 'variant');
});

ok('ABLITERATION_PREFIX is the frozen namespaced prefix', () => {
  assert.equal(ABLITERATION_PREFIX, 'abliteration:');
});

// ---------------------------------------------------------------------------
// Provider flags + endpoint + headers (GC §1 + §2)
// ---------------------------------------------------------------------------

ok('abliteration capability flags are F,F,F,T', () => {
  const cfg = getProviderConfig('abliteration');
  assert.equal(cfg.supportsProviderRouting, false);
  assert.equal(cfg.supportsPlugins, false);
  assert.equal(cfg.supportsReasoningParam, false);
  assert.equal(cfg.supportsJsonSchema, true);
});

ok('abliteration endpoint + key setting are frozen', () => {
  const cfg = getProviderConfig('abliteration');
  assert.equal(cfg.chatCompletionsUrl, 'https://api.abliteration.ai/v1/chat/completions');
  assert.equal(cfg.apiKeySetting, 'abliteration_api_key');
});

ok('abliteration headers are Bearer-only (no x-api-key/Referer/Title)', () => {
  const headers = getProviderConfig('abliteration').buildHeaders('k123');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(headers['Authorization'], 'Bearer k123');
  assert.equal('x-api-key' in headers, false);
  assert.equal('HTTP-Referer' in headers, false);
  assert.equal('X-Title' in headers, false);
});

// ---------------------------------------------------------------------------
// Catalog (GC §3 frozen static table)
// ---------------------------------------------------------------------------

ok('catalog carries exactly the three frozen ids in order', () => {
  assert.deepEqual(
    ABLITERATION_CATALOG.map((m) => m.id),
    [
      'abliteration:abliterated-model',
      'abliteration:abliterated-model-large',
      'abliteration:abliterated-model-large-v2',
    ],
  );
});

ok('catalog names are frozen', () => {
  assert.deepEqual(
    ABLITERATION_CATALOG.map((m) => m.name),
    ['Abliterated Model', 'Abliterated Model Large', 'Abliterated Model Large V2'],
  );
});

ok('catalog contexts are frozen (262144 / 1M / 1M)', () => {
  assert.deepEqual(
    ABLITERATION_CATALOG.map((m) => m.context_length),
    [262144, 1000000, 1000000],
  );
});

ok('catalog pricing is frozen ($1/$3 base, $3/$5 larges)', () => {
  assert.deepEqual(
    ABLITERATION_CATALOG.map((m) => m.pricing),
    [
      { prompt: '0.000001', completion: '0.000003' },
      { prompt: '0.000003', completion: '0.000005' },
      { prompt: '0.000003', completion: '0.000005' },
    ],
  );
});

ok('catalog descriptions state the text-only restriction for the two larges', () => {
  const [base, large, largeV2] = ABLITERATION_CATALOG;
  assert.match(large.description, /text-only/i);
  assert.match(largeV2.description, /text-only/i);
  assert.match(base.description, /image/i);
});

// ---------------------------------------------------------------------------
// Cost (GC §6 frozen table + hit rule)
// ---------------------------------------------------------------------------

ok('cost spot: base 1M prompt + 1M completion = $4.00', () => {
  const cost = computeAbliterationCost(
    { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } as never,
    'abliterated-model',
  );
  assert.equal(cost, 4);
});

ok('cost spot: large 1M prompt + 1M completion = $8.00 (both larges)', () => {
  for (const id of ['abliterated-model-large', 'abliterated-model-large-v2']) {
    const cost = computeAbliterationCost(
      { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } as never,
      id,
    );
    assert.equal(cost, 8, id);
  }
});

ok('cost spot: 1M cached prompt on base = $0.10', () => {
  const cost = computeAbliterationCost(
    {
      prompt_tokens: 1_000_000,
      prompt_tokens_details: { cached_tokens: 1_000_000 },
      completion_tokens: 0,
    } as never,
    'abliterated-model',
  );
  assert.equal(cost, 0.1);
});

ok('cost hit rule prefers details.cached_tokens, falls back to prompt_cache_hit_tokens', () => {
  assert.equal(
    abliterationCachedTokens({ prompt_tokens_details: { cached_tokens: 7 }, prompt_cache_hit_tokens: 3 } as never),
    7,
  );
  assert.equal(abliterationCachedTokens({ prompt_cache_hit_tokens: 3 } as never), 3);
  assert.equal(abliterationCachedTokens(null), 0);
  // Miss clamps at zero when hit exceeds prompt_tokens.
  const clamped = computeAbliterationCost(
    { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 50 }, completion_tokens: 0 } as never,
    'abliterated-model',
  );
  assert.equal(clamped, (50 * 0.1) / 1_000_000);
});

ok('cost is 0 for unknown models and missing usage', () => {
  assert.equal(
    computeAbliterationCost({ prompt_tokens: 100, completion_tokens: 100 } as never, 'nope'),
    0,
  );
  assert.equal(computeAbliterationCost(null, 'abliterated-model'), 0);
  assert.equal(computeAbliterationCost(undefined, 'abliterated-model'), 0);
});

// ---------------------------------------------------------------------------
// Reasoning arm (GC §4 frozen matrix)
// ---------------------------------------------------------------------------

ok('assistantReasoningField(abliteration) is the default reasoning field', () => {
  assert.equal(assistantReasoningField('abliteration'), 'reasoning');
});

ok('effort matrix: toggle on sends every allowed effort verbatim', () => {
  for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.deepEqual(buildAbliterationReasoning(true, effort), { reasoning_effort: effort }, effort);
  }
});

ok('effort matrix: off/none/unknown/garbage/ultracode omit the field (fail-safe)', () => {
  assert.deepEqual(buildAbliterationReasoning(false, 'high'), {});
  for (const effort of ['none', null, undefined, 'ULTRA', 'ultra', 'ultracode', '', 'banana', 'max ']) {
    assert.deepEqual(buildAbliterationReasoning(true, effort as never), {}, String(effort));
  }
});

ok('effort arm never emits reasoning-object/thinking/include_reasoning/max_tokens', () => {
  const body = buildAbliterationReasoning(true, 'high');
  assert.deepEqual(Object.keys(body), ['reasoning_effort']);
});

// ---------------------------------------------------------------------------
// Guard + ultracode absence (GC §5 + §11)
// ---------------------------------------------------------------------------

ok('large-model guard message is the exact frozen string', () => {
  assert.equal(
    ABLITERATION_LARGE_TEXT_ONLY_MESSAGE,
    'Abliteration large models are text-only; use abliteration:abliterated-model for image content.',
  );
});

ok('isAbliterationLargeModel is true only for the two large upstream ids', () => {
  assert.equal(isAbliterationLargeModel('abliterated-model-large'), true);
  assert.equal(isAbliterationLargeModel('abliterated-model-large-v2'), true);
  assert.equal(isAbliterationLargeModel('abliterated-model'), false);
  assert.equal(isAbliterationLargeModel(null), false);
});

ok('ultracode is absent from the catalog and never emitted by the effort arm', () => {
  assert.doesNotMatch(JSON.stringify(ABLITERATION_CATALOG), /ultracode/);
  for (const m of ABLITERATION_CATALOG) {
    assert.doesNotMatch(m.id, /ultracode/);
  }
  assert.deepEqual(buildAbliterationReasoning(true, 'ultracode'), {});
});

console.log(`abliteration provider tests passed (${checks} checks)`);
