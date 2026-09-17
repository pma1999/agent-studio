/**
 * Pure readers for models.dev (`https://models.dev/api.json`) entries — the
 * catalog OpenCode's own client routes with. Schema reference:
 * github.com/sst/models.dev AGENTS.md ("Reasoning options"):
 *
 * - `reasoning: false` → the model does not think.
 * - `reasoning_options: []` → always on, no caller control.
 * - `{type:'toggle'}` → on/off on the same id.
 * - `{type:'effort', values}` → graded levels (`none` in values = off).
 * - `{type:'budget_tokens', min?, max?}` → a real reasoning token budget.
 * - `provider.npm` per model overrides the provider's SDK package, which
 *   decides the wire (`@ai-sdk/anthropic` → messages, `@ai-sdk/openai` →
 *   responses, openai-compatible → chat).
 */
import {
  capabilityFromControls,
  noReasoning,
  unknownReasoning,
  type PublishedReasoningControls,
  type ReasoningCapability,
  type ReasoningWireSupport,
} from '../../../shared/models/reasoning.js';
import type { PriceRates, PriceTier, PricingSpec } from '../../../shared/models/pricing.js';
import type { ModelInputModality, ModelTransport } from '../../../shared/models/catalog.js';

export interface ModelsDevCostRow {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

export interface ModelsDevModel {
  id: string;
  name?: string;
  description?: string;
  family?: string;
  attachment?: boolean;
  reasoning?: boolean;
  reasoning_options?: Array<{ type?: string; values?: unknown[]; min?: number; max?: number }>;
  tool_call?: boolean;
  status?: string;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; input?: number; output?: number };
  cost?: ModelsDevCostRow & { tiers?: Array<ModelsDevCostRow & { tier?: { type?: string; size?: number } }> };
  interleaved?: { field?: string } | boolean;
  provider?: { npm?: string; api?: string };
}

export interface ModelsDevProvider {
  id: string;
  npm?: string;
  api?: string;
  name?: string;
  models: Record<string, ModelsDevModel>;
}

/** Published reasoning controls, `null` = no reasoning, `undefined` = not published. */
export function modelsDevReasoningControls(model: ModelsDevModel): PublishedReasoningControls | null | undefined {
  if (model.reasoning !== true) return model.reasoning === false ? null : undefined;
  const options = model.reasoning_options;
  if (!Array.isArray(options)) return undefined;
  const effort = options.find((o) => o?.type === 'effort');
  const budget = options.find((o) => o?.type === 'budget_tokens');
  return {
    toggle: options.some((o) => o?.type === 'toggle'),
    effortValues: Array.isArray(effort?.values) ? effort.values : null,
    budget: budget
      ? {
          min: typeof budget.min === 'number' ? budget.min : null,
          max: typeof budget.max === 'number' ? budget.max : null,
        }
      : null,
  };
}

/** Capability of a models.dev entry on a host wire. */
export function modelsDevCapability(model: ModelsDevModel | null | undefined, wire: ReasoningWireSupport): ReasoningCapability {
  if (!model) return unknownReasoning();
  const controls = modelsDevReasoningControls(model);
  if (controls === null) return noReasoning();
  if (controls === undefined) return unknownReasoning();
  return capabilityFromControls(controls, wire);
}

function rates(row: ModelsDevCostRow | undefined): PriceRates | null {
  if (!row || typeof row.input !== 'number' || typeof row.output !== 'number') return null;
  return {
    input: row.input,
    output: row.output,
    ...(typeof row.cache_read === 'number' ? { cacheRead: row.cache_read } : {}),
    ...(typeof row.cache_write === 'number' ? { cacheWrite: row.cache_write } : {}),
  };
}

/** Pricing from a models.dev `cost` block (USD per 1M; context tiers kept). */
export function modelsDevPricing(model: ModelsDevModel | null | undefined): PricingSpec | null {
  const base = rates(model?.cost);
  if (!base) return null;
  const tiers: PriceTier[] = [];
  for (const row of model?.cost?.tiers ?? []) {
    const tierRates = rates(row);
    const size = row.tier?.type === 'context' ? row.tier.size : undefined;
    if (tierRates && typeof size === 'number' && size > 0) tiers.push({ aboveContextTokens: size, rates: tierRates });
  }
  tiers.sort((a, b) => a.aboveContextTokens - b.aboveContextTokens);
  return { rates: base, ...(tiers.length > 0 ? { tiers } : {}), source: 'models.dev' };
}

const MODALITIES: ReadonlySet<string> = new Set(['text', 'image', 'file', 'audio', 'video', 'pdf']);

export function modelsDevModalities(model: ModelsDevModel | null | undefined): ModelInputModality[] | null {
  if (!Array.isArray(model?.modalities?.input)) return null;
  const input = model.modalities.input.filter((m): m is ModelInputModality => MODALITIES.has(m));
  return input.length > 0 ? input : null;
}

/** Replay field for the reasoning trace, from `interleaved.field`. */
export function modelsDevHistoryField(
  model: ModelsDevModel | null | undefined,
  fallback: 'reasoning' | 'reasoning_content',
): 'reasoning' | 'reasoning_content' {
  const interleaved = model?.interleaved;
  if (interleaved && typeof interleaved === 'object') {
    if (interleaved.field === 'reasoning_content') return 'reasoning_content';
    if (interleaved.field === 'reasoning' || interleaved.field === 'reasoning_details') return 'reasoning';
  }
  return fallback;
}

/** Wire implied by an AI SDK package name; null when the package is not one we speak. */
export function transportForSdkPackage(npm: string | undefined): ModelTransport | null {
  switch (npm) {
    case '@ai-sdk/anthropic':
      return 'messages';
    case '@ai-sdk/openai':
      return 'responses';
    case '@ai-sdk/openai-compatible':
      return 'chat';
    default:
      return null;
  }
}

/** Per-model transport: the model's `provider.npm` override, else the provider package. */
export function modelsDevTransport(model: ModelsDevModel, provider: Pick<ModelsDevProvider, 'npm'>): ModelTransport | null {
  return transportForSdkPackage(model.provider?.npm ?? provider.npm);
}

export function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}
