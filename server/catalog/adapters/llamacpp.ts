/**
 * llama.cpp (local): GGUF files scanned through the paired agent, the running
 * server's status, and `/props` of the loaded model for its reasoning
 * capability. Machine-local and fast-changing (load/unload), so it keeps a
 * short memory cache and no persisted snapshot; start/stop invalidate it.
 */
import type { CatalogModel } from '../../../shared/models/catalog.js';
import { CachedResource } from '../cache.js';
import { llamacppCatalogModel, type LlamaServerProps, type LlamacppScanEntry } from '../normalize/llamacpp.js';
import type { ProviderCatalogAdapter } from '../types.js';
import { logListFailure, providerCatalog, unknownCatalogModel, userScope } from './common.js';

export interface LlamacppAdapterDeps {
  hasCapability(userId: string): boolean;
  capabilityMessage: string;
  listEntries(userId: string): Promise<LlamacppScanEntry[]>;
  /** Key of the model currently served, or null. */
  loadedModelKey(userId: string): Promise<string | null>;
  /** `/props` of the running server, or null when unreachable. */
  fetchProps(userId: string): Promise<LlamaServerProps | null>;
  ttlMs?: number;
}

export function createLlamacppAdapter(deps: LlamacppAdapterDeps): ProviderCatalogAdapter {
  const cache = new CachedResource<CatalogModel[]>({ ttlMs: deps.ttlMs ?? 30 * 1000 });

  const build = async (userId: string): Promise<CatalogModel[]> => {
    const entries = await deps.listEntries(userId);
    const loadedKey = await deps.loadedModelKey(userId).catch(() => null);
    const props = loadedKey ? await deps.fetchProps(userId).catch(() => null) : null;
    return entries.map((entry) => llamacppCatalogModel(entry, entry.key === loadedKey, entry.key === loadedKey ? props : null));
  };

  const list: ProviderCatalogAdapter['list'] = async (ctx, opts) => {
    if (!deps.hasCapability(ctx.userId)) {
      return providerCatalog('llamacpp', 'unavailable', [], null, deps.capabilityMessage);
    }
    const scope = userScope('llamacpp', ctx.userId);
    try {
      const hit = await cache.read(scope, 'local', () => build(ctx.userId), { force: opts?.force });
      return providerCatalog('llamacpp', hit.stale ? 'stale' : 'ok', hit.value, hit.fetchedAt);
    } catch (err) {
      logListFailure('llamacpp', err);
      return providerCatalog('llamacpp', 'error', [], null, err instanceof Error ? err.message : 'Failed to scan the llama.cpp models directory.');
    }
  };

  return {
    provider: 'llamacpp',
    list,
    async resolve(ctx, upstreamId) {
      const catalog = await list(ctx, { preferCached: true });
      return catalog.models.find((m) => m.upstreamId === upstreamId) ?? unknownCatalogModel('llamacpp', upstreamId, 'llamacpp');
    },
    invalidate(ctx) {
      cache.forget(userScope('llamacpp', ctx.userId));
    },
  };
}
