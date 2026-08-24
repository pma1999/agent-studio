/**
 * OFFLINE acceptance harness for task 2 — PURE domain module
 * `server/providers/llamacpp.ts` (zero db/network imports, like lmstudio.ts):
 *
 * 1. canonical knob bag EXACT defaults (global-constraints.md §3);
 * 2. parseKnobs accept/reject matrix (partials OK; unknown keys, negative
 *    threads/ctx, mtp out of [0,5], reasoning_budget < -1, disallowed cache
 *    types, bad gpu_layers all rejected);
 * 3. buildLlamaServerArgv golden argv per global-constraints §4 — exact order,
 *    every knob explicit, mmap:false ⇒ `--load-mode none`, reasoning_budget -1
 *    ⇒ flag omitted, device ≠ cuda ⇒ flag omitted, MTP pair ONLY when
 *    mtp>0 && mtpCapable && parallel_slots===1;
 * 4. mergeKnobLayers precedence request > model > global > default;
 * 5. collapseShardEntries: single file; -00001/-00002 pair collapses to the
 *    -00001- representative; -00002-only orphan kept on lowest shard;
 *    mmproj tolerated input; case-insensitive matching; summed sizeBytes;
 *    mtp_capable via case-insensitive 'mtp' in name;
 * 6. legacy lmstudio guard + frozen message string;
 * 7. sampling pin constant (§6 top_p = 0.8);
 * 8. think splitter copy sanity (tag split across deltas).
 */
import assert from 'node:assert/strict';
import {
  LLAMACPP_DEFAULT_KNOBS,
  LLAMACPP_SAMPLING_TOP_P,
  REMOVED_LMSTUDIO_MESSAGE,
  buildLlamaServerArgv,
  collapseShardEntries,
  createThinkStreamSplitter,
  isLegacyLmStudioModel,
  mergeKnobLayers,
  parseKnobs,
  stripThinkBlocks,
  type LlamacppKnobs,
} from '../server/providers/llamacpp.js';

let checks = 0;
function ok(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`ok ${checks} - ${name}`);
}

const DEFAULTS: LlamacppKnobs = { ...LLAMACPP_DEFAULT_KNOBS };

// ---------------------------------------------------------------------------
// 1. Canonical knob bag — EXACT §3 defaults
// ---------------------------------------------------------------------------

ok('LLAMACPP_DEFAULT_KNOBS matches the §3 canonical bag exactly', () => {
  assert.deepEqual({ ...LLAMACPP_DEFAULT_KNOBS }, {
    n_cpu_moe: 35,
    threads: 8,
    threads_batch: 16,
    cache_type_k: 'q8_0',
    cache_type_v: 'q8_0',
    ctx: 8192,
    mtp: 2,
    reasoning_budget: 0,
    mmap: true,
    device: 'cuda',
    gpu_layers: 'all',
    flash_attn: 'on',
    parallel_slots: 1,
  });
});

// ---------------------------------------------------------------------------
// 2. parseKnobs accept/reject matrix
// ---------------------------------------------------------------------------

ok('parseKnobs accepts the full canonical bag and echoes it', () => {
  const parsed = parseKnobs({ ...DEFAULTS });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.knobs, DEFAULTS);
});

ok('parseKnobs accepts partials and leaves absent keys unset', () => {
  const parsed = parseKnobs({ threads: 4 });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.knobs, { threads: 4 });
  const empty = parseKnobs({});
  assert.equal(empty.ok, true);
  if (empty.ok) assert.deepEqual(empty.knobs, {});
});

ok('parseKnobs accepts boundary values (mtp 0 and 5, budget -1, gpu_layers numeric strings)', () => {
  for (const partial of [
    { mtp: 0 },
    { mtp: 5 },
    { reasoning_budget: -1 },
    { reasoning_budget: 0 },
    { threads: 1 },
    { ctx: 1 },
    { n_cpu_moe: 0 },
    { parallel_slots: 1 },
    { gpu_layers: '24' },
    { gpu_layers: 'auto' },
    { flash_attn: 'auto' },
    { device: 'cpu' },
  ]) {
    const parsed = parseKnobs(partial);
    assert.equal(parsed.ok, true, `expected accept for ${JSON.stringify(partial)}`);
  }
});

