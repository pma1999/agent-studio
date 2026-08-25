/**
 * Pure llama.cpp launch-knob logic for the Settings section and the reasoning
 * hint: canonical defaults + Increment 2 preset/sampling rows (global-constraints
 * §3), layer merge with the active-preset layer (§5 resolution v2), per-knob
 * origin derivation for the launch-config preview (plan.md D6/D7), and argv
 * rendering. No React, no fetch — kept as a pure module so the behavior is
 * inspectable without a component harness.
 *
 * Mirrors server/providers/llamacpp.ts field-for-field; do not invent knobs.
 */
import type {
  LlamaCppPresetId,
  LlamaCppPresetsRow,
  LlamaCppSampling,
  LlamaCppStatus,
} from '../api/client';

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
  // §4 Increment 2c — OPTIONAL emit-when-set knobs. NOT part of
  // LLAMACPP_KNOB_DEFAULTS: absent = omitted from argv = server default.
  /** Prompt/logical batch size (`--batch-size`, int ≥ 1). */
  logical_batch?: number;
  /** Physical batch size (`--ubatch-size`, int ≥ 1). */
  ubatch?: number;
  /** Reasoning template (`--reasoning-format`); 'auto' is never emitted. */
  reasoning_format?: LlamaCppReasoningFormat;
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

/** Values accepted by llama.cpp `--reasoning-format` (§4 Increment 2c). */
export const LLAMACPP_REASONING_FORMATS = ['auto', 'none', 'deepseek', 'deepseek-legacy'] as const;

export type LlamaCppReasoningFormat = (typeof LLAMACPP_REASONING_FORMATS)[number];

// --- Increment 2 presets & sampling (§3 Increment 2; value-identical mirror) ---

/** Preset ids in card/display order (§3 Increment 2). */
export const LLAMACPP_PRESET_IDS = ['rapido', 'equilibrado', 'profundo'] as const;

/** Resolved id when the stored scalar is absent/invalid (§3 Increment 2). */
export const LLAMACPP_ACTIVE_PRESET_DEFAULT: LlamaCppPresetId = 'equilibrado';

/**
 * Canonical preset slots — copied verbatim from §3 Increment 2. These are the
 * WRITE-time fillers and the editor placeholders; on READ the stored partial
 * is exposed as-stored (missing keys fall through to the lower merge layers).
 */
export const LLAMACPP_CANONICAL_PRESETS: LlamaCppPresetsRow = Object.freeze({
  rapido: { reasoning_budget: 1024, mtp: 2 }, // MTP ON (draft-mtp, n-max 2)
  equilibrado: { reasoning_budget: 2048, mtp: 0 }, // MTP OFF
  profundo: { reasoning_budget: 4096, mtp: 0 }, // MTP OFF
});

/** Canonical sampling row — copied verbatim from §3 Increment 2. */
export const LLAMACPP_SAMPLING_DEFAULTS: LlamaCppSampling = Object.freeze({
  temp: 0.6,
  top_p: 0.95,
  top_k: 20,
  min_p: 0,
  repeat_penalty: 1,
});

/** §3 Increment 2 zod bounds for the sampling row (top_k must be an integer). */
export interface LlamaCppSamplingBounds {
  min: number;
  max: number;
  integer?: boolean;
}

export const LLAMACPP_SAMPLING_BOUNDS: Record<keyof LlamaCppSampling, LlamaCppSamplingBounds> =
  Object.freeze({
    temp: { min: 0, max: 2 },
    top_p: { min: 0, max: 1 },
    top_k: { min: 0, max: 128, integer: true },
    min_p: { min: 0, max: 1 },
    repeat_penalty: { min: 0, max: 2 },
  });

/** Preset-card metadata — titles + usage copy pinned EXACTLY by §10 user spec. */
export interface LlamaCppPresetMeta {
  id: LlamaCppPresetId;
  label: string;
  usage: string;
}

export const LLAMACPP_PRESET_META: readonly LlamaCppPresetMeta[] = [
  { id: 'rapido', label: 'RÁPIDO', usage: 'consultas normales, explicaciones, código sencillo' },
  { id: 'equilibrado', label: 'EQUILIBRADO', usage: 'uso diario recomendado' },
  { id: 'profundo', label: 'PROFUNDO', usage: 'problemas difíciles, debugging complejo, matemáticas' },
];

/** Display order of the knob table (= §4 argv emission order; optional §4
 * Increment 2c knobs sit at their exact emission slots). */
const KNOB_ORDER: LlamaCppKnobKey[] = [
  'ctx',
  'parallel_slots',
  'threads',
  'threads_batch',
  'logical_batch',
  'ubatch',
  'gpu_layers',
  'n_cpu_moe',
  'flash_attn',
  'cache_type_k',
  'cache_type_v',
  'mmap',
  'reasoning_budget',
  'device',
  'reasoning_format',
  'mtp',
];

