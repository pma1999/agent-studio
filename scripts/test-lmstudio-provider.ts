import assert from 'node:assert/strict';
import {
  LMSTUDIO_PREFIX,
  getProviderConfig,
  isCodexModel,
  isLmStudioModel,
  persistedModelId,
  resolveProviderId,
  toUpstreamModelId,
} from '../server/providers/index.js';
import {
  DEFAULT_LMSTUDIO_PROFILE_ID,
  LMSTUDIO_PROFILES,
  LMSTUDIO_SAMPLING,
  buildComplianceKnobs,
  createThinkStreamSplitter,
  normalizeCatalogEntry,
  resolveLmStudioSampling,
  shouldAttachTools,
  stripThinkBlocks,
  toCatalogModel,
} from '../server/providers/lmstudio.js';
import { SENSITIVE_SETTINGS_KEYS } from '../server/crypto.js';

let checks = 0;
function ok(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`ok ${checks} - ${name}`);
}

interface Split {
  reasoning: string;
  content: string;
}
const EMPTY_SPLIT: Split = { reasoning: '', content: '' };
function merged(...parts: Split[]): Split {
  return parts.reduce(
    (acc, p) => ({ reasoning: acc.reasoning + p.reasoning, content: acc.content + p.content }),
    EMPTY_SPLIT,
  );
}

// ---------------------------------------------------------------------------
// 1. Registry: prefix resolution, upstream stripping, static config
// ---------------------------------------------------------------------------

ok('resolveProviderId routes lmstudio: prefixed ids', () => {
  assert.equal(resolveProviderId('lmstudio:qwen/qwen3-coder-30b'), 'lmstudio');
});
ok('resolveProviderId leaves other providers untouched', () => {
  assert.equal(resolveProviderId('deepseek:deepseek-v4-flash'), 'deepseek');
  assert.equal(resolveProviderId('codex:gpt-5.1-codex'), 'codex');
  assert.equal(resolveProviderId('anthropic/claude-3.5-sonnet'), 'openrouter');
  assert.equal(resolveProviderId(null), 'openrouter');
});
ok('toUpstreamModelId strips the lmstudio prefix (incl. @quant suffix)', () => {
  assert.equal(toUpstreamModelId('lmstudio:qwen/qwen3-coder-30b'), 'qwen/qwen3-coder-30b');
  assert.equal(toUpstreamModelId('lmstudio:qwen/qwen3-coder-30b@q4_k_m'), 'qwen/qwen3-coder-30b@q4_k_m');
});
ok('LMSTUDIO_PREFIX is the pinned namespace', () => {
  assert.equal(LMSTUDIO_PREFIX, 'lmstudio:');
});
ok('isLmStudioModel gates exactly the lmstudio namespace', () => {
  assert.equal(isLmStudioModel('lmstudio:any-model'), true);
  assert.equal(isLmStudioModel('openrouter/auto'), false);
  assert.equal(isLmStudioModel(null), false);
  assert.equal(isLmStudioModel(undefined), false);
  // neighbors unchanged
  assert.equal(isCodexModel('codex:x'), true);
  assert.equal(isCodexModel('lmstudio:x'), false);
});
ok("getProviderConfig('lmstudio') matches global-constraints §2 verbatim", () => {
  const cfg = getProviderConfig('lmstudio');
  assert.equal(cfg.id, 'lmstudio');
  assert.equal(cfg.label, 'LM Studio (Local)');
  assert.equal(cfg.chatCompletionsUrl, ''); // resolved per-user from settings; never a static URL
  assert.equal(cfg.apiKeySetting, 'lmstudio_api_token');
  assert.equal(cfg.supportsProviderRouting, false);
  assert.equal(cfg.supportsPlugins, false);
  assert.equal(cfg.supportsReasoningParam, false);
  assert.equal(cfg.supportsJsonSchema, true);
});
ok('lmstudio buildHeaders: conditional bearer, always JSON content type', () => {
  const cfg = getProviderConfig('lmstudio');
  assert.deepEqual(cfg.buildHeaders('tok-123'), {
    'Content-Type': 'application/json',
    Authorization: 'Bearer tok-123',
  });
  const anonymous = cfg.buildHeaders('');
  assert.equal(anonymous['Content-Type'], 'application/json');
  assert.equal('Authorization' in anonymous, false);
});