ok('parseKnobs rejects unknown keys', () => {
  const parsed = parseKnobs({ threads: 4, not_a_knob: 1 });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.error, /not_a_knob|Unrecognized/i);
});

ok('parseKnobs rejects negative or zero threads/threads_batch/ctx/parallel_slots', () => {
  for (const partial of [
    { threads: -1 },
    { threads: 0 },
    { threads_batch: -4 },
    { threads_batch: 0 },
    { ctx: -8192 },
    { ctx: 0 },
    { parallel_slots: 0 },
    { parallel_slots: -2 },
  ]) {
    const parsed = parseKnobs(partial);
    assert.equal(parsed.ok, false, `expected reject for ${JSON.stringify(partial)}`);
  }
});

ok('parseKnobs rejects negative n_cpu_moe', () => {
  assert.equal(parseKnobs({ n_cpu_moe: -1 }).ok, false);
});

ok('parseKnobs rejects mtp below 0 or above 5, and non-integers', () => {
  for (const mtp of [-1, 6, 100, 1.5]) {
    const parsed = parseKnobs({ mtp });
    assert.equal(parsed.ok, false, `expected reject for mtp=${mtp}`);
  }
});

ok('parseKnobs rejects reasoning_budget below -1', () => {
  assert.equal(parseKnobs({ reasoning_budget: -2 }).ok, false);
  assert.equal(parseKnobs({ reasoning_budget: -100 }).ok, false);
});

ok('parseKnobs rejects cache types outside the llama.cpp allowed set', () => {
  for (const key of ['cache_type_k', 'cache_type_v']) {
    for (const value of ['q5_2', 'q6_K', 'F16', '', 'int8']) {
      const parsed = parseKnobs({ [key]: value });
      assert.equal(parsed.ok, false, `expected reject for ${key}=${value}`);
    }
  }
  // every documented member of the set must be accepted for both slots
  for (const value of ['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1']) {
    assert.equal(parseKnobs({ cache_type_k: value }).ok, true, `cache_type_k ${value}`);
    assert.equal(parseKnobs({ cache_type_v: value }).ok, true, `cache_type_v ${value}`);
  }
});

ok('parseKnobs rejects gpu_layers outside {"all","auto", positive int string}', () => {
  for (const value of ['many', '-2', '0', '24.5', ' 24', 42, null]) {
    const parsed = parseKnobs({ gpu_layers: value as unknown as string });
    assert.equal(parsed.ok, false, `expected reject for gpu_layers=${String(value)}`);
  }
});

ok('parseKnobs rejects wrong scalar types (string numbers are not ints)', () => {
  assert.equal(parseKnobs({ threads: '8' }).ok, false);
  assert.equal(parseKnobs({ ctx: '8192' }).ok, false);
  assert.equal(parseKnobs({ mmap: 'true' }).ok, false);
  assert.equal(parseKnobs({ mtp: null }).ok, false);
  assert.equal(parseKnobs(null).ok, false);
  assert.equal(parseKnobs('bag').ok, false);
  assert.equal(parseKnobs([1, 2]).ok, false);
});

// ---------------------------------------------------------------------------
// 3. buildLlamaServerArgv — §4 golden sequence
// ---------------------------------------------------------------------------

function expectedDefaultArgs(modelPath: string, modelKey: string): string[] {
  return [
    '--model', modelPath,
    '--alias', modelKey,
    '--host', '127.0.0.1',
    '--port', '8712',
    '--ctx-size', '8192',
    '--parallel', '1',
    '--threads', '8',
    '--threads-batch', '16',
    '--gpu-layers', 'all',
    '--n-cpu-moe', '35',
    '--flash-attn', 'on',
    '--cache-type-k', 'q8_0',
    '--cache-type-v', 'q8_0',
    '--load-mode', 'mmap',
    '--jinja',
    '--reasoning-budget', '0',
    '--device', 'CUDA0',
    '--spec-type', 'draft-mtp',
    '--spec-draft-n-max', '2',
  ];
}

