/**
 * Shared public sources (keyless, global scope): the models.dev catalog and
 * the OpenCode Go docs markdown.
 */
import { CachedResource, type SnapshotStore } from './cache.js';
import { fetchJson, fetchText, type FetchLike } from './http.js';
import type { PriceRates } from '../../shared/models/pricing.js';
import type { ModelsDevProvider } from './normalize/modelsDev.js';
import { parseOpencodeGoDocs, type OpencodeGoDocs } from './normalize/opencodeGo.js';

export const MODELS_DEV_URL = 'https://models.dev/api.json';
export const OPENCODE_GO_DOCS_URL = 'https://opencode.ai/docs/go.md';

/** models.dev provider keys the adapters read. */
export const MODELS_DEV_PROVIDER_KEYS = ['deepseek', 'abliteration-ai', 'opencode-go'] as const;
export type ModelsDevProviderKey = (typeof MODELS_DEV_PROVIDER_KEYS)[number];

type ModelsDevSlice = Partial<Record<ModelsDevProviderKey, ModelsDevProvider>>;

export interface ModelsDevSource {
  /** Provider slice, or null when models.dev is unreachable and nothing is cached. */
  provider(key: ModelsDevProviderKey): Promise<ModelsDevProvider | null>;
}

export interface OpencodeGoDocsSource {
  docs(): Promise<OpencodeGoDocs | null>;
}

export function createModelsDevSource(opts: { store?: SnapshotStore | null; fetchImpl?: FetchLike; ttlMs?: number } = {}): ModelsDevSource {
  const cache = new CachedResource<ModelsDevSlice>({ ttlMs: opts.ttlMs ?? 60 * 60 * 1000, store: opts.store });
  const fetcher = async (): Promise<ModelsDevSlice> => {
    const all = await fetchJson<Record<string, ModelsDevProvider>>(MODELS_DEV_URL, { fetchImpl: opts.fetchImpl, timeoutMs: 20_000 });
    const slice: ModelsDevSlice = {};
    for (const key of MODELS_DEV_PROVIDER_KEYS) {
      const provider = all?.[key];
      if (provider && typeof provider === 'object' && provider.models && typeof provider.models === 'object') {
        slice[key] = provider;
      }
    }
    if (Object.keys(slice).length === 0) throw new Error('models.dev payload has none of the expected providers');
    return slice;
  };
  return {
    async provider(key) {
      try {
        const hit = await cache.getFast('models.dev', 'public', fetcher);
        return hit.value[key] ?? null;
      } catch (err) {
        console.warn('[catalog] models.dev unavailable:', err instanceof Error ? err.message : String(err));
        return null;
      }
    },
  };
}

export function createOpencodeGoDocsSource(opts: { store?: SnapshotStore | null; fetchImpl?: FetchLike; ttlMs?: number } = {}): OpencodeGoDocsSource {
  // Stored parsed as plain arrays: Maps do not survive the JSON snapshot.
  const cache = new CachedResource<{
    endpoints: Array<[string, string]>;
    monthlyLimits: Array<[string, number | null]>;
    rates: Array<[string, PriceRates]>;
  }>({
    ttlMs: opts.ttlMs ?? 6 * 60 * 60 * 1000,
    store: opts.store,
  });
  const fetcher = async () => {
    const parsed = parseOpencodeGoDocs(await fetchText(OPENCODE_GO_DOCS_URL, { fetchImpl: opts.fetchImpl }));
    if (parsed.endpoints.size === 0) throw new Error('OpenCode Go docs: endpoint table not found');
    return { endpoints: [...parsed.endpoints], monthlyLimits: [...parsed.monthlyLimits], rates: [...parsed.rates] };
  };
  return {
    async docs() {
      try {
        const hit = await cache.getFast('opencode-go:docs', 'public', fetcher);
        return {
          endpoints: new Map(hit.value.endpoints) as OpencodeGoDocs['endpoints'],
          monthlyLimits: new Map(hit.value.monthlyLimits),
          rates: new Map(hit.value.rates ?? []),
        };
      } catch (err) {
        console.warn('[catalog] OpenCode Go docs unavailable:', err instanceof Error ? err.message : String(err));
        return null;
      }
    },
  };
}
