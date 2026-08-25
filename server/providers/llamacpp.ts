/**
 * llama.cpp local provider — PURE domain module.
 *
 * Holds every provider quirk that can be decided offline: the canonical knob
 * bag + zod validation, the preset slots + sampling row schemas, the single
 * source of launch truth (argv builder), shard-aware GGUF model discovery
 * math, the legacy LM Studio guard and the `<think>` stream splitter. This
 * file imports NOTHING from db/settings/network except zod, so it stays
 * unit-testable without a database or HTTP stack (same discipline as
 * server/providers/lmstudio.ts).
 *
 * User-scoped settings resolution, process lifecycle and transport selection
 * live in llamacppTransport.ts, not here.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Knob bag (global-constraints.md §3 — canonical defaults are FROZEN)
// ---------------------------------------------------------------------------

/** KV-cache quantization types accepted by llama.cpp `-ctk/-ctv`. */
export const LLAMACPP_CACHE_TYPES = [
  'f32',
  'f16',
  'bf16',
  'q8_0',
  'q4_0',
  'q4_1',
  'iq4_nl',
  'q5_0',
  'q5_1',
] as const;

export type LlamacppCacheType = (typeof LLAMACPP_CACHE_TYPES)[number];

export type LlamacppFlashAttn = 'on' | 'off' | 'auto';
export type LlamacppDevice = 'cuda' | 'cpu';

/** Values accepted by llama.cpp `--reasoning-format`. */
export const LLAMACPP_REASONING_FORMATS = ['auto', 'none', 'deepseek', 'deepseek-legacy'] as const;

export type LlamacppReasoningFormat = (typeof LLAMACPP_REASONING_FORMATS)[number];

export interface LlamacppKnobs {
  /** MoE expert layers kept on CPU (`--n-cpu-moe`). */
  n_cpu_moe: number;
  /** Generation threads (`--threads`). */
  threads: number;
  /** Prompt/batch threads (`--threads-batch`). */
  threads_batch: number;
  cache_type_k: LlamacppCacheType;
  cache_type_v: LlamacppCacheType;
  ctx: number;
  /** MTP draft tokens; 0 disables speculative decoding. */
  mtp: number;
  /** Server-wide reasoning budget; -1 = unrestricted (flag omitted). */
  reasoning_budget: number;
  mmap: boolean;
  device: LlamacppDevice;
  /** `'all' | 'auto' | '<positive int as string>'` (`--gpu-layers`). */
  gpu_layers: string;
  flash_attn: LlamacppFlashAttn;
  parallel_slots: number;
  // §4 Increment 2c — OPTIONAL emit-when-set knobs. Absent from the canonical
  // bag on purpose: absent = omitted from argv = llama-server default applies.
  /** Prompt/logical batch size (`--batch-size`, int ≥ 1). */
  logical_batch?: number;
  /** Physical batch size (`--ubatch-size`, int ≥ 1). */
  ubatch?: number;
  /**
   * Reasoning template (`--reasoning-format`). NEVER emitted as `'auto'`
   * ('auto' == the server default, so argv stays byte-identical to absent).
   */
  reasoning_format?: LlamacppReasoningFormat;
}

export type LlamacppKnobOverrides = Partial<LlamacppKnobs>;