ok('buildLlamaServerArgv emits the exact §4 sequence for the default bag (MTP capable)', () => {
  const modelPath = '/models/Qwen3.6-35B-A3B-MTP/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf';
  const modelKey = 'Qwen3.6-35B-A3B-UD-Q4_K_M';
  const { args } = buildLlamaServerArgv({
    modelPath,
    modelKey,
    port: 8712,
    knobs: DEFAULTS,
    mtpCapable: true,
  });
  assert.deepEqual(args, expectedDefaultArgs(modelPath, modelKey));
});

ok('buildLlamaServerArgv omits --reasoning-budget entirely at -1', () => {
  const knobs = { ...DEFAULTS, reasoning_budget: -1 };
  const { args } = buildLlamaServerArgv({
    modelPath: '/m/x.gguf',
    modelKey: 'x',
    port: 9000,
    knobs,
    mtpCapable: false,
  });
  assert.equal(args.includes('--reasoning-budget'), false);
  assert.ok(!args.some((a) => a === '-1'));
});

ok('buildLlamaServerArgv maps mmap:false to --load-mode none', () => {
  const { args } = buildLlamaServerArgv({
    modelPath: '/m/x.gguf',
    modelKey: 'x',
    port: 8712,
    knobs: { ...DEFAULTS, mmap: false },
    mtpCapable: false,
  });
  const idx = args.indexOf('--load-mode');
  assert.notEqual(idx, -1);
  assert.equal(args[idx + 1], 'none');
});

ok('buildLlamaServerArgv emits --device CUDA0 only when device is cuda', () => {
  const off = buildLlamaServerArgv({
    modelPath: '/m/x.gguf',
    modelKey: 'x',
    port: 8712,
    knobs: { ...DEFAULTS, device: 'cpu' },
    mtpCapable: false,
  }).args;
  assert.equal(off.includes('--device'), false);

  const on = buildLlamaServerArgv({
    modelPath: '/m/x.gguf',
    modelKey: 'x',
    port: 8712,
    knobs: { ...DEFAULTS, device: 'cuda' },
    mtpCapable: false,
  }).args;
  const idx = on.indexOf('--device');
  assert.notEqual(idx, -1);
  assert.equal(on[idx + 1], 'CUDA0');
});

ok('buildLlamaServerArgv MTP matrix: pair only when mtp>0 && mtpCapable && parallel_slots===1', () => {
  const cases: Array<{ knobs: Partial<LlamacppKnobs>; mtpCapable: boolean; wantPair: boolean }> = [
    { knobs: {}, mtpCapable: true, wantPair: true },          // defaults: mtp=2, slots=1
    { knobs: {}, mtpCapable: false, wantPair: false },        // model lacks MTP head
    { knobs: { mtp: 0 }, mtpCapable: true, wantPair: false }, // knob explicitly off
    { knobs: { mtp: 3 }, mtpCapable: true, wantPair: true },  // custom draft count honored
    { knobs: { parallel_slots: 2 }, mtpCapable: true, wantPair: false }, // MTP needs np=1
    { knobs: { parallel_slots: 2, mtp: 5 }, mtpCapable: false, wantPair: false },
  ];
  for (const c of cases) {
    const { args } = buildLlamaServerArgv({
      modelPath: '/m/x.gguf',
      modelKey: 'x',
      port: 8712,
      knobs: { ...DEFAULTS, ...c.knobs },
      mtpCapable: c.mtpCapable,
    });
    const hasSpecType = args.includes('--spec-type');
    assert.equal(hasSpecType, c.wantPair, `matrix ${JSON.stringify(c)}: --spec-type presence`);
    if (c.wantPair) {
      const i = args.indexOf('--spec-type');
      assert.deepEqual(args.slice(i, i + 4), ['--spec-type', 'draft-mtp', '--spec-draft-n-max', String(c.knobs.mtp ?? DEFAULTS.mtp)]);
    }
  }
});