const KNOB_LABELS: Record<LlamaCppKnobKey, string> = {
  n_cpu_moe: 'MoE blocks on CPU',
  threads: 'Threads',
  threads_batch: 'Batch threads',
  logical_batch: 'Logical batch',
  ubatch: 'Ubatch (physical)',
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
  reasoning_format: 'Reasoning format',
};

/**
 * Per-key value types for fail-soft parse/merge. Derived-from-defaults checks
 * (`typeof LLAMACPP_KNOB_DEFAULTS[key]`) cannot see the OPTIONAL §4 Increment
 * 2c knobs (absent from the canonical bag), so the types are spelled out.
 */
const KNOB_VALUE_TYPES: Record<LlamaCppKnobKey, 'number' | 'boolean' | 'string'> = {
  n_cpu_moe: 'number',
  threads: 'number',
  threads_batch: 'number',
  logical_batch: 'number',
  ubatch: 'number',
  cache_type_k: 'string',
  cache_type_v: 'string',
  ctx: 'number',
  mtp: 'number',
  reasoning_budget: 'number',
  mmap: 'boolean',
  device: 'string',
  gpu_layers: 'string',
  flash_attn: 'string',
  parallel_slots: 'number',
  reasoning_format: 'string',
};

/** Value-type of a knob key (optional knobs included) — editor/parse helper. */
export function knobValueType(key: LlamaCppKnobKey): 'number' | 'boolean' | 'string' {
  return KNOB_VALUE_TYPES[key];
}

/** Fail-soft acceptance: right primitive type AND (for the closed
 * `reasoning_format` enum) a documented member value. */
function knobValueAcceptable(key: LlamaCppKnobKey, value: unknown): boolean {
  if (key === 'reasoning_format') {
    return typeof value === 'string' && (LLAMACPP_REASONING_FORMATS as readonly string[]).includes(value);
  }
  return typeof value === KNOB_VALUE_TYPES[key];
}

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
      if (knobValueAcceptable(key, value)) {
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

/**
 * Parses the persisted `llamacpp_presets` row fail-soft (§3 Increment 2 READ
 * discipline: the validated PARTIAL is exposed as-stored — missing keys fall
 * through to the LOWER merge layers, not to the canonical preset values; the
 * canonical ⊕ provided fill happens at WRITE time server-side). Unknown slot
 * ids and mistyped knob keys are ignored rather than trusted; an absent or
 * corrupt row yields empty slots (whole-layer fail-soft, no per-key salvage).
 */
export function parseLlamaCppPresetsRow(raw: string | null | undefined): LlamaCppPresetsRow {
  const row: LlamaCppPresetsRow = { rapido: {}, equilibrado: {}, profundo: {} };
  if (!raw || !raw.trim()) return row;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return row;
    for (const id of LLAMACPP_PRESET_IDS) {
      const slot = parsed[id];
      if (!slot || typeof slot !== 'object' || Array.isArray(slot)) continue;
      const clean: LlamaCppKnobOverrides = {};
      for (const key of KNOB_ORDER) {
        const value = (slot as Record<string, unknown>)[key];
        if (knobValueAcceptable(key, value)) {
          (clean as Record<string, unknown>)[key] = value;
        }
      }
      row[id] = clean;
    }
    return row;
  } catch {
    return row;
  }
}

/** Resolves the persisted `llamacpp_active_preset` scalar; absent/invalid ⇒
 * `'equilibrado'` + console.warn (§3 Increment 2). */
export function parseLlamaCppActivePreset(raw: string | null | undefined): LlamaCppPresetId {
  if (LLAMACPP_PRESET_IDS.includes(raw as LlamaCppPresetId)) return raw as LlamaCppPresetId;
  console.warn(
    `[llamacpp] invalid llamacpp_active_preset "${raw ?? ''}" — falling back to '${LLAMACPP_ACTIVE_PRESET_DEFAULT}'`,
  );
  return LLAMACPP_ACTIVE_PRESET_DEFAULT;
}

/** Per-field sampling validation against the §3 zod bounds; null when valid. */
export function samplingValidationError(key: keyof LlamaCppSampling, value: number): string | null {
  const bounds = LLAMACPP_SAMPLING_BOUNDS[key];
  if (!Number.isFinite(value)) return 'Enter a number.';
  if (bounds.integer && !Number.isInteger(value)) return 'Must be a whole number.';
  if (value < bounds.min || value > bounds.max) return `Allowed range: ${bounds.min}–${bounds.max}.`;
  return null;
}

/**
 * Parses the persisted `llamacpp_sampling` row fail-soft: missing keys take
 * their canonical value; ANY present-but-invalid key resolves the WHOLE row to
 * the canonical values (mirrors the server zod whole-row semantics — no
 * per-key salvage).
 */
