/**
 * Pure normalizer for Arnict `GET /v1/models` (key-gated, `schema_version`
 * 2.4) entries.
 *
 * Modalities carry their own limits and `pricing[{type, unit, cost_usd}]`
 * rows (`prompt`, `cached_prompt` on input; `completion` on output). The text
 * output modality lists `supported_parameters`; a `reasoning` entry means the
 * model thinks. The API publishes no per-model levels, so a boolean
 * `reasoning` parameter gets the gateway vocabulary verified with a key on
 * 2026-09-13 (`reasoning:{enabled, effort}`; effort `none|minimal|low|medium|
 * high|xhigh|max`; any other option → 400). If Arnict ever publishes an enum
 * (`{type:'enum', values}`), those values win.
 */
import { capabilityFromControls, noReasoning, type ReasoningCapability } from '../../../shared/models/reasoning.js';
import { perMillionFromPerToken, type PricingSpec } from '../../../shared/models/pricing.js';
import type { CatalogModel, ModelInputModality } from '../../../shared/models/catalog.js';
import { namespacedModelId } from '../../../shared/models/providers.js';
import { positiveInt } from './modelsDev.js';

interface ArnictPriceRow {
  type?: string;
  unit?: string;
  cost_usd?: string;
}

interface ArnictModality {
  type?: string;
  supported_inputs?: { max_context_length?: { value?: number } };
  supported_parameters?: Record<string, { type?: string; values?: unknown[]; min?: number; max?: number }>;
  max_length?: { value?: number };
  pricing?: ArnictPriceRow[];
}

export interface ArnictModelEntry {
  schema_version?: string;
  id?: string;
  name?: string;
  description?: string;
  input_modalities?: ArnictModality[];
  output_modalities?: ArnictModality[];
  is_free?: boolean;
}

/** Gateway effort vocabulary (verified with a key, 2026-09-13). */
export const ARNICT_GATEWAY_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

const ARNICT_WIRE = { toggle: true, noneEffort: true, effort: true, budget: false } as const;

function textOutput(entry: ArnictModelEntry): ArnictModality | undefined {
  return (entry.output_modalities ?? []).find((m) => m?.type === 'text');
}

export function arnictReasoning(entry: ArnictModelEntry): ReasoningCapability {
  const param = textOutput(entry)?.supported_parameters?.reasoning;
  if (!param) return noReasoning();
  const published = Array.isArray(param.values) ? param.values : null;
  return capabilityFromControls(
    {
      toggle: true,
      effortValues: published ?? ARNICT_GATEWAY_EFFORTS,
      budget: null,
      levelsSource: published ? 'model' : 'host',
    },
    ARNICT_WIRE,
  );
}

function priceOf(rows: ArnictPriceRow[] | undefined, type: string): number | null {
  const row = (rows ?? []).find((r) => r?.type === type && (r.unit === undefined || r.unit === 'token'));
  return row ? perMillionFromPerToken(row.cost_usd) : null;
}

export function arnictPricing(entry: ArnictModelEntry): PricingSpec | null {
  const textInput = (entry.input_modalities ?? []).find((m) => m?.type === 'text');
  const input = priceOf(textInput?.pricing, 'prompt');
  const output = priceOf(textOutput(entry)?.pricing, 'completion');
  if (input === null || output === null) return null;
  const cacheRead = priceOf(textInput?.pricing, 'cached_prompt');
  return {
    rates: { input, output, ...(cacheRead !== null ? { cacheRead } : {}) },
    source: 'provider-api',
  };
}

const MODALITIES: ReadonlySet<string> = new Set(['text', 'image', 'file', 'audio', 'video']);

export function arnictCatalogModel(entry: ArnictModelEntry): CatalogModel | null {
  if (!entry.id) return null;
  const textInput = (entry.input_modalities ?? []).find((m) => m?.type === 'text');
  const inputModalities = (entry.input_modalities ?? [])
    .map((m) => m?.type)
    .filter((m): m is ModelInputModality => typeof m === 'string' && MODALITIES.has(m));
  return {
    id: namespacedModelId('arnict', entry.id),
    provider: 'arnict',
    upstreamId: entry.id,
    name: entry.name || entry.id,
    description: entry.description || '',
    contextLength: positiveInt(textInput?.supported_inputs?.max_context_length?.value),
    maxOutputTokens: positiveInt(textOutput(entry)?.max_length?.value),
    inputModalities: inputModalities.length > 0 ? inputModalities : ['text'],
    pricing: arnictPricing(entry),
    transport: 'chat',
    historyReasoningField: 'reasoning',
    reasoning: arnictReasoning(entry),
    lifecycle: 'active',
    monthlyLimitUsd: null,
  };
}