ok('buildLlamaServerArgv passes every numeric/enum knob explicitly (never server defaults)', () => {
  const knobs: LlamacppKnobs = {
    n_cpu_moe: 28,
    threads: 6,
    threads_batch: 12,
    cache_type_k: 'q4_0',
    cache_type_v: 'f16',
    ctx: 16384,
    mtp: 0,
    reasoning_budget: 1024,
    mmap: true,
    device: 'cpu',
    gpu_layers: '18',
    flash_attn: 'off',
    parallel_slots: 2,
  };
  const { args } = buildLlamaServerArgv({
    modelPath: '/m/y.gguf',
    modelKey: 'y-key',
    port: 9101,
    knobs,
    mtpCapable: true, // inert anyway: mtp=0 and slots=2
  });
  const flagValue = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  assert.equal(flagValue('--model'), '/m/y.gguf');
  assert.equal(flagValue('--alias'), 'y-key');
  assert.equal(flagValue('--host'), '127.0.0.1');
  assert.equal(flagValue('--port'), '9101');
  assert.equal(flagValue('--ctx-size'), '16384');
  assert.equal(flagValue('--parallel'), '2');
  assert.equal(flagValue('--threads'), '6');
  assert.equal(flagValue('--threads-batch'), '12');
  assert.equal(flagValue('--gpu-layers'), '18');
  assert.equal(flagValue('--n-cpu-moe'), '28');
  assert.equal(flagValue('--flash-attn'), 'off');
  assert.equal(flagValue('--cache-type-k'), 'q4_0');
  assert.equal(flagValue('--cache-type-v'), 'f16');
  assert.equal(flagValue('--load-mode'), 'mmap');
  assert.equal(flagValue('--reasoning-budget'), '1024');
  assert.equal(args.filter((a) => a === '--jinja').length, 1);
  assert.equal(args.includes('--spec-type'), false);
});

ok('buildLlamaServerArgv keeps --jinja always on and never emits --no-mmproj', () => {
  const { args } = buildLlamaServerArgv({
    modelPath: '/m/x.gguf',
    modelKey: 'x',
    port: 8712,
    knobs: DEFAULTS,
    mtpCapable: false,
  });
  assert.ok(args.includes('--jinja'));
  assert.equal(args.includes('--no-mmproj'), false);
});

// ---------------------------------------------------------------------------
// 4. mergeKnobLayers — request > model > global > default
// ---------------------------------------------------------------------------

ok('mergeKnobLayers resolves request > model > global > default knob-by-knob', () => {
  const base: LlamacppKnobs = { ...DEFAULTS };
  const globalLayer = { threads: 6, ctx: 4096, cache_type_v: 'f16' as const };
  const modelLayer = { threads: 4, gpu_layers: '20' };
  const requestLayer = { ctx: 2048 };

  const merged = mergeKnobLayers(base, globalLayer, modelLayer, requestLayer);
  // request wins over model over global over default
  assert.equal(merged.ctx, 2048);
  assert.equal(merged.threads, 4);
  assert.equal(merged.gpu_layers, '20');
  assert.equal(merged.cache_type_v, 'f16');
  // untouched knobs keep the canonical defaults
  assert.equal(merged.n_cpu_moe, 35);
  assert.equal(merged.mtp, 2);
  assert.equal(merged.parallel_slots, 1);
  assert.equal(merged.device, 'cuda');

  // layer omission tolerated at every position
  assert.deepEqual(mergeKnobLayers(base), base);
  assert.deepEqual(mergeKnobLayers(base, undefined, { threads: 9 }), { ...base, threads: 9 });
});

// ---------------------------------------------------------------------------
// 5. collapseShardEntries
// ---------------------------------------------------------------------------

interface RawEntry {
  path: string;
  name: string;
  sizeBytes?: number;
}

ok('collapseShardEntries passes non-shard files through keyed on basename minus .gguf', () => {
  const entries: RawEntry[] = [
    { path: 'D:/models/ModelA.gguf', name: 'ModelA.gguf', sizeBytes: 100 },
    { path: 'D:/models/model-b.GGUF', name: 'model-b.GGUF', sizeBytes: 7 },
  ];
  const collapsed = collapseShardEntries(entries);
  assert.deepEqual(collapsed, [
    { key: 'ModelA', path: 'D:/models/ModelA.gguf', sizeBytes: 100, shards: 1, mtpCapable: false },
    { key: 'model-b', path: 'D:/models/model-b.GGUF', sizeBytes: 7, shards: 1, mtpCapable: false },
  ]);
});

