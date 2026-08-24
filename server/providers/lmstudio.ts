/**
 * LM Studio (local server) domain logic — PURE module.
 *
 * Holds every provider quirk that can be decided offline: load profiles,
 * sampling defaults, `<think>` stream splitting, catalog normalization and
 * compliance-knob comparison. This file imports NOTHING from db/settings/
 * express so it stays unit-testable without a database or HTTP stack.
 *
 * Network callers (routes, chat loop) consume these exports in later tasks;
 * the user-scoped base URL / token resolution lives with them, not here.
 */

import { LMSTUDIO_PREFIX } from './index.js';

// ---------------------------------------------------------------------------
// Load profiles (global-constraints §3; EQUILIBRADO is the default)
// ---------------------------------------------------------------------------

export type LmStudioProfileId = 'rapido' | 'equilibrado' | 'contexto_grande';

export interface LmStudioProfile {
  id: LmStudioProfileId;
  label: string;
  // REST-applied knobs (POST /api/v1/models/load body)
  contextLength: number;
  flashAttention: boolean;
  offloadKvCacheToGpu: boolean;
  evalBatchSize: number;
  // Advisory knobs — NOT REST-settable; surfaced as GUI/script guidance only
  quantizationExpectation: string;
  gpuOffload: string;
  kvCacheQuant: string;
  vCacheQuant: string;
  parallel: number;
  cpuThreads: string;
}

export const DEFAULT_LMSTUDIO_PROFILE_ID: LmStudioProfileId = 'equilibrado';

const ADVISORY_DEFAULTS = {
  quantizationExpectation: 'Q4_K_M',
  gpuOffload: 'auto',
  kvCacheQuant: 'Q8_0',
  vCacheQuant: 'Q8_0',
  parallel: 1,
  cpuThreads: 'auto',
} as const;

function makeProfile(
  id: LmStudioProfileId,
  label: string,
  contextLength: number,
): LmStudioProfile {
  return {
    id,
    label,
    contextLength,
    flashAttention: true,
    offloadKvCacheToGpu: false,
    evalBatchSize: 512,
    ...ADVISORY_DEFAULTS,
  };
}

export const LMSTUDIO_PROFILES: Record<LmStudioProfileId, LmStudioProfile> = {
  rapido: makeProfile('rapido', 'RÁPIDO', 32768),
  equilibrado: makeProfile('equilibrado', 'EQUILIBRADO', 65536),
  contexto_grande: makeProfile('contexto_grande', 'CONTEXTO GRANDE', 131072),
};

// ---------------------------------------------------------------------------
// Sampling defaults (global-constraints §4)
// ---------------------------------------------------------------------------

export const LMSTUDIO_SAMPLING = {
  general: { temperature: 0.65, top_p: 0.9 }, // band 0.6–0.7
  coding: { temperature: 0.30, top_p: 0.9 }, // band 0.2–0.4
} as const;

export type LmStudioSamplingUsage = keyof typeof LMSTUDIO_SAMPLING;

/**
 * Resolves the sampling fields for an lmstudio request: the agent's own
 * temperature always wins when set; otherwise the usage band default applies.
 * `top_p` is pinned at 0.9 for this provider.
 */
export function resolveLmStudioSampling(
  agentTemperature: number | null | undefined,
  usage: LmStudioSamplingUsage = 'general',
): { temperature: number; top_p: number } {
  const preset = LMSTUDIO_SAMPLING[usage] ?? LMSTUDIO_SAMPLING.general;
  return {
    temperature: agentTemperature ?? preset.temperature,
    top_p: preset.top_p,
  };
}

// ---------------------------------------------------------------------------
// <think>…</think> stream splitting
//
// Reasoning models (e.g. Qwen3) wrap chain-of-thought in <think></think>.
// SSE deltas can split a tag anywhere ('<th' + 'ink>'), so classification is
// a small state machine that holds back any trailing partial tag until it
// resolves. Outside a block everything is content; inside, reasoning.
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

// ---------------------------------------------------------------------------
// Capability gating (fail-open)
// ---------------------------------------------------------------------------

/**
 * Whether tools may be attached for a model with this capability report.
 *
 * Advisory-veto semantics: absence of tools never vetoes (`true`), an unknown
 * capability fails open (`true`), and ONLY an explicit `trainedForToolUse:
 * false` vetoes. The caller combines this with its own has-tools check when
 * building the request body.
 */
export function shouldAttachTools(
  capability: { trainedForToolUse?: boolean | null },
  hasTools: boolean,
): boolean {
  if (!hasTools) return true;
  return capability.trainedForToolUse !== false;
}

// ---------------------------------------------------------------------------
// Variant stripping + swap-candidate selection (global-constraints §11)
// ---------------------------------------------------------------------------

/**
 * Base key of an upstream model key: the portion before the FIRST '@'
 * (`'qwen/qwen3-coder-30b@q4_k_m'` → `'qwen/qwen3-coder-30b'`). Keys without
 * a variant suffix pass through unchanged. Quant variants of one model share
 * a base and must therefore never swap against each other (§11).
 */
