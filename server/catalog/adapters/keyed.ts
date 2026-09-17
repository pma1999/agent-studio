/**
 * Adapter factory for providers whose model list needs the user's API key.
 *
 * The raw live list is cached per user (scope) and per key hash (variant), so
 * users never see each other's lists and a rotated key refetches. Catalog
 * models are rebuilt from the raw list on every read, so fresher public
 * metadata applies without refetching the keyed list. Without a key the
 * catalog is `needs-connection`, listing whatever public metadata knows.
 */
import type { CatalogModel, ModelTransport } from '../../../shared/models/catalog.js';
import type { ProviderId } from '../../../shared/models/providers.js';
import { CachedResource, type SnapshotStore } from '../cache.js';
import { UpstreamError } from '../http.js';
import type { ProviderCatalogAdapter } from '../types.js';
import {
  credentialVariant,
  failureMessage,
  failureState,
  logListFailure,
  providerCatalog,
  unknownCatalogModel,
  userScope,
} from './common.js';

export interface KeyedAdapterConfig<Raw> {
  provider: ProviderId;
  label: string;
  store?: SnapshotStore | null;
  ttlMs?: number;
  defaultTransport: ModelTransport;
  defaultHistoryField?: CatalogModel['historyReasoningField'];
  getApiKey(userId: string): string | null;
  fetchLive(apiKey: string): Promise<Raw>;
  build(raw: Raw): Promise<CatalogModel[]>;
  /** Models known from public metadata, listed while no key is configured. */
  publicModels?(): Promise<CatalogModel[]>;
  /** A model no longer listed but still described by public metadata. */
  resolveUnlisted?(upstreamId: string): Promise<CatalogModel | null>;
}

export function createKeyedAdapter<Raw>(config: KeyedAdapterConfig<Raw>): ProviderCatalogAdapter {
  // A rejected key must never keep serving the list it used to unlock.
  const cache = new CachedResource<Raw>({
    ttlMs: config.ttlMs ?? 10 * 60 * 1000,
    store: config.store,
    isFatal: (err) => err instanceof UpstreamError && err.isAuthError,
  });

  const publicList = async (): Promise<CatalogModel[]> => {
    try {
      return (await config.publicModels?.()) ?? [];
    } catch {
      return [];
    }
  };

  const list: ProviderCatalogAdapter['list'] = async (ctx, opts) => {
    const apiKey = config.getApiKey(ctx.userId)?.trim();
    if (!apiKey) {
      return providerCatalog(
        config.provider,
        'needs-connection',
        await publicList(),
        null,
        `Add your ${config.label} API key in Settings to use these models.`,
      );
    }
    const scope = userScope(config.provider, ctx.userId);
    const variant = credentialVariant(apiKey);
    const fetcher = () => config.fetchLive(apiKey);
    try {
      const hit = await cache.read(scope, variant, fetcher, opts);
      return providerCatalog(config.provider, hit.stale ? 'stale' : 'ok', await config.build(hit.value), hit.fetchedAt);
    } catch (err) {
      logListFailure(config.provider, err);
      return providerCatalog(config.provider, failureState(err), await publicList(), null, failureMessage(config.label, err));
    }
  };

  return {
    provider: config.provider,
    list,
    async resolve(ctx, upstreamId) {
      const catalog = await list(ctx, { preferCached: true });
      const listed = catalog.models.find((m) => m.upstreamId === upstreamId);
      if (listed) return listed;
      const unlisted = await config.resolveUnlisted?.(upstreamId).catch(() => null);
      return unlisted
        ?? unknownCatalogModel(config.provider, upstreamId, config.defaultTransport, config.defaultHistoryField);
    },
    invalidate(ctx) {
      cache.forget(userScope(config.provider, ctx.userId));
    },
  };
}