ok('collapseShardEntries collapses a -00001/-00002 pair onto the -00001- shard', () => {
  const entries: RawEntry[] = [
    { path: 'D:/m/Big-00001-of-00002.gguf', name: 'Big-00001-of-00002.gguf', sizeBytes: 30 },
    { path: 'D:/m/Big-00002-of-00002.gguf', name: 'Big-00002-of-00002.gguf', sizeBytes: 12 },
  ];
  const collapsed = collapseShardEntries(entries);
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].key, 'Big-00001-of-00002');
  assert.equal(collapsed[0].path, 'D:/m/Big-00001-of-00002.gguf'); // llama-server loads shard 1
  assert.equal(collapsed[0].sizeBytes, 42); // logical size sums the shards
  assert.equal(collapsed[0].shards, 2);
  assert.equal(collapsed[0].mtpCapable, false);
});

ok('collapseShardEntries keeps an orphan -00002-only set on its lowest (only) shard', () => {
  const entries: RawEntry[] = [
    { path: 'D:/m/Orphan-00002-of-00003.gguf', name: 'Orphan-00002-of-00003.gguf', sizeBytes: 5 },
  ];
  const collapsed = collapseShardEntries(entries);
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].key, 'Orphan-00002-of-00003');
  assert.equal(collapsed[0].path, 'D:/m/Orphan-00002-of-00003.gguf');
  assert.equal(collapsed[0].shards, 1);
});

ok('collapseShardEntries prefers the -00001- shard even when it arrives last / out of order', () => {
  const entries: RawEntry[] = [
    { path: 'D:/m/S-00003-of-00003.gguf', name: 'S-00003-of-00003.gguf', sizeBytes: 1 },
    { path: 'D:/m/S-00002-of-00003.gguf', name: 'S-00002-of-00003.gguf', sizeBytes: 1 },
    { path: 'D:/m/S-00001-of-00003.gguf', name: 'S-00001-of-00003.gguf', sizeBytes: 1 },
  ];
  const collapsed = collapseShardEntries(entries);
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].key, 'S-00001-of-00003');
  assert.equal(collapsed[0].path, 'D:/m/S-00001-of-00003.gguf');
  assert.equal(collapsed[0].sizeBytes, 3);
  assert.equal(collapsed[0].shards, 3);
});

ok('collapseShardEntries matches shards case-insensitively and tolerates mmproj input', () => {
  const entries: RawEntry[] = [
    { path: 'D:/m/Mix-00001-of-00002.GGUF', name: 'Mix-00001-of-00002.GGUF', sizeBytes: 2 },
    { path: 'D:/m/Mix-00002-OF-00002.gguf', name: 'Mix-00002-OF-00002.gguf', sizeBytes: 3 },
    { path: 'D:/m/mmproj-F16.gguf', name: 'mmproj-F16.gguf', sizeBytes: 1 }, // excluded upstream; tolerated here
  ];
  const collapsed = collapseShardEntries(entries);
  assert.equal(collapsed.length, 2);
  const mix = collapsed.find((entry) => entry.key.startsWith('Mix'));
  assert.ok(mix);
  assert.equal(mix.shards, 2, 'case-insensitive shard suffixes still group together');
  assert.equal(mix.sizeBytes, 5);
  const mmproj = collapsed.find((entry) => entry.key.startsWith('mmproj'));
  assert.ok(mmproj);
  assert.equal(mmproj.shards, 1);
});

