/**
 * The model catalog contract served by `GET /api/models/catalog` and read by
 * the send path. One shape for every provider; provider-specific facts live
 * in the adapters that build it. Zero dependencies outside `shared/`.
 */
import type { PricingSpec } from './pricing.js';
import type { ProviderId } from './providers.js';
import type { ReasoningCapability } from './reasoning.js';

/** How requests reach the model. */
export type ModelTransport =
  /** OpenAI-compatible `POST /chat/completions`. */
  | 'chat'
  /** Anthropic-compatible `POST /messages`. */
  | 'messages'
  /** OpenAI Responses `POST /responses`. */
  | 'responses'
  /** Codex app-server JSON-RPC turns. */
  | 'codex'
  /** Local llama-server (chat-completions over the paired agent). */
  | 'llamacpp';

export type ModelInputModality = 'text' | 'image' | 'file' | 'audio' | 'video' | 'pdf';

export type ModelLifecycle =
  /** Listed by the host right now. */
  | 'active'
  /** Listed, but the host marks it deprecated. */
  | 'deprecated'
  /** No longer listed; still resolvable for existing conversations and agents. */
  | 'legacy';

export interface LlamaCppModelDetails {
  path: string;
  sizeBytes: number | null;
  shards: number;
  mtpCapable: boolean;
  loaded: boolean;
}

export interface CatalogModel {
  /** Namespaced app id (`deepseek:deepseek-flash`, `anthropic/claude-…`). */
  id: string;
  provider: ProviderId;
  /** Id sent upstream. */
  upstreamId: string;
  name: string;
  description: string;
  contextLength: number | null;
  maxOutputTokens: number | null;
  /** Accepted inputs; null when nothing published says (never assume text-only). */
  inputModalities: ModelInputModality[] | null;
  /** Null when the price is not published anywhere we can read. */
  pricing: PricingSpec | null;
  transport: ModelTransport;
  /** Assistant-history field that replays the reasoning trace. */
  historyReasoningField: 'reasoning' | 'reasoning_content';
  reasoning: ReasoningCapability;
  lifecycle: ModelLifecycle;
  /** Monthly spend cap the host applies to this model, when published. */
  monthlyLimitUsd: number | null;
  llamacpp?: LlamaCppModelDetails;
}

export type ProviderCatalogState =
  /** Fresh list. */
  | 'ok'
  /** Upstream failed; serving the last good list. */
  | 'stale'
  /** The provider needs an API key or account connection before it can list. */
  | 'needs-connection'
  /** Not available for this user (e.g. no paired local agent). */
  | 'unavailable'
  /** Upstream failed and there is nothing to serve. */
  | 'error';

export interface ProviderCatalog {
  provider: ProviderId;
  state: ProviderCatalogState;
  models: CatalogModel[];
  /** ISO timestamp of the data served. */
  fetchedAt: string | null;
  /** User-facing reason for non-`ok` states. */
  message: string | null;
}

export interface CatalogResponse {
  providers: ProviderCatalog[];
}
