import type { OpenRouterModel } from '../types';
import {
  DEEPSEEK_PREFIX,
  DEEPSEEK_DIRECT_GROUP,
  DEEPSEEK_ACCENT,
  isDeepSeekDirectModel,
  CODEX_PREFIX,
  CODEX_DIRECT_GROUP,
  CODEX_ACCENT,
  isCodexModel,
  ABLITERATION_PREFIX,
  ABLITERATION_GROUP,
  ABLITERATION_ACCENT,
  isAbliterationModel,
  ARNICT_PREFIX,
  ARNICT_GROUP,
  ARNICT_ACCENT,
  isArnictModel,
  OPENCODE_GO_PREFIX,
  OPENCODE_GO_GROUP,
  OPENCODE_GO_ACCENT,
  OPENCODE_GO_BADGE_META,
  isOpencodeGoModel,
  type OpencodeGoBadgeKind,
  LLAMACPP_PREFIX,
  LLAMACPP_GROUP,
  LLAMACPP_ACCENT,
  isLlamaCppModel,
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
  // Abliteration-direct models (`abliteration:...`) group under their own label.
  if (isAbliterationModel(id)) return ABLITERATION_GROUP;
  // Arnict-direct models (`arnict:...`) group under their own label.
  // NOTE: strip the prefix before any `/` split — upstream ids have `author/slug` form.
  if (isArnictModel(id)) return ARNICT_GROUP;
  // OpenCode Go-direct models (`opencode-go:...`) group under their own label.
  if (isOpencodeGoModel(id)) return OPENCODE_GO_GROUP;
  // llama.cpp local models (`llamacpp:...`) group under their own label.
  if (isLlamaCppModel(id)) return LLAMACPP_GROUP;
  const slash = id.indexOf('/');
  return slash > 0 ? id.substring(0, slash) : 'other';
}

