/**
 * Pure llama.cpp launch-knob logic for the Settings section and the reasoning
 * hint: canonical defaults (global-constraints §3), layer merge (§5 start
 * precedence), per-knob origin derivation for the launch-config preview
 * (plan.md D6/D7), and argv rendering. No React, no fetch — kept as a pure
 * module so the behavior is inspectable without a component harness.
 *
 * Mirrors server/providers/llamacpp.ts field-for-field; do not invent knobs.
 */
import type { LlamaCppStatus } from '../api/client';

export const LLAMACPP_PORT_DEFAULT = 8712;
/** `llamacpp_idle_unload_minutes` server default; `0` = off. */
export const LLAMACPP_IDLE_UNLOAD_DEFAULT = 45;
/** Bounded log fetch (§5 logs envelope). */
export const LLAMACPP_LOGS_MAX_BYTES = 8192;

/** Canonical knob bag — copied verbatim from global-constraints §3. */
export interface LlamaCppKnobBag {
  n_cpu_moe: number;
  threads: number;
  threads_batch: number;
  cache_type_k: string;
  cache_type_v: string;
  ctx: number;
  mtp: number;
  reasoning_budget: number;
  mmap: boolean;
  device: 'cuda' | 'cpu';
  gpu_layers: string;
  flash_attn: string;
  parallel_slots: number;
}

export type LlamaCppKnobKey = keyof LlamaCppKnobBag;
export type LlamaCppKnobOverrides = Partial<LlamaCppKnobBag>;

/** Shipped defaults (§3) — identical to server LLAMACPP_DEFAULT_KNOBS. */
export const LLAMACPP_KNOB_DEFAULTS: LlamaCppKnobBag = Object.freeze({
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

/** KV-cache quant types accepted by `-ctk/-ctv` (server LLAMACPP_CACHE_TYPES). */
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

/** Display order of the knob table (= §4 argv emission order). */
const KNOB_ORDER: LlamaCppKnobKey[] = [
  'ctx',
  'parallel_slots',
  'threads',
  'threads_batch',
  'gpu_layers',
  'n_cpu_moe',
  'flash_attn',
  'cache_type_k',
  'cache_type_v',
  'mmap',
  'reasoning_budget',
  'device',
  'mtp',
];

const KNOB_LABELS: Record<LlamaCppKnobKey, string> = {
  n_cpu_moe: 'MoE blocks on CPU',
  threads: 'Threads',
  threads_batch: 'Batch threads',
  cache_type_k: 'KV cache K type',
  cache_type_v: 'KV cache V type',
  ctx: 'Context size',
  mtp: 'MTP draft tokens',
  reasoning_budget: 'Reasoning budget',
  mmap: 'mmap load mode',
  device: 'Device',
  gpu_layers: 'GPU layers',
  flash_attn: 'Flash attention',
  parallel_slots: 'Parallel slots',
};

/**
 * Human-readable value for a knob as it appears in argv (`--load-mode mmap`,
 * `--device CUDA0`, …) — mirrors buildLlamaServerArgv's stringification.
 */
export function formatKnobValue(key: LlamaCppKnobKey, value: LlamaCppKnobBag[LlamaCppKnobKey]): string {
  switch (key) {
    case 'mmap':
      return value ? 'mmap' : 'none';
    case 'device':
      return value === 'cuda' ? 'CUDA0' : 'CPU';
    default:
      return String(value);
  }
}

/**
 * Merges knob layers with the frozen §5 precedence (later non-undefined keys
 * win); mirrors server mergeKnobLayers. Unknown/mistyped keys from corrupt or
 * hand-edited rows are ignored rather than trusted.
 */
export function mergeKnobLayers(
  base: LlamaCppKnobBag,
  ...layers: Array<LlamaCppKnobOverrides | null | undefined>
): LlamaCppKnobBag {
  const merged: LlamaCppKnobBag = { ...base };
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue;
    for (const key of KNOB_ORDER) {
      const value = (layer as Record<string, unknown>)[key];
      if (value !== undefined && typeof value === typeof merged[key]) {
        (merged as unknown as Record<string, unknown>)[key] = value;
      }
    }
  }
  return merged;
}

/**
 * Parses one persisted settings JSON row fail-soft. A missing/corrupt row
 * resolves to `fallback` (canonical defaults or `{}`), matching the ratified
 * §4 amendment "no per-key salvage".
 */
export function parseLlamaCppJsonRow<T extends object>(raw: string | null | undefined, fallback: T): T {
  if (!raw || !raw.trim()) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
    return { ...fallback, ...parsed };
  } catch {
    return fallback;
  }
}

/** Per-model override row for a key out of the persisted overrides record. */
export function overridesForKey(raw: string | null | undefined, modelKey: string): LlamaCppKnobOverrides {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, LlamaCppKnobOverrides>;
    const row = parsed?.[modelKey];
    return row && typeof row === 'object' && !Array.isArray(row) ? row : {};
  } catch {
    return {};
  }
}