// ---------------------------------------------------------------------------
// 2. persistedModelId matrix (chat.ts consumes in task 5)
// ---------------------------------------------------------------------------

ok('persistedModelId keeps the NAMESPACED id for deepseek and lmstudio', () => {
  assert.equal(persistedModelId('deepseek', 'deepseek:deepseek-v4-flash', 'deepseek-v4-flash'),
    'deepseek:deepseek-v4-flash');
  assert.equal(persistedModelId('lmstudio', 'lmstudio:qwen/qwen3-coder-30b@q4_k_m', 'qwen/qwen3-coder-30b@q4_k_m'),
    'lmstudio:qwen/qwen3-coder-30b@q4_k_m');
});
ok('persistedModelId prefers the upstream-served model for other providers', () => {
  assert.equal(persistedModelId('openrouter', 'openrouter/auto', 'anthropic/claude-3.5-sonnet'),
    'anthropic/claude-3.5-sonnet');
  assert.equal(persistedModelId('codex', 'codex:gpt-5.1-codex', 'gpt-5.1-codex'), 'gpt-5.1-codex');
});
ok('persistedModelId falls back to the effective id when upstream echoes nothing', () => {
  assert.equal(persistedModelId('openrouter', 'openrouter/auto', null), 'openrouter/auto');
  assert.equal(persistedModelId('codex', 'codex:gpt-5.1-codex', null), 'codex:gpt-5.1-codex');
});

// ---------------------------------------------------------------------------
// 3. Profiles: frozen numbers from global-constraints §3
// ---------------------------------------------------------------------------

ok('LMSTUDIO_PROFILES contains exactly the three pinned ids', () => {
  assert.deepEqual(Object.keys(LMSTUDIO_PROFILES).sort(), ['contexto_grande', 'equilibrado', 'rapido']);
});
ok('DEFAULT_LMSTUDIO_PROFILE_ID is equilibrado', () => {
  assert.equal(DEFAULT_LMSTUDIO_PROFILE_ID, 'equilibrado');
});
ok('profile labels and REST knobs carry the exact §3 numbers', () => {
  assert.deepEqual(
    Object.entries(LMSTUDIO_PROFILES).map(([, p]) => [p.id, p.label, p.contextLength]),
    [
      ['rapido', 'RÁPIDO', 32768],
      ['equilibrado', 'EQUILIBRADO', 65536],
      ['contexto_grande', 'CONTEXTO GRANDE', 131072],
    ],
  );
  for (const p of Object.values(LMSTUDIO_PROFILES)) {
    assert.equal(p.flashAttention, true, `${p.id}.flashAttention`);
    assert.equal(p.offloadKvCacheToGpu, false, `${p.id}.offloadKvCacheToGpu`);
    assert.equal(p.evalBatchSize, 512, `${p.id}.evalBatchSize`);
  }
});
ok('profiles carry the advisory non-REST knobs verbatim', () => {
  for (const p of Object.values(LMSTUDIO_PROFILES)) {
    assert.equal(p.quantizationExpectation, 'Q4_K_M', `${p.id}.quantizationExpectation`);
    assert.equal(p.gpuOffload, 'auto', `${p.id}.gpuOffload`);
    assert.equal(p.kvCacheQuant, 'Q8_0', `${p.id}.kvCacheQuant`);
    assert.equal(p.vCacheQuant, 'Q8_0', `${p.id}.vCacheQuant`);
    assert.equal(p.parallel, 1, `${p.id}.parallel`);
    assert.equal(p.cpuThreads, 'auto', `${p.id}.cpuThreads`);
  }
});

// ---------------------------------------------------------------------------
// 4. Sampling defaults (global-constraints §4)
// ---------------------------------------------------------------------------

