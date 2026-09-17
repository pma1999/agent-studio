/** OpenRouter: keyless live `GET /api/v1/models`, global scope. */
import type { CatalogModel } from '../../../shared/models/catalog.js';
import { CachedResource, type SnapshotStore } from '../cache.js';
import { fetchJson, type FetchLike } from '../http.js';
import { openRouterCatalogModel, type OpenRouterModelEntry } from '../normalize/openrouter.js';
import type { ProviderCatalogAdapter } from '../types.js';
import { failureMessage, logListFailure, providerCatalog, unknownCatalogModel } from './common.js';

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

export interface OpenRouterAdapterDeps {
  store?: SnapshotStore | null;
  fetchImpl?: FetchLike;
  ttlMs?: number;
}

export function createOpenRouterAdapter(deps: OpenRouterAdapterDeps = {}): ProviderCatalogAdapter {
  const cache = new CachedResource<CatalogModel[]>({ ttlMs: deps.ttlMs ?? 5 * 60 * 1000, store: deps.store });
  const fetcher = async () => {
    const json = await fetchJson<{ data?: OpenRouterModelEntry[] }>(OPENROUTER_MODELS_URL, { fetchImpl: deps.fetchImpl, timeoutMs: 15_000 });
    if (!Array.isArray(json.data)) throw new Error('OpenRouter models payload has no data array');
    return json.data.filter((e) => typeof e?.id === 'string').map(openRouterCatalogModel);
  };

  const list: ProviderCatalogAdapter['list'] = async (_ctx, opts) => {
    try {
      const hit = await cache.read('openrouter', 'public', fetcher, opts);
      return providerCatalog('openrouter', hit.stale ? 'stale' : 'ok', hit.value, hit.fetchedAt);
    } catch (err) {
      logListFailure('openrouter', err);
      return providerCatalog('openrouter', 'error', [], null, failureMessage('OpenRouter', err));
    }
  };

  return {
    provider: 'openrouter',
    list,
    async resolve(ctx, upstreamId) {
      const catalog = await list(ctx, { preferCached: true });
      return catalog.models.find((m) => m.upstreamId === upstreamId) ?? unknownCatalogModel('openrouter', upstreamId, 'chat');
    },
    invalidate() {
      // Global public data: nothing user-scoped to drop.
    },
  };
}
