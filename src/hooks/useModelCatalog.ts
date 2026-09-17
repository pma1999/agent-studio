/**
 * Client model catalog: one request (`GET /api/models/catalog`) shared by
 * every component through a module store, served stale-while-revalidate.
 *
 * Refreshes when it goes stale on mount, when the window regains focus after
 * the TTL, and immediately on `MODEL_CATALOG_CHANGED_EVENT` (keys saved,
 * accounts connected, local server started or stopped).
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { modelsApi } from '../api/client';
import type { CatalogModel, CatalogResponse, ProviderCatalog } from '../../shared/models/catalog';
import type { ProviderId } from '../../shared/models/providers';
import { unknownReasoning, type ReasoningCapability } from '../../shared/models/reasoning';
import { LLAMACPP_STATUS_CHANGED_EVENT, MODEL_CATALOG_CHANGED_EVENT } from '../utils/providers';

const STALE_AFTER_MS = 5 * 60 * 1000;

interface CatalogState {
  providers: ProviderCatalog[];
  byId: ReadonlyMap<string, CatalogModel>;
  loading: boolean;
  error: string | null;
  loadedAt: number | null;
}

let state: CatalogState = { providers: [], byId: new Map(), loading: false, error: null, loadedAt: null };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function setState(next: Partial<CatalogState>): void {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
}

function index(response: CatalogResponse): ReadonlyMap<string, CatalogModel> {
  const byId = new Map<string, CatalogModel>();
  for (const provider of response.providers) {
    for (const model of provider.models) byId.set(model.id, model);
  }
  return byId;
}

/** Loads (or reloads) the catalog; concurrent callers share one request. */
export function refreshModelCatalog(opts: { force?: boolean } = {}): Promise<void> {
  if (inflight) return inflight;
  if (!opts.force && state.loadedAt !== null && Date.now() - state.loadedAt < STALE_AFTER_MS) return Promise.resolve();
  setState({ loading: true });
  inflight = modelsApi
    .catalog({ refresh: opts.force === true })
    .then((response) => {
      setState({ providers: response.providers, byId: index(response), loading: false, error: null, loadedAt: Date.now() });
    })
    .catch((err: unknown) => {
      // Keep serving the last good catalog; surface the failure.
      setState({ loading: false, error: err instanceof Error ? err.message : 'Failed to load models' });
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

let windowListenersInstalled = false;
function installWindowListeners(): void {
  if (windowListenersInstalled || typeof window === 'undefined') return;
  windowListenersInstalled = true;
  const force = () => void refreshModelCatalog({ force: true });
  window.addEventListener(MODEL_CATALOG_CHANGED_EVENT, force);
  window.addEventListener(LLAMACPP_STATUS_CHANGED_EVENT, force);
  window.addEventListener('focus', () => void refreshModelCatalog());
}

function subscribe(listener: () => void): () => void {
  installWindowListeners();
  listeners.add(listener);
  void refreshModelCatalog();
  return () => listeners.delete(listener);
}

const getSnapshot = () => state;

/** The whole catalog (providers with their state + a model index). */
export function useModelCatalog() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const refresh = useCallback(() => refreshModelCatalog({ force: true }), []);
  return { ...snapshot, refresh };
}

/** One provider's catalog, or null before the first load. */
export function useProviderCatalog(provider: ProviderId): ProviderCatalog | null {
  const { providers } = useModelCatalog();
  return useMemo(() => providers.find((p) => p.provider === provider) ?? null, [providers, provider]);
}

export interface CatalogModelLookup {
  model: CatalogModel | null;
  /** Capability to render: null while the first load is pending; unknown for unlisted models. */
  reasoning: ReasoningCapability | null;
  loading: boolean;
}

/** A model by id. Unlisted ids (retired or not yet loaded) resolve to an unknown capability. */
export function useCatalogModel(modelId: string | null | undefined): CatalogModelLookup {
  const { byId, loadedAt, loading } = useModelCatalog();
  return useMemo(() => {
    const model = modelId ? byId.get(modelId) ?? null : null;
    if (model) return { model, reasoning: model.reasoning, loading: false };
    if (loadedAt === null) return { model: null, reasoning: null, loading: true };
    return { model: null, reasoning: unknownReasoning(), loading };
  }, [byId, loadedAt, loading, modelId]);
}
