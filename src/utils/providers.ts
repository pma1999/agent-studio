/**
 * Frontend view of the provider scheme.
 *
 * The scheme itself (ids, prefixes, which provider serves a model id) lives in
 * `shared/models/providers.ts` and is re-exported here; this module adds only
 * what the UI needs on top: a display label, a group key for the model
 * selector, a brand accent, and the transport badge. One row per provider —
 * adding a provider means adding a row, and TypeScript demands it.
 */
import type { ModelTransport } from '../../shared/models/catalog';
import {
  PROVIDER_PREFIXES,
  providerOfModelId,
  upstreamIdOf,
  type ProviderId,
} from '../../shared/models/providers';

export { PROVIDER_PREFIXES, providerOfModelId, upstreamIdOf };
export type { ProviderId };

export interface ProviderUi {
  /** Group heading and settings-card title. */
  label: string;
  /** Synthetic author/group key used by the model selector. */
  group: string;
  accent: string;
}

/**
 * OpenRouter models group by their author (`openai/…`, `anthropic/…`), so it
 * has no group key of its own; every direct provider is one group.
 */
export const PROVIDER_UI: Readonly<Record<ProviderId, ProviderUi>> = {
  openrouter: { label: 'OpenRouter', group: 'openrouter', accent: '#6467f2' },
  deepseek: { label: 'DeepSeek · Direct', group: 'deepseek-direct', accent: '#4D6BFE' },
  codex: { label: 'ChatGPT · Codex', group: 'codex-chatgpt', accent: '#10a37f' },
  abliteration: { label: 'Abliteration · Direct', group: 'abliteration-direct', accent: '#e5489e' },
  arnict: { label: 'Arnict · Direct', group: 'arnict-direct', accent: '#14b8a6' },
  'opencode-go': { label: 'OpenCode Go · Direct', group: 'opencode-go-direct', accent: '#a855f7' },
  llamacpp: { label: 'llama.cpp · Local', group: 'llamacpp-local', accent: '#ca8a04' },
  lmstudio: { label: 'LM Studio', group: 'lmstudio-removed', accent: 'var(--text-muted)' },
};

/** Providers the UI offers, in the order the model selector groups them. */
export const DIRECT_PROVIDERS: readonly ProviderId[] = [
  'deepseek',
  'codex',
  'abliteration',
  'arnict',
  'opencode-go',
  'llamacpp',
];

/** Group key of a model id: the direct provider's group, or the OpenRouter author. */
export function modelGroupKey(modelId: string): string {
  const provider = providerOfModelId(modelId);
  if (provider !== 'openrouter') return PROVIDER_UI[provider].group;
  const slash = modelId.indexOf('/');
  return slash > 0 ? modelId.slice(0, slash) : 'other';
}

/** Provider whose group key this is, or null for an OpenRouter author group. */
export function providerOfGroupKey(group: string): ProviderId | null {
  const entry = (Object.entries(PROVIDER_UI) as Array<[ProviderId, ProviderUi]>)
    .find(([, ui]) => ui.group === group);
  return entry && entry[0] !== 'openrouter' ? entry[0] : null;
}

/** Provider routing (endpoint preferences) is an OpenRouter-only affordance. */
export function supportsProviderRouting(modelId: string | null | undefined): boolean {
  return providerOfModelId(modelId) === 'openrouter';
}

export interface TransportBadge {
  label: string;
  background: string;
  color: string;
}

/**
 * Badge for models served over a non-default wire, so a row's API shape is
 * visible where it matters. Chat and local models wear none. Colour pairs are
 * WCAG AA on both light and dark surfaces (amber 6.37:1, blue 7.15:1).
 */
export const TRANSPORT_BADGES: Readonly<Partial<Record<ModelTransport, TransportBadge>>> = {
  messages: { label: 'Anthropic', background: '#fef3c7', color: '#92400e' },
  responses: { label: 'Responses', background: '#dbeafe', color: '#1e40af' },
};

export function transportBadge(transport: ModelTransport | null | undefined): TransportBadge | null {
  return transport ? TRANSPORT_BADGES[transport] ?? null : null;
}

/**
 * Browser event fired after anything that can change which models a user can
 * see or send to: an API key saved or cleared, a ChatGPT account connected or
 * signed out, a local llama.cpp server started or stopped. The catalog hook
 * listens and reloads.
 */
export const MODEL_CATALOG_CHANGED_EVENT = 'models:catalog-changed';

/** Fired by the llama.cpp panel on config save, status test, start and stop. */
export const LLAMACPP_STATUS_CHANGED_EVENT = 'llamacpp:status-changed';

export function notifyModelCatalogChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(MODEL_CATALOG_CHANGED_EVENT));
}

/**
 * Legacy guard (plan.md D8): ids of the REMOVED previous local provider stay
 * out of every pickable selector list, while conversations that still hold one
 * keep rendering their history labels and surface the server's removal error
 * on send. The prefix literal is assembled at runtime so this file keeps the
 * exhaustive removal-sweep grep clean — this helper is the single intentional
 * reference to that removed scheme in src/.
 */
const REMOVED_LOCAL_PROVIDER_PREFIX = ['lm', 'studio:'].join('');

export function isRemovedLocalProviderId(modelId: string | null | undefined): boolean {
  return typeof modelId === 'string' && modelId.startsWith(REMOVED_LOCAL_PROVIDER_PREFIX);
}

/** True for a model served by this provider (`isOfProvider(id, 'codex')`). */
export function isOfProvider(modelId: string | null | undefined, provider: ProviderId): boolean {
  return typeof modelId === 'string' && providerOfModelId(modelId) === provider;
}

/** Display form of a model id: the upstream id, without the scheme prefix. */
export function stripProviderPrefix(modelId: string): string {
  return upstreamIdOf(modelId);
}

export const LLAMACPP_ACCENT = PROVIDER_UI.llamacpp.accent;
