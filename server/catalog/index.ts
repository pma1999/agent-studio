/**
 * Model catalog registry: one adapter per provider (exhaustive by type), the
 * production wiring of their dependencies, and the entry points routes and
 * the send path use.
 */
import db from '../db.js';
import type { ProviderId } from '../../shared/models/providers.js';
import { getSettingValue } from '../routes/settings.js';
import { getProviderConfig } from '../providers/index.js';
import {
  getLlamacppStatus,
  hasLlamacppCapability,
  LLAMACPP_CAPABILITY_ERROR,
  listLlamacppModels,
  llamacppFetch,
} from '../providers/llamacppTransport.js';
import { CodexForbiddenError, CodexUnavailableError, listChatgptModels } from '../codex/instanceManager.js';
import type { SnapshotRecord, SnapshotStore } from './cache.js';
import { createModelsDevSource, createOpencodeGoDocsSource } from './sources.js';
import { createOpenRouterAdapter } from './adapters/openrouter.js';
import { createAbliterationAdapter, createArnictAdapter, createDeepseekAdapter } from './adapters/direct.js';
import { createOpencodeGoAdapter } from './adapters/opencodeGo.js';
import { createCodexAdapter } from './adapters/codex.js';
import { createLlamacppAdapter } from './adapters/llamacpp.js';
import { providerCatalog, unknownCatalogModel } from './adapters/common.js';
import type { LlamaServerProps } from './normalize/llamacpp.js';
import type { ProviderCatalogAdapter } from './types.js';
import { createModelCatalogRegistry, type CatalogAdapters, type ModelCatalogRegistry } from './registry.js';

export type { CatalogAdapters, ModelCatalogRegistry } from './registry.js';

/** Persisted snapshots in `model_catalog_snapshots`. */
export function createDbSnapshotStore(): SnapshotStore {
  return {
    read(scope) {
      const row = db.prepare('SELECT variant, payload, fetched_at FROM model_catalog_snapshots WHERE scope = ?').get(scope) as
        | { variant: string; payload: string; fetched_at: number }
        | undefined;
      if (!row) return null;
      return { variant: row.variant, payload: JSON.parse(row.payload), fetchedAt: row.fetched_at } satisfies SnapshotRecord;
    },
    write(scope, record) {
      db.prepare(`
        INSERT INTO model_catalog_snapshots (scope, variant, payload, fetched_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(scope) DO UPDATE SET variant = excluded.variant, payload = excluded.payload, fetched_at = excluded.fetched_at
      `).run(scope, record.variant, JSON.stringify(record.payload), record.fetchedAt);
    },
    delete(scope) {
      db.prepare('DELETE FROM model_catalog_snapshots WHERE scope = ?').run(scope);
    },
  };
}

/** Removed provider: recognized so its ids never fall through to OpenRouter. */
const lmstudioAdapter: ProviderCatalogAdapter = {
  provider: 'lmstudio',
  async list() {
    return providerCatalog('lmstudio', 'unavailable', [], null, 'LM Studio support was removed.');
  },
  async resolve(_ctx, upstreamId) {
    return unknownCatalogModel('lmstudio', upstreamId, 'chat');
  },
  invalidate() {},
};

function apiKeyReader(provider: ProviderId): (userId: string) => string | null {
  const setting = getProviderConfig(provider).apiKeySetting;
  return (userId) => getSettingValue(userId, setting) || null;
}

function createProductionAdapters(): CatalogAdapters {
  const store = createDbSnapshotStore();
  const modelsDev = createModelsDevSource({ store });
  const docs = createOpencodeGoDocsSource({ store });
  return {
    openrouter: createOpenRouterAdapter({ store }),
    deepseek: createDeepseekAdapter({ store, modelsDev, getApiKey: apiKeyReader('deepseek') }),
    abliteration: createAbliterationAdapter({ store, modelsDev, getApiKey: apiKeyReader('abliteration') }),
    arnict: createArnictAdapter({ store, getApiKey: apiKeyReader('arnict') }),
    'opencode-go': createOpencodeGoAdapter({ store, modelsDev, docs, getApiKey: apiKeyReader('opencode-go') }),
    codex: createCodexAdapter({
      store,
      listModels: listChatgptModels,
      isForbidden: (err) => err instanceof CodexForbiddenError,
      isUnavailable: (err) => err instanceof CodexUnavailableError,
    }),
    llamacpp: createLlamacppAdapter({
      hasCapability: hasLlamacppCapability,
      capabilityMessage: LLAMACPP_CAPABILITY_ERROR,
      listEntries: (userId) => listLlamacppModels(userId),
      loadedModelKey: async (userId) => {
        const status = await getLlamacppStatus(userId);
        return status.running ? status.modelKey : null;
      },
      fetchProps: async (userId): Promise<LlamaServerProps | null> => {
        const response = await llamacppFetch(userId, '/props', { signal: AbortSignal.timeout(5_000) });
        return response.ok ? ((await response.json()) as LlamaServerProps) : null;
      },
    }),
    lmstudio: lmstudioAdapter,
  };
}

let registry: ModelCatalogRegistry | null = null;

/** The production registry (created on first use). */
export function modelCatalog(): ModelCatalogRegistry {
  registry ??= createModelCatalogRegistry(createProductionAdapters());
  return registry;
}

/** Test seam: replace the production registry (null restores lazy production wiring). */
export function setModelCatalogForTests(next: ModelCatalogRegistry | null): void {
  registry = next;
}
