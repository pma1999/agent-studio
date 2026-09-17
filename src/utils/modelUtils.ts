/**
 * Display helpers for catalog models: grouping, labels, prices, badges.
 *
 * Everything here reads a `CatalogModel` (or its id). Nothing knows what a
 * given provider offers — that comes from the server catalog — so a new
 * provider or model needs no change in this file.
 */
import type { CatalogModel } from '../../shared/models/catalog';
import { isFreePricing, type PricingSpec } from '../../shared/models/pricing';
import {
  DIRECT_PROVIDERS,
  PROVIDER_UI,
  modelGroupKey,
  providerOfGroupKey,
  providerOfModelId,
  transportBadge,
  upstreamIdOf,
  type ProviderId,
} from './providers';

export const FAVORITES_STORAGE_KEY = 'agent-studio:favorite-models';
export const RECENT_STORAGE_KEY = 'modelSelector.recent';
export const MAX_RECENT = 5;

export { modelGroupKey };

/** Short display name: `openai/gpt-4o` → `gpt-4o`, `deepseek:deepseek-v4-pro` → `deepseek-v4-pro`. */
export function formatModelId(modelId: string): string {
  const upstream = upstreamIdOf(modelId);
  if (providerOfModelId(modelId) !== 'openrouter') return upstream;
  const parts = upstream.split('/');
  return parts[parts.length - 1] || upstream;
}

/** OpenRouter author keys that have a proper display name. */
const AUTHOR_DISPLAY_NAMES: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  'meta-llama': 'Meta',
  mistralai: 'Mistral',
  deepseek: 'DeepSeek',
  microsoft: 'Microsoft',
  amazon: 'Amazon',
  cohere: 'Cohere',
  '01-ai': '01.AI',
  nvidia: 'NVIDIA',
  'x-ai': 'xAI',
  moonshotai: 'Moonshot AI',
  qwen: 'Qwen',
  'z-ai': 'Z.AI',
};

const AUTHOR_COLORS: Record<string, string> = {
  openai: '#10a37f',
  anthropic: '#d97757',
  google: '#4285f4',
  'meta-llama': '#0081fb',
  mistralai: '#f97316',
  deepseek: '#4f46e5',
  microsoft: '#00a4ef',
  amazon: '#ff9900',
  cohere: '#ff6b6b',
};

/** Heading for a group key: the provider's label, or the OpenRouter author. */
export function formatAuthor(group: string): string {
  const provider = providerOfGroupKey(group);
  if (provider) return PROVIDER_UI[provider].label;
  return AUTHOR_DISPLAY_NAMES[group] || group.charAt(0).toUpperCase() + group.slice(1);
}

export function getAuthorColor(group: string): string {
  const provider = providerOfGroupKey(group);
  if (provider) return PROVIDER_UI[provider].accent;
  return AUTHOR_COLORS[group] || 'var(--text-muted)';
}

export type ProviderTier = 'premium' | 'standard' | 'economy';

export interface ProviderMeta {
  name: string;
  color: string;
  iconName: 'sparkles' | 'zap' | 'eye' | 'brain';
  tier: ProviderTier;
}

const AUTHOR_META: Record<string, Pick<ProviderMeta, 'iconName' | 'tier'>> = {
  anthropic: { iconName: 'brain', tier: 'premium' },
  openai: { iconName: 'sparkles', tier: 'premium' },
  google: { iconName: 'zap', tier: 'premium' },
  'meta-llama': { iconName: 'eye', tier: 'standard' },
  mistralai: { iconName: 'zap', tier: 'standard' },
  cohere: { iconName: 'brain', tier: 'standard' },
};

/** Local models are free and their window can be unknown, so they sit in Economy. */
const PROVIDER_ICON: Record<ProviderId, Pick<ProviderMeta, 'iconName' | 'tier'>> = {
  openrouter: { iconName: 'sparkles', tier: 'standard' },
  deepseek: { iconName: 'brain', tier: 'premium' },
  codex: { iconName: 'sparkles', tier: 'premium' },
  abliteration: { iconName: 'brain', tier: 'premium' },
  arnict: { iconName: 'brain', tier: 'premium' },
  'opencode-go': { iconName: 'brain', tier: 'premium' },
  llamacpp: { iconName: 'zap', tier: 'economy' },
  lmstudio: { iconName: 'zap', tier: 'economy' },
};

/** Display metadata for a group key (from `modelGroupKey(id)`). */
export function getProviderMeta(group: string): ProviderMeta {
  const provider = providerOfGroupKey(group);
  if (provider) {
    return { name: PROVIDER_UI[provider].label, color: PROVIDER_UI[provider].accent, ...PROVIDER_ICON[provider] };
  }
  return {
    name: formatAuthor(group),
    color: getAuthorColor(group),
    ...(AUTHOR_META[group] ?? { iconName: 'sparkles' as const, tier: 'economy' as const }),
  };
}

