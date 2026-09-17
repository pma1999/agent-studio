/**
 * Pure normalizer for OpenRouter `GET /api/v1/models` entries.
 *
 * Reasoning (model-level `reasoning` object, OpenRouter OpenAPI `ModelReasoning`):
 * - absent → the model does not think;
 * - `mandatory: true` → cannot be disabled;
 * - `supported_efforts` → graded levels (`none` listed = off by effort);
 *   absent → on/off only;
 * - `default_enabled` / `default_effort` → host defaults;
 * - `supports_max_tokens` → `reasoning.max_tokens` budget accepted.
 * Router ids (`openrouter/*`) resolve per request: capability unknown.
 *
 * Pricing is per-token decimal strings; `overrides[].min_prompt_tokens`
 * rows are context tiers. Responses carry the real `cost`, so time-window
 * overrides are not modelled here. `-1` marks router (dynamic) pricing.
 */
import {
  capabilityFromControls,
  noReasoning,
  unknownReasoning,
  type ReasoningCapability,
} from '../../../shared/models/reasoning.js';
import { perMillionFromPerToken, type PriceRates, type PriceTier, type PricingSpec } from '../../../shared/models/pricing.js';
import type { CatalogModel, ModelInputModality } from '../../../shared/models/catalog.js';
import { positiveInt } from './modelsDev.js';

export interface OpenRouterPricingRow {
  prompt?: string;
  completion?: string;
  input_cache_read?: string;
  input_cache_write?: string;
  min_prompt_tokens?: number;
}

export interface OpenRouterModelEntry {
  id: string;
  name?: string;
  description?: string;
  context_length?: number | null;
  architecture?: { input_modalities?: string[] };
  pricing?: OpenRouterPricingRow & { overrides?: OpenRouterPricingRow[] };
  top_provider?: { context_length?: number | null; max_completion_tokens?: number | null };
  supported_parameters?: string[];
  reasoning?: {
    mandatory?: boolean;
    default_enabled?: boolean;
    supported_efforts?: unknown[] | null;
    default_effort?: string | null;
    supports_max_tokens?: boolean;
  } | null;
  expiration_date?: string | null;
}

/** OpenRouter's `reasoning` parameter carries `enabled`, `effort` (incl. `none`) and `max_tokens`. */
const OPENROUTER_REASONING_WIRE = { toggle: true, noneEffort: true, effort: true, budget: true } as const;

export function isOpenRouterRouterId(id: string): boolean {
  return id.startsWith('openrouter/');
}

export function openRouterReasoning(entry: OpenRouterModelEntry): ReasoningCapability {
  if (isOpenRouterRouterId(entry.id)) return unknownReasoning();
  const r = entry.reasoning;
  if (!r || typeof r !== 'object') {
    return (entry.supported_parameters ?? []).includes('reasoning') ? unknownReasoning() : noReasoning();
  }
  const mandatory = r.mandatory === true;
  return capabilityFromControls(
    {
      toggle: !mandatory,
      effortValues: Array.isArray(r.supported_efforts) ? r.supported_efforts.filter((v) => !(mandatory && v === 'none')) : null,
      budget: r.supports_max_tokens === true ? { min: null, max: null } : null,
      defaultEnabled: typeof r.default_enabled === 'boolean' ? r.default_enabled : null,
      defaultLevel: r.default_effort,
    },
    OPENROUTER_REASONING_WIRE,
  );
}

function ratesFrom(row: OpenRouterPricingRow | undefined): PriceRates | null {
  const input = perMillionFromPerToken(row?.prompt);
  const output = perMillionFromPerToken(row?.completion);
  if (input === null || output === null) return null;
  const cacheRead = perMillionFromPerToken(row?.input_cache_read);
  const cacheWrite = perMillionFromPerToken(row?.input_cache_write);
  return {
    input,
    output,
    ...(cacheRead !== null ? { cacheRead } : {}),
    ...(cacheWrite !== null ? { cacheWrite } : {}),
  };
}

export function openRouterPricing(entry: OpenRouterModelEntry): PricingSpec | null {
  const base = ratesFrom(entry.pricing);
  if (!base) return null;
  const tiers: PriceTier[] = [];
  for (const row of entry.pricing?.overrides ?? []) {
    const min = positiveInt(row.min_prompt_tokens);
    if (min === null) continue;
    // Missing fields in an override row keep the base rate.
    const merged = ratesFrom({ ...entry.pricing, ...row });
    if (merged) tiers.push({ aboveContextTokens: min - 1, rates: merged });
  }
  tiers.sort((a, b) => a.aboveContextTokens - b.aboveContextTokens);
  return { rates: base, ...(tiers.length > 0 ? { tiers } : {}), source: 'provider-api' };
}

const MODALITIES: ReadonlySet<string> = new Set(['text', 'image', 'file', 'audio', 'video']);

export function openRouterCatalogModel(entry: OpenRouterModelEntry): CatalogModel {
  const inputModalities = (entry.architecture?.input_modalities ?? ['text']).filter(
    (m): m is ModelInputModality => MODALITIES.has(m),
  );
  return {
    id: entry.id,
    provider: 'openrouter',
    upstreamId: entry.id,
    name: entry.name || entry.id,
    description: entry.description || '',
    contextLength: positiveInt(entry.context_length) ?? positiveInt(entry.top_provider?.context_length),
    maxOutputTokens: positiveInt(entry.top_provider?.max_completion_tokens),
    inputModalities: inputModalities.length > 0 ? inputModalities : ['text'],
    pricing: openRouterPricing(entry),
    transport: 'chat',
    historyReasoningField: 'reasoning',
    reasoning: openRouterReasoning(entry),
    // `expiration_date` is a scheduled removal (often years out), not a deprecation flag.
    lifecycle: 'active',
    monthlyLimitUsd: null,
  };
}
