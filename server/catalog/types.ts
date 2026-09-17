/**
 * Adapter contract every provider implements. `ProviderId` keys the registry
 * exhaustively, so adding a provider fails to compile until its adapter
 * exists.
 */
import type { CatalogModel, ProviderCatalog } from '../../shared/models/catalog.js';
import type { ProviderId } from '../../shared/models/providers.js';
import type { ReadOptions } from './cache.js';

export interface CatalogContext {
  userId: string;
}

export interface ProviderCatalogAdapter {
  readonly provider: ProviderId;
  /** Never throws: failures surface as the catalog `state`. */
  list(ctx: CatalogContext, opts?: ReadOptions): Promise<ProviderCatalog>;
  /**
   * Never throws and never waits for a refresh when any data is known. A model
   * that is not listed but has metadata resolves as `legacy`; with nothing
   * known it resolves with unknown capability and the provider's default wire.
   */
  resolve(ctx: CatalogContext, upstreamId: string): Promise<CatalogModel>;
  /** Drops cached data for this user (e.g. key saved, local server restarted). */
  invalidate(ctx: CatalogContext): void;
}
