/**
 * Offline acceptance harness for the abliteration.ai provider.
 *
 * Routing, flags, endpoint and headers come from the pure provider registry;
 * the catalog (names, contexts, prices, modalities, reasoning levels) comes
 * from the live `GET /v1/models` payload captured 2026-09-16 plus models.dev,
 * through the same normalizer the catalog adapter uses; costs through the
 * shared engine; request fields through the shared reasoning wire.
 *
 * Usage:
 *   npx tsx scripts/test-abliteration-provider.ts
 *
 * Offline: no network, no DB.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ABLITERATION_PREFIX,
  getProviderConfig,
  isAbliterationModel,
  persistedModelId,
  resolveProviderId,
  textOnlyModelMessage,
  toUpstreamModelId,
} from '../server/providers/index.js';
import { abliterationCatalogModel, type AbliterationModelEntry } from '../server/catalog/normalize/abliteration.js';
import type { ModelsDevProvider } from '../server/catalog/normalize/modelsDev.js';
import { chatReasoningFields } from '../server/providers/wire/reasoning.js';
import { cachedTokensFromChat, computeCost, pricedUsageFromChat } from '../shared/models/pricing.js';
import { planReasoning } from '../shared/models/reasoning.js';

const FIXTURES = resolve(import.meta.dirname, 'fixtures/models');
const live = (JSON.parse(readFileSync(resolve(FIXTURES, 'abliteration-models.json'), 'utf8')) as { data: AbliterationModelEntry[] }).data;
const modelsDev = (JSON.parse(readFileSync(resolve(FIXTURES, 'modelsdev-api.json'), 'utf8')) as Record<string, ModelsDevProvider>)['abliteration-ai'];
const catalog = live.map((entry) => abliterationCatalogModel(entry, modelsDev.models[entry.id!])!);
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
  assert.equal(toUpstreamModelId('abliteration:abliterated-model-large-v2'), 'abliterated-model-large-v2');
});

ok('persistedModelId keeps the namespaced id for abliteration', () => {
  assert.equal(persistedModelId('abliteration', 'abliteration:abliterated-model', 'abliterated-model'), 'abliteration:abliterated-model');
  assert.equal(persistedModelId('abliteration', 'abliteration:abliterated-model-large-v2', null), 'abliteration:abliterated-model-large-v2');
  assert.equal(persistedModelId('openrouter', 'org/model', 'variant'), 'variant');
});

ok('ABLITERATION_PREFIX is the frozen namespaced prefix', () => {
  assert.equal(ABLITERATION_PREFIX, 'abliteration:');
});

// ---------------------------------------------------------------------------
// Provider flags + endpoint + headers
// ---------------------------------------------------------------------------

ok('abliteration capability flags: no routing, no plugins, JSON schema supported', () => {
  const cfg = getProviderConfig('abliteration');
  assert.equal(cfg.supportsProviderRouting, false);
  assert.equal(cfg.supportsPlugins, false);
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
// Catalog from the live API
// ---------------------------------------------------------------------------

ok('catalog lists the live ids with their API names', () => {
  assert.deepEqual(catalog.map((m) => m.id), [
    'abliteration:abliterated-model',
    'abliteration:abliterated-model-large',
    'abliteration:abliterated-model-large-v2',
  ]);
  assert.deepEqual(catalog.map((m) => m.name), ['Abliterated Model', 'Abliterated Large', 'Abliterated Large v2']);
});

ok('contexts and output limits come from the API', () => {
  assert.deepEqual(catalog.map((m) => m.contextLength), [262144, 1000000, 1000000]);
  assert.deepEqual(catalog.map((m) => m.maxOutputTokens), [262134, 999990, 999990]);
});

ok('prices come from the API ($1/$3 base, $3/$5 larges, cached reads at 10%)', () => {
  assert.deepEqual(catalog.map((m) => m.pricing?.rates), [
    { input: 1, output: 3, cacheRead: 0.1 },
    { input: 3, output: 5, cacheRead: 0.3 },
    { input: 3, output: 5, cacheRead: 0.3 },
  ]);
});

ok('modalities: base accepts images, both larges are text-only', () => {
  assert.deepEqual(byId('abliterated-model').inputModalities, ['text', 'image']);
  assert.deepEqual(byId('abliterated-model-large').inputModalities, ['text']);
  assert.deepEqual(byId('abliterated-model-large-v2').inputModalities, ['text']);
});

ok('models the account cannot use are not listed', () => {
  const locked = { ...live[0], id: 'abliterated-model-locked', access: { available: false, locked: true } };
  assert.equal(abliterationCatalogModel(locked, undefined), null);
});

// ---------------------------------------------------------------------------
// Cost through the shared engine
// ---------------------------------------------------------------------------

const costOf = (upstreamId: string, usage: Parameters<typeof pricedUsageFromChat>[0]) =>
  computeCost(byId(upstreamId).pricing, pricedUsageFromChat(usage));

ok('cost spot: base 1M prompt + 1M completion = $4.00', () => {
  assert.equal(costOf('abliterated-model', { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }), 4);
});

ok('cost spot: large 1M prompt + 1M completion = $8.00 (both larges)', () => {
  for (const id of ['abliterated-model-large', 'abliterated-model-large-v2']) {
    assert.equal(costOf(id, { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }), 8, id);
  }
});

ok('cost spot: 1M cached prompt on base = $0.10', () => {
  assert.equal(costOf('abliterated-model', { prompt_tokens: 1_000_000, prompt_tokens_details: { cached_tokens: 1_000_000 }, completion_tokens: 0 }), 0.1);
});

ok('cached tokens prefer prompt_cache_hit_tokens, fall back to details; miss never negative', () => {
  assert.equal(cachedTokensFromChat({ prompt_tokens_details: { cached_tokens: 7 } }), 7);
  assert.equal(cachedTokensFromChat({ prompt_cache_hit_tokens: 3 }), 3);
  assert.equal(cachedTokensFromChat(null), 0);
  const clamped = costOf('abliterated-model', { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 50 }, completion_tokens: 0 });
  assert.equal(clamped, (50 * 0.1) / 1_000_000);
});

ok('no pricing or no usage costs nothing', () => {
  assert.equal(computeCost(null, pricedUsageFromChat({ prompt_tokens: 100, completion_tokens: 100 })), 0);
  assert.equal(computeCost(byId('abliterated-model').pricing, null), 0);
});

// ---------------------------------------------------------------------------
// Reasoning (docs.abliteration.ai/capabilities/thinking)
// ---------------------------------------------------------------------------

const send = (upstreamId: string, request: Parameters<typeof planReasoning>[1]) => {
  const model = byId(upstreamId);
  return chatReasoningFields(model, planReasoning(model.reasoning, request));
};

ok('history replays the trace as `reasoning`', () => {
  for (const model of catalog) assert.equal(model.historyReasoningField, 'reasoning');
});

ok('base model: every level is sent verbatim', () => {
  for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.deepEqual(send('abliterated-model', { enabled: true, level: effort }), { reasoning_effort: effort }, effort);
  }
});

ok('large models: levels clamp to the modes the docs list', () => {
  assert.deepEqual(send('abliterated-model-large', { enabled: true, level: 'medium' }), { reasoning_effort: 'high' });
  assert.deepEqual(send('abliterated-model-large', { enabled: true, level: 'xhigh' }), { reasoning_effort: 'high' });
  assert.deepEqual(send('abliterated-model-large-v2', { enabled: true, level: 'medium' }), { reasoning_effort: 'low' });
  assert.deepEqual(send('abliterated-model-large-v2', { enabled: true, level: 'max' }), { reasoning_effort: 'max' });
});

ok('off: none where the model allows it; large-v2 always reasons (lowest mode)', () => {
  assert.deepEqual(send('abliterated-model', { enabled: false }), { reasoning_effort: 'none' });
  assert.deepEqual(send('abliterated-model-large', { enabled: false }), { reasoning_effort: 'none' });
  assert.deepEqual(send('abliterated-model-large-v2', { enabled: false }), { reasoning_effort: 'low' });
});

ok('on without a level omits the field (host default depth)', () => {
  assert.deepEqual(send('abliterated-model', { enabled: true }), {});
});

ok('garbage and ultracode never reach the wire; only reasoning_effort is ever emitted', () => {
  for (const effort of ['ULTRA', 'ultra', 'ultracode', '', 'banana', 'max ']) {
    const fields = send('abliterated-model', { enabled: true, level: effort });
    assert.doesNotMatch(JSON.stringify(fields), /ultra|banana/, effort);
    assert.ok(Object.keys(fields).every((k) => k === 'reasoning_effort'), effort);
  }
  assert.doesNotMatch(JSON.stringify(catalog), /ultracode/);
});

// ---------------------------------------------------------------------------
// Text-only guard
// ---------------------------------------------------------------------------

ok('text-only guard message names the model', () => {
  assert.equal(
    textOnlyModelMessage(byId('abliterated-model-large').name),
    'Abliterated Large is text-only; choose a model that accepts images for image content.',
  );
});

console.log(`abliteration provider tests passed (${checks} checks)`);