/** The §3 canonical bag — EXACT values, do not tune here. */
export const LLAMACPP_DEFAULT_KNOBS: LlamacppKnobs = Object.freeze({
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

function intSchema(min: number, max = Number.POSITIVE_INFINITY): z.ZodNumber {
  let schema = z.number().int();
  if (min !== Number.NEGATIVE_INFINITY) schema = schema.min(min);
  if (max !== Number.POSITIVE_INFINITY) schema = schema.max(max);
  return schema;
}

const GPU_LAYERS_SCHEMA = z
  .string()
  .refine(
    (value) =>
      value === 'all'
      || value === 'auto'
      || (/^\d+$/.test(value) && Number.parseInt(value, 10) > 0),
    "gpu_layers must be 'all', 'auto', or a positive integer as a string",
  );

export const KNOB_OVERRIDE_SCHEMA = z
  .object({
    n_cpu_moe: intSchema(0),
    threads: intSchema(1),
    threads_batch: intSchema(1),
    cache_type_k: z.enum(LLAMACPP_CACHE_TYPES),
    cache_type_v: z.enum(LLAMACPP_CACHE_TYPES),
    ctx: intSchema(1),
    mtp: intSchema(0, 5),
    reasoning_budget: intSchema(-1),
    mmap: z.boolean(),
    device: z.enum(['cuda', 'cpu']),
    gpu_layers: GPU_LAYERS_SCHEMA,
    flash_attn: z.enum(['on', 'off', 'auto']),
    parallel_slots: intSchema(1),
    // §4 Increment 2c — optional emit-when-set knobs (.partial() below makes
    // each key optional; they are deliberately NOT in LLAMACPP_DEFAULT_KNOBS).
    logical_batch: intSchema(1),
    ubatch: intSchema(1),
    reasoning_format: z.enum(LLAMACPP_REASONING_FORMATS),
  })
  .strict()
  .partial();

export type KnobsParseResult =
  | { ok: true; knobs: LlamacppKnobOverrides }
  | { ok: false; error: string };

/**
 * Whole-row schema for the `llamacpp_model_overrides` settings JSON:
 * `Record<modelKey, Partial<knobBag>>` with every entry strictly validated.
 */
export const LLAMACPP_MODEL_OVERRIDES_ROW_SCHEMA = z.record(z.string(), KNOB_OVERRIDE_SCHEMA);

// ---------------------------------------------------------------------------
// Presets + sampling row (global-constraints.md §3 Increment 2 amendment)
// ---------------------------------------------------------------------------

/** The three editable preset slots, in canonical order. */
export const LLAMACPP_PRESET_IDS = ['rapido', 'equilibrado', 'profundo'] as const;

export type LlamacppPresetId = (typeof LLAMACPP_PRESET_IDS)[number];

/** Shape of the persisted/read-back `llamacpp_presets` JSON row. */
export interface LlamacppPresetsRow {
  rapido: LlamacppKnobOverrides;
  equilibrado: LlamacppKnobOverrides;
  profundo: LlamacppKnobOverrides;
}

/** The §3 Increment 2 canonical presets — EXACT values, do not tune here. */
export const LLAMACPP_CANONICAL_PRESETS: LlamacppPresetsRow = Object.freeze({
  rapido: Object.freeze({ reasoning_budget: 1024, mtp: 2 }), // MTP ON (draft-mtp, n-max 2)
  equilibrado: Object.freeze({ reasoning_budget: 2048, mtp: 0 }), // MTP OFF
  profundo: Object.freeze({ reasoning_budget: 4096, mtp: 0 }), // MTP OFF
});

/**
 * Whole-row schema for the `llamacpp_presets` settings JSON: exactly the three
 * named slots, each a strict `Partial<knobBag>` (any knob key is legal for
 * future-proofing; unknown keys rejected).
 */
export const LLAMACPP_PRESETS_ROW_SCHEMA = z
  .object({
    rapido: KNOB_OVERRIDE_SCHEMA,
    equilibrado: KNOB_OVERRIDE_SCHEMA,
    profundo: KNOB_OVERRIDE_SCHEMA,
  })
  .strict();

/** Default active-preset pointer when nothing (or something invalid) is stored. */
export const LLAMACPP_ACTIVE_PRESET_DEFAULT: LlamacppPresetId = 'equilibrado';

/** Scalar schema for `llamacpp_active_preset`; must be one of the three ids. */
export const LLAMACPP_ACTIVE_PRESET_SCHEMA = z.enum(LLAMACPP_PRESET_IDS);

/** Sampling knobs injected into chat/council request bodies (§6/§10). */
export interface LlamacppSampling {
  temp: number;
  top_p: number;
  top_k: number;
  min_p: number;
  repeat_penalty: number;
}

/** The §3 Increment 2 canonical sampling row — EXACT values, do not tune here. */
export const LLAMACPP_SAMPLING_DEFAULTS: LlamacppSampling = Object.freeze({
  temp: 0.6,
  top_p: 0.95,
  top_k: 20,
  min_p: 0,
  repeat_penalty: 1,
});

/** Whole-row schema for the `llamacpp_sampling` settings JSON (strict bounds). */
export const LLAMACPP_SAMPLING_ROW_SCHEMA = z
  .object({
    temp: z.number().min(0).max(2),
    top_p: z.number().min(0).max(1),
    top_k: intSchema(0, 128),
    min_p: z.number().min(0).max(1),
    repeat_penalty: z.number().min(0).max(2),
  })
  .strict();

/**
 * Validates one knob layer (the full canonical bag or any partial). Unknown
 * keys are rejected (`strict`) so typos never silently no-op; every numeric /
 * enum constraint from global-constraints §3/§4 is enforced.
 */
export function parseKnobs(partial: unknown): KnobsParseResult {
  const result = KNOB_OVERRIDE_SCHEMA.safeParse(partial);
  if (result.success) return { ok: true, knobs: result.data };
  const issue = result.error.issues[0];
  return { ok: false, error: issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'invalid knob bag' };
}

/**
 * Merges knob layers with the frozen precedence request > model > global >
 * default: later non-undefined keys win over earlier ones; keys absent from
 * every layer keep the base (canonical) value.
 */
export function mergeKnobLayers(
  base: LlamacppKnobs,
  ...layers: Array<LlamacppKnobOverrides | undefined | null>
): LlamacppKnobs {
  const merged: LlamacppKnobs = { ...base };
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined) (merged as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Argv builder (global-constraints.md §4 — single source of launch truth)
// ---------------------------------------------------------------------------

export interface BuildLlamaServerArgvInput {
  /** Absolute path to the `.gguf` file (first shard for split models). */
  modelPath: string;
  /** Stripped model key — also passed to llama-server as `--alias`. */
  modelKey: string;
  port: number;
  /** FULLY merged knob bag (defaults ⊕ global ⊕ model override ⊕ request). */
  knobs: LlamacppKnobs;
  /** Whether the model file ships an MTP head (case-insensitive name match). */
  mtpCapable: boolean;
}

/**
 * Builds the llama-server argv AFTER the executable (global-constraints §2:
 * spawn frames carry `args`, never a shell string).
 *
 * Emits exactly, in order: --model, --alias, --host 127.0.0.1, --port,
 * --ctx-size, --parallel, --threads, --threads-batch, [--batch-size,
 * --ubatch-size ONLY when the OPTIONAL knobs are set], --gpu-layers,
 * --n-cpu-moe, --flash-attn, --cache-type-k, --cache-type-v, --load-mode
 * mmap|none, --jinja, [--reasoning-budget N when ≥ 0], [--device CUDA0 when
 * device==='cuda'], [--reasoning-format <v> when set and ≠ 'auto'], plus the
 * MTP pair ONLY when `mtp>0 && mtpCapable && parallel_slots===1`.
 *
 * Every numeric/enum arg is explicit — llama-server defaults drift (`--fit`
 * auto-resizes unset args; the port default will change upstream). `--jinja`
 * stays on for Qwen3.x chat templates/tool calls; `--no-mmproj` is never
 * emitted (only meaningful with -hf downloads).
 *
 * §4 Increment 2c: logical_batch/ubatch/reasoning_format are OPTIONAL
 * emit-when-set knobs — absent keys (and reasoning_format 'auto') keep the
 * argv BYTE-IDENTICAL to the pre-amendment builder.
 */
export function buildLlamaServerArgv(input: BuildLlamaServerArgvInput): { args: string[] } {
  const { modelPath, modelKey, port, knobs, mtpCapable } = input;
  const args: string[] = [
    '--model', modelPath,
    '--alias', modelKey,
    '--host', '127.0.0.1',
    '--port', String(port),
    '--ctx-size', String(knobs.ctx),
    '--parallel', String(knobs.parallel_slots),
    '--threads', String(knobs.threads),
    '--threads-batch', String(knobs.threads_batch),
    // §4 Increment 2c emission slot: both optional batch flags directly after
    // --threads-batch; each present ONLY when its knob is defined.
    ...(knobs.logical_batch !== undefined ? ['--batch-size', String(knobs.logical_batch)] : []),
    ...(knobs.ubatch !== undefined ? ['--ubatch-size', String(knobs.ubatch)] : []),
    '--gpu-layers', String(knobs.gpu_layers),
    '--n-cpu-moe', String(knobs.n_cpu_moe),
    '--flash-attn', String(knobs.flash_attn),
    '--cache-type-k', String(knobs.cache_type_k),
    '--cache-type-v', String(knobs.cache_type_v),
    // §4 mapping: desired mmap=true ⇒ explicit `--load-mode mmap`; false ⇒ `none`.
    '--load-mode', knobs.mmap ? 'mmap' : 'none',
    '--jinja',
  ];
  // -1 means "unrestricted" (the server default) — omit the flag entirely.
  if (knobs.reasoning_budget >= 0) {
    args.push('--reasoning-budget', String(knobs.reasoning_budget));
  }
  if (knobs.device === 'cuda') {
    args.push('--device', 'CUDA0');
  }
  // §4 Increment 2c emission slot: directly before the MTP pair; 'auto' is the
  // server default and is NEVER emitted (byte-identical to an absent key).
  if (knobs.reasoning_format !== undefined && knobs.reasoning_format !== 'auto') {
    args.push('--reasoning-format', knobs.reasoning_format);
  }
  if (knobs.mtp > 0 && mtpCapable && knobs.parallel_slots === 1) {
    args.push('--spec-type', 'draft-mtp', '--spec-draft-n-max', String(knobs.mtp));
  }
  return { args };
}

// ---------------------------------------------------------------------------
// Shard-aware model discovery (integration-llamacpp.md §5)
// ---------------------------------------------------------------------------

/** Matches continuation-shard suffixes: `-00001-of-00002.gguf` (case-insensitive). */
const SHARD_SUFFIX_RE = /-(\d{5})-of-(\d{5})\.gguf$/i;

const GGUF_EXTENSION_RE = /\.gguf$/i;
const MTP_NAME_RE = /mtp/i;

/** One collapsed logical model as surfaced by discovery/catalog consumers. */
export interface LlamacppModelEntry {
  /** Basename minus `.gguf` of the representative (first-shard) entry. */
  key: string;
  /** Absolute path of the representative entry (llama-server loads shard 1). */
  path: string;
  /** Summed size across all shards when known; undefined when absent. */
  sizeBytes?: number;
  /** Number of files collapsed into this logical model (1 for single files). */
  shards: number;
  /** Case-insensitive 'mtp' anywhere in the representative's file name. */
  mtpCapable: boolean;
}

interface RawScanEntry {
  path: string;
  name: string;
  sizeBytes?: number;
}

interface ShardGroup {
  firstIndex: number;
  members: RawScanEntry[];
  representative: RawScanEntry;
  representativeShard: number;
}

function keyFromName(name: string): string {
  return name.replace(GGUF_EXTENSION_RE, '');
}

/**
 * Collapses agent scan entries into logical models.
 *
 * Entries matching `-\d{5}-of-\d{5}.gguf` group by their shared prefix and
 * collapse onto the `-00001-` shard (lowest shard number when 00001 is
 * absent — e.g. an orphan `-00002-of-…` set still loads by its only member).
 * Non-shard files pass through untouched. mmproj projectors are excluded
 * agent-side but tolerated here (they surface as ordinary single entries).
 * First-appearance order is preserved; empty input yields empty output.
 */
export function collapseShardEntries(entries: Array<RawScanEntry>): LlamacppModelEntry[] {
  const groups = new Map<string, ShardGroup>();
  const order: Array<{ kind: 'single'; entry: RawScanEntry } | { kind: 'group'; base: string }> = [];

  for (const entry of entries) {
    const match = entry.name.match(SHARD_SUFFIX_RE);
    if (!match || match.index === undefined) {
      order.push({ kind: 'single', entry });
      continue;
    }
    const base = entry.name.slice(0, match.index);
    const shardNumber = Number.parseInt(match[1], 10);
    let group = groups.get(base);
    if (!group) {
      group = { firstIndex: order.length, members: [], representative: entry, representativeShard: shardNumber };
      groups.set(base, group);
      order.push({ kind: 'group', base });
    }
    group.members.push(entry);
    if (
      shardNumber === 1
      || (shardNumber < group.representativeShard && group.representativeShard !== 1)
    ) {
      group.representative = entry;
      group.representativeShard = shardNumber;
    }
  }

  return order.map((item) => {
    if (item.kind === 'single') {
      return {
        key: keyFromName(item.entry.name),
        path: item.entry.path,
        ...(item.entry.sizeBytes !== undefined ? { sizeBytes: item.entry.sizeBytes } : {}),
        shards: 1,
        mtpCapable: MTP_NAME_RE.test(item.entry.name),
      };
    }
    const group = groups.get(item.base)!;
    const sized = group.members.filter((member) => typeof member.sizeBytes === 'number');
    const totalSize = sized.length > 0
      ? sized.reduce((sum, member) => sum + (member.sizeBytes ?? 0), 0)
      : undefined;
    return {
      key: keyFromName(group.representative.name),
      path: group.representative.path,
      ...(totalSize !== undefined ? { sizeBytes: totalSize } : {}),
      shards: group.members.length,
      mtpCapable: MTP_NAME_RE.test(group.representative.name),
    };
  });
}

// ---------------------------------------------------------------------------
// Legacy LM Studio guard (global-constraints.md §1)
// ---------------------------------------------------------------------------

/** True for persisted ids from the REMOVED lmstudio provider (`lmstudio:<id>`). */
export function isLegacyLmStudioModel(modelId: string): boolean {
  return modelId.startsWith('lmstudio:');
}

/** Frozen HTTP-400 rejection text for legacy ids (chat.ts AND councilExecutor). */
export const REMOVED_LMSTUDIO_MESSAGE =
  'This conversation uses the removed LM Studio provider (lmstudio:<id>). Pick an llamacpp: model in the model selector.';

// ---------------------------------------------------------------------------
// Sampling row (global-constraints.md §3/§6 Increment 2 amendment)
//
// The former §6 hard-coded pin (`LLAMACPP_SAMPLING_TOP_P = 0.8`) is DELETED:
// sampling now lives in the persisted `llamacpp_sampling` settings row and is
// injected into request bodies through the shared resolveLlamacppSampling()
// resolver (llamacppTransport.ts) by BOTH chat.ts and councilExecutor.ts.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// <think>…</think> stream splitting (copied from server/providers/lmstudio.ts)
//
// Reasoning models wrap chain-of-thought in <think></think>. SSE deltas can
// split a tag anywhere ('<th' + 'ink>'), so classification is a small state
// machine that holds back any trailing partial tag until it resolves. Outside
// a block everything is content; inside, reasoning.
// ---------------------------------------------------------------------------

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

export interface ThinkSplitResult {
  reasoning: string;
  content: string;
}

export interface ThinkStreamSplitter {
  /** Consumes one delta and returns the reasoning/content split it contained. */
  push(delta: string): ThinkSplitResult;
  /**
   * Ends the stream and emits anything still buffered. A dangling partial tag
   * is literal text of the current region — in particular the tail of an
   * unterminated think block is reasoning.
   */
  flush(): ThinkSplitResult;
}

export function createThinkStreamSplitter(): ThinkStreamSplitter {
  let insideThink = false;
  let pending = '';

  const emit = (text: string, out: ThinkSplitResult): void => {
    if (!text) return;
    if (insideThink) out.reasoning += text;
    else out.content += text;
  };

  const drain = (final: boolean, out: ThinkSplitResult): void => {
    while (pending) {
      const lt = pending.indexOf('<');
      if (lt === -1) {
        emit(pending, out);
        pending = '';
        break;
      }
      emit(pending.slice(0, lt), out);
      const candidate = pending.slice(lt);
      const tag = insideThink ? THINK_CLOSE : THINK_OPEN;
      if (candidate.startsWith(tag)) {
        pending = pending.slice(lt + tag.length);
        insideThink = !insideThink;
        continue;
      }
      if (!final && tag.startsWith(candidate)) {
        pending = candidate; // keep ONLY the undecided partial tag — the prefix is already emitted
        return;
      }
      // Not (the start of) the tag we are waiting for: '<' is literal text.
      emit('<', out);
      pending = candidate.slice(1); // rescan; terminates because a tag needs another '<'
    }
  };

  const run = (delta: string, final: boolean): ThinkSplitResult => {
    const out: ThinkSplitResult = { reasoning: '', content: '' };
    pending += delta;
    drain(final, out);
    return out;
  };

  return {
    push: (delta) => run(delta, false),
    flush: () => run('', true),
  };
}

/** Removes complete <think>…</think> blocks plus any unterminated <think>… tail. */
export function stripThinkBlocks(text: string): string {
  const splitter = createThinkStreamSplitter();
  const pushed = splitter.push(text);
  const flushed = splitter.flush();
  return pushed.content + flushed.content;
}