ok('LMSTUDIO_SAMPLING pins the two bands', () => {
  assert.equal(LMSTUDIO_SAMPLING.general.temperature, 0.65);
  assert.equal(LMSTUDIO_SAMPLING.coding.temperature, 0.30);
  assert.equal(LMSTUDIO_SAMPLING.general.top_p, 0.9);
  assert.equal(LMSTUDIO_SAMPLING.coding.top_p, 0.9);
});
ok('resolveLmStudioSampling honors the per-agent temperature override', () => {
  assert.deepEqual(resolveLmStudioSampling(0.2), { temperature: 0.2, top_p: 0.9 });
  assert.deepEqual(resolveLmStudioSampling(1.5, 'coding'), { temperature: 1.5, top_p: 0.9 });
  assert.deepEqual(resolveLmStudioSampling(0, 'general'), { temperature: 0, top_p: 0.9 }); // 0 is a real value
});
ok('resolveLmStudioSampling falls back per usage band on null/undefined', () => {
  assert.deepEqual(resolveLmStudioSampling(null), { temperature: 0.65, top_p: 0.9 });
  assert.deepEqual(resolveLmStudioSampling(undefined), { temperature: 0.65, top_p: 0.9 });
  assert.deepEqual(resolveLmStudioSampling(null, 'general'), { temperature: 0.65, top_p: 0.9 });
  assert.deepEqual(resolveLmStudioSampling(undefined, 'coding'), { temperature: 0.30, top_p: 0.9 });
  assert.deepEqual(resolveLmStudioSampling(null, 'coding'), { temperature: 0.30, top_p: 0.9 });
});

// ---------------------------------------------------------------------------
// 5. <think> handling
// ---------------------------------------------------------------------------

ok('stripThinkBlocks removes complete blocks and keeps surrounding content', () => {
  assert.equal(stripThinkBlocks('<think>reasoning</think>answer'), 'answer');
  assert.equal(stripThinkBlocks('pre<think>r</think>post'), 'prepost');
  assert.equal(stripThinkBlocks('<think>a</think>X<think>b</think>Y'), 'XY');
});
ok('stripThinkBlocks drops an unterminated <think>… tail entirely', () => {
  assert.equal(stripThinkBlocks('<think>never closed'), '');
  assert.equal(stripThinkBlocks('visible<think>hidden'), 'visible');
});
ok('stripThinkBlocks passes plain text and stray close tags through', () => {
  assert.equal(stripThinkBlocks('no tags here'), 'no tags here');
  assert.equal(stripThinkBlocks('</think>stray open'), '</think>stray open');
  assert.equal(stripThinkBlocks('a < b and x << y'), 'a < b and x << y');
});
ok('splitter handles <think> split across two and three pushes', () => {
  let s = createThinkStreamSplitter();
  let r = merged(
    s.push('Hello '),
    s.push('<th'),
    s.push('ink>secret'),
    s.push('</think> world'),
    s.flush(),
  );
  assert.equal(r.content, 'Hello  world');
  assert.equal(r.reasoning, 'secret');

  s = createThinkStreamSplitter();
  r = merged(s.push('a<th'), s.push('in'), s.push('k>x</think>b'), s.flush());
  assert.equal(r.content, 'ab');
  assert.equal(r.reasoning, 'x');
});
ok('splitter handles </think> split across pushes', () => {
  const s = createThinkStreamSplitter();
  const r = merged(s.push('<think>why</th'), s.push('ink>done'), s.flush());
  assert.equal(r.reasoning, 'why');
  assert.equal(r.content, 'done');
});
ok('splitter emits per-push deltas and buffers partial tags', () => {
  const s = createThinkStreamSplitter();
  assert.deepEqual(s.push('plain '), { reasoning: '', content: 'plain ' });
  assert.deepEqual(s.push('<th'), { reasoning: '', content: '' }); // held, undecided
  assert.deepEqual(s.push('ink>'), { reasoning: '', content: '' }); // tag consumed
  assert.deepEqual(s.push('chain '), { reasoning: 'chain ', content: '' });
  assert.deepEqual(s.flush(), { reasoning: '', content: '' });
});
ok('splitter treats a dangling partial opener at EOF as content', () => {
  const s = createThinkStreamSplitter();
  const r = merged(s.push('math: 1 <th'), s.flush());
  assert.equal(r.content, 'math: 1 <th');
  assert.equal(r.reasoning, '');
});
ok('splitter emits an unterminated closing-tag tail as reasoning', () => {
  const s = createThinkStreamSplitter();
  const r = merged(s.push('<think>r</thi'), s.flush());
  assert.equal(r.reasoning, 'r</thi');
  assert.equal(r.content, '');
});
ok('splitter round-trips a full streamed turn identically to stripThinkBlocks', () => {
  const full = 'A<think>one</think>B<think>two</think>C';
  const s = createThinkStreamSplitter();
  const parts: Split[] = [];
  for (const chunk of full.match(/.{1,3}/gs) ?? []) parts.push(s.push(chunk));
  parts.push(s.flush());
  const r = merged(...parts);
  assert.equal(r.content, 'ABC');
  assert.equal(r.reasoning, 'onetwo');
});