ok('collapseShardEntries flags mtp_capable via case-insensitive mtp in the name', () => {
  const entries: RawEntry[] = [
    { path: 'D:/m/Qwen-MTP-00001-of-00002.gguf', name: 'Qwen-MTP-00001-of-00002.gguf', sizeBytes: 2 },
    { path: 'D:/m/Qwen-MTP-00002-of-00002.gguf', name: 'Qwen-MTP-00002-of-00002.gguf', sizeBytes: 2 },
    { path: 'D:/m/plain-mtproxy.gguf', name: 'plain-mtproxy.gguf' },
    { path: 'D:/m/nope.gguf', name: 'nope.gguf' },
  ];
  const collapsed = collapseShardEntries(entries);
  assert.deepEqual(
    collapsed.map((entry) => ({ key: entry.key, mtpCapable: entry.mtpCapable })),
    [
      { key: 'Qwen-MTP-00001-of-00002', mtpCapable: true },
      { key: 'plain-mtproxy', mtpCapable: true },
      { key: 'nope', mtpCapable: false },
    ],
  );
});

ok('collapseShardEntries handles empty input, missing sizes, and near-shard names', () => {
  assert.deepEqual(collapseShardEntries([]), []);
  const noSizes = collapseShardEntries([{ path: 'D:/m/A-00001-of-00002.gguf', name: 'A-00001-of-00002.gguf' }]);
  assert.equal(noSizes[0].sizeBytes, undefined);
  // five digits are required: a -123-of-99999 suffix is NOT a shard marker
  const nearMiss = collapseShardEntries([{ path: 'D:/m/v2-123-of-456.gguf', name: 'v2-123-of-456.gguf' }]);
  assert.equal(nearMiss.length, 1);
  assert.equal(nearMiss[0].shards, 1);
  assert.equal(nearMiss[0].key, 'v2-123-of-456');
});

// ---------------------------------------------------------------------------
// 6. Legacy LM Studio guard
// ---------------------------------------------------------------------------

ok('isLegacyLmStudioModel gates exactly the lmstudio: namespace', () => {
  assert.equal(isLegacyLmStudioModel('lmstudio:qwen/qwen3-coder'), true);
  assert.equal(isLegacyLmStudioModel('lmstudio:'), true);
  assert.equal(isLegacyLmStudioModel('llamacpp:SomeModel'), false);
  assert.equal(isLegacyLmStudioModel('deepseek:x'), false);
  assert.equal(isLegacyLmStudioModel('openrouter/auto'), false);
  assert.equal(isLegacyLmStudioModel(''), false);
  assert.equal(isLegacyLmStudioModel('see lmstudio:x'), false); // prefix must lead
});

ok('REMOVED_LMSTUDIO_MESSAGE matches the frozen §1 rejection text verbatim', () => {
  assert.equal(
    REMOVED_LMSTUDIO_MESSAGE,
    'This conversation uses the removed LM Studio provider (lmstudio:<id>). Pick an llamacpp: model in the model selector.',
  );
});

// ---------------------------------------------------------------------------
// 7. Sampling pin (§6)
// ---------------------------------------------------------------------------

ok('LLAMACPP_SAMPLING_TOP_P pins top_p at 0.8 (§6 Unsloth non-thinking recommendation)', () => {
  assert.equal(LLAMACPP_SAMPLING_TOP_P, 0.8);
});

// ---------------------------------------------------------------------------
// 8. Think splitter copy sanity
// ---------------------------------------------------------------------------

ok('think splitter splits complete blocks and tolerates tags split across deltas', () => {
  const splitter = createThinkStreamSplitter();
  const a = splitter.push('<th');
  const b = splitter.push('ink>secret thought');
  const c = splitter.push('</thi');
  const d = splitter.push('nk>answer text');
  const e = splitter.flush();
  const mergedText = [a, b, c, d, e].reduce(
    (acc, part) => ({ reasoning: acc.reasoning + part.reasoning, content: acc.content + part.content }),
    { reasoning: '', content: '' },
  );
  assert.equal(mergedText.reasoning, 'secret thought');
  assert.equal(mergedText.content, 'answer text');

  assert.equal(stripThinkBlocks('<think>a</think>visible'), 'visible');
  assert.equal(stripThinkBlocks('no tags at all'), 'no tags at all');
  assert.equal(stripThinkBlocks('<think>unterminated tail'), '');
});

console.log(`llamacpp provider tests passed (${checks} checks)`);