/** Effective persisted reasoning budget for a model (defaults ⊕ override). */
export function effectiveReasoningBudget(
  defaultsRow: string | null | undefined,
  overridesRow: string | null | undefined,
  modelKey: string | null | undefined,
): number {
  const base = parseLlamaCppJsonRow(defaultsRow, LLAMACPP_KNOB_DEFAULTS);
  const override = modelKey ? overridesForKey(overridesRow, modelKey) : {};
  const merged = mergeKnobLayers(base, override);
  return typeof merged.reasoning_budget === 'number' ? merged.reasoning_budget : LLAMACPP_KNOB_DEFAULTS.reasoning_budget;
}

export type KnobOrigin = 'global' | `model:${string}` | 'inert';

export interface LaunchKnobRow {
  key: LlamaCppKnobKey;
  label: string;
  /** Value as it appears in argv. */
  value: string;
  /** llama.cpp flag emitted for this knob (null when conditional and omitted). */
  flag: string | null;
  origin: KnobOrigin;
  /** D7 inert reasons — only set when origin === 'inert'. */
  inertReason?: 'model-not-mtp' | 'requires-parallel-1';
}

const FLAG_BY_KEY: Partial<Record<LlamaCppKnobKey, string>> = {
  ctx: '--ctx-size',
  parallel_slots: '--parallel',
  threads: '--threads',
  threads_batch: '--threads-batch',
  gpu_layers: '--gpu-layers',
  n_cpu_moe: '--n-cpu-moe',
  flash_attn: '--flash-attn',
  cache_type_k: '--cache-type-k',
  cache_type_v: '--cache-type-v',
  mmap: '--load-mode',
  reasoning_budget: '--reasoning-budget',
  device: '--device',
  mtp: '--spec-draft-n-max',
};

/**
 * Derives the launch-config preview rows with per-knob origin (D6):
 * `global` when only the defaults row carries the key, `model:<key>` when a
 * per-model override supplies it, `inert` for the MTP pair whose flags are
 * omitted (D7) — reason `model-not-mtp` or `requires-parallel-1`.
 *
 * `mtpActive` comes from the §5 status payload (argv truth); `mtpCapable`
 * from the catalog entry. When neither catalog nor status is available for
 * the running model, an inactive MTP>0 knob reports `model-not-mtp`.
 */
export function deriveLaunchRows(options: {
  defaults: LlamaCppKnobBag;
  overrides: LlamaCppKnobOverrides;
  modelKey: string | null;
  mtpCapable?: boolean | null;
  mtpActive?: boolean | null;
}): LaunchKnobRow[] {
  const { defaults, overrides, modelKey, mtpCapable, mtpActive } = options;
  const effective = mergeKnobLayers(defaults, overrides);

  return KNOB_ORDER.map((key) => {
    const overridden = (overrides as Record<string, unknown>)[key] !== undefined;
    const originBase: KnobOrigin = overridden ? `model:${modelKey ?? '?'}` : 'global';
    let flag = FLAG_BY_KEY[key] ?? null;
    let inertReason: LaunchKnobRow['inertReason'];

    if (key === 'reasoning_budget' && effective.reasoning_budget < 0) {
      flag = null; // §4: -1 means unrestricted → flag omitted entirely
    }
    if (key === 'device' && effective.device !== 'cuda') {
      flag = null; // §4: --device CUDA0 only when device==='cuda'
    }

    if (key === 'mtp') {
      const active = mtpActive === true;
      if (!active) {
        if (effective.mtp <= 0) {
          flag = null; // knob off by config — not inert, just disabled
        } else if (effective.parallel_slots !== 1) {
          inertReason = 'requires-parallel-1';
          flag = null;
        } else if (mtpCapable === false || mtpCapable == null) {
          inertReason = 'model-not-mtp';
          flag = null;
        }
      }
    }

    return {
      key,
      label: KNOB_LABELS[key],
      value: formatKnobValue(key, effective[key]),
      flag,
      origin: inertReason ? 'inert' : originBase,
      ...(inertReason ? { inertReason } : {}),
    };
  });
}

/** Single monospace line for the preview; empty argv renders as a dash. */
export function formatArgvLine(argv: string[] | null | undefined): string {
  if (!argv || argv.length === 0) return '—';
  return argv.join(' ');
}

/**
 * Coarse phase label for the start flow (spawning → loading → ready), driven
 * by the §5 status payload polled while a start request is in flight.
 */
export type StartPhase = 'spawning' | 'loading' | 'ready';

export function phaseFromStatus(status: Pick<LlamaCppStatus, 'running' | 'healthy'> | null): StartPhase {
  if (!status || !status.running) return 'spawning';
  return status.healthy ? 'ready' : 'loading';
}
