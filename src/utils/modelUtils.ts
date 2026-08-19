import {
  DEEPSEEK_PREFIX,
  DEEPSEEK_DIRECT_GROUP,
  DEEPSEEK_ACCENT,
  isDeepSeekDirectModel,
  CODEX_PREFIX,
  CODEX_DIRECT_GROUP,
  CODEX_ACCENT,
  isCodexModel,
} from './providers';

export const FAVORITES_STORAGE_KEY = 'agent-studio:favorite-models';
export const RECENT_STORAGE_KEY = 'modelSelector.recent';
export const MAX_RECENT = 5;

/** Extract provider/author from model ID e.g. "openai/gpt-4o" -> "openai" */
export function getModelAuthor(id: string): string {
  // DeepSeek-direct models (`deepseek:...`) group separately from OpenRouter's `deepseek/...` slugs.
  if (isDeepSeekDirectModel(id)) return DEEPSEEK_DIRECT_GROUP;
  // ChatGPT (Codex) models (`codex:...`) group under their own label.
  if (isCodexModel(id)) return CODEX_DIRECT_GROUP;
  const slash = id.indexOf('/');
  return slash > 0 ? id.substring(0, slash) : 'other';
}

/** Short display name from model ID e.g. "openai/gpt-4o" -> "gpt-4o", "deepseek:deepseek-v4-pro" -> "deepseek-v4-pro" */
export function formatModelId(modelId: string): string {
  if (modelId.startsWith(DEEPSEEK_PREFIX)) return modelId.slice(DEEPSEEK_PREFIX.length);
  if (modelId.startsWith(CODEX_PREFIX)) return modelId.slice(CODEX_PREFIX.length);
  const parts = modelId.split('/');
  if (parts.length > 1) return parts[parts.length - 1];
  return modelId;
}

const AUTHOR_DISPLAY_NAMES: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  'meta-llama': 'Meta',
  mistralai: 'Mistral',
  deepseek: 'DeepSeek',
  [DEEPSEEK_DIRECT_GROUP]: 'DeepSeek · Direct',
  [CODEX_DIRECT_GROUP]: 'ChatGPT · Codex',
  microsoft: 'Microsoft',
  amazon: 'Amazon',
  cohere: 'Cohere',
  '01-ai': '01.AI',
  nvidia: 'NVIDIA',
  'x-ai': 'xAI',
};

export function formatAuthor(author: string): string {
  return AUTHOR_DISPLAY_NAMES[author] || author.charAt(0).toUpperCase() + author.slice(1);
}

const AUTHOR_COLORS: Record<string, string> = {
  openai: '#10a37f',
  anthropic: '#d97757',
  google: '#4285f4',
  'meta-llama': '#0081fb',
  mistralai: '#f97316',
  deepseek: '#4f46e5',
  [DEEPSEEK_DIRECT_GROUP]: DEEPSEEK_ACCENT,
  [CODEX_DIRECT_GROUP]: CODEX_ACCENT,
  microsoft: '#00a4ef',
  amazon: '#ff9900',
  cohere: '#ff6b6b',
};

export function getAuthorColor(author: string): string {
  return AUTHOR_COLORS[author] || 'var(--text-muted)';
}

export type ProviderTier = 'premium' | 'standard' | 'economy';

export interface ProviderMeta {
  name: string;
  color: string;
  iconName: 'sparkles' | 'zap' | 'eye' | 'brain';
  tier: ProviderTier;
}

const PROVIDER_META: Record<string, ProviderMeta> = {
  anthropic: { name: 'Anthropic', color: '#d4a574', iconName: 'brain', tier: 'premium' },
  openai: { name: 'OpenAI', color: '#7ab88f', iconName: 'sparkles', tier: 'premium' },
  google: { name: 'Google', color: '#8ba4d4', iconName: 'zap', tier: 'premium' },
  [DEEPSEEK_DIRECT_GROUP]: { name: 'DeepSeek · Direct', color: DEEPSEEK_ACCENT, iconName: 'brain', tier: 'premium' },
  'meta-llama': { name: 'Meta', color: '#a78bfa', iconName: 'eye', tier: 'standard' },
  mistralai: { name: 'Mistral', color: '#f59e0b', iconName: 'zap', tier: 'standard' },
  cohere: { name: 'Cohere', color: '#ec4899', iconName: 'brain', tier: 'standard' },
  deepseek: { name: 'DeepSeek', color: '#4f46e5', iconName: 'zap', tier: 'economy' },
  microsoft: { name: 'Microsoft', color: '#00a4ef', iconName: 'zap', tier: 'economy' },
  amazon: { name: 'Amazon', color: '#ff9900', iconName: 'zap', tier: 'economy' },
  '01-ai': { name: '01.AI', color: 'var(--text-muted)', iconName: 'sparkles', tier: 'economy' },
  nvidia: { name: 'NVIDIA', color: 'var(--text-muted)', iconName: 'zap', tier: 'economy' },
  'x-ai': { name: 'xAI', color: 'var(--text-muted)', iconName: 'sparkles', tier: 'economy' },
};

/** Provider metadata for display; author is from getModelAuthor(id) */
export function getProviderMeta(provider: string): ProviderMeta {
  const meta = PROVIDER_META[provider];
  if (meta) return meta;
  return {
    name: formatAuthor(provider),
    color: getAuthorColor(provider),
    iconName: 'sparkles',
    tier: 'economy',
  };
}

export function formatPrice(priceStr: string): string {
  const price = parseFloat(priceStr);
  if (isNaN(price) || price === 0) return 'Gratis';
  const perMillion = price * 1000000;
  if (perMillion >= 1) return `$${perMillion.toFixed(2)}/M`;
  if (perMillion >= 0.1) return `$${perMillion.toFixed(3)}/M`;
  if (perMillion >= 0.01) return `$${perMillion.toFixed(4)}/M`;
  const fixed6 = perMillion.toFixed(6);
  const trimmed = fixed6.replace(/\.?0+$/, '');
  return `$${trimmed}/M`;
}

export function formatUptime(pct: number | null): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return '—';
  return `${pct.toFixed(2)}%`;
}

export function formatContext(length: number): string {
  if (length >= 1000000) return `${(length / 1000000).toFixed(1)}M`;
  if (length >= 1000) return `${(length / 1000).toFixed(0)}K`;
  return String(length);
}

export const PROVIDER_PRIORITY = [
  DEEPSEEK_DIRECT_GROUP,
  CODEX_DIRECT_GROUP,
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
] as const;