export function stripVariantKey(key: string): string {
  const at = key.indexOf('@');
  return at === -1 ? key : key.slice(0, at);
}

/**
 * Loaded model keys whose VARIANT-STRIPPED base differs from the target's —
 * i.e. what a §11 single-slot swap ejects before loading the target. Quant
 * variants of the SAME key are never candidates. Input order is preserved;
 * empty input yields empty output.
 */
export function selectSwapCandidates(targetKey: string, loadedKeys: string[]): string[] {
  const targetBase = stripVariantKey(targetKey);
  return loadedKeys.filter((key) => stripVariantKey(key) !== targetBase);
}

// ---------------------------------------------------------------------------
// Catalog normalization (GET /api/v1/models → OpenRouterModel-shaped rows)
// ---------------------------------------------------------------------------

/** Tolerant view of one native-v1 `/api/v1/models` element. */
export interface LmStudioCatalogEntry {
  key: string; // upstream model key, e.g. 'qwen/qwen3-coder-30b' or '...@q4_k_m'
  displayName: string;
  description: string;
  contextLength: number; // 0 when unknown
  quantization: string | null;
  loaded: boolean;
  trainedForToolUse: boolean | null; // unknown → null (gates fail open)
  loadedConfigs: unknown[];
  /** Live `loaded_instances[].id` values; [] when absent/unloaded (§11 additive field). */
  loadedInstanceIds: string[];
}

/** Namespaced row shaped like the frontend's OpenRouterModel (§8). */
export interface LmStudioCatalogModel {
  id: string; // `${LMSTUDIO_PREFIX}${entry.key}`
  name: string;
  description?: string;
  context_length: number; // may be 0 when unknown
  pricing: { prompt: string; completion: string }; // local inference is free
  quantization?: string | null;
  loaded?: boolean;
  trained_for_tool_use?: boolean | null;
}

