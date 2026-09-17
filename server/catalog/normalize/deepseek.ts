/**
 * Pure normalizer for DeepSeek direct models: the live `GET /models` id list
 * (key-gated, ids only) enriched with the models.dev `deepseek` entry and the
 * verified overrides (rates models.dev lags on, peak tariff, distinct levels).
 *
 * Wire (api-docs.deepseek.com/guides/thinking_mode): `thinking.type`
 * enabled|disabled + top-level `reasoning_effort`; no budget field. History
 * replays the trace as `reasoning_content` (required on tool-call turns).
 */
import { capabilityFromControls, type ReasoningCapability } from '../../../shared/models/reasoning.js';
import type { PricingSpec } from '../../../shared/models/pricing.js';
import type { CatalogModel } from '../../../shared/models/catalog.js';
import { namespacedModelId } from '../../../shared/models/providers.js';
import { DEEPSEEK_DIRECT_RATES, DEEPSEEK_DISTINCT_LEVELS, DEEPSEEK_PEAK_SCHEDULE } from '../overrides.js';
import {
  modelsDevCapability,
  modelsDevModalities,
  modelsDevPricing,
  positiveInt,
  type ModelsDevModel,
} from './modelsDev.js';

export const DEEPSEEK_WIRE = { toggle: true, noneEffort: true, effort: true, budget: false } as const;

export function deepseekReasoning(metadata: ModelsDevModel | undefined): ReasoningCapability {
  const fromMetadata = modelsDevCapability(metadata, DEEPSEEK_WIRE);
  if (fromMetadata.status === 'known') return fromMetadata;
  return capabilityFromControls(
    { toggle: true, effortValues: DEEPSEEK_DISTINCT_LEVELS.value, budget: null, levelsSource: 'host' },
    DEEPSEEK_WIRE,
  );
}

export function deepseekPricing(upstreamId: string, metadata: ModelsDevModel | undefined): PricingSpec | null {
  const override = DEEPSEEK_DIRECT_RATES.value[upstreamId];
  const base = override
    ? { rates: override, source: 'override' as const }
    : modelsDevPricing(metadata);
  return base ? { ...base, peak: DEEPSEEK_PEAK_SCHEDULE.value } : null;
}

export function deepseekCatalogModel(
  upstreamId: string,
  metadata: ModelsDevModel | undefined,
  lifecycle: CatalogModel['lifecycle'],
): CatalogModel {
  return {
    id: namespacedModelId('deepseek', upstreamId),
    provider: 'deepseek',
    upstreamId,
    name: metadata?.name || upstreamId,
    description: metadata?.description || '',
    contextLength: positiveInt(metadata?.limit?.context),
    maxOutputTokens: positiveInt(metadata?.limit?.output),
    inputModalities: modelsDevModalities(metadata),
    pricing: deepseekPricing(upstreamId, metadata),
    transport: 'chat',
    // API contract: thinking-mode tool-call turns must replay `reasoning_content` (else 400).
    historyReasoningField: 'reasoning_content',
    reasoning: deepseekReasoning(metadata),
    lifecycle,
    monthlyLimitUsd: null,
  };
}
