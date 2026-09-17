/**
 * Registry over one adapter per provider. Pure (no DB, no network of its
 * own): production wiring lives in `./index.ts`.
 */
import type { CatalogModel, CatalogResponse, ProviderCatalog } from '../../shared/models/catalog.js';
import { providerOfModelId, upstreamIdOf, type ProviderId } from '../../shared/models/providers.js';
import type { CatalogContext, ProviderCatalogAdapter } from './types.js';
import type { ReadOptions } from './cache.js';

/** Exhaustive by provider: a new `ProviderId` does not compile without its adapter. */
export type CatalogAdapters = Record<ProviderId, ProviderCatalogAdapter>;

export interface ModelCatalogRegistry {
  getCatalog(userId: string, opts?: ReadOptions): Promise<CatalogResponse>;
  getProviderCatalog(userId: string, provider: ProviderId, opts?: ReadOptions): Promise<ProviderCatalog>;
  resolveModel(userId: string, modelId: string): Promise<CatalogModel>;
  invalidate(userId: string, provider: ProviderId): void;
}

export function createModelCatalogRegistry(adapters: CatalogAdapters): ModelCatalogRegistry {
  const ctx = (userId: string): CatalogContext => ({ userId });
  return {
    async getCatalog(userId, opts) {
      const providers = await Promise.all(
        (Object.keys(adapters) as ProviderId[])
          .filter((provider) => provider !== 'lmstudio')
          .map((provider) => adapters[provider].list(ctx(userId), opts)),
      );
      return { providers };
    },
    getProviderCatalog(userId, provider, opts) {
      return adapters[provider].list(ctx(userId), opts);
    },
    resolveModel(userId, modelId) {
      return adapters[providerOfModelId(modelId)].resolve(ctx(userId), upstreamIdOf(modelId));
    },
    invalidate(userId, provider) {
      adapters[provider].invalidate(ctx(userId));
    },
  };
}

