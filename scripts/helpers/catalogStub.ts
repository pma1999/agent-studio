/**
 * Offline model catalog for route-level tests: every id resolves to an
 * unknown-capability model unless an override describes it. Install with
 * `setModelCatalogForTests(stubModelCatalog({...}))` before exercising routes
 * that resolve models (chat, council, compaction, messages).
 */
import type { CatalogModel } from '../../shared/models/catalog.js';
import { providerOfModelId, upstreamIdOf } from '../../shared/models/providers.js';
import { unknownCatalogModel } from '../../server/catalog/adapters/common.js';
import type { ModelCatalogRegistry } from '../../server/catalog/registry.js';

const DEFAULT_TRANSPORT: Record<string, CatalogModel['transport']> = {
  codex: 'codex',
  llamacpp: 'llamacpp',
};

export function stubModelCatalog(overrides: Record<string, Partial<CatalogModel>> = {}): ModelCatalogRegistry {
  const resolve = (modelId: string): CatalogModel => {
    const provider = providerOfModelId(modelId);
    const base = unknownCatalogModel(provider, upstreamIdOf(modelId), DEFAULT_TRANSPORT[provider] ?? 'chat');
    return { ...base, ...overrides[modelId] };
  };
  return {
    async getCatalog() {
      return { providers: [] };
    },
    async getProviderCatalog(_userId, provider) {
      return { provider, state: 'ok', models: [], fetchedAt: null, message: null };
    },
    async resolveModel(_userId, modelId) {
      return resolve(modelId);
    },
    invalidate() {},
  };
}
