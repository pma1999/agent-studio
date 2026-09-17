/**
 * Offline acceptance harness for the arnict.com provider.
 *
 * Routing, flags, endpoint and headers come from the pure provider registry;
 * the catalog (ids, names, contexts, prices, modalities, reasoning) comes from
 * the keyed live `GET /v1/models` payload (schema 2.4) captured 2026-09-16
 * through the catalog normalizer; costs through the shared engine; request
 * fields through the shared reasoning wire (object `reasoning:{enabled,effort}`,
 * keyed verification 2026-09-13).
 *
 * Usage:
 *   npx tsx scripts/test-arnict-provider.ts
 *
 * Offline: no network, no DB.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ARNICT_PREFIX,
  getProviderConfig,
  isArnictModel,
  persistedModelId,
  resolveProviderId,
  toUpstreamModelId,
} from '../server/providers/index.js';
import { arnictCatalogModel, ARNICT_GATEWAY_EFFORTS, type ArnictModelEntry } from '../server/catalog/normalize/arnict.js';
import { chatReasoningFields } from '../server/providers/wire/reasoning.js';
import { cachedTokensFromChat, computeCost, pricedUsageFromChat } from '../shared/models/pricing.js';
import { planReasoning, type ReasoningRequest } from '../shared/models/reasoning.js';

const live = (JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/models/arnict-models.json'), 'utf8')) as { data: ArnictModelEntry[] }).data;
const catalog = live.map((entry) => arnictCatalogModel(entry)!);
const byId = (upstreamId: string) => catalog.find((m) => m.upstreamId === upstreamId)!;

let checks = 0;
function ok(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`ok ${checks} - ${name}`);
}

// ---------------------------------------------------------------------------
// Routing / strip / persist
// ---------------------------------------------------------------------------

ok('resolveProviderId routes namespaced ids to arnict', () => {
  assert.equal(resolveProviderId('arnict:zai/glm-5.3-flash-uncensored'), 'arnict');
  assert.equal(resolveProviderId('arnict:qwen/qwen3.8-27b'), 'arnict');
});

ok('resolveProviderId leaves bare/upstream ids off arnict (prefix is load-bearing)', () => {
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
  assert.equal(isArnictModel('zai/glm-5.3-flash-uncensored'), false);
  assert.equal(isArnictModel(null), false);
});

ok('toUpstreamModelId strips the arnict prefix (keeps the author/slug form)', () => {
  assert.equal(toUpstreamModelId('arnict:zai/glm-5.3-flash-uncensored'), 'zai/glm-5.3-flash-uncensored');
  assert.equal(toUpstreamModelId('arnict:zai/glm-5.3-flash-uncensored/flex'), 'zai/glm-5.3-flash-uncensored/flex');
});

ok('persistedModelId keeps the namespaced id for arnict', () => {
  assert.equal(persistedModelId('arnict', 'arnict:zai/glm-5.3-flash-uncensored', 'zai/glm-5.3-flash-uncensored'), 'arnict:zai/glm-5.3-flash-uncensored');
  assert.equal(persistedModelId('arnict', 'arnict:qwen/qwen3.8-27b', null), 'arnict:qwen/qwen3.8-27b');
  assert.equal(persistedModelId('openrouter', 'org/model', 'variant'), 'variant');
});

ok('ARNICT_PREFIX is the frozen namespaced prefix', () => {
  assert.equal(ARNICT_PREFIX, 'arnict:');
});

// ---------------------------------------------------------------------------
// Provider flags + endpoint + headers
// ---------------------------------------------------------------------------

ok('arnict capability flags: no routing, no plugins, json_schema on', () => {
  const cfg = getProviderConfig('arnict');
  assert.equal(cfg.supportsProviderRouting, false);
  assert.equal(cfg.supportsPlugins, false);
  assert.equal(cfg.supportsJsonSchema, true);
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
// Catalog from the live API
// ---------------------------------------------------------------------------

ok('catalog lists every live id (including the flex tier the static list missed)', () => {
  assert.deepEqual(catalog.map((m) => m.id), [
    'arnict:zai/glm-5.3-flash-uncensored',
    'arnict:qwen/qwen3.8-27b',
    'arnict:zai/glm-5.3-flash-uncensored/flex',
  ]);
  assert.deepEqual(catalog.map((m) => m.name), ['GLM 5.3 Flash Uncensored', 'Qwen: Qwen 3.8 27B', 'GLM 5.3 Flash Uncensored (Flex)']);
});

ok('contexts and output limits come from the modality records', () => {
  assert.deepEqual(catalog.map((m) => m.contextLength), [1048576, 262144, 1048576]);
  assert.deepEqual(catalog.map((m) => m.maxOutputTokens), [131072, 131072, 131072]);
});

ok('prices come from the modality pricing rows (flex at half price, Qwen free)', () => {
  assert.deepEqual(catalog.map((m) => m.pricing?.rates), [
    { input: 0.125, output: 0.5, cacheRead: 0.05 },
    { input: 0, output: 0, cacheRead: 0 },
    { input: 0.0625, output: 0.25, cacheRead: 0.025 },
  ]);
});

ok('every model accepts text and images', () => {
  for (const model of catalog) assert.deepEqual(model.inputModalities, ['text', 'image']);
});

// ---------------------------------------------------------------------------
// Cost through the shared engine
// ---------------------------------------------------------------------------

const costOf = (upstreamId: string, usage: Parameters<typeof pricedUsageFromChat>[0]) =>
  computeCost(byId(upstreamId).pricing, pricedUsageFromChat(usage));

ok('cost spot: GLM 1M prompt + 1M completion = $0.625', () => {
  assert.equal(costOf('zai/glm-5.3-flash-uncensored', { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }), 0.625);
});

ok('cost spot: GLM 1M prompt (250k cached) + 1M completion = $0.60625', () => {
  assert.equal(
    costOf('zai/glm-5.3-flash-uncensored', { prompt_tokens: 1_000_000, prompt_tokens_details: { cached_tokens: 250_000 }, completion_tokens: 1_000_000 }),
    0.60625,
  );
});

ok('cost spot: Qwen is $0 regardless of tokens', () => {
  assert.equal(costOf('qwen/qwen3.8-27b', { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }), 0);
});

ok('cached tokens read details.cached_tokens; miss never negative', () => {
  assert.equal(cachedTokensFromChat({ prompt_tokens_details: { cached_tokens: 7 } }), 7);
  assert.equal(cachedTokensFromChat({}), 0);
  assert.equal(cachedTokensFromChat(undefined), 0);
  assert.equal(costOf('zai/glm-5.3-flash-uncensored', { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 50 }, completion_tokens: 0 }), (50 * 0.05) / 1_000_000);
});

// ---------------------------------------------------------------------------
// Reasoning: live `reasoning` flag + gateway vocabulary, object wire
// ---------------------------------------------------------------------------

const send = (request: ReasoningRequest, opts?: { structuredOutput?: boolean }) => {
  const model = byId('zai/glm-5.3-flash-uncensored');
  return chatReasoningFields(model, planReasoning(model.reasoning, request), opts);
};

ok('capability: gateway vocabulary (host-level), switchable, no budget field', () => {
  const cap = byId('zai/glm-5.3-flash-uncensored').reasoning;
  assert.equal(cap.levelsSource, 'host');
  assert.equal(cap.canDisable, true);
  assert.deepEqual(cap.levels, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(cap.budget, null);
  assert.deepEqual([...ARNICT_GATEWAY_EFFORTS], ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
});

ok('history replays the trace as `reasoning`', () => {
  assert.equal(byId('zai/glm-5.3-flash-uncensored').historyReasoningField, 'reasoning');
});

ok('off and none both send {enabled:false}', () => {
  assert.deepEqual(send({ enabled: false, level: 'high' }), { reasoning: { enabled: false } });
  assert.deepEqual(send({ enabled: true, level: 'none' }), { reasoning: { enabled: false } });
});

for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
  ok(`effort '${effort}' travels inside the reasoning object`, () => {
    assert.deepEqual(send({ enabled: true, level: effort }), { reasoning: { enabled: true, effort } });
  });
}

ok('on without a level (or with garbage) is bare {enabled:true} or a clamped level, never garbage', () => {
  assert.deepEqual(send({ enabled: true }), { reasoning: { enabled: true } });
  assert.deepEqual(send({ enabled: true, level: 'bogus' }), { reasoning: { enabled: true, effort: 'medium' } });
});

ok('structured output forces reasoning off (trace would eat max_tokens)', () => {
  assert.deepEqual(send({ enabled: true, level: 'high' }, { structuredOutput: true }), { reasoning: { enabled: false } });
});

ok('only the reasoning object is ever emitted (no top-level effort, thinking or max_tokens)', () => {
  const cases = [
    send({ enabled: false }),
    send({ enabled: true }),
    ...(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const).map((effort) => send({ enabled: true, level: effort })),
    send({ enabled: true, level: 'high', budget: 4096 }),
  ];
  for (const fields of cases) {
    assert.deepEqual(Object.keys(fields), ['reasoning']);
    for (const key of Object.keys(fields.reasoning as object)) assert.ok(key === 'enabled' || key === 'effort', key);
  }
});

ok('a model without the reasoning parameter sends nothing', () => {
  const plain = arnictCatalogModel({ ...live[0], id: 'x/plain', output_modalities: [{ type: 'text', supported_parameters: {} }] })!;
  assert.deepEqual(chatReasoningFields(plain, planReasoning(plain.reasoning, { enabled: true, level: 'high' })), {});
});

ok('ultracode and total_credits never appear in the catalog', () => {
  assert.doesNotMatch(JSON.stringify(catalog), /ultracode|total_credits/);
});

console.log(`arnict provider tests passed (${checks} checks)`);
