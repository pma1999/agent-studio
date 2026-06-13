import { resolveProviderId } from './providers/index.js';

export type ProviderRoutingConfig =
  | { mode: 'auto' }
  | { mode: 'provider'; provider_slug: string; allow_fallbacks: boolean };

export interface OpenRouterProviderPreference {
  order: string[];
  allow_fallbacks: boolean;
}

export interface OpenRouterEndpoint {
  tag: string;
  name: string;
  provider_name: string;
  context_length: number;
  max_completion_tokens: number | null;
  pricing: {
    prompt: string;
    completion: string;
  };
  quantization: string | null;
  supported_parameters: string[];
  status: number | null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function valueByEitherName(value: Record<string, unknown>, snakeName: string, camelName: string): unknown {
  return value[snakeName] ?? value[camelName];
}

function stringArrayOrEmpty(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((param): param is string => typeof param === 'string')
    : [];
}

export function normalizeProviderRoutingConfig(input: unknown): ProviderRoutingConfig | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  if (value.mode === 'auto') return { mode: 'auto' };
  if (value.mode !== 'provider') return null;

  const providerSlug = stringOrNull(value.provider_slug);
  if (!providerSlug) return null;

  return {
    mode: 'provider',
    provider_slug: providerSlug,
    allow_fallbacks: value.allow_fallbacks !== false,
  };
}

export function parseProviderRoutingConfig(raw: unknown): ProviderRoutingConfig | null {
  if (raw == null) return null;
  if (typeof raw === 'object') return normalizeProviderRoutingConfig(raw);
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    return normalizeProviderRoutingConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function serializeProviderRoutingConfig(config: ProviderRoutingConfig | null | undefined): string | null {
  const normalized = normalizeProviderRoutingConfig(config);
  return normalized ? JSON.stringify(normalized) : null;
}

export function normalizeProviderRoutingMap(input: unknown): Record<string, ProviderRoutingConfig> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const output: Record<string, ProviderRoutingConfig> = {};
  for (const [modelId, config] of Object.entries(input as Record<string, unknown>)) {
    const normalized = normalizeProviderRoutingConfig(config);
    if (modelId.trim() && normalized) {
      output[modelId] = normalized;
    }
  }
  return output;
}

export function parseProviderRoutingMap(raw: unknown): Record<string, ProviderRoutingConfig> {
  if (raw == null) return {};
  if (typeof raw === 'object') return normalizeProviderRoutingMap(raw);
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    return normalizeProviderRoutingMap(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function serializeProviderRoutingMap(map: unknown): string {
  return JSON.stringify(normalizeProviderRoutingMap(map));
}

export function resolveProviderRouting(
  ...configs: Array<ProviderRoutingConfig | null | undefined>
): ProviderRoutingConfig {
  for (const config of configs) {
    const normalized = normalizeProviderRoutingConfig(config);
    if (normalized) return normalized;
  }
  return { mode: 'auto' };
}

export function buildOpenRouterProviderPreference(
  config: ProviderRoutingConfig | null | undefined
): OpenRouterProviderPreference | undefined {
  const normalized = normalizeProviderRoutingConfig(config);
  if (!normalized || normalized.mode === 'auto') return undefined;
  return {
    order: [normalized.provider_slug],
    allow_fallbacks: normalized.allow_fallbacks,
  };
}

export function assertProviderRoutingCompatible(
  modelId: string,
  config: ProviderRoutingConfig | null | undefined
): void {
  const normalized = normalizeProviderRoutingConfig(config);
  if (normalized?.mode !== 'provider') return;
  // Provider routing is an OpenRouter-only concept.
  if (resolveProviderId(modelId) !== 'openrouter') {
    throw new Error('Provider routing is only available for OpenRouter models.');
  }
  if (modelId === 'openrouter/auto') {
    throw new Error('Provider routing requires a concrete model. Select a model instead of openrouter/auto.');
  }
}

export function normalizeOpenRouterEndpoint(input: unknown): OpenRouterEndpoint | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  const tag = stringOrNull(value.tag);
  if (!tag) return null;

  const pricing = value.pricing && typeof value.pricing === 'object'
    ? value.pricing as Record<string, unknown>
    : {};

  return {
    tag,
    name: stringOrNull(value.name) ?? tag,
    provider_name: stringOrNull(valueByEitherName(value, 'provider_name', 'providerName')) ?? tag.split('/')[0] ?? tag,
    context_length: numberOrNull(valueByEitherName(value, 'context_length', 'contextLength')) ?? 0,
    max_completion_tokens: numberOrNull(valueByEitherName(value, 'max_completion_tokens', 'maxCompletionTokens')),
    pricing: {
      prompt: stringOrNull(pricing.prompt) ?? '0',
      completion: stringOrNull(pricing.completion) ?? '0',
    },
    quantization: stringOrNull(value.quantization),
    supported_parameters: stringArrayOrEmpty(valueByEitherName(value, 'supported_parameters', 'supportedParameters')),
    status: numberOrNull(value.status),
  };
}

function extractOpenRouterEndpointItems(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  if (!input || typeof input !== 'object') return [];

  const value = input as Record<string, unknown>;
  if (Array.isArray(value.endpoints)) return value.endpoints;
  if ('data' in value) return extractOpenRouterEndpointItems(value.data);
  return [];
}

export function normalizeOpenRouterEndpoints(data: unknown): OpenRouterEndpoint[] {
  return extractOpenRouterEndpointItems(data)
    .map((item) => normalizeOpenRouterEndpoint(item))
    .filter((item): item is OpenRouterEndpoint => item !== null);
}