// ---------------------------------------------------------------------------
// 6. Capability gating
// ---------------------------------------------------------------------------

ok('shouldAttachTools truth table: fail-open except explicit false', () => {
  assert.equal(shouldAttachTools({ trainedForToolUse: null }, false), true); // no tools in play -> no veto
  assert.equal(shouldAttachTools({ trainedForToolUse: null }, true), true); // fail-open on unknown
  assert.equal(shouldAttachTools({ trainedForToolUse: undefined }, true), true);
  assert.equal(shouldAttachTools({ trainedForToolUse: true }, true), true);
  assert.equal(shouldAttachTools({ trainedForToolUse: true }, false), true);
  assert.equal(shouldAttachTools({ trainedForToolUse: false }, true), false); // only explicit false vetoes
  assert.equal(shouldAttachTools({}, true), true);
});

// ---------------------------------------------------------------------------
// 7. Catalog normalization (tolerant of missing fields)
// ---------------------------------------------------------------------------

// Exact official-docs native-v1 payload shape (LM Studio 0.4.x) — FF-01 regression anchor.
// https://lmstudio.ai/docs/developer/rest/list
const DOCS_MODEL = {
  type: 'llm',
  publisher: 'qwen',
  key: 'qwen/qwen3-coder-30b',
  display_name: 'Qwen3 Coder 30B',
  architecture: 'qwen3',
  quantization: { name: 'Q4_K_M', bits_per_weight: 4.56, size_bytes: 18688131232, params_string: '30.5B' },
  loaded_instances: [
    {
      id: 'a1b2c3d4',
      config: { context_length: 40960, eval_batch_size: 512, parallel: 1, flash_attention: true,
        offload_kv_cache_to_gpu: false },
    },
  ],
  max_context_length: 40960,
  format: 'gguf',
  capabilities: { vision: false, trained_for_tool_use: true, reasoning: { allowed_options: ['off', 'on'], default: 'on' } },
  variants: [{ key: 'qwen/qwen3-coder-30b@q4_k_m' }],
  selected_variant: { key: 'qwen/qwen3-coder-30b@q4_k_m' },
} as unknown as Record<string, unknown>;

