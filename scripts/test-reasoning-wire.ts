/**
 * Reasoning plan → request fields for every provider and transport, driven by
 * catalog models built from real payloads (2026-09-16). Wire shapes mirror the
 * keyed verifications recorded in each module header. Offline, db-free.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { planReasoning, unknownReasoning, type ReasoningRequest } from '../shared/models/reasoning.js';
import type { CatalogModel } from '../shared/models/catalog.js';
import { openRouterCatalogModel, type OpenRouterModelEntry } from '../server/catalog/normalize/openrouter.js';
import { codexCatalogModel, type CodexProtocolModel } from '../server/catalog/normalize/codex.js';
import { arnictCatalogModel, type ArnictModelEntry } from '../server/catalog/normalize/arnict.js';
import { abliterationCatalogModel, type AbliterationModelEntry } from '../server/catalog/normalize/abliteration.js';
import { deepseekCatalogModel } from '../server/catalog/normalize/deepseek.js';
import { opencodeGoCatalogModel, parseOpencodeGoDocs } from '../server/catalog/normalize/opencodeGo.js';
import { llamacppCatalogModel } from '../server/catalog/normalize/llamacpp.js';
import { unknownCatalogModel } from '../server/catalog/adapters/common.js';
import type { ModelsDevProvider } from '../server/catalog/normalize/modelsDev.js';
import {
  chatReasoningFields,
  codexTurnEffort,
  mayRetryMaxEffort,
  messagesThinkingFields,
  responsesReasoning,
} from '../server/providers/wire/reasoning.js';
import {
  buildMessagesBody,
  buildResponsesBody,
  mapMessagesUsage,
  mapResponsesUsage,
  refreshTransportBody,
  MESSAGES_BODY_KEYS,
} from '../server/providers/wire/transports.js';

const FIXTURES = resolve(import.meta.dirname, 'fixtures/models');
const raw = (name: string) => readFileSync(resolve(FIXTURES, name), 'utf8');
const data = <T>(name: string) => (JSON.parse(raw(name)) as { data: T[] }).data;

let checks = 0;
function ok(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`ok ${checks} - ${name}`);
}

const send = (model: CatalogModel, request: ReasoningRequest) => chatReasoningFields(model, planReasoning(model.reasoning, request));

const openrouter = data<OpenRouterModelEntry>('openrouter-models.json');
const or = (id: string) => openRouterCatalogModel(openrouter.find((m) => m.id === id)!);
const md = JSON.parse(raw('modelsdev-api.json')) as Record<string, ModelsDevProvider>;
const goDocs = parseOpencodeGoDocs(raw('opencode-go-docs.md'));
const go = (id: string) => opencodeGoCatalogModel(id, md['opencode-go'].models[id], md['opencode-go'], goDocs, 'active');

ok('OpenRouter: explicit off for switchable models; mandatory models forced on at the lowest level', () => {
  assert.deepEqual(send(or('openai/gpt-5.5'), { enabled: false, level: 'high' }), { reasoning: { enabled: false } });
  assert.deepEqual(send(or('anthropic/claude-fable-5.1'), { enabled: false }), { reasoning: { effort: 'low' } });
  assert.deepEqual(send(or('openai/gpt-5.5'), { enabled: true, level: 'max' }), { reasoning: { effort: 'xhigh' } });
});

ok('OpenRouter: no reasoning → nothing sent; routers keep host defaults when off; budget only where supported', () => {
  const plain = openRouterCatalogModel(openrouter.find((m) => !m.reasoning && !(m.supported_parameters ?? []).includes('reasoning'))!);
  assert.deepEqual(send(plain, { enabled: true, level: 'high' }), {});
  assert.deepEqual(send(or('openrouter/auto'), { enabled: false }), {});
  assert.deepEqual(send(or('openrouter/auto'), { enabled: true, level: 'max', budget: 4096 }), { reasoning: { effort: 'max', max_tokens: 4096 } });
  const budgeted = openRouterCatalogModel(openrouter.find((m) => m.reasoning?.supports_max_tokens && !m.reasoning.supported_efforts)!);
  assert.deepEqual(send(budgeted, { enabled: true, budget: 2048 }), { reasoning: { max_tokens: 2048 } });
  assert.deepEqual(send(or('openai/gpt-5.5'), { enabled: true, budget: 2048 }), { reasoning: { enabled: true } }, 'budget dropped');
});

ok('OpenRouter: max retry only when max is actually sent', () => {
  const auto = or('openrouter/auto');
  assert.equal(mayRetryMaxEffort(auto, planReasoning(auto.reasoning, { enabled: true, level: 'max' })), true);
  const gpt = or('openai/gpt-5.5');
  assert.equal(mayRetryMaxEffort(gpt, planReasoning(gpt.reasoning, { enabled: true, level: 'max' })), false, 'clamped to xhigh first');
});

ok('DeepSeek: thinking.type switch + reasoning_effort clamped to the model levels', () => {
  const pro = deepseekCatalogModel('deepseek-v4-pro', md.deepseek.models['deepseek-v4-pro'], 'active');
  assert.deepEqual(send(pro, { enabled: false, level: 'max' }), { thinking: { type: 'disabled' } });
  assert.deepEqual(send(pro, { enabled: true, level: 'xhigh' }), { thinking: { type: 'enabled' }, reasoning_effort: 'high' });
  const flash = deepseekCatalogModel('deepseek-flash', md.deepseek.models['deepseek-flash'], 'active');
  assert.deepEqual(send(flash, { enabled: true, level: 'medium' }), { thinking: { type: 'enabled' }, reasoning_effort: 'low' });
  assert.deepEqual(send(flash, { enabled: true }), { thinking: { type: 'enabled' } });
});

ok('Abliteration: none switches off where allowed; large-v2 cannot be switched off', () => {
  const entries = data<AbliterationModelEntry>('abliteration-models.json');
  const ab = (id: string) => abliterationCatalogModel(entries.find((m) => m.id === id)!, md['abliteration-ai'].models[id])!;
  assert.deepEqual(send(ab('abliterated-model'), { enabled: false }), { reasoning_effort: 'none' });
  assert.deepEqual(send(ab('abliterated-model-large-v2'), { enabled: false }), { reasoning_effort: 'low' });
  assert.deepEqual(send(ab('abliterated-model-large'), { enabled: true, level: 'medium' }), { reasoning_effort: 'high' }, 'docs: minimal–high → high');
});

ok('Arnict: reasoning object; structured output forces it off', () => {
  const glm = arnictCatalogModel(data<ArnictModelEntry>('arnict-models.json')[0])!;
  assert.deepEqual(send(glm, { enabled: true, level: 'high' }), { reasoning: { enabled: true, effort: 'high' } });
  assert.deepEqual(send(glm, { enabled: false }), { reasoning: { enabled: false } });
  const plan = planReasoning(glm.reasoning, { enabled: true, level: 'high' });
  assert.deepEqual(chatReasoningFields(glm, plan, { structuredOutput: true }), { reasoning: { enabled: false } });
});

ok('OpenCode Go chat: reasoning_effort; no control models send nothing; off only via listed none', () => {
  assert.deepEqual(send(go('mimo-v2.5'), { enabled: true, level: 'high' }), {});
  assert.deepEqual(send(go('mimo-v2.5'), { enabled: false }), {});
  assert.deepEqual(send(go('kimi-k3'), { enabled: true, level: 'low' }), { reasoning_effort: 'max' });
  assert.deepEqual(send(go('hy3'), { enabled: false }), { reasoning_effort: 'none' });
  assert.deepEqual(send(go('glm-5.3'), { enabled: false }), { reasoning_effort: 'low' }, 'forced on at the floor');
  const future = unknownCatalogModel('opencode-go', 'brand-new', 'chat');
  assert.deepEqual(send(future, { enabled: true, level: 'high' }), { reasoning_effort: 'high' });
  assert.deepEqual(send(future, { enabled: false }), {});
});

ok('OpenCode Go messages: disabled / classic budget / output_config per model', () => {
  const thinking = (id: string, request: ReasoningRequest) => {
    const model = go(id);
    return messagesThinkingFields(model, planReasoning(model.reasoning, request));
  };
  assert.deepEqual(thinking('minimax-m2.7', { enabled: false }), {}, 'always on, never sent');
  assert.deepEqual(thinking('minimax-m3', { enabled: false }), { thinking: { type: 'disabled' } });
  assert.deepEqual(thinking('minimax-m3', { enabled: true }), { thinking: { type: 'enabled', budget_tokens: 8192 } });
  assert.deepEqual(thinking('qwen3.7-plus', { enabled: true, budget: 500_000 }), { thinking: { type: 'enabled', budget_tokens: 262144 } });
  assert.deepEqual(thinking('qwen3.7-plus', { enabled: true, budget: 100 }), { thinking: { type: 'enabled', budget_tokens: 1024 } });
  assert.deepEqual(thinking('qwen3.8-max', { enabled: true, level: 'max' }), { output_config: { effort: 'xhigh' } });
  assert.deepEqual(thinking('qwen3.8-max', { enabled: true }), {});
  assert.deepEqual(thinking('qwen3.8-max', { enabled: false }), { thinking: { type: 'disabled' } });
});

ok('OpenCode Go responses: effort always explicit; none only where listed', () => {
  const effort = (id: string, request: ReasoningRequest) => {
    const model = go(id);
    return responsesReasoning(model, planReasoning(model.reasoning, request));
  };
  assert.deepEqual(effort('gpt-5.6-luna', { enabled: false }), { effort: 'none' });
  assert.deepEqual(effort('grok-4.6', { enabled: false }), { effort: 'low' });
  assert.deepEqual(effort('muse-spark-1.3-contributor', { enabled: false }), { effort: 'minimal' });
  assert.deepEqual(effort('muse-spark-1.3-contributor', { enabled: true, level: 'max' }), { effort: 'xhigh' });
  assert.deepEqual(effort('gpt-5.6-luna', { enabled: true }), { effort: 'low' });
});

ok('Codex: turn effort is the planned level; off impossible without a listed none', () => {
  const models = data<CodexProtocolModel>('codex-model-list.json');
  const gpt55 = codexCatalogModel(models.find((m) => m.id === 'gpt-5.5')!)!;
  assert.equal(codexTurnEffort(gpt55, planReasoning(gpt55.reasoning, { enabled: true, level: 'max' })), 'xhigh');
  assert.equal(codexTurnEffort(gpt55, planReasoning(gpt55.reasoning, { enabled: false })), 'low');
  const unknownModel = unknownCatalogModel('codex', 'gpt-next', 'codex');
  assert.equal(codexTurnEffort(unknownModel, planReasoning(unknownModel.reasoning, { enabled: false })), null);
});

ok('llama.cpp: enable_thinking always; reasoning_effort only for graded or unknown templates', () => {
  const entry = { key: 'Qwen3', path: '/m/Qwen3.gguf', shards: 1, mtpCapable: false };
  const unloaded = llamacppCatalogModel(entry, false, null);
  assert.deepEqual(send(unloaded, { enabled: true, level: 'high' }), { chat_template_kwargs: { enable_thinking: true }, reasoning_effort: 'high' });
  const toggleOnly = llamacppCatalogModel(entry, true, { chat_template: '{% if enable_thinking %}{% endif %}', chat_template_caps: {} });
  assert.deepEqual(send(toggleOnly, { enabled: true, level: 'high' }), { chat_template_kwargs: { enable_thinking: true } });
  assert.deepEqual(send(toggleOnly, { enabled: false }), { chat_template_kwargs: { enable_thinking: false } });
});

ok('transport bodies: tools, system and reasoning in one place; rebuild replaces owned keys only', () => {
  const tools = [{ type: 'function' as const, function: { name: 'web_search', description: 'Search', parameters: { type: 'object' } } }];
  const messages = [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'web_search', arguments: '{"q":"x"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'result' },
  ];
  const qwen = go('qwen3.8-flash');
  const body = buildMessagesBody({ model: qwen, plan: planReasoning(qwen.reasoning, { enabled: true, level: 'xhigh' }), messages, tools, includeTools: true, temperature: 0.7, maxTokens: 1000 });
  assert.equal(body.system, 'Be brief.');
  assert.deepEqual(body.output_config, { effort: 'xhigh' });
  assert.deepEqual((body.tools as unknown[])[0], { name: 'web_search', description: 'Search', input_schema: { type: 'object' } });
  assert.deepEqual((body.messages as Array<{ role: string }>).map((m) => m.role), ['user', 'assistant', 'user']);
  const off = buildMessagesBody({ model: qwen, plan: planReasoning(qwen.reasoning, { enabled: false }), messages, tools, includeTools: false, temperature: 0.7, maxTokens: 1000 });
  const target = { ...body };
  refreshTransportBody(target, off, MESSAGES_BODY_KEYS);
  assert.equal(target.output_config, undefined);
  assert.deepEqual(target.thinking, { type: 'disabled' });
  assert.equal(target.tools, undefined);
  assert.equal(target.max_tokens, 1000);
  const luna = go('gpt-5.6-luna');
  const responses = buildResponsesBody({ model: luna, plan: planReasoning(luna.reasoning, { enabled: true, level: 'high' }), messages, tools, includeTools: true, temperature: 1, maxTokens: 500 });
  assert.equal(responses.instructions, 'Be brief.');
  assert.deepEqual(responses.reasoning, { effort: 'high' });
  assert.deepEqual((responses.tools as unknown[])[0], { type: 'function', name: 'web_search', description: 'Search', parameters: { type: 'object' } });
  assert.throws(() => buildResponsesBody({ model: luna, plan: planReasoning(unknownReasoning(), { enabled: true }), messages, tools: [{ type: 'function', function: { name: 'bad name', description: '', parameters: {} } }], includeTools: true, temperature: 1, maxTokens: 1 }));
});

ok('transport usage: Anthropic excludes cache from input; Responses includes it', () => {
  assert.deepEqual(mapMessagesUsage({ input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5, output_tokens: 7, cost: '0.001' }), {
    priced: { inputTokens: 10, cacheReadTokens: 90, cacheWriteTokens: 5, outputTokens: 7 },
    promptTokens: 105,
    outputTokens: 7,
    cachedTokens: 90,
    reasoningTokens: 0,
    upstreamCost: 0.001,
  });
  assert.deepEqual(mapResponsesUsage({ input_tokens: 100, input_tokens_details: { cached_tokens: 60 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 12 } }), {
    priced: { inputTokens: 40, cacheReadTokens: 60, cacheWriteTokens: 0, outputTokens: 20 },
    promptTokens: 100,
    outputTokens: 20,
    cachedTokens: 60,
    reasoningTokens: 12,
    upstreamCost: null,
  });
});

console.log(`\n${checks} checks passed`);
