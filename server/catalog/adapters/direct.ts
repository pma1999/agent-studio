/**
 * Key-gated direct providers: DeepSeek, Abliteration and Arnict.
 * Each lists live with the user's key and enriches from public metadata.
 */
import type { SnapshotStore } from '../cache.js';
import { fetchJson, type FetchLike } from '../http.js';
import { abliterationCatalogModel, abliterationCatalogModelFromMetadata, type AbliterationModelEntry } from '../normalize/abliteration.js';
import { arnictCatalogModel, type ArnictModelEntry } from '../normalize/arnict.js';
import { deepseekCatalogModel } from '../normalize/deepseek.js';
import type { ModelsDevSource } from '../sources.js';
import type { ProviderCatalogAdapter } from '../types.js';
import { ABLITERATION_BASE_URL, ARNICT_BASE_URL, DEEPSEEK_BASE_URL } from '../../providers/index.js';
import { createKeyedAdapter } from './keyed.js';

export interface DirectAdapterDeps {
  store?: SnapshotStore | null;
  fetchImpl?: FetchLike;
  modelsDev: ModelsDevSource;
  getApiKey(userId: string): string | null;
}

function bearer(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

function idsOf(json: { data?: Array<{ id?: unknown }> }): string[] {
  return (Array.isArray(json.data) ? json.data : [])
    .map((entry) => entry?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

export function createDeepseekAdapter(deps: DirectAdapterDeps): ProviderCatalogAdapter {
  const metadata = async () => (await deps.modelsDev.provider('deepseek'))?.models ?? {};
  return createKeyedAdapter<string[]>({
    provider: 'deepseek',
    label: 'DeepSeek',
    store: deps.store,
    defaultTransport: 'chat',
    defaultHistoryField: 'reasoning_content',
    getApiKey: deps.getApiKey,
    fetchLive: async (apiKey) => idsOf(await fetchJson(`${DEEPSEEK_BASE_URL}/models`, { headers: bearer(apiKey), fetchImpl: deps.fetchImpl })),
    build: async (ids) => {
      const md = await metadata();
      return ids.map((id) => deepseekCatalogModel(id, md[id], 'active'));
    },
    publicModels: async () => Object.values(await metadata()).map((m) => deepseekCatalogModel(m.id, m, 'active')),
    resolveUnlisted: async (id) => {
      const entry = (await metadata())[id];
      return entry ? deepseekCatalogModel(id, entry, 'legacy') : null;
    },
  });
}

export function createAbliterationAdapter(deps: DirectAdapterDeps): ProviderCatalogAdapter {
  const metadata = async () => (await deps.modelsDev.provider('abliteration-ai'))?.models ?? {};
  return createKeyedAdapter<AbliterationModelEntry[]>({
    provider: 'abliteration',
    label: 'Abliteration',
    store: deps.store,
    defaultTransport: 'chat',
    getApiKey: deps.getApiKey,
    fetchLive: async (apiKey) => {
      const json = await fetchJson<{ data?: AbliterationModelEntry[] }>(`${ABLITERATION_BASE_URL}/v1/models`, {
        headers: bearer(apiKey),
        fetchImpl: deps.fetchImpl,
      });
      if (!Array.isArray(json.data)) throw new Error('Abliteration models payload has no data array');
      return json.data;
    },
    build: async (entries) => {
      const md = await metadata();
      return entries
        .map((entry) => abliterationCatalogModel(entry, entry.id ? md[entry.id] : undefined))
        .filter((m): m is NonNullable<typeof m> => m !== null);
    },
    publicModels: async () => Object.values(await metadata()).map((m) => abliterationCatalogModelFromMetadata(m, 'active')),
    resolveUnlisted: async (id) => {
      const entry = (await metadata())[id];
      return entry ? abliterationCatalogModelFromMetadata(entry, 'legacy') : null;
    },
  });
}

export function createArnictAdapter(deps: Omit<DirectAdapterDeps, 'modelsDev'>): ProviderCatalogAdapter {
  return createKeyedAdapter<ArnictModelEntry[]>({
    provider: 'arnict',
    label: 'Arnict',
    store: deps.store,
    defaultTransport: 'chat',
    getApiKey: deps.getApiKey,
    fetchLive: async (apiKey) => {
      const json = await fetchJson<{ data?: ArnictModelEntry[] }>(`${ARNICT_BASE_URL}/v1/models`, {
        headers: bearer(apiKey),
        fetchImpl: deps.fetchImpl,
      });
      if (!Array.isArray(json.data)) throw new Error('Arnict models payload has no data array');
      return json.data;
    },
    build: async (entries) => entries.map(arnictCatalogModel).filter((m): m is NonNullable<typeof m> => m !== null),
  });
}