ok('REGRESSION FF-01: verbatim official-docs 0.4.x payload maps correctly', () => {
  const e = normalizeCatalogEntry(DOCS_MODEL);
  assert.equal(e.key, 'qwen/qwen3-coder-30b'); // identity from `key`, NOT `id`
  assert.equal(e.displayName, 'Qwen3 Coder 30B');
  assert.equal(e.description, ''); // docs carry no description field
  assert.equal(e.contextLength, 40960);
  assert.equal(e.quantization, 'Q4_K_M'); // quantization OBJECT -> name string expectation
  assert.equal(e.loaded, true); // DERIVED from loaded_instances.length > 0
  assert.equal(e.trainedForToolUse, true); // capabilities OBJECT boolean field
  assert.deepEqual(e.loadedConfigs, [
    { context_length: 40960, eval_batch_size: 512, parallel: 1, flash_attention: true,
      offload_kv_cache_to_gpu: false },
  ]);
});
ok('REGRESSION FF-06: legacy openai-only row keyed by id (no key) normalizes', () => {
  const e = normalizeCatalogEntry({ id: 'some-model' });
  assert.equal(e.key, 'some-model'); // id fallback restores identity on ≤0.3.x
  assert.equal(e.displayName, 'some-model'); // derived from key when no display_name
  assert.equal(e.loaded, false); // no loaded_instances -> not loaded (state-less rows stay honest)
  assert.equal(toCatalogModel(e).id, 'lmstudio:some-model'); // namespacing works again
});
ok('normalizeCatalogEntry tolerates an empty raw entry', () => {
  assert.deepEqual(normalizeCatalogEntry({} as Record<string, unknown>), {
    key: '',
    displayName: '',
    description: '',
    contextLength: 0,
    quantization: null,
    loaded: false,
    trainedForToolUse: null,
    loadedConfigs: [],
    loadedInstanceIds: [], // task 9 §11 additive field
  });
});
ok('normalizeCatalogEntry derives displayName and tolerates junk context lengths', () => {
  const e = normalizeCatalogEntry({ key: 'qwen/qwen3-4b', max_context_length: 'not-a-number' });
  assert.equal(e.displayName, 'qwen3-4b');
  assert.equal(e.contextLength, 0);
  assert.equal(normalizeCatalogEntry({ key: 'm', max_context_length: -5 }).contextLength, 0);
});
ok('normalizeCatalogEntry: capabilities-object semantics for tool use', () => {
  assert.equal(
    normalizeCatalogEntry({ key: 'm', capabilities: { trained_for_tool_use: false } }).trainedForToolUse,
    false,
  );
  assert.equal(normalizeCatalogEntry({ key: 'm', capabilities: { vision: true } }).trainedForToolUse, null);
  assert.equal(normalizeCatalogEntry({ key: 'm', capabilities: {} }).trainedForToolUse, null);
  assert.equal(normalizeCatalogEntry({ key: 'm' }).trainedForToolUse, null);
  // legacy ARRAY form is not the documented shape — must be ignored (unknown), never truthy-scanned
  assert.equal(normalizeCatalogEntry({ key: 'm', capabilities: ['tools'] }).trainedForToolUse, null);
});
ok('normalizeCatalogEntry: loaded derives from loaded_instances only', () => {
  assert.equal(normalizeCatalogEntry({ key: 'm', loaded_instances: [{ id: 'i', config: {} }] }).loaded, true);
  assert.equal(normalizeCatalogEntry({ key: 'm', loaded_instances: [] }).loaded, false);
  assert.equal(normalizeCatalogEntry({ key: 'm' }).loaded, false);
  assert.equal(normalizeCatalogEntry({ key: 'm', state: 'loaded' }).loaded, false); // v0-era field must NOT flip it
  assert.equal(normalizeCatalogEntry({ key: 'm', loaded_instances: 'junk' }).loaded, false);
});
ok('toCatalogModel produces the namespaced OpenRouterModel-shaped object per §8', () => {
  const m = toCatalogModel(normalizeCatalogEntry(DOCS_MODEL));
  assert.equal(m.id, 'lmstudio:qwen/qwen3-coder-30b');
  assert.equal(m.name, 'Qwen3 Coder 30B');
  assert.equal(m.description, undefined); // optional; absent in the docs payload
  assert.equal(m.context_length, 40960);
  assert.deepEqual(m.pricing, { prompt: '0', completion: '0' }); // zero pricing tolerance
  assert.equal(m.quantization, 'Q4_K_M');
  assert.equal(m.loaded, true);
  assert.equal(m.trained_for_tool_use, true);
});
ok('toCatalogModel keeps zero context_length when unknown (never NaN)', () => {
  const m = toCatalogModel(normalizeCatalogEntry({}));
  assert.equal(m.id, 'lmstudio:');
  assert.equal(m.context_length, 0);
  assert.deepEqual(m.pricing, { prompt: '0', completion: '0' });
  assert.ok(Number.isFinite(m.context_length));
});

// ---------------------------------------------------------------------------
// 8. Compliance knobs (global-constraints §3/§8)
// ---------------------------------------------------------------------------

const PROFILE = LMSTUDIO_PROFILES.equilibrado;

