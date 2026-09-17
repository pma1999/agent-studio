/**
 * Offline acceptance harness for the OpenCode Go provider.
 *
 * Routing, flags, endpoints and headers come from the pure provider registry.
 * Everything else is derived, exactly as production does it, from three
 * captured sources (2026-09-16): the keyless live `GET /v1/models` id list,
 * the models.dev `opencode-go` entries and the official docs markdown
 * (`https://opencode.ai/docs/go.md`). Costs go through the shared pricing
 * engine, request fields through the shared reasoning wire — one wire per
 * transport, chosen by the catalog and never by a hand-written id list.
 *
 * Usage:
 *   npx tsx scripts/test-opencode-go-provider.ts
 *
 * Offline: no network, no DB.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  OPENCODE_GO_ANTHROPIC_VERSION,
  OPENCODE_GO_BASE_URL,
  OPENCODE_GO_CHAT_COMPLETIONS_URL,
  OPENCODE_GO_DOCS_URL,
  OPENCODE_GO_MESSAGES_URL,
  OPENCODE_GO_PREFIX,
  OPENCODE_GO_RESPONSES_URL,
  OPENCODE_GO_USER_AGENT,
  OPENCODE_GO_VALIDATE_MODEL,
  getProviderConfig,
  isOpencodeGoModel,
  opencodeGoFormatMismatchMessage,
  persistedModelId,
  resolveProviderId,
  toUpstreamModelId,
} from '../server/providers/index.js';
import type { ModelsDevProvider } from '../server/catalog/normalize/modelsDev.js';
import {
  isOfferedByOpencodeGo,
  opencodeGoCatalogModel,
  parseOpencodeGoDocs,
} from '../server/catalog/normalize/opencodeGo.js';
import {
  chatReasoningFields,
  messagesThinkingFields,
  responsesReasoning,
} from '../server/providers/wire/reasoning.js';
import { computeCost, pricedUsageFromChat } from '../shared/models/pricing.js';
import { planReasoning, type ReasoningRequest } from '../shared/models/reasoning.js';
import type { CatalogModel } from '../shared/models/catalog.js';

const FIXTURES = resolve(import.meta.dirname, 'fixtures/models');
const raw = (name: string) => readFileSync(resolve(FIXTURES, name), 'utf8');

const liveIds = (JSON.parse(raw('opencode-go-models.json')) as { data: Array<{ id: string }> }).data.map((e) => e.id);
const modelsDev = (JSON.parse(raw('modelsdev-api.json')) as Record<string, ModelsDevProvider>)['opencode-go'];
const docs = parseOpencodeGoDocs(raw('opencode-go-docs.md'));

const catalog: CatalogModel[] = liveIds
  .filter((id) => isOfferedByOpencodeGo(modelsDev.models[id], id, docs))
  .map((id) => opencodeGoCatalogModel(
    id,
    modelsDev.models[id],
    modelsDev,
    docs,
    modelsDev.models[id]?.status === 'deprecated' ? 'deprecated' : 'active',
  ));
const byId = (upstreamId: string): CatalogModel => {
  const model = catalog.find((m) => m.upstreamId === upstreamId);
  assert.ok(model, `${upstreamId} present in the catalog`);
  return model!;
};

let checks = 0;
function ok(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`ok ${checks} - ${name}`);
}

// ---------------------------------------------------------------------------
// Routing / strip / persist
// ---------------------------------------------------------------------------

ok('resolveProviderId routes namespaced Go ids to opencode-go', () => {
  assert.equal(resolveProviderId('opencode-go:kimi-k3'), 'opencode-go');
  assert.equal(resolveProviderId('opencode-go:minimax-m2.7'), 'opencode-go');
  assert.equal(resolveProviderId('opencode-go:grok-4.6'), 'opencode-go');
});

ok('resolveProviderId leaves bare/upstream ids off Go (prefix is load-bearing)', () => {
  assert.equal(resolveProviderId('kimi-k3'), 'openrouter');
  assert.equal(resolveProviderId('openai/gpt-4o'), 'openrouter');
  assert.equal(resolveProviderId('deepseek:deepseek-chat'), 'deepseek');
  assert.equal(resolveProviderId('codex:gpt-5'), 'codex');
  assert.equal(resolveProviderId('llamacpp:Qwen3'), 'llamacpp');
  assert.equal(resolveProviderId('abliteration:abliterated-model'), 'abliteration');
  assert.equal(resolveProviderId('arnict:zai/glm-5.3-flash-uncensored'), 'arnict');
});

ok('isOpencodeGoModel classifies both ways', () => {
  assert.equal(isOpencodeGoModel('opencode-go:kimi-k3'), true);
  assert.equal(isOpencodeGoModel('opencode-go:grok-4.6'), true);
  assert.equal(isOpencodeGoModel('kimi-k3'), false);
  assert.equal(isOpencodeGoModel('openai/gpt-4o'), false);
  assert.equal(isOpencodeGoModel(null), false);
});

ok('toUpstreamModelId strips the opencode-go prefix', () => {
  assert.equal(toUpstreamModelId('opencode-go:kimi-k3'), 'kimi-k3');
  assert.equal(toUpstreamModelId('opencode-go:minimax-m2.7'), 'minimax-m2.7');
});

ok('persistedModelId keeps the namespaced id for opencode-go', () => {
  assert.equal(persistedModelId('opencode-go', 'opencode-go:kimi-k3', 'kimi-k3'), 'opencode-go:kimi-k3');
  assert.equal(persistedModelId('opencode-go', 'opencode-go:grok-4.6', null), 'opencode-go:grok-4.6');
  assert.equal(persistedModelId('openrouter', 'org/model', 'variant'), 'variant');
});

ok('OPENCODE_GO_PREFIX is the frozen namespaced prefix', () => {
  assert.equal(OPENCODE_GO_PREFIX, 'opencode-go:');
});

// ---------------------------------------------------------------------------
// Provider flags + endpoints + headers
// ---------------------------------------------------------------------------

ok('opencode-go capability flags: no routing, no plugins, no json_schema', () => {
  const cfg = getProviderConfig('opencode-go');
  assert.equal(cfg.supportsProviderRouting, false);
  assert.equal(cfg.supportsPlugins, false);
  assert.equal(cfg.supportsJsonSchema, false);
});

ok('opencode-go endpoint + label + key setting are frozen', () => {
  const cfg = getProviderConfig('opencode-go');
  assert.equal(cfg.id, 'opencode-go');
  assert.equal(cfg.label, 'OpenCode Go');
  assert.equal(cfg.chatCompletionsUrl, 'https://opencode.ai/zen/go/v1/chat/completions');
  assert.equal(cfg.apiKeySetting, 'opencode_go_api_key');
});

ok('opencode-go URL constants are frozen (canonical /zen/go/v1, no trailing slash)', () => {
  assert.equal(OPENCODE_GO_BASE_URL, 'https://opencode.ai/zen/go/v1');
  assert.equal(OPENCODE_GO_CHAT_COMPLETIONS_URL, 'https://opencode.ai/zen/go/v1/chat/completions');
  assert.equal(OPENCODE_GO_MESSAGES_URL, 'https://opencode.ai/zen/go/v1/messages');
  assert.equal(OPENCODE_GO_RESPONSES_URL, 'https://opencode.ai/zen/go/v1/responses');
  assert.equal(OPENCODE_GO_ANTHROPIC_VERSION, '2023-06-01');
  assert.equal(OPENCODE_GO_USER_AGENT, 'agent-studio/1.0');
  assert.equal(OPENCODE_GO_DOCS_URL, 'https://opencode.ai/docs/go/');
  assert.equal(OPENCODE_GO_VALIDATE_MODEL, 'mimo-v2.5');
});

ok('opencode-go headers are Bearer + User-Agent (no x-api-key/Referer/Title)', () => {
  const headers = getProviderConfig('opencode-go').buildHeaders('k123');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(headers['Authorization'], 'Bearer k123');
  assert.equal(headers['User-Agent'], 'agent-studio/1.0');
  assert.equal('x-api-key' in headers, false);
  assert.equal('HTTP-Referer' in headers, false);
  assert.equal('X-Title' in headers, false);
});

// ---------------------------------------------------------------------------
// Docs parsing: the two tables the catalog depends on
// ---------------------------------------------------------------------------

ok('docs endpoint table yields a transport per listed id', () => {
  assert.equal(docs.endpoints.size, 29);
  assert.equal(docs.endpoints.get('kimi-k3'), 'chat');
  assert.equal(docs.endpoints.get('minimax-m3'), 'messages');
  assert.equal(docs.endpoints.get('qwen3.7-plus'), 'messages');
  assert.equal(docs.endpoints.get('grok-4.6'), 'responses');
  assert.equal(docs.endpoints.get('union-alpha'), 'messages');
  assert.equal(docs.endpoints.has('grok-4.5'), false, 'retired ids leave the table');
});

ok('docs price table yields the base band per model (off-peak, below the tier, "-" is not a rate)', () => {
  // Go publishes its own prices: they win field by field over the aggregator.
  assert.deepEqual(docs.rates.get('minimax-m2.7'), { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 });
  // DeepSeek: the off-peak row is the base; the peak row is the schedule's x2.
  assert.deepEqual(docs.rates.get('deepseek-v4-pro'), { input: 0.66, output: 1.98, cacheRead: 0.022 });
  // Tiered: the "<= 256K" row is the base; models.dev carries the upper tier.
  assert.deepEqual(docs.rates.get('qwen3.7-plus'), { input: 0.4, output: 1.6, cacheRead: 0.04, cacheWrite: 0.5 });
  // "-" means not published, never free: `computeCost` must fall back to input.
  assert.equal('cacheWrite' in (docs.rates.get('kimi-k3') ?? {}), false);
  assert.deepEqual(docs.rates.get('union-alpha'), { input: 0, output: 0, cacheRead: 0 }, 'Free is a real zero');
});

ok('published rates override the aggregator; tiers and peak keep their own source', () => {
  // models.dev lists no cache-write rate for MiniMax and lags M2.5 cached reads.
  assert.deepEqual(byId('minimax-m2.7').pricing?.rates, { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 });
  assert.deepEqual(byId('minimax-m2.5').pricing?.rates, { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 });
  // Structure untouched: the 512K tier exists only in models.dev.
  assert.deepEqual(byId('minimax-m3').pricing?.tiers, [
    { aboveContextTokens: 512000, rates: { input: 0.6, output: 2.4, cacheRead: 0.12 } },
  ]);
  assert.equal(byId('minimax-m3').pricing?.source, 'models.dev');
});

ok('docs usage-limits table yields monthly caps, promos read the live amount, unlimited is null', () => {
  assert.equal(docs.monthlyLimits.get('kimi-k3'), 15);
  assert.equal(docs.monthlyLimits.get('glm-5.3-flash'), 60);
  assert.equal(docs.monthlyLimits.get('hy4-preview'), 30);
  // "~~$15~~ **$60** · 4x · Ends Sep 20": the struck-through old cap is ignored.
  assert.equal(docs.monthlyLimits.get('deepseek-v4.1-flash'), 60);
  assert.equal(docs.monthlyLimits.get('union-alpha'), null);
});

ok('a docs markdown without the tables degrades to empty maps instead of throwing', () => {
  const empty = parseOpencodeGoDocs('# Go\n\nNo tables here.\n');
  assert.equal(empty.endpoints.size, 0);
  assert.equal(empty.monthlyLimits.size, 0);
  assert.equal(empty.rates.size, 0);
});

// ---------------------------------------------------------------------------
// Catalog: live ids ∩ what Go still offers
// ---------------------------------------------------------------------------

ok('catalog is the live list minus the models Go no longer offers', () => {
  assert.equal(liveIds.length, 38);
  assert.equal(catalog.length, 29);
  for (const hidden of ['grok-4.5', 'glm-5', 'kimi-k2.5', 'hy3-preview', 'deepseek-flash', 'omen-alpha', 'qwen3.5-plus', 'mimo-v2-pro', 'ox-alpha-free']) {
    assert.equal(catalog.some((m) => m.upstreamId === hidden), false, hidden);
  }
  // A model added upstream after this code was written needs no code change.
  assert.equal(byId('union-alpha').name, 'Union Alpha Free');
  // Deprecated but still served: kept, and marked.
  assert.equal(byId('minimax-m2.5').lifecycle, 'deprecated');
  assert.equal(byId('kimi-k3').lifecycle, 'active');
});

ok('ids are namespaced, names and descriptions come from models.dev', () => {
  for (const model of catalog) {
    assert.equal(model.id, `opencode-go:${model.upstreamId}`);
    assert.equal(model.provider, 'opencode-go');
    assert.ok(model.name.length > 0, model.upstreamId);
  }
  assert.equal(byId('kimi-k3').name, 'Kimi K3');
  assert.equal(byId('deepseek-v4-pro').name, 'DeepSeek V4 Pro (New)');
  assert.equal(byId('gpt-5.6-luna').name, 'GPT-5.6 Luna');
});

ok('transport: docs endpoint table decides, per-model SDK package wins over it', () => {
  const transports = new Map(catalog.map((m) => [m.upstreamId, m.transport]));
  for (const id of ['kimi-k3', 'glm-5.3-flash', 'deepseek-v4-pro', 'mimo-v2.5', 'hy3', 'longcat-2.0']) {
    assert.equal(transports.get(id), 'chat', id);
  }
  for (const id of ['minimax-m3', 'minimax-m2.7', 'qwen3.8-max', 'qwen3.7-plus', 'union-alpha']) {
    assert.equal(transports.get(id), 'messages', id);
  }
  for (const id of ['grok-4.6', 'gpt-5.6-luna', 'muse-spark-1.3-contributor']) {
    assert.equal(transports.get(id), 'responses', id);
  }
  assert.deepEqual(
    [...new Set(catalog.map((m) => m.transport))].sort(),
    ['chat', 'messages', 'responses'],
  );
});

ok('contexts, output limits and modalities come from models.dev', () => {
  assert.deepEqual(
    [byId('kimi-k3'), byId('glm-5.1'), byId('grok-4.6')].map((m) => [m.contextLength, m.maxOutputTokens]),
    [[1048576, 131072], [202752, 32768], [500000, 500000]],
  );
  assert.deepEqual(byId('glm-5.3').inputModalities, ['text']);
  assert.deepEqual(byId('kimi-k3').inputModalities, ['text', 'image', 'video']);
  assert.deepEqual(byId('mimo-v2.5').inputModalities, ['text', 'image', 'audio', 'video']);
});

ok('monthly limits ride along from the docs (null = unlimited)', () => {
  assert.equal(byId('kimi-k3').monthlyLimitUsd, 15);
  assert.equal(byId('mimo-v2.5').monthlyLimitUsd, 60);
  assert.equal(byId('qwen3.8-flash').monthlyLimitUsd, 30);
  assert.equal(byId('union-alpha').monthlyLimitUsd, null);
});

ok('history replay field is per model (reasoning_content where the host emits it)', () => {
  assert.equal(byId('kimi-k3').historyReasoningField, 'reasoning_content');
  assert.equal(byId('deepseek-v4-pro').historyReasoningField, 'reasoning_content');
  assert.equal(byId('glm-5.3-flash').historyReasoningField, 'reasoning_content');
  assert.equal(byId('hy3').historyReasoningField, 'reasoning');
  assert.equal(byId('grok-4.6').historyReasoningField, 'reasoning');
  assert.equal(byId('minimax-m3').historyReasoningField, 'reasoning');
});

// ---------------------------------------------------------------------------
// Pricing through the shared engine (docs/models.dev rates, $/1M)
// ---------------------------------------------------------------------------

const costOf = (
  upstreamId: string,
  usage: Parameters<typeof pricedUsageFromChat>[0],
  ctx?: { contextTokens?: number; at?: Date },
) => computeCost(byId(upstreamId).pricing, pricedUsageFromChat(usage), ctx);

const OFF_PEAK = new Date('2026-09-16T12:00:00Z'); // Wednesday noon UTC
const PEAK = new Date('2026-09-16T02:00:00Z'); // Wednesday 02:00 UTC

ok('cost spot: kimi-k3 1000 prompt + 500 completion = $0.0105', () => {
  assert.equal(costOf('kimi-k3', { prompt_tokens: 1000, completion_tokens: 500 }, { at: OFF_PEAK }), 0.0105);
});

ok('cost spot: cached reads bill at the cached rate, in either usage shape', () => {
  const expected = 9825 / 1_000_000;
  const viaHit = costOf('kimi-k3', { prompt_tokens: 1000, prompt_cache_hit_tokens: 250, completion_tokens: 500 }, { at: OFF_PEAK });
  const viaDetails = costOf('kimi-k3', { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 250 }, completion_tokens: 500 }, { at: OFF_PEAK });
  assert.ok(Math.abs(viaHit - expected) < 1e-12, `${viaHit} ~= ${expected}`);
  assert.ok(Math.abs(viaDetails - expected) < 1e-12, `${viaDetails} ~= ${expected}`);
});

ok('cost: cache writes bill at the write rate, or at input when the host publishes none', () => {
  // MiniMax M2.7: in 0.30, read 0.06, out 1.20, write (docs) 0.375.
  const written = costOf('minimax-m2.7', { prompt_tokens: 1000, prompt_cache_write_tokens: 200, completion_tokens: 100 }, { at: OFF_PEAK });
  assert.ok(Math.abs(written - 435 / 1_000_000) < 1e-12, `${written} ~= ${435 / 1_000_000}`);
  // Kimi K3 publishes no write rate: writes bill as input (3.00).
  const fallback = costOf('kimi-k3', { prompt_tokens: 1000, prompt_cache_write_tokens: 200, completion_tokens: 0 }, { at: OFF_PEAK });
  assert.ok(Math.abs(fallback - 3000 / 1_000_000) < 1e-12, `${fallback} ~= ${3000 / 1_000_000}`);
});

ok('cost: context tiers bill above the threshold; the threshold itself stays on the base tier', () => {
  const out1M = { prompt_tokens: 0, completion_tokens: 1_000_000 };
  const cases: Array<[string, number, number, number]> = [
    ['qwen3.7-plus', 1.6, 4.8, 256000],
    ['qwen3.6-plus', 3, 6, 256000],
    ['gpt-5.6-luna', 1.2, 1.8, 272000],
    ['grok-4.6', 6, 12, 200000],
    ['minimax-m3', 1.2, 2.4, 512000],
  ];
  for (const [id, base, above, upTo] of cases) {
    assert.equal(costOf(id, out1M, { at: OFF_PEAK }), base, `${id} without context`);
    assert.equal(costOf(id, out1M, { contextTokens: upTo, at: OFF_PEAK }), base, `${id} at the edge`);
    assert.equal(costOf(id, out1M, { contextTokens: upTo + 1, at: OFF_PEAK }), above, `${id} above`);
  }
  // Reads and writes follow the tier too (each tier is a whole absolute row).
  const read1M = { prompt_tokens: 1_000_000, prompt_cache_hit_tokens: 1_000_000, completion_tokens: 0 };
  assert.equal(costOf('grok-4.6', read1M, { contextTokens: 200001, at: OFF_PEAK }), 1);
  const write1M = { prompt_tokens: 0, prompt_cache_write_tokens: 1_000_000, completion_tokens: 0 };
  assert.equal(costOf('qwen3.7-plus', write1M, { contextTokens: 256000, at: OFF_PEAK }), 0.5);
  assert.equal(costOf('qwen3.7-plus', write1M, { contextTokens: 256001, at: OFF_PEAK }), 1.5);
});

ok('cost: only the DeepSeek family carries the peak schedule, and it doubles every rate', () => {
  const peaked = catalog.filter((m) => m.pricing?.peak).map((m) => m.upstreamId).sort();
  assert.deepEqual(peaked, ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro', 'deepseek-v4.1-flash']);
  const usage = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 };
  assert.equal(costOf('deepseek-v4-pro', usage, { at: OFF_PEAK }), 2.64);
  assert.equal(costOf('deepseek-v4-pro', usage, { at: PEAK }), 5.28);
  const read1M = { prompt_tokens: 1_000_000, prompt_cache_hit_tokens: 1_000_000, completion_tokens: 0 };
  assert.equal(costOf('deepseek-v4-flash', read1M, { at: PEAK }), 0.006);
  // Peak is Mon-Fri only: the same hour on Saturday bills off-peak.
  assert.equal(costOf('deepseek-v4-pro', usage, { at: new Date('2026-09-19T02:00:00Z') }), 2.64);
  // …and so does an hour outside the two windows on a weekday.
  assert.equal(costOf('deepseek-v4-pro', usage, { at: new Date('2026-09-16T05:00:00Z') }), 2.64);
});

ok('cost: a free model stays free and a missing usage costs nothing', () => {
  assert.equal(costOf('union-alpha', { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }, { at: OFF_PEAK }), 0);
  assert.equal(computeCost(byId('kimi-k3').pricing, null), 0);
  assert.equal(computeCost(null, pricedUsageFromChat({ prompt_tokens: 100, completion_tokens: 100 })), 0);
});

// ---------------------------------------------------------------------------
// Reasoning: one capability per model, one wire per transport
// ---------------------------------------------------------------------------

const plan = (upstreamId: string, request: ReasoningRequest) => planReasoning(byId(upstreamId).reasoning, request);
const chat = (upstreamId: string, request: ReasoningRequest) => chatReasoningFields(byId(upstreamId), plan(upstreamId, request));
const messages = (upstreamId: string, request: ReasoningRequest) => messagesThinkingFields(byId(upstreamId), plan(upstreamId, request));
const responses = (upstreamId: string, request: ReasoningRequest) => responsesReasoning(byId(upstreamId), plan(upstreamId, request));

ok('capabilities are per model, never per provider', () => {
  const cap = (id: string) => byId(id).reasoning;
  // Always on, no gradation: the UI shows no control at all.
  assert.deepEqual([cap('mimo-v2.5').levels, cap('mimo-v2.5').canDisable], [[], false]);
  // One level only: on at max, no switch.
  assert.deepEqual([cap('kimi-k3').levels, cap('kimi-k3').canDisable], [['max'], false]);
  // Graded, not switchable.
  assert.deepEqual(cap('glm-5.3-flash').levels, ['low', 'high', 'max']);
  assert.deepEqual(cap('deepseek-v4-pro').levels, ['high', 'max']);
  // Switchable + graded.
  assert.deepEqual([cap('hy3').levels, cap('hy3').canDisable], [['low', 'high'], true]);
  assert.deepEqual([cap('gpt-5.6-luna').levels, cap('gpt-5.6-luna').canDisable], [['low', 'medium', 'high', 'xhigh', 'max'], true]);
  // Switchable with a token budget instead of levels.
  assert.deepEqual([cap('qwen3.7-plus').levels, cap('qwen3.7-plus').budget], [[], { min: null, max: 262144 }]);
  for (const model of catalog) assert.equal(model.reasoning.levelsSource, 'model', model.upstreamId);
});

ok('chat wire: reasoning_effort only, clamped down to the nearest level the model has', () => {
  // The clamp never spends more than asked: it falls to the nearest lower
  // level, and only climbs when the model has nothing below.
  assert.deepEqual(chat('glm-5.3-flash', { enabled: true, level: 'medium' }), { reasoning_effort: 'low' });
  assert.deepEqual(chat('glm-5.3-flash', { enabled: true, level: 'xhigh' }), { reasoning_effort: 'high' });
  assert.deepEqual(chat('glm-5.3-flash', { enabled: true, level: 'max' }), { reasoning_effort: 'max' });
  assert.deepEqual(chat('hy3', { enabled: true, level: 'max' }), { reasoning_effort: 'high' });
  assert.deepEqual(chat('kimi-k3', { enabled: true, level: 'low' }), { reasoning_effort: 'max' }, 'the only level it has');
  assert.deepEqual(chat('deepseek-v4-pro', { enabled: true, level: 'minimal' }), { reasoning_effort: 'high' });
});

ok('chat wire: off only where the host lists none; always-on models send nothing', () => {
  assert.deepEqual(chat('hy3', { enabled: false }), { reasoning_effort: 'none' });
  assert.deepEqual(chat('hy4-preview', { enabled: false }), { reasoning_effort: 'none' });
  // Not switchable: forced on at its lowest level instead of a bogus none.
  assert.deepEqual(chat('kimi-k3', { enabled: false }), { reasoning_effort: 'max' });
  assert.deepEqual(chat('glm-5.3-flash', { enabled: false }), { reasoning_effort: 'low' });
  // No control at all: nothing goes on the wire, on or off.
  assert.deepEqual(chat('mimo-v2.5', { enabled: true, level: 'high' }), {});
  assert.deepEqual(chat('mimo-v2.5', { enabled: false }), {});
});

ok('chat wire: the plan reports every adjustment it had to make', () => {
  assert.deepEqual(plan('kimi-k3', { enabled: false }).adjustments, [{ kind: 'forced-on' }]);
  assert.deepEqual(plan('deepseek-v4-pro', { enabled: true, level: 'low' }).adjustments, [
    { kind: 'level-clamped', from: 'low', to: 'high' },
  ]);
  // A budget on a chat model has nowhere to go: dropped, and said so.
  assert.deepEqual(plan('glm-5.3-flash', { enabled: true, level: 'high', budget: 4096 }).adjustments, [
    { kind: 'budget-dropped', from: 4096 },
  ]);
  assert.deepEqual(plan('glm-5.3-flash', { enabled: true, level: 'high' }).adjustments, []);
});

ok('messages wire: graded models take output_config.effort, budget models the classic thinking block', () => {
  assert.deepEqual(messages('qwen3.8-max', { enabled: true, level: 'xhigh' }), { output_config: { effort: 'xhigh' } });
  assert.deepEqual(messages('qwen3.8-max', { enabled: true, level: 'high' }), { output_config: { effort: 'medium' } });
  assert.deepEqual(messages('qwen3.8-flash', { enabled: true, level: 'minimal' }), { output_config: { effort: 'low' } });
  assert.deepEqual(messages('qwen3.7-plus', { enabled: true, budget: 20000 }), { thinking: { type: 'enabled', budget_tokens: 20000 } });
  assert.deepEqual(messages('qwen3.7-plus', { enabled: true }), { thinking: { type: 'enabled', budget_tokens: 8192 } });
  // Over the published ceiling: clamped, never rejected upstream.
  assert.deepEqual(messages('qwen3.6-plus', { enabled: true, budget: 999_999 }), { thinking: { type: 'enabled', budget_tokens: 81920 } });
});

ok('messages wire: off where switchable, silence where the model always reasons', () => {
  assert.deepEqual(messages('qwen3.7-plus', { enabled: false }), { thinking: { type: 'disabled' } });
  assert.deepEqual(messages('qwen3.8-max', { enabled: false }), { thinking: { type: 'disabled' } });
  assert.deepEqual(messages('minimax-m2.7', { enabled: false }), {});
  assert.deepEqual(messages('union-alpha', { enabled: true, level: 'high' }), {});
});

ok('responses wire: the effort is always explicit (never the host default)', () => {
  assert.deepEqual(responses('gpt-5.6-luna', { enabled: true, level: 'xhigh' }), { effort: 'xhigh' });
  assert.deepEqual(responses('gpt-5.6-luna', { enabled: false }), { effort: 'none' });
  assert.deepEqual(responses('grok-4.6', { enabled: true, level: 'max' }), { effort: 'xhigh' }, 'clamped to the top listed level');
  // Grok cannot be switched off: the lowest listed level stands in.
  assert.deepEqual(responses('grok-4.6', { enabled: false }), { effort: 'low' });
  assert.deepEqual(responses('muse-spark-1.3-contributor', { enabled: true, level: 'max' }), { effort: 'xhigh' });
});

ok('no catalog model offers a level outside the shared vocabulary (never ultra/ultracode)', () => {
  assert.doesNotMatch(JSON.stringify(catalog), /ultracode|ultra"/);
  for (const model of catalog) {
    for (const level of model.reasoning.levels) {
      assert.ok(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(level), `${model.upstreamId}: ${level}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Wrong-wire error text
// ---------------------------------------------------------------------------

ok('format-mismatch text names the model and points at the model list', () => {
  assert.equal(
    opencodeGoFormatMismatchMessage('union-alpha', 'not supported for format oa-compat'),
    'OpenCode Go rejected model union-alpha on the requested transport (not supported for format oa-compat). The model may need a different API format; pick one from the model list or refresh it.',
  );
  assert.equal(
    opencodeGoFormatMismatchMessage('union-alpha', ''),
    'OpenCode Go rejected model union-alpha on the requested transport. The model may need a different API format; pick one from the model list or refresh it.',
  );
});

console.log(`opencode-go provider tests passed (${checks} checks)`);
