/**
 * OpenCode Go: the keyless live `GET /v1/models` id list (global scope)
 * joined with models.dev metadata and the official docs tables. Listing needs
 * no key; sending does, so a missing key marks the catalog
 * `needs-connection` while still showing what Go offers.
 */
import type { CatalogModel } from '../../../shared/models/catalog.js';
import { CachedResource, type SnapshotStore } from '../cache.js';
import { fetchText, type FetchLike } from '../http.js';
import { OPENCODE_GO_BASE_URL } from '../../providers/index.js';
import { isOfferedByOpencodeGo, opencodeGoCatalogModel, opencodeGoTransport } from '../normalize/opencodeGo.js';
import type { ModelsDevSource, OpencodeGoDocsSource } from '../sources.js';
import type { ProviderCatalogAdapter } from '../types.js';
import { failureMessage, logListFailure, providerCatalog, unknownCatalogModel } from './common.js';

export interface OpencodeGoAdapterDeps {
  store?: SnapshotStore | null;
  fetchImpl?: FetchLike;
  modelsDev: ModelsDevSource;
  docs: OpencodeGoDocsSource;
  getApiKey(userId: string): string | null;
  ttlMs?: number;
}

export function createOpencodeGoAdapter(deps: OpencodeGoAdapterDeps): ProviderCatalogAdapter {
  const cache = new CachedResource<string[]>({ ttlMs: deps.ttlMs ?? 10 * 60 * 1000, store: deps.store });
  const fetchIds = async (): Promise<string[]> => {
    // The gateway serves JSON as text/plain: parse by content.
    const json = JSON.parse(await fetchText(`${OPENCODE_GO_BASE_URL}/models`, { fetchImpl: deps.fetchImpl })) as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(json.data)) throw new Error('OpenCode Go models payload has no data array');
    return json.data.map((e) => e?.id).filter((id): id is string => typeof id === 'string' && id.length > 0);
  };

  const build = async (ids: string[]): Promise<CatalogModel[]> => {
    const [provider, docs] = await Promise.all([deps.modelsDev.provider('opencode-go'), deps.docs.docs()]);
    const metadata = provider?.models ?? {};
    return ids
      .filter((id) => isOfferedByOpencodeGo(metadata[id], id, docs))
      .map((id) => opencodeGoCatalogModel(id, metadata[id], provider ?? undefined, docs, metadata[id]?.status === 'deprecated' ? 'deprecated' : 'active'));
  };

  const list: ProviderCatalogAdapter['list'] = async (ctx, opts) => {
    const hasKey = !!deps.getApiKey(ctx.userId)?.trim();
    try {
      const hit = await cache.read('opencode-go', 'public', fetchIds, opts);
      const models = await build(hit.value);
      if (!hasKey) {
        return providerCatalog('opencode-go', 'needs-connection', models, hit.fetchedAt, 'Add your OpenCode Go API key in Settings to use these models.');
      }
      return providerCatalog('opencode-go', hit.stale ? 'stale' : 'ok', models, hit.fetchedAt);
    } catch (err) {
      logListFailure('opencode-go', err);
      return providerCatalog('opencode-go', 'error', [], null, failureMessage('OpenCode Go', err));
    }
  };

  return {
    provider: 'opencode-go',
    list,
    async resolve(ctx, upstreamId) {
      const catalog = await list(ctx, { preferCached: true });
      const listed = catalog.models.find((m) => m.upstreamId === upstreamId);
      if (listed) return listed;
      const [provider, docs] = await Promise.all([deps.modelsDev.provider('opencode-go'), deps.docs.docs()]);
      const entry = provider?.models[upstreamId];
      if (entry) return opencodeGoCatalogModel(upstreamId, entry, provider ?? undefined, docs, 'legacy');
      // Nothing known: the wire still follows the docs endpoint table when it lists the id.
      return unknownCatalogModel('opencode-go', upstreamId, opencodeGoTransport(upstreamId, undefined, undefined, docs));
    },
    invalidate() {
      // Listing is public; the key state is read on every list.
    },
  };
}