/** Short display name from model ID e.g. "openai/gpt-4o" -> "gpt-4o", "deepseek:deepseek-v4-pro" -> "deepseek-v4-pro" */
export function formatModelId(modelId: string): string {
  if (modelId.startsWith(DEEPSEEK_PREFIX)) return modelId.slice(DEEPSEEK_PREFIX.length);
  if (modelId.startsWith(CODEX_PREFIX)) return modelId.slice(CODEX_PREFIX.length);
  if (modelId.startsWith(ABLITERATION_PREFIX)) return modelId.slice(ABLITERATION_PREFIX.length);
  if (modelId.startsWith(ARNICT_PREFIX)) return modelId.slice(ARNICT_PREFIX.length);
  if (modelId.startsWith(OPENCODE_GO_PREFIX)) return modelId.slice(OPENCODE_GO_PREFIX.length);
  if (modelId.startsWith(LLAMACPP_PREFIX)) return modelId.slice(LLAMACPP_PREFIX.length);
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
  [ABLITERATION_GROUP]: 'Abliteration · Direct',
  [ARNICT_GROUP]: 'Arnict · Direct',
  [OPENCODE_GO_GROUP]: 'OpenCode Go · Direct',
  [LLAMACPP_GROUP]: 'llama.cpp · Local',
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
  [ABLITERATION_GROUP]: ABLITERATION_ACCENT,
  [ARNICT_GROUP]: ARNICT_ACCENT,
  [OPENCODE_GO_GROUP]: OPENCODE_GO_ACCENT,
  [LLAMACPP_GROUP]: LLAMACPP_ACCENT,
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
  [ABLITERATION_GROUP]: { name: 'Abliteration · Direct', color: ABLITERATION_ACCENT, iconName: 'brain', tier: 'premium' },
  [ARNICT_GROUP]: { name: 'Arnict · Direct', color: ARNICT_ACCENT, iconName: 'brain', tier: 'premium' },
  [OPENCODE_GO_GROUP]: { name: 'OpenCode Go · Direct', color: OPENCODE_GO_ACCENT, iconName: 'brain', tier: 'premium' },
  // Local models are free and their context can be unknown (0) — grouped as Economy.
  [LLAMACPP_GROUP]: { name: 'llama.cpp · Local', color: LLAMACPP_ACCENT, iconName: 'zap', tier: 'economy' },
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
  ABLITERATION_GROUP,
  ARNICT_GROUP,
  OPENCODE_GO_GROUP,
  LLAMACPP_GROUP,
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

// ----- OpenCode Go picker (T7): badges, pending suffix, limits, ordering -----
// Single source for every Go display decision below is the served catalog
// entry (`transport` / `sendable` / `monthlyLimitUsd`, T1): the frontend never
// duplicates the enablement decision in its own constants.

/** Transport served per Go entry (mirrors the server `OpenCodeGoTransport`). */
export type OpencodeGoTransport = 'chat' | 'messages' | 'responses';

/** Served-entry fields the picker reads (all optional: tolerate old payloads). */
export interface OpencodeGoListFields {
  transport?: OpencodeGoTransport | string;
  sendable?: boolean;
  monthlyLimitUsd?: number;
  priceNote?: string;
}

export type OpencodeGoListModel = OpenRouterModel & OpencodeGoListFields;

/** Suffix for phase-2 rows whose entry is not send-enabled yet. */
export const OPENCODE_GO_PENDING_SUFFIX = '· pendiente de verificación';

/** Transport label for accessible row names (`<Nombre>, <transporte>, <precio>`). */
export const OPENCODE_GO_TRANSPORT_LABELS: Record<OpencodeGoTransport, string> = {
  chat: 'Chat',
  messages: 'Anthropic',
  responses: 'Responses',
};

/** Transport of a Go row from its served entry, or null (non-Go / unknown). */
export function getOpencodeGoTransport(model: OpenRouterModel): OpencodeGoTransport | null {
  if (!isOpencodeGoModel(model.id)) return null;
  const t = (model as OpencodeGoListFields).transport;
  return t === 'chat' || t === 'messages' || t === 'responses' ? t : null;
}

/** Badge kind for a Go row: phase-2 only (`messages` → anthropic, `responses` → responses). */
export function getOpencodeGoBadgeKind(model: OpenRouterModel): OpencodeGoBadgeKind | null {
  const t = getOpencodeGoTransport(model);
  if (t === 'messages') return 'anthropic';
  if (t === 'responses') return 'responses';
  return null;
}

/** Badge label for a Go row (`Anthropic` / `Responses`), or null for chat rows. */
export function getOpencodeGoBadgeLabel(model: OpenRouterModel): string | null {
  const kind = getOpencodeGoBadgeKind(model);
  return kind ? OPENCODE_GO_BADGE_META[kind].label : null;
}

/**
 * Whether the row wears the pending-verification suffix. Governed ONLY by the
 * served `sendable` field (`=== false`); absent/old payloads never suffix.
 */
export function isOpencodeGoPendingVerification(model: OpenRouterModel): boolean {
  return isOpencodeGoModel(model.id) && (model as OpencodeGoListFields).sendable === false;
}

/** Monthly-limit label for settings Go rows (`$60/mes`, or `límite n/d`). */
export function formatOpencodeGoMonthlyLimit(model: OpenRouterModel): string {
  const v = (model as OpencodeGoListFields).monthlyLimitUsd;
  return typeof v === 'number' && Number.isFinite(v) ? `$${v}/mes` : 'límite n/d';
}

/**
 * Settings intra-Go order: base price ascending (prompt/in, then
 * completion/out). Stable: ties keep catalog order. Global provider order
 * (`PROVIDER_PRIORITY`, Go 5th) is untouched — this only sorts inside Go.
 */
export function compareOpencodeGoByPriceAsc(a: OpenRouterModel, b: OpenRouterModel): number {
  const inDiff = parseFloat(a.pricing.prompt) - parseFloat(b.pricing.prompt);
  if (inDiff !== 0) return inDiff;
  return parseFloat(a.pricing.completion) - parseFloat(b.pricing.completion);
}

/**
 * Transport search criterion (T7): a Go row matches when the query (≥2 chars,
 * case-insensitive) is a substring of its badge label (`anthropic`,
 * `responses`) or its transport key (`messages`, `responses`, `chat`).
 */
export function opencodeGoMatchesTransportQuery(model: OpenRouterModel, query: string): boolean {
  if (!isOpencodeGoModel(model.id)) return false;
  const q = query.trim().toLowerCase();
  if (q.length < 2) return false;
  const t = getOpencodeGoTransport(model);
  const badge = getOpencodeGoBadgeLabel(model);
  return [t, badge].some((s) => typeof s === 'string' && s.toLowerCase().includes(q));
}

/**
 * Accessible row name for a Go row: `"<Nombre>, <transporte>, <precio>"` plus
 * `, pendiente de verificación` when the suffix is shown (the visual badge is
 * `aria-hidden` and `aria-label` replaces content announcement, so neither
 * signal may be lost for AT).
 */
export function getOpencodeGoAccessibleName(model: OpenRouterModel): string {
  const t = getOpencodeGoTransport(model);
  const transport = t ? OPENCODE_GO_TRANSPORT_LABELS[t] : 'OpenCode Go';
  const base = `${model.name}, ${transport}, ${formatPrice(model.pricing.prompt)}`;
  return isOpencodeGoPendingVerification(model) ? `${base}, pendiente de verificación` : base;
}
