/**
 * Pure normalizer for Codex app-server `model/list` entries (protocol v2
 * `Model`). Each model declares `supportedReasoningEfforts[{reasoningEffort,
 * description}]` and `defaultReasoningEffort`; turns take `effort`. Values
 * outside the canonical vocabulary (e.g. `ultra`, automatic task delegation)
 * are not offered. There is no separate off switch: off exists only when the
 * model lists `none`.
 */
import {
  capabilityFromControls,
  isReasoningLevel,
  unknownReasoning,
  type ReasoningCapability,
  type ReasoningLevel,
} from '../../../shared/models/reasoning.js';
import type { CatalogModel, ModelInputModality } from '../../../shared/models/catalog.js';
import { namespacedModelId } from '../../../shared/models/providers.js';

export interface CodexProtocolModel {
  id?: string;
  model?: string;
  displayName?: string | null;
  description?: string | null;
  hidden?: boolean;
  supportedReasoningEfforts?: Array<{ reasoningEffort?: string; description?: string }> | null;
  defaultReasoningEffort?: string | null;
  inputModalities?: string[] | null;
}

const CODEX_WIRE = { toggle: false, noneEffort: true, effort: true, budget: false } as const;

export function codexReasoning(model: CodexProtocolModel): ReasoningCapability {
  const efforts = model.supportedReasoningEfforts;
  if (!Array.isArray(efforts)) return unknownReasoning();
  const descriptions: Partial<Record<ReasoningLevel, string>> = {};
  for (const option of efforts) {
    if (isReasoningLevel(option?.reasoningEffort) && typeof option.description === 'string' && option.description.trim()) {
      descriptions[option.reasoningEffort] = option.description.trim();
    }
  }
  return capabilityFromControls(
    {
      toggle: false,
      effortValues: efforts.map((option) => option?.reasoningEffort),
      budget: null,
      defaultLevel: model.defaultReasoningEffort,
      levelDescriptions: descriptions,
    },
    CODEX_WIRE,
  );
}

const MODALITIES: ReadonlySet<string> = new Set(['text', 'image', 'file', 'audio', 'video']);

export function codexCatalogModel(model: CodexProtocolModel): CatalogModel | null {
  const upstreamId = model.id || model.model;
  if (!upstreamId || model.hidden) return null;
  const inputModalities = (model.inputModalities ?? ['text']).filter((m): m is ModelInputModality => MODALITIES.has(m));
  return {
    id: namespacedModelId('codex', upstreamId),
    provider: 'codex',
    upstreamId,
    name: model.displayName || upstreamId,
    description: model.description || '',
    contextLength: null,
    maxOutputTokens: null,
    inputModalities: inputModalities.length > 0 ? inputModalities : ['text'],
    // Billed to the user's ChatGPT plan, never per token.
    pricing: { rates: { input: 0, output: 0 }, source: 'subscription' },
    transport: 'codex',
    historyReasoningField: 'reasoning',
    reasoning: codexReasoning(model),
    lifecycle: 'active',
    monthlyLimitUsd: null,
  };
}
