/**
 * Reasoning capability: normalizers against real upstream payloads captured
 * 2026-09-16 (scripts/fixtures/models, keys never included) and the shared
 * planner every consumer uses. Offline, db-free.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  capabilityFromControls,
  noReasoning,
  planReasoning,
  unknownReasoning,
  type ReasoningCapability,
} from '../shared/models/reasoning.js';
import { openRouterReasoning, type OpenRouterModelEntry } from '../server/catalog/normalize/openrouter.js';
import { codexCatalogModel, type CodexProtocolModel } from '../server/catalog/normalize/codex.js';
import { arnictCatalogModel, type ArnictModelEntry } from '../server/catalog/normalize/arnict.js';
import { abliterationCatalogModel, type AbliterationModelEntry } from '../server/catalog/normalize/abliteration.js';
import { deepseekCatalogModel } from '../server/catalog/normalize/deepseek.js';
import { opencodeGoCatalogModel, parseOpencodeGoDocs, isOfferedByOpencodeGo } from '../server/catalog/normalize/opencodeGo.js';
import { llamacppReasoningFromProps } from '../server/catalog/normalize/llamacpp.js';
import type { ModelsDevProvider } from '../server/catalog/normalize/modelsDev.js';

const FIXTURES = resolve(import.meta.dirname, 'fixtures/models');
const fixture = <T>(name: string): T => JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8')) as T;

let checks = 0;
function ok(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`ok ${checks} - ${name}`);
}

function shape(cap: ReasoningCapability) {
  return { supported: cap.supported, canDisable: cap.canDisable, levels: cap.levels, budget: cap.budget !== null, status: cap.status };
}

// ---------------------------------------------------------------------------
// OpenRouter
// ---------------------------------------------------------------------------
const openrouter = fixture<{ data: OpenRouterModelEntry[] }>('openrouter-models.json').data;
const orById = (id: string) => {
  const entry = openrouter.find((m) => m.id === id);
  assert.ok(entry, `fixture has ${id}`);
  return entry;
};

ok('OpenRouter: no reasoning object → does not think', () => {
  const entry = openrouter.find((m) => !m.reasoning && !(m.supported_parameters ?? []).includes('reasoning'));
  assert.ok(entry);
  assert.deepEqual(shape(openRouterReasoning(entry)), shape(noReasoning()));
});

ok('OpenRouter: routers (openrouter/auto) are unknown', () => {
  assert.equal(openRouterReasoning(orById('openrouter/auto')).status, 'unknown');
});

ok('OpenRouter: mandatory graded model (claude-fable-5.1) → no switch, low…max, default high', () => {
  const cap = openRouterReasoning(orById('anthropic/claude-fable-5.1'));
  assert.equal(cap.canDisable, false);
  assert.deepEqual(cap.levels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(cap.defaultLevel, 'high');
  assert.equal(cap.defaultEnabled, true);
});

ok('OpenRouter: optional graded with none (gpt-5.5) → switch, low…xhigh, none never a level', () => {
  const cap = openRouterReasoning(orById('openai/gpt-5.5'));
  assert.equal(cap.canDisable, true);
  assert.equal(cap.disableVia, 'toggle');
  assert.deepEqual(cap.levels, ['low', 'medium', 'high', 'xhigh']);
  assert.equal(cap.defaultEnabled, true);
});

ok('OpenRouter: every observed reasoning shape maps without throwing and never lists none/ultra', () => {
  for (const entry of openrouter) {
    const cap = openRouterReasoning(entry);
    assert.ok(!(cap.levels as string[]).includes('none'), entry.id);
    assert.ok(!(cap.levels as string[]).includes('ultra'), entry.id);
    if (entry.reasoning?.mandatory) assert.equal(cap.canDisable, false, entry.id);
    if (entry.reasoning && !entry.reasoning.supported_efforts) assert.deepEqual(cap.levels, [], entry.id);
    if (entry.reasoning?.supports_max_tokens) assert.ok(cap.budget, entry.id);
  }
});

ok('OpenRouter: {mandatory:true} without efforts → always on, no controls', () => {
  const entry = openrouter.find((m) => m.reasoning?.mandatory === true && !m.reasoning.supported_efforts);
  assert.ok(entry);
  assert.deepEqual(shape(openRouterReasoning(entry)), { supported: true, canDisable: false, levels: [], budget: false, status: 'known' });
});

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------
const codex = fixture<{ data: CodexProtocolModel[] }>('codex-model-list.json').data;

ok('Codex: official levels per model, ultra never offered, no off switch', () => {
  const astra = codexCatalogModel(codex.find((m) => m.id === 'gpt-6-astra')!)!;
  assert.deepEqual(astra.reasoning.levels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(astra.reasoning.canDisable, false);
  assert.equal(astra.reasoning.defaultLevel, 'low');
  assert.equal(astra.reasoning.levelDescriptions?.max, 'Maximum reasoning depth for the hardest problems');
  assert.equal(Object.keys(astra.reasoning.levelDescriptions ?? {}).includes('ultra'), false);
  const gpt55 = codexCatalogModel(codex.find((m) => m.id === 'gpt-5.5')!)!;
  assert.deepEqual(gpt55.reasoning.levels, ['low', 'medium', 'high', 'xhigh']);
  assert.equal(gpt55.id, 'codex:gpt-5.5');
});

ok('Codex: hidden models are not listed; missing effort list is unknown', () => {
  assert.equal(codexCatalogModel({ id: 'x', hidden: true }), null);
  assert.equal(codexCatalogModel({ id: 'x' })!.reasoning.status, 'unknown');
});

// ---------------------------------------------------------------------------
// Arnict (live keyed payload, schema 2.4)
// ---------------------------------------------------------------------------
const arnict = fixture<{ data: ArnictModelEntry[] }>('arnict-models.json').data;

ok('Arnict: reasoning parameter → gateway vocabulary with switch; prices/limits from the API', () => {
  const glm = arnictCatalogModel(arnict.find((m) => m.id === 'zai/glm-5.3-flash-uncensored')!)!;
  assert.equal(glm.reasoning.levelsSource, 'host');
  assert.equal(glm.reasoning.canDisable, true);
  assert.deepEqual(glm.reasoning.levels, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(glm.reasoning.budget, null);
  assert.deepEqual(glm.pricing?.rates, { input: 0.125, output: 0.5, cacheRead: 0.05 });
  assert.equal(glm.contextLength, 1048576);
  assert.equal(glm.maxOutputTokens, 131072);
  assert.deepEqual(glm.inputModalities, ['text', 'image']);
});

ok('Arnict: model without reasoning parameter does not think; published enum wins', () => {
  const plain: ArnictModelEntry = { id: 'a/b', output_modalities: [{ type: 'text', supported_parameters: {} }] };
  assert.equal(arnictCatalogModel(plain)!.reasoning.supported, false);
  const enumerated: ArnictModelEntry = {
    id: 'a/c',
    output_modalities: [{ type: 'text', supported_parameters: { reasoning: { type: 'enum', values: ['none', 'high'] } } }],
  };
  const cap = arnictCatalogModel(enumerated)!.reasoning;
  assert.equal(cap.levelsSource, 'model');
  assert.deepEqual(cap.levels, ['high']);
});

// ---------------------------------------------------------------------------
// models.dev-backed providers
// ---------------------------------------------------------------------------
const modelsDev = fixture<Record<string, ModelsDevProvider>>('modelsdev-api.json');
const abliteration = fixture<{ data: AbliterationModelEntry[] }>('abliteration-models.json').data;

ok('Abliteration: levels match the official docs per model', () => {
  const md = modelsDev['abliteration-ai'].models;
  const byId = (id: string) => abliterationCatalogModel(abliteration.find((m) => m.id === id)!, md[id])!;
  const base = byId('abliterated-model');
  assert.equal(base.reasoning.canDisable, true);
  assert.equal(base.reasoning.disableVia, 'none-effort');
  assert.deepEqual(base.reasoning.levels, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  const large = byId('abliterated-model-large');
  assert.equal(large.reasoning.canDisable, true);
  assert.deepEqual(large.reasoning.levels, ['high', 'max']);
  const v2 = byId('abliterated-model-large-v2');
  assert.equal(v2.reasoning.canDisable, false, 'large-v2 always reasons');
  assert.deepEqual(v2.reasoning.levels, ['low', 'high', 'max']);
  assert.deepEqual(base.pricing?.rates, { input: 1, output: 3, cacheRead: 0.1 });
  assert.deepEqual(v2.inputModalities, ['text']);
});

ok('DeepSeek: per-model levels, switch via thinking.type, verified V4 Pro rates + peak tariff', () => {
  const md = modelsDev.deepseek.models;
  const flash = deepseekCatalogModel('deepseek-flash', md['deepseek-flash'], 'active');
  assert.deepEqual(flash.reasoning.levels, ['low', 'high', 'max']);
  assert.equal(flash.reasoning.disableVia, 'toggle');
  const pro = deepseekCatalogModel('deepseek-v4-pro', md['deepseek-v4-pro'], 'active');
  assert.deepEqual(pro.reasoning.levels, ['high', 'max']);
  assert.deepEqual(pro.pricing?.rates, { input: 0.66, output: 1.98, cacheRead: 0.022 });
  assert.equal(pro.pricing?.source, 'override');
  assert.equal(pro.pricing?.peak?.multiplier, 2);
  assert.equal(pro.historyReasoningField, 'reasoning_content');
  const unknownModel = deepseekCatalogModel('deepseek-v9', undefined, 'active');
  assert.deepEqual(unknownModel.reasoning.levels, ['low', 'high', 'max'], 'host vocabulary without metadata');
  assert.equal(unknownModel.reasoning.levelsSource, 'host');
});

const goDocs = parseOpencodeGoDocs(readFileSync(resolve(FIXTURES, 'opencode-go-docs.md'), 'utf8'));

ok('OpenCode Go docs: endpoint table → transports; usage table → monthly caps (names normalized)', () => {
  assert.equal(goDocs.endpoints.get('minimax-m2.5'), 'messages');
  assert.equal(goDocs.endpoints.get('gpt-5.6-luna'), 'responses');
  assert.equal(goDocs.monthlyLimits.get('kimi-k3'), 15);
  assert.equal(goDocs.monthlyLimits.get('mimo-v2.5'), 60, 'MiMo-V2.5 vs MiMo V2.5');
  assert.equal(goDocs.monthlyLimits.get('union-alpha'), null, 'Unlimited');
  assert.equal(goDocs.monthlyLimits.get('qwen3.7-plus'), 60, 'tiered rows share one cap');
});

ok('OpenCode Go: capability follows the transport wire', () => {
  const provider = modelsDev['opencode-go'];
  const go = (id: string) => opencodeGoCatalogModel(id, provider.models[id], provider, goDocs, 'active');
  const kimi = go('kimi-k3');
  assert.equal(kimi.transport, 'chat');
  assert.deepEqual(kimi.reasoning.levels, ['max']);
  assert.equal(kimi.reasoning.canDisable, false);
  const mimo = go('mimo-v2.5');
  assert.deepEqual(shape(mimo.reasoning), { supported: true, canDisable: false, levels: [], budget: false, status: 'known' }, 'always on');
  const longcat = go('longcat-2.0');
  assert.equal(longcat.reasoning.canDisable, false, 'toggle is a no-op on the chat wire');
  const qwen37 = go('qwen3.7-plus');
  assert.equal(qwen37.transport, 'messages');
  assert.equal(qwen37.reasoning.canDisable, true);
  assert.deepEqual(qwen37.reasoning.budget, { min: null, max: 262144 });
  assert.equal(qwen37.pricing?.tiers?.[0].aboveContextTokens, 256000);
  const qwen38 = go('qwen3.8-max');
  assert.deepEqual(qwen38.reasoning.levels, ['low', 'medium', 'xhigh']);
  assert.equal(qwen38.reasoning.budget, null, 'graded messages models reject the budget form');
  const luna = go('gpt-5.6-luna');
  assert.equal(luna.transport, 'responses');
  assert.equal(luna.reasoning.disableVia, 'none-effort');
  assert.deepEqual(luna.reasoning.levels, ['low', 'medium', 'high', 'xhigh', 'max']);
  const union = go('union-alpha');
  assert.equal(union.transport, 'messages', 'chat returns 500 for union-alpha; models.dev routes it to messages');
  const pro = go('deepseek-v4-pro');
  assert.equal(pro.pricing?.peak?.multiplier, 2, 'DeepSeek family peak tariff');
  assert.equal(pro.historyReasoningField, 'reasoning_content');
  assert.equal(kimi.monthlyLimitUsd, 15);
});

ok('OpenCode Go: deprecated models are offered only while the docs still list them', () => {
  const md = modelsDev['opencode-go'].models;
  assert.equal(isOfferedByOpencodeGo(md['minimax-m2.5'], 'minimax-m2.5', goDocs), true);
  assert.equal(isOfferedByOpencodeGo(md['grok-4.5'], 'grok-4.5', goDocs), false);
  assert.equal(isOfferedByOpencodeGo(undefined, 'hy3-preview', goDocs), false, 'no metadata');
  assert.equal(isOfferedByOpencodeGo(md['kimi-k3'], 'kimi-k3', null), true, 'docs unreachable');
});

// ---------------------------------------------------------------------------
// llama.cpp /props
// ---------------------------------------------------------------------------
ok('llama.cpp: props caps decide the capability; unloaded is unknown', () => {
  assert.equal(llamacppReasoningFromProps(null).status, 'unknown');
  const graded = llamacppReasoningFromProps({
    chat_template: '{% if enable_thinking %}<think>{% endif %}{{ reasoning_effort }}',
    chat_template_caps: { supports_reasoning_effort: true },
  });
  assert.equal(graded.canDisable, true);
  assert.deepEqual(graded.levels, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(graded.levelsSource, 'host');
  const toggle = llamacppReasoningFromProps({ chat_template: '{% if enable_thinking %}<think>{% endif %}', chat_template_caps: {} });
  assert.deepEqual(shape(toggle), { supported: true, canDisable: true, levels: [], budget: false, status: 'known' });
  const plain = llamacppReasoningFromProps({ chat_template: '{{ bos_token }}{% for m in messages %}{{ m.content }}{% endfor %}', chat_template_caps: {} });
  assert.equal(plain.supported, false);
  const markers = llamacppReasoningFromProps({ chat_template: '<think>{{ m.content }}', chat_template_caps: {} });
  assert.equal(markers.status, 'unknown');
});

// ---------------------------------------------------------------------------
// capabilityFromControls: wire support gates published controls
// ---------------------------------------------------------------------------
ok('capabilityFromControls: controls the wire cannot carry are dropped', () => {
  const published = { toggle: true, effortValues: ['low', 'high'], budget: { min: 1024, max: 8192 } };
  const none = capabilityFromControls(published, { toggle: false, noneEffort: false, effort: false, budget: false });
  assert.deepEqual(shape(none), { supported: true, canDisable: false, levels: [], budget: false, status: 'known' });
  const all = capabilityFromControls(published, { toggle: true, noneEffort: true, effort: true, budget: true });
  assert.deepEqual(shape(all), { supported: true, canDisable: true, levels: ['low', 'high'], budget: true, status: 'known' });
  const garbage = capabilityFromControls({ toggle: false, effortValues: [null, 'default', 'ultra', 'high'], budget: null }, { toggle: true, noneEffort: true, effort: true, budget: true });
  assert.deepEqual(garbage.levels, ['high']);
});

// ---------------------------------------------------------------------------
// planReasoning
// ---------------------------------------------------------------------------
const graded = capabilityFromControls({ toggle: true, effortValues: ['high', 'max'], budget: null }, { toggle: true, noneEffort: true, effort: true, budget: false });
const alwaysOnGraded = capabilityFromControls({ toggle: false, effortValues: ['low', 'medium', 'high'], budget: null }, { toggle: true, noneEffort: true, effort: true, budget: false });
const alwaysOn = capabilityFromControls({ toggle: false, effortValues: [], budget: null }, { toggle: true, noneEffort: true, effort: true, budget: true });
const budgeted = capabilityFromControls({ toggle: true, effortValues: null, budget: { min: 1024, max: 32768 } }, { toggle: true, noneEffort: false, effort: true, budget: true });

ok('plan: supported level passes through; unsupported clamps to nearest below, else above', () => {
  assert.deepEqual(planReasoning(graded, { enabled: true, level: 'max' }), { enabled: true, level: 'max', budget: null, adjustments: [] });
  const below = planReasoning(graded, { enabled: true, level: 'xhigh' });
  assert.equal(below.level, 'high');
  assert.deepEqual(below.adjustments, [{ kind: 'level-clamped', from: 'xhigh', to: 'high' }]);
  assert.equal(planReasoning(graded, { enabled: true, level: 'low' }).level, 'high', 'nothing below → nearest above');
});

ok('plan: off honoured when the model can disable; forced on at the lowest level otherwise', () => {
  assert.deepEqual(planReasoning(graded, { enabled: false, level: 'max' }), { enabled: false, level: null, budget: null, adjustments: [] });
  assert.equal(planReasoning(graded, { enabled: true, level: 'none' }).enabled, false, "'none' means off");
  const forced = planReasoning(alwaysOnGraded, { enabled: false, level: 'high' });
  assert.deepEqual(forced, { enabled: true, level: 'low', budget: null, adjustments: [{ kind: 'forced-on' }] });
  const forcedNoLevels = planReasoning(alwaysOn, { enabled: false });
  assert.deepEqual(forcedNoLevels, { enabled: true, level: null, budget: null, adjustments: [{ kind: 'forced-on' }] });
});

ok('plan: model without reasoning is off; level without graded control is dropped', () => {
  assert.deepEqual(planReasoning(noReasoning(), { enabled: true, level: 'high' }), { enabled: false, level: null, budget: null, adjustments: [{ kind: 'forced-off' }] });
  assert.deepEqual(planReasoning(alwaysOn, { enabled: true, level: 'high' }).adjustments, [{ kind: 'level-dropped', from: 'high' }]);
});

ok('plan: budget clamps into the host range; dropped without a budget field', () => {
  const clamped = planReasoning(budgeted, { enabled: true, budget: 100 });
  assert.equal(clamped.budget, 1024);
  assert.deepEqual(clamped.adjustments, [{ kind: 'budget-clamped', from: 100, to: 1024 }]);
  assert.equal(planReasoning(budgeted, { enabled: true, budget: 99_999 }).budget, 32768);
  assert.deepEqual(planReasoning(graded, { enabled: true, level: 'high', budget: 4096 }).adjustments, [{ kind: 'budget-dropped', from: 4096 }]);
  assert.equal(planReasoning(budgeted, { enabled: true, budget: 0 }).budget, null, 'non-positive = unset');
});

ok('plan: unknown capability is a passthrough that still drops garbage levels', () => {
  assert.deepEqual(planReasoning(unknownReasoning(), { enabled: true, level: 'max', budget: 2048 }), { enabled: true, level: 'max', budget: 2048, adjustments: [] });
  assert.equal(planReasoning(unknownReasoning(), { enabled: true, level: 'ultra' }).level, null);
  assert.equal(planReasoning(unknownReasoning(), { enabled: false, level: 'max' }).enabled, false);
});

console.log(`\n${checks} checks passed`);