type RawRecord = Record<string, unknown>;

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function contextLengthOrZero(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** `quantization{name,…}` object → its string expectation; tolerates a plain string; absent → null. */
function quantizationFromRaw(raw: RawRecord): string | null {
  const q = raw.quantization;
  if (typeof q === 'string') return q || null;
  if (q !== null && typeof q === 'object') return str((q as RawRecord).name) || null;
  return null;
}

/**
 * Tool-use capability from the documented `capabilities` OBJECT
 * (`{vision, trained_for_tool_use, reasoning{…}}`). Absent object or absent
 * field → null (unknown) so downstream capability gating fails open.
 */
function trainedForToolUseFromRaw(raw: RawRecord): boolean | null {
  const caps = raw.capabilities;
  if (caps === null || typeof caps !== 'object' || Array.isArray(caps)) return null;
  const flag = (caps as RawRecord).trained_for_tool_use;
  return typeof flag === 'boolean' ? flag : null;
}

/**
 * Maps one native-v1 `GET /api/v1/models` element (LM Studio 0.4.x, per
 * https://lmstudio.ai/docs/developer/rest/list) to the tolerant entry shape.
 * Documented input fields:
 *   `key` (model identity), `display_name`, `max_context_length`,
 *   `quantization{name,bits_per_weight,size_bytes,params_string}`,
 *   `loaded_instances[{id, config{context_length,…}}]`,
 *   `capabilities{vision, trained_for_tool_use, reasoning{…}}`.
 * `loaded` is DERIVED from `loaded_instances.length > 0`. Legacy ≤0.3.x rows
 * (openai-only branch) are identified via `id`/`model` fallback; their v0-era
 * `state` field never flips `loaded`. Never throws on absent fields.
 */
export function normalizeCatalogEntry(raw: RawRecord): LmStudioCatalogEntry {
  // Identity precedence per FF-06: native-v1 rows carry `key`; legacy ≤0.3.x
  // /v1/models rows fed through the openai-only branch are keyed by `id`
  // (or `model`). Without this fallback those rows collapse to ''.
  const key = str(raw.key) || str(raw.id) || str(raw.model);
  const displayName =
    str(raw.display_name) ||
    (key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key);
  const instances = Array.isArray(raw.loaded_instances) ? raw.loaded_instances : [];
  return {
    key,
    displayName,
    description: str(raw.description),
    contextLength: contextLengthOrZero(raw.max_context_length),
    quantization: quantizationFromRaw(raw),
    loaded: instances.length > 0,
    trainedForToolUse: trainedForToolUseFromRaw(raw),
    loadedConfigs: instances.map((inst) =>
      inst !== null && typeof inst === 'object'
        ? ((inst as RawRecord).config ?? {})
        : {}),
    loadedInstanceIds: instances
      .map((inst) => (inst !== null && typeof inst === 'object' ? str((inst as RawRecord).id) : ''))
      .filter((id) => id.length > 0),
  };
}

/** Namespaces an entry into the OpenRouterModel-shaped catalog row (zero pricing/context tolerated). */
export function toCatalogModel(entry: LmStudioCatalogEntry): LmStudioCatalogModel {
  return {
    id: `${LMSTUDIO_PREFIX}${entry.key}`,
    name: entry.displayName,
    ...(entry.description ? { description: entry.description } : {}),
    context_length: entry.contextLength, // 0 when unknown — consumers must tolerate
    pricing: { prompt: '0', completion: '0' },
    quantization: entry.quantization,
    loaded: entry.loaded,
    trained_for_tool_use: entry.trainedForToolUse,
  };
}

// ---------------------------------------------------------------------------
// Compliance knobs (profile vs live loaded_instances[].config; global §3/§8)
// ---------------------------------------------------------------------------

export type ComplianceKnobMethod = 'rest' | 'gui' | 'sdk-script';

export interface ComplianceKnob {
  key: string;
  label: string;
  expected: string;
  actual: string | null;
  met: boolean | null; // null = knob not observable live
  how: ComplianceKnobMethod;
  guidance?: string;
}

/** Profile field → live `config` key for the four REST-applied load knobs. */
const REST_KNOB_SPECS: Array<{ profileKey: keyof LmStudioProfile; wireKey: string; label: string }> = [
  { profileKey: 'contextLength', wireKey: 'context_length', label: 'Context length' },
  { profileKey: 'flashAttention', wireKey: 'flash_attention', label: 'Flash attention' },
  { profileKey: 'offloadKvCacheToGpu', wireKey: 'offload_kv_cache_to_gpu', label: 'Offload KV cache to GPU' },
  { profileKey: 'evalBatchSize', wireKey: 'eval_batch_size', label: 'Eval batch size' },
];

const NON_REST_KNOB_SPECS: Array<{ key: string; label: string; advisoryKey: keyof typeof ADVISORY_DEFAULTS }> = [
  { key: 'quantization_expectation', label: 'Quantization', advisoryKey: 'quantizationExpectation' },
  { key: 'gpu_offload', label: 'GPU offload', advisoryKey: 'gpuOffload' },
  { key: 'kv_cache_quant', label: 'KV cache quant', advisoryKey: 'kvCacheQuant' },
  { key: 'v_cache_quant', label: 'V cache quant', advisoryKey: 'vCacheQuant' },
  { key: 'parallel', label: 'Parallel sessions', advisoryKey: 'parallel' },
  { key: 'cpu_threads', label: 'CPU threads', advisoryKey: 'cpuThreads' },
];

/** Canonical form for comparing expected vs actual knob values ('512' ≍ 512, 'FALSE' ≍ false). */
function canonValue(value: unknown): string {
  const s = String(value).trim().toLowerCase();
  if (s === '1') return 'true';
  if (s === '0') return 'false';
  return s;
}

function guiGuidance(label: string): string {
  return (
    `Manually choose model load parameters for "${label}" in LM Studio's model loader ` +
    '(this knob cannot be set over the REST API); or apply it programmatically with an @lmstudio/sdk script.'
  );
}

function sdkScriptGuidance(label: string): string {
  return (
    'This LM Studio version has no native load-config API. ' +
    `Manually choose model load parameters for "${label}" in the app's loader, ` +
    'or set defaults with an @lmstudio/sdk script.'
  );
}

/**
 * Compares the active profile against the model's live load config.
 *
 * REST knobs are met/unmet by comparing `liveConfig` values; non-REST knobs
 * are advisory-only (`met: null`) and carry one-time GUI/script guidance.
 * With `liveConfig === null` nothing is observable, so every knob reports
 * `met: null`.
 */
export function buildComplianceKnobs(
  profile: LmStudioProfile,
  liveConfig: Record<string, unknown> | null,
  apiSurface: 'native-v1' | 'openai-only' | null,
): ComplianceKnob[] {
  const knobs: ComplianceKnob[] = [];

  for (const spec of REST_KNOB_SPECS) {
    const expected = String(profile[spec.profileKey]);
    let actual: string | null = null;
    if (liveConfig !== null && liveConfig[spec.wireKey] != null) {
      actual = String(liveConfig[spec.wireKey]);
    }
    knobs.push({
      key: spec.wireKey,
      label: spec.label,
      expected,
      actual,
      met: actual !== null ? canonValue(actual) === canonValue(expected) : null,
      how: 'rest',
    });
  }

  const nonRestHow: ComplianceKnobMethod = apiSurface === 'openai-only' ? 'sdk-script' : 'gui';
  for (const spec of NON_REST_KNOB_SPECS) {
    const expected = String(profile[spec.advisoryKey]);
    knobs.push({
      key: spec.key,
      label: spec.label,
      expected,
      actual: null, // advisory knobs are not observable in the live config
      met: null,
      how: nonRestHow,
      guidance:
        nonRestHow === 'sdk-script' ? sdkScriptGuidance(spec.label) : guiGuidance(spec.label),
    });
  }

  return knobs;
}