ok('REST knobs report met=true against a compliant live config', () => {
  const knobs = buildComplianceKnobs(
    PROFILE,
    { context_length: 65536, flash_attention: true, offload_kv_cache_to_gpu: false, eval_batch_size: 512 },
    'native-v1',
  );
  const rest = knobs.filter((k) => k.how === 'rest');
  assert.deepEqual(rest.map((k) => k.key), [
    'context_length',
    'flash_attention',
    'offload_kv_cache_to_gpu',
    'eval_batch_size',
  ]);
  for (const k of rest) {
    assert.equal(k.met, true, k.key);
    assert.notEqual(k.actual, null, k.key);
  }
  assert.equal(rest.find((k) => k.key === 'context_length')?.expected, '65536');
  assert.equal(rest.find((k) => k.key === 'flash_attention')?.expected, 'true');
  assert.equal(rest.find((k) => k.key === 'offload_kv_cache_to_gpu')?.expected, 'false');
  assert.equal(rest.find((k) => k.key === 'eval_batch_size')?.expected, '512');
});
ok('REST knobs report met=false on drift, tolerating stringly-typed live values', () => {
  const knobs = buildComplianceKnobs(
    PROFILE,
    { context_length: 4096, flash_attention: 'false', offload_kv_cache_to_gpu: false, eval_batch_size: '512' },
    'native-v1',
  );
  const byKey = new Map(knobs.map((k) => [k.key, k]));
  assert.equal(byKey.get('context_length')?.met, false);
  assert.equal(byKey.get('flash_attention')?.met, false); // 'false' string canon-equals expected false
  assert.equal(byKey.get('eval_batch_size')?.met, true); // '512' string canon-equals 512
  assert.equal(byKey.get('offload_kv_cache_to_gpu')?.met, true);
});
ok('liveConfig null => every knob unobservable (met:null), expectations still present', () => {
  const knobs = buildComplianceKnobs(PROFILE, null, 'native-v1');
  assert.ok(knobs.length >= 10);
  for (const k of knobs) {
    assert.equal(k.met, null, k.key);
    assert.equal(k.actual, null, k.key);
    assert.ok(k.expected.length > 0, k.key);
  }
});
ok('non-REST knobs are gui-classified on native-v1 with pinned GUI + script guidance', () => {
  const knobs = buildComplianceKnobs(PROFILE, null, 'native-v1').filter((k) => k.how !== 'rest');
  assert.deepEqual(knobs.map((k) => k.key), [
    'quantization_expectation',
    'gpu_offload',
    'kv_cache_quant',
    'v_cache_quant',
    'parallel',
    'cpu_threads',
  ]);
  for (const k of knobs) {
    assert.equal(k.how, 'gui');
    assert.equal(k.met, null);
    assert.ok(k.guidance?.includes('Manually choose model load parameters'), k.key);
    assert.ok(/@lmstudio\/sdk|script/i.test(k.guidance ?? ''), k.key);
  }
  const byKey = new Map(knobs.map((k) => [k.key, k]));
  assert.equal(byKey.get('gpu_offload')?.expected, 'auto');
  assert.equal(byKey.get('kv_cache_quant')?.expected, 'Q8_0');
  assert.equal(byKey.get('v_cache_quant')?.expected, 'Q8_0');
  assert.equal(byKey.get('parallel')?.expected, '1');
  assert.equal(byKey.get('cpu_threads')?.expected, 'auto');
  assert.equal(byKey.get('quantization_expectation')?.expected, 'Q4_K_M');
});
ok('non-REST knobs are sdk-script-classified on openai-only surfaces', () => {
  const knobs = buildComplianceKnobs(PROFILE, null, 'openai-only').filter((k) => k.how !== 'rest');
  for (const k of knobs) {
    assert.equal(k.how, 'sdk-script', k.key);
    assert.ok(k.guidance?.includes('Manually choose model load parameters'), k.key);
    assert.ok(/script/i.test(k.guidance ?? ''), k.key);
  }
});

// ---------------------------------------------------------------------------
// 9. Crypto registration
// ---------------------------------------------------------------------------

ok("'lmstudio_api_token' is registered as a sensitive (encrypted-at-rest) setting", () => {
  assert.equal(SENSITIVE_SETTINGS_KEYS.has('lmstudio_api_token'), true);
  // pre-existing registrations intact
  assert.equal(SENSITIVE_SETTINGS_KEYS.has('deepseek_api_key'), true);
  assert.equal(SENSITIVE_SETTINGS_KEYS.has('openrouter_api_key'), true);
});

console.log(`\nlmstudio provider domain module: ${checks} checks OK`);
