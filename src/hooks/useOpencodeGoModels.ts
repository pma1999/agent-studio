import { useState, useEffect, useCallback } from 'react';
import { modelsApi, type OpencodeGoListMeta } from '../api/client';
import type { OpenRouterModel } from '../types';

/**
 * Browser event fired by the Settings panel after the Go key is saved or
 * tests OK, so live consumers refresh the catalog without a page reload.
 * Signal-only (no payload), like `CHATGPT_STATUS_CHANGED_EVENT`.
 */
export const OPENCODE_GO_STATUS_CHANGED_EVENT = 'opencode-go:status-changed';

/** How long a fetched catalog is served without hitting the network again (soft SWR, minutes-order). */
const SWR_TTL_MS = 5 * 60 * 1000;

// Stale-while-revalidate cache — the catalog is static, so a soft TTL is
// enough (no fetch per mount/keystroke); the status-changed event drops it.
let cached: { at: number; models: OpenRouterModel[]; meta: OpencodeGoListMeta | null } | null = null;
let inflight = false;

/**
 * Fail-soft OpenCode Go catalog hook. On any failure it exposes `error` and
 * keeps serving the stale list when there is one, so the OpenRouter list
 * still works. `refresh` forces a re-fetch bypassing the TTL (retry).
 */
export function useOpencodeGoModels(options?: { enabled?: boolean }) {
  const enabled = options?.enabled !== false;
  const [models, setModels] = useState<OpenRouterModel[]>(cached?.models ?? []);
  const [meta, setMeta] = useState<OpencodeGoListMeta | null>(cached?.meta ?? null);
  const [loading, setLoading] = useState(enabled && !cached);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (force = false) => {
    if (inflight) return;
    if (!force && cached && Date.now() - cached.at < SWR_TTL_MS) {
      setModels(cached.models);
      setMeta(cached.meta);
      setLoading(false);
      return;
    }
    inflight = true;
    setLoading(true);
    // Stale-while-revalidate: keep serving the stale list while refetching.
    if (cached) {
      setModels(cached.models);
      setMeta(cached.meta);
    }
    try {
      const res = await modelsApi.opencodego();
      const data = res.data ?? [];
      const nextMeta = res.meta ?? null;
      cached = { at: Date.now(), models: data, meta: nextMeta };
      setModels(data);
      setMeta(nextMeta);
      setError(null);
    } catch (err) {
      // OpenCode Go is optional — fail soft so the OpenRouter list still works.
      console.warn('Failed to load OpenCode Go models:', err);
      cached = null;
      setModels([]);
      setMeta(null);
      setError(err instanceof Error ? err.message : 'Failed to load OpenCode Go models');
    } finally {
      inflight = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void load();
  }, [enabled, load]);

  // Refresh when Settings saves/tests the Go key (status-changed event),
  // bypassing the TTL and dropping the module cache so the new key state
  // is reflected (not just a re-render).
  useEffect(() => {
    if (!enabled) return;
    const handler = () => {
      cached = null;
      void load(true);
    };
    window.addEventListener(OPENCODE_GO_STATUS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(OPENCODE_GO_STATUS_CHANGED_EVENT, handler);
  }, [enabled, load]);

  const refresh = useCallback(() => load(true), [load]);

  return { models, loading, error, meta, refresh };
}
