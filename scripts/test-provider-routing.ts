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
  uptime_last_5m: null,
  uptime_last_30m: null,
  uptime_last_1d: null,
  throughput_last_30m: null,
  latency_last_30m: null,
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
  uptime_last_5m: null,
  uptime_last_30m: null,
  uptime_last_1d: null,
  throughput_last_30m: null,
  latency_last_30m: null,
};

assert.deepEqual(normalizeOpenRouterEndpoint(camelCaseEndpointInput), camelCaseEndpoint);
assert.deepEqual(
  normalizeOpenRouterEndpoints({ data: { endpoints: [camelCaseEndpointInput, { name: 'Missing tag' }] } }),
  [camelCaseEndpoint]
);
assert.deepEqual(normalizeOpenRouterEndpoints({ data: [endpoint] }), [endpoint]);
assert.equal(normalizeOpenRouterEndpoint({ name: 'Missing tag' }), null);

// (a) Uptime + pricing extendido poblado — preserva todos los campos operativos reales
const richEndpointInput = {
  tag: 'x',
  pricing: {
    prompt: '0.0000025',
    completion: '0.00001',
    input_cache_read: '0.000001',
    discount: 0,
  },
  uptime_last_5m: 99.98,
  uptime_last_30m: 99.82,
  uptime_last_1d: 99.94,
  latency_last_30m: { p50: 0.25, p75: 0.35, p90: 0.48, p99: 0.85 },
  throughput_last_30m: { p50: 45.2, p75: 60, p90: 85, p99: 120 },
  status: 0,
};

const richEndpoint = normalizeOpenRouterEndpoint(richEndpointInput);
assert.deepEqual(richEndpoint?.pricing, {
  prompt: '0.0000025',
  completion: '0.00001',
  input_cache_read: '0.000001',
  discount: 0,
});
assert.equal(richEndpoint?.uptime_last_5m, 99.98);
assert.equal(richEndpoint?.uptime_last_30m, 99.82);
assert.equal(richEndpoint?.uptime_last_1d, 99.94);
assert.deepEqual(richEndpoint?.latency_last_30m, { p50: 0.25, p75: 0.35, p90: 0.48, p99: 0.85 });
assert.deepEqual(richEndpoint?.throughput_last_30m, { p50: 45.2, p75: 60, p90: 85, p99: 120 });
assert.equal(richEndpoint?.status, 0);

// (b) Campos ausentes → null (no inventa valores, pricing fallback a '0')
const minimalInput = { tag: 'y', pricing: { prompt: '0.000001' } };
const minimalEndpoint = normalizeOpenRouterEndpoint(minimalInput);
assert.equal(minimalEndpoint?.pricing.prompt, '0.000001');
assert.equal(minimalEndpoint?.pricing.completion, '0');
assert.equal(minimalEndpoint?.uptime_last_5m, null);
assert.equal(minimalEndpoint?.uptime_last_30m, null);
assert.equal(minimalEndpoint?.uptime_last_1d, null);
assert.equal(minimalEndpoint?.throughput_last_30m, null);
assert.equal(minimalEndpoint?.latency_last_30m, null);
assert.equal(minimalEndpoint?.status, null);
// pricing extendido con tipos incorrectos debe ser ignorado, no forzar
const invalidPricingInput = {
  tag: 'z',
  pricing: {
    prompt: '0.000001',
    input_cache_read: 123 as unknown as string,
    image: 456 as unknown as string,
    discount: '0.5' as unknown as number,
  },
  uptime_last_5m: '99.9' as unknown as number,
  throughput_last_30m: { p50: 1, p75: 2 } as unknown as { p50: number; p75: number; p90: number; p99: number },
};
const invalidEndpoint = normalizeOpenRouterEndpoint(invalidPricingInput);
assert.equal(invalidEndpoint?.pricing.input_cache_read, undefined);
assert.equal(invalidEndpoint?.pricing.image, undefined);
assert.equal(invalidEndpoint?.pricing.discount, undefined);
assert.equal(invalidEndpoint?.uptime_last_5m, null);
assert.equal(invalidEndpoint?.throughput_last_30m, null);

// (c) Wrapper anidado {data:{endpoints:[...]}} con fields percentiles preservados y filtra sin-tag
const wrapperExtendedInput = {
  data: {
    endpoints: [
      richEndpointInput,
      { name: 'Missing tag' },
    ],
  },
};
const wrapperExtended = normalizeOpenRouterEndpoints(wrapperExtendedInput);
assert.equal(wrapperExtended.length, 1);
assert.equal(wrapperExtended[0].tag, 'x');
assert.deepEqual(wrapperExtended[0].latency_last_30m, { p50: 0.25, p75: 0.35, p90: 0.48, p99: 0.85 });
assert.deepEqual(wrapperExtended[0].throughput_last_30m, { p50: 45.2, p75: 60, p90: 85, p99: 120 });
assert.equal(wrapperExtended[0].uptime_last_5m, 99.98);

// snake_case vs camelCase tolerancia para uptime/percentiles
const camelRichInput = {
  tag: 'camel-rich',
  pricing: { prompt: '0.000001', completion: '0.000002' },
  uptimeLast5m: 98.5,
  uptimeLast30m: 97.2,
  uptimeLast1d: 96.1,
  throughputLast30m: { p50: 10, p75: 20, p90: 30, p99: 40 },
  latencyLast30m: { p50: 0.1, p75: 0.2, p90: 0.3, p99: 0.4 },
};
const camelRich = normalizeOpenRouterEndpoint(camelRichInput);
assert.equal(camelRich?.uptime_last_5m, 98.5);
assert.equal(camelRich?.uptime_last_30m, 97.2);
assert.equal(camelRich?.uptime_last_1d, 96.1);
assert.deepEqual(camelRich?.throughput_last_30m, { p50: 10, p75: 20, p90: 30, p99: 40 });
assert.deepEqual(camelRich?.latency_last_30m, { p50: 0.1, p75: 0.2, p90: 0.3, p99: 0.4 });

console.log('provider routing tests passed');
