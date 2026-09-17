/**
 * Codex (ChatGPT): `model/list` from the user's app-server, per-user scope.
 * Account problems are never masked by an old list: a disconnected or
 * forbidden account invalidates the cache.
 */
import type { CatalogModel } from '../../../shared/models/catalog.js';
import { CachedResource, type SnapshotStore } from '../cache.js';
import { codexCatalogModel, type CodexProtocolModel } from '../normalize/codex.js';
import type { ProviderCatalogAdapter } from '../types.js';
import { logListFailure, providerCatalog, unknownCatalogModel, userScope } from './common.js';

export interface CodexAdapterDeps {
  store?: SnapshotStore | null;
  listModels(userId: string): Promise<CodexProtocolModel[]>;
  /** True for "not allowed for this user". */
  isForbidden(err: unknown): boolean;
  /** True for "no connected ChatGPT account" (or app-server unavailable). */
  isUnavailable(err: unknown): boolean;
  ttlMs?: number;
}

export function createCodexAdapter(deps: CodexAdapterDeps): ProviderCatalogAdapter {
  const cache = new CachedResource<CodexProtocolModel[]>({
    ttlMs: deps.ttlMs ?? 60 * 1000,
    store: deps.store,
    isFatal: (err) => deps.isForbidden(err) || deps.isUnavailable(err),
  });

  const list: ProviderCatalogAdapter['list'] = async (ctx, opts) => {
    const scope = userScope('codex', ctx.userId);
    const fetcher = () => deps.listModels(ctx.userId);
    try {
      const hit = await cache.read(scope, 'account', fetcher, opts);
      const models = hit.value.map(codexCatalogModel).filter((m): m is CatalogModel => m !== null);
      return providerCatalog('codex', hit.stale ? 'stale' : 'ok', models, hit.fetchedAt);
    } catch (err) {
      if (deps.isForbidden(err)) {
        return providerCatalog('codex', 'unavailable', [], null, 'ChatGPT is not enabled for your account.');
      }
      if (deps.isUnavailable(err)) {
        return providerCatalog('codex', 'needs-connection', [], null, err instanceof Error ? err.message : 'Connect your ChatGPT account in Settings.');
      }
      logListFailure('codex', err);
      return providerCatalog('codex', 'error', [], null, 'ChatGPT models could not be loaded right now.');
    }
  };

  return {
    provider: 'codex',
    list,
    async resolve(ctx, upstreamId) {
      const catalog = await list(ctx, { preferCached: true });
      return catalog.models.find((m) => m.upstreamId === upstreamId) ?? unknownCatalogModel('codex', upstreamId, 'codex');
    },
    invalidate(ctx) {
      cache.forget(userScope('codex', ctx.userId));
    },
  };
}