/** Direct providers first (in settings order), then the OpenRouter authors. */
export const PROVIDER_PRIORITY: readonly string[] = [
  ...DIRECT_PROVIDERS.map((provider) => PROVIDER_UI[provider].group),
  'openai',
  'anthropic',
  'google',
  'meta-llama',
  'mistralai',
  'deepseek',
  'microsoft',
  'amazon',
  'cohere',
  'x-ai',
];

// ---------------------------------------------------------------------------
// Prices, windows, limits
// ---------------------------------------------------------------------------

/** A USD-per-1M rate, at the precision it needs to stay meaningful. */
export function formatRate(perMillion: number | null | undefined): string {
  if (perMillion === null || perMillion === undefined || !Number.isFinite(perMillion)) return '—';
  if (perMillion === 0) return 'Free';
  if (perMillion >= 1) return `$${perMillion.toFixed(2)}/M`;
  if (perMillion >= 0.1) return `$${perMillion.toFixed(3)}/M`;
  if (perMillion >= 0.01) return `$${perMillion.toFixed(4)}/M`;
  return `$${perMillion.toFixed(6).replace(/\.?0+$/, '')}/M`;
}

/** Input rate of a model, the number shown in dense rows. */
export function formatModelPrice(pricing: PricingSpec | null | undefined): string {
  if (!pricing) return '—';
  if (isFreePricing(pricing)) return 'Free';
  return formatRate(pricing.rates.input);
}

/** `in $0.15/M · out $0.60/M`, for the detail line. */
export function formatPriceRange(pricing: PricingSpec | null | undefined): string | null {
  if (!pricing) return null;
  if (isFreePricing(pricing)) return 'Free';
  return `in ${formatRate(pricing.rates.input)} · out ${formatRate(pricing.rates.output)}`;
}

export function formatUptime(pct: number | null): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return '—';
  return `${pct.toFixed(2)}%`;
}

/** Context window in the compact form the rows use (`1.0M`, `256K`). */
export function formatContext(length: number | null | undefined): string {
  if (length === null || length === undefined || !Number.isFinite(length) || length <= 0) return '—';
  if (length >= 1000000) return `${(length / 1000000).toFixed(1)}M`;
  if (length >= 1000) return `${(length / 1000).toFixed(0)}K`;
  return String(length);
}

/** Monthly spend cap, where the host publishes one. */
export function formatMonthlyLimit(model: Pick<CatalogModel, 'monthlyLimitUsd'>): string | null {
  const limit = model.monthlyLimitUsd;
  if (limit === null || limit === undefined) return null;
  return Number.isFinite(limit) ? `$${limit}/month` : null;
}

// ---------------------------------------------------------------------------
// Row decoration
// ---------------------------------------------------------------------------

/** Badge for a model served over a non-chat wire (`Anthropic`, `Responses`). */
export function modelTransportBadge(model: Pick<CatalogModel, 'transport'>) {
  return transportBadge(model.transport);
}

/** Note for a model that is no longer listed or is on its way out. */
export function lifecycleNote(model: Pick<CatalogModel, 'lifecycle'>): string | null {
  switch (model.lifecycle) {
    case 'legacy':
      return 'No longer listed';
    case 'deprecated':
      return 'Deprecated';
    default:
      return null;
  }
}

/** `"<name>, Anthropic, in $0.30/M"` — what assistive tech reads for a row. */
export function modelAccessibleName(model: CatalogModel): string {
  const badge = modelTransportBadge(model);
  const parts = [model.name, badge?.label, formatModelPrice(model.pricing), lifecycleNote(model)];
  return parts.filter(Boolean).join(', ');
}

/** Matches a row against a search query, including its transport wire. */
export function modelMatchesQuery(model: CatalogModel, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  const badge = modelTransportBadge(model)?.label ?? '';
  return [model.id, model.name, model.description, model.transport, badge]
    .some((field) => typeof field === 'string' && field.toLowerCase().includes(q));
}

/** Cheapest first (input, then output). Stable: ties keep catalog order. */
export function compareByPriceAsc(a: CatalogModel, b: CatalogModel): number {
  const rate = (model: CatalogModel, key: 'input' | 'output') => model.pricing?.rates[key] ?? Number.POSITIVE_INFINITY;
  return (rate(a, 'input') - rate(b, 'input')) || (rate(a, 'output') - rate(b, 'output'));
}
