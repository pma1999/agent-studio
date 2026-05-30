import assert from 'node:assert/strict';
import {
  assertProviderRoutingCompatible,
  buildOpenRouterProviderPreference,
  normalizeOpenRouterEndpoint,
  normalizeOpenRouterEndpoints,
  normalizeProviderRoutingMap,
  normalizeProviderRoutingConfig,
  parseProviderRoutingConfig,
  resolveProviderRouting,
  serializeProviderRoutingMap,
  serializeProviderRoutingConfig,
} from '../server/providerRouting.js';

const providerRouting = normalizeProviderRoutingConfig({
  mode: 'provider',
  provider_slug: ' deepinfra/turbo ',
  allow_fallbacks: false,
});

assert.deepEqual(providerRouting, {
  mode: 'provider',
  provider_slug: 'deepinfra/turbo',
  allow_fallbacks: false,
});

assert.deepEqual(buildOpenRouterProviderPreference(providerRouting), {
  order: ['deepinfra/turbo'],
  allow_fallbacks: false,
});

assert.equal(buildOpenRouterProviderPreference({ mode: 'auto' }), undefined);
assert.deepEqual(resolveProviderRouting(null, { mode: 'auto' }, providerRouting), { mode: 'auto' });
assert.deepEqual(resolveProviderRouting(null, null), { mode: 'auto' });

const serialized = serializeProviderRoutingConfig(providerRouting);
assert.equal(serialized, '{"mode":"provider","provider_slug":"deepinfra/turbo","allow_fallbacks":false}');
assert.deepEqual(parseProviderRoutingConfig(serialized), providerRouting);
assert.equal(parseProviderRoutingConfig(''), null);
assert.equal(normalizeProviderRoutingConfig({ mode: 'provider', provider_slug: '', allow_fallbacks: true }), null);

const routingMap = normalizeProviderRoutingMap({
  'deepseek/deepseek-r1': providerRouting,
  'openai/gpt-4o': { mode: 'auto' },
  invalid: { mode: 'provider', provider_slug: '' },
});
assert.deepEqual(routingMap, {
  'deepseek/deepseek-r1': providerRouting,
  'openai/gpt-4o': { mode: 'auto' },
});
assert.equal(
  serializeProviderRoutingMap(routingMap),
  '{"deepseek/deepseek-r1":{"mode":"provider","provider_slug":"deepinfra/turbo","allow_fallbacks":false},"openai/gpt-4o":{"mode":"auto"}}'
);

assert.throws(
  () => assertProviderRoutingCompatible('openrouter/auto', providerRouting),
  /concrete model/
);
assert.doesNotThrow(() => assertProviderRoutingCompatible('deepseek/deepseek-r1', providerRouting));

const endpoint = normalizeOpenRouterEndpoint({
  tag: 'deepinfra/turbo',
  name: 'DeepInfra: DeepSeek R1 Turbo',
  provider_name: 'DeepInfra',
  context_length: 163840,
  max_completion_tokens: 8192,
  pricing: {
    prompt: '0.0000005',
    completion: '0.000002',
  },
  quantization: 'fp8',
  supported_parameters: ['temperature', 'tools'],
  status: 0,
});

assert.deepEqual(endpoint, {
  tag: 'deepinfra/turbo',
  name: 'DeepInfra: DeepSeek R1 Turbo',
  provider_name: 'DeepInfra',
  context_length: 163840,
  max_completion_tokens: 8192,
  pricing: {
    prompt: '0.0000005',
    completion: '0.000002',
  },
  quantization: 'fp8',
  supported_parameters: ['temperature', 'tools'],
  status: 0,
});

const camelCaseEndpointInput = {
  tag: 'openai',
  name: 'OpenAI: GPT-4',
  providerName: 'OpenAI',
  contextLength: 8192,
  maxCompletionTokens: 4096,
  pricing: {
    prompt: '0.00003',
    completion: '0.00006',
  },
  quantization: 'fp16',
  supportedParameters: ['temperature', 'top_p', 42],
};

const camelCaseEndpoint = {
  tag: 'openai',
  name: 'OpenAI: GPT-4',
  provider_name: 'OpenAI',
  context_length: 8192,
  max_completion_tokens: 4096,
  pricing: {
    prompt: '0.00003',
    completion: '0.00006',
  },
  quantization: 'fp16',
  supported_parameters: ['temperature', 'top_p'],
  status: null,
};

assert.deepEqual(normalizeOpenRouterEndpoint(camelCaseEndpointInput), camelCaseEndpoint);
assert.deepEqual(
  normalizeOpenRouterEndpoints({ data: { endpoints: [camelCaseEndpointInput, { name: 'Missing tag' }] } }),
  [camelCaseEndpoint]
);
assert.deepEqual(normalizeOpenRouterEndpoints({ data: [endpoint] }), [endpoint]);
assert.equal(normalizeOpenRouterEndpoint({ name: 'Missing tag' }), null);

console.log('provider routing tests passed');
