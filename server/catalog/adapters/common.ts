/** Helpers shared by provider adapters. */
import crypto from 'node:crypto';
import { unknownReasoning } from '../../../shared/models/reasoning.js';
import type { CatalogModel, ModelTransport, ProviderCatalog, ProviderCatalogState } from '../../../shared/models/catalog.js';
import { namespacedModelId, type ProviderId } from '../../../shared/models/providers.js';
import { UpstreamError } from '../http.js';

/** Cache variant for key-gated data: a short hash, never the key itself. */
export function credentialVariant(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

/** Scope for data that belongs to one user. */
export function userScope(provider: ProviderId, userId: string): string {
  return `${provider}:user:${userId}`;
}

export function providerCatalog(
  provider: ProviderId,
  state: ProviderCatalogState,
  models: CatalogModel[],
  fetchedAt: number | null,
  message: string | null = null,
): ProviderCatalog {
  return {
    provider,
    state,
    models,
    fetchedAt: fetchedAt === null ? null : new Date(fetchedAt).toISOString(),
    message,
  };
}

/** A model nothing is known about: unknown capability, provider's default wire. */
export function unknownCatalogModel(
  provider: ProviderId,
  upstreamId: string,
  transport: ModelTransport,
  historyReasoningField: CatalogModel['historyReasoningField'] = 'reasoning',
): CatalogModel {
  return {
    id: namespacedModelId(provider, upstreamId),
    provider,
    upstreamId,
    name: upstreamId,
    description: '',
    contextLength: null,
    maxOutputTokens: null,
    inputModalities: null,
    pricing: null,
    transport,
    historyReasoningField,
    reasoning: unknownReasoning(),
    lifecycle: 'legacy',
    monthlyLimitUsd: null,
  };
}

/** User-facing reason for a failed upstream list. */
export function failureMessage(label: string, err: unknown): string {
  if (err instanceof UpstreamError && err.isAuthError) return `${label} rejected the API key. Check it in Settings.`;
  if (err instanceof UpstreamError && err.status === 429) return `${label} is rate limiting model listing. Try again shortly.`;
  return `${label} models could not be loaded right now.`;
}

/** Catalog state for a failure: auth failures ask for a new key. */
export function failureState(err: unknown): ProviderCatalogState {
  return err instanceof UpstreamError && err.isAuthError ? 'needs-connection' : 'error';
}

export function logListFailure(provider: ProviderId, err: unknown): void {
  console.warn(`[catalog] ${provider} list failed:`, err instanceof Error ? err.message : String(err));
}