export function parseLlamaCppSamplingRow(raw: string | null | undefined): LlamaCppSampling {
  const canonical = { ...LLAMACPP_SAMPLING_DEFAULTS };
  if (!raw || !raw.trim()) return canonical;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return canonical;
    const row = { ...canonical };
    for (const key of Object.keys(LLAMACPP_SAMPLING_BOUNDS) as Array<keyof LlamaCppSampling>) {
      const value = parsed[key];
      if (value === undefined) continue; // keep canonical
      if (typeof value !== 'number' || samplingValidationError(key, value)) return canonical;
      row[key] = value;
    }
    return row;
  } catch {
    return canonical;
  }
}

/**
 * Effective persisted reasoning budget for a model at resolution v2
 * (§3 Increment 2): canonical defaults ⊕ llamacpp_load_defaults ⊕
 * ACTIVE-PRESET partial ⊕ llamacpp_model_overrides[modelKey]. `-1` =
 * UNLIMITED (§10) — the argv builder omits the flag entirely.
 */
export function effectiveReasoningBudgetV2(
  defaultsRow: string | null | undefined,
  presetsRow: string | null | undefined,
  activePresetValue: string | null | undefined,
  overridesRow: string | null | undefined,
  modelKey: string | null | undefined,
): number {
  const base = parseLlamaCppJsonRow(defaultsRow, LLAMACPP_KNOB_DEFAULTS);
  const activeId = parseLlamaCppActivePreset(activePresetValue);
  const presetLayer = parseLlamaCppPresetsRow(presetsRow)[activeId];
  const override = modelKey ? overridesForKey(overridesRow, modelKey) : {};
  const merged = mergeKnobLayers(base, presetLayer, override);
  return typeof merged.reasoning_budget === 'number'
    ? merged.reasoning_budget
    : LLAMACPP_KNOB_DEFAULTS.reasoning_budget;
}

export type KnobOrigin = 'global' | `model:${string}` | `preset:${string}` | 'inert';

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
  logical_batch: '--batch-size',
  ubatch: '--ubatch-size',
  gpu_layers: '--gpu-layers',
  n_cpu_moe: '--n-cpu-moe',
  flash_attn: '--flash-attn',
  cache_type_k: '--cache-type-k',
  cache_type_v: '--cache-type-v',
  mmap: '--load-mode',
  reasoning_budget: '--reasoning-budget',
  device: '--device',
  reasoning_format: '--reasoning-format',
  mtp: '--spec-draft-n-max',
};

/**
 * Derives the launch-config preview rows with per-knob origin (D6):
 * `global` when only the defaults row carries the key, `` `preset:<id>` ``
 * when the ACTIVE-PRESET layer supplies it (resolution v2), `model:<key>`
 * when a per-model override supplies it (precedence: model override >
 * preset > global), `inert` for the MTP pair whose flags are omitted (D7) —
 * reason `model-not-mtp` or `requires-parallel-1`.
 *
 * §4 Increment 2c OPTIONAL knobs render a dash with an omitted flag while
 * unset; `reasoning_format 'auto'` also shows its flag as omitted ('auto' ==
 * server default).
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
  /** ACTIVE-PRESET partial layer (§3 resolution v2); optional for pre-Increment-2 callers. */
  preset?: LlamaCppKnobOverrides | null;
  /** Preset id used in origin display, e.g. `preset:equilibrado`. */
  presetId?: string | null;
}): LaunchKnobRow[] {
  const { defaults, overrides, modelKey, mtpCapable, mtpActive, preset, presetId } = options;
  const effective = mergeKnobLayers(defaults, preset, overrides);

  return KNOB_ORDER.map((key) => {
    const overridden = (overrides as Record<string, unknown>)[key] !== undefined;
    const presetSupplied = preset != null && (preset as Record<string, unknown>)[key] !== undefined;
    const originBase: KnobOrigin = overridden
      ? `model:${modelKey ?? '?'}`
      : presetSupplied
        ? `preset:${presetId ?? '?'}`
        : 'global';
    const rawValue = effective[key];
    let flag = FLAG_BY_KEY[key] ?? null;
    let inertReason: LaunchKnobRow['inertReason'];

    if (key === 'reasoning_budget' && effective.reasoning_budget < 0) {
      flag = null; // §4: -1 means unrestricted → flag omitted entirely
    }
    if (key === 'device' && effective.device !== 'cuda') {
      flag = null; // §4: --device CUDA0 only when device==='cuda'
    }
    if (rawValue === undefined) {
      flag = null; // §4 Increment 2c: OPTIONAL knob unset → omitted from argv
    } else if (key === 'reasoning_format' && rawValue === 'auto') {
      flag = null; // §4 Increment 2c: 'auto' == server default → never emitted
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
      value: rawValue === undefined ? '—' : formatKnobValue(key, rawValue),
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
 * Display form for a `reasoning_budget` value; `-1` renders the explicit
 * UNLIMITED affordance copy (§10 — the builder omits the flag at -1).
 */
export function formatReasoningBudget(value: number): string {
  return value === -1 ? '∞ ilimitado' : String(value);
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
