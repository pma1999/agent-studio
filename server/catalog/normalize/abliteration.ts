/**
 * Pure normalizer for Abliteration `GET /v1/models` (key-gated,
 * `PublicModelResponse`) entries, enriched with the models.dev
 * `abliteration-ai` entry for reasoning levels.
 *
 * The live list is authoritative for what exists, prices, context, output
 * limit, modalities and access. It publishes no levels, only a `reasoning`
 * feature flag; the models.dev levels match docs.abliteration.ai/capabilities/
 * thinking exactly (verified 2026-09-16). On `/v1/chat/completions` the wire
 * is top-level `reasoning_effort` (`none` switches off where the model allows
 * it); there is no budget field on chat.
 */
import { capabilityFromControls, noReasoning, type ReasoningCapability } from '../../../shared/models/reasoning.js';
import { perMillionFromPerToken, type PricingSpec } from '../../../shared/models/pricing.js';
import type { CatalogModel, ModelInputModality } from '../../../shared/models/catalog.js';
import { namespacedModelId } from '../../../shared/models/providers.js';
import { modelsDevCapability, modelsDevModalities, modelsDevPricing, positiveInt, type ModelsDevModel } from './modelsDev.js';

export interface AbliterationModelEntry {
  id?: string;
  name?: string;
  display_name?: string;
  access?: { available?: boolean; locked?: boolean };
  input_modalities?: string[];
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string };
  supported_features?: string[];
  is_ready?: boolean;
  context_length?: number;
  max_output_length?: number;
}

/** Chat wire: `reasoning_effort` graded, `none` = off, no toggle or budget field. */
export const ABLITERATION_CHAT_WIRE = { toggle: false, noneEffort: true, effort: true, budget: false } as const;

/** Chat Completions accepts the full ladder on every model (docs, "Setting effort per endpoint"). */
const ABLITERATION_CHAT_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export function abliterationReasoning(entry: AbliterationModelEntry, metadata: ModelsDevModel | undefined): ReasoningCapability {
  if (!(entry.supported_features ?? []).includes('reasoning')) return noReasoning();
  const fromMetadata = modelsDevCapability(metadata, ABLITERATION_CHAT_WIRE);
  if (fromMetadata.status === 'known' && fromMetadata.supported) return fromMetadata;
  return capabilityFromControls(
    { toggle: false, effortValues: ABLITERATION_CHAT_EFFORTS, budget: null, levelsSource: 'host' },
    ABLITERATION_CHAT_WIRE,
  );
}

export function abliterationPricing(entry: AbliterationModelEntry): PricingSpec | null {
  const input = perMillionFromPerToken(entry.pricing?.prompt);
  const output = perMillionFromPerToken(entry.pricing?.completion);
  if (input === null || output === null) return null;
  const cacheRead = perMillionFromPerToken(entry.pricing?.input_cache_read);
  return { rates: { input, output, ...(cacheRead !== null ? { cacheRead } : {}) }, source: 'provider-api' };
}

/** A model described only by models.dev (no key yet, or no longer listed). */
export function abliterationCatalogModelFromMetadata(metadata: ModelsDevModel, lifecycle: CatalogModel['lifecycle']): CatalogModel {
  return {
    id: namespacedModelId('abliteration', metadata.id),
    provider: 'abliteration',
    upstreamId: metadata.id,
    name: metadata.name || metadata.id,
    description: metadata.description || '',
    contextLength: positiveInt(metadata.limit?.context),
    maxOutputTokens: positiveInt(metadata.limit?.output),
    inputModalities: modelsDevModalities(metadata),
    pricing: modelsDevPricing(metadata),
    transport: 'chat',
    historyReasoningField: 'reasoning',
    reasoning: modelsDevCapability(metadata, ABLITERATION_CHAT_WIRE),
    lifecycle,
    monthlyLimitUsd: null,
  };
}

const MODALITIES: ReadonlySet<string> = new Set(['text', 'image', 'file', 'audio', 'video']);

export function abliterationCatalogModel(entry: AbliterationModelEntry, metadata: ModelsDevModel | undefined): CatalogModel | null {
  if (!entry.id || entry.access?.available === false) return null;
  const inputModalities = (entry.input_modalities ?? ['text']).filter((m): m is ModelInputModality => MODALITIES.has(m));
  return {
    id: namespacedModelId('abliteration', entry.id),
    provider: 'abliteration',
    upstreamId: entry.id,
    name: entry.display_name || entry.name || entry.id,
    description: metadata?.description || '',
    contextLength: positiveInt(entry.context_length),
    maxOutputTokens: positiveInt(entry.max_output_length),
    inputModalities: inputModalities.length > 0 ? inputModalities : ['text'],
    pricing: abliterationPricing(entry),
    transport: 'chat',
    historyReasoningField: 'reasoning',
    reasoning: abliterationReasoning(entry, metadata),
    lifecycle: 'active',
    monthlyLimitUsd: null,
  };
}
