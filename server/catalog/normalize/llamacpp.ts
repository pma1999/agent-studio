/**
 * Pure normalizer for local llama.cpp models (scanned GGUF files) and the
 * reasoning capability of the loaded model read from llama-server `GET /props`.
 *
 * `/props.chat_template_caps.supports_reasoning_effort` is computed by
 * llama.cpp by rendering the chat template with a `reasoning_effort` value
 * (common/jinja/caps.cpp): when true, per-request `reasoning_effort` reaches
 * the template (`none` disables). The template source decides the rest:
 * `enable_thinking` → per-request on/off via `chat_template_kwargs`; thinking
 * markers without that switch → unknown; no thinking constructs → the model
 * does not think. A model that is not loaded has no props: unknown.
 */
import {
  capabilityFromControls,
  noReasoning,
  unknownReasoning,
  type ReasoningCapability,
} from '../../../shared/models/reasoning.js';
import { REASONING_EFFORT_ORDER } from '../../../shared/reasoningEfforts.js';
import type { CatalogModel } from '../../../shared/models/catalog.js';
import { namespacedModelId } from '../../../shared/models/providers.js';

export interface LlamaServerProps {
  chat_template?: string;
  chat_template_caps?: Record<string, unknown>;
  modalities?: { vision?: boolean; audio?: boolean; video?: boolean };
  default_generation_settings?: { n_ctx?: number };
}

const LLAMACPP_WIRE = { toggle: true, noneEffort: true, effort: true, budget: false } as const;

const THINKING_MARKERS = /<think>|reasoning_content|thinking/i;

export function llamacppReasoningFromProps(props: LlamaServerProps | null | undefined): ReasoningCapability {
  if (!props) return unknownReasoning();
  const template = typeof props.chat_template === 'string' ? props.chat_template : '';
  const gradedByTemplate = props.chat_template_caps?.supports_reasoning_effort === true;
  const toggleByTemplate = template.includes('enable_thinking');
  if (gradedByTemplate) {
    return capabilityFromControls(
      { toggle: toggleByTemplate, effortValues: ['none', ...REASONING_EFFORT_ORDER], budget: null, levelsSource: 'host' },
      LLAMACPP_WIRE,
    );
  }
  if (toggleByTemplate) {
    return capabilityFromControls({ toggle: true, effortValues: null, budget: null }, LLAMACPP_WIRE);
  }
  if (!template) return unknownReasoning();
  return THINKING_MARKERS.test(template) ? unknownReasoning() : noReasoning();
}

export interface LlamacppScanEntry {
  key: string;
  path: string;
  sizeBytes?: number;
  shards: number;
  mtpCapable: boolean;
}

export function llamacppCatalogModel(
  entry: LlamacppScanEntry,
  loaded: boolean,
  props: LlamaServerProps | null,
): CatalogModel {
  const vision = props?.modalities?.vision === true;
  return {
    id: namespacedModelId('llamacpp', entry.key),
    provider: 'llamacpp',
    upstreamId: entry.key,
    name: entry.key,
    description: '',
    contextLength: loaded && typeof props?.default_generation_settings?.n_ctx === 'number' && props.default_generation_settings.n_ctx > 0
      ? props.default_generation_settings.n_ctx
      : null,
    maxOutputTokens: null,
    inputModalities: loaded && props ? (vision ? ['text', 'image'] : ['text']) : null,
    pricing: { rates: { input: 0, output: 0 }, source: 'local' },
    transport: 'llamacpp',
    historyReasoningField: 'reasoning',
    reasoning: loaded ? llamacppReasoningFromProps(props) : unknownReasoning(),
    lifecycle: 'active',
    monthlyLimitUsd: null,
    llamacpp: {
      path: entry.path,
      sizeBytes: entry.sizeBytes ?? null,
      shards: entry.shards,
      mtpCapable: entry.mtpCapable,
      loaded,
    },
  };
}
