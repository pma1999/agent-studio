import { useState, useEffect, useCallback } from 'react';
import { modelsApi, type LmStudioModel } from '../api/client';
import { LMSTUDIO_STATUS_CHANGED_EVENT } from '../utils/providers';

/** How long a cached catalog is served without hitting the network again. */
const SWR_TTL_MS = 60_000;

// Stale-while-revalidate cache — deliberately NOT permanent (unlike the DeepSeek
// catalog): LM Studio models load/unload at runtime, so entries expire after
// 60 s and the cache is dropped entirely on failure.
let cached: { at: number; models: LmStudioModel[] } | null = null;
let inflight = false;

/**
 * Fail-soft LM Studio catalog hook. On any failure it returns an empty list and
 * a warning so the OpenRouter/DeepSeek/Codex lists are unaffected.
 */
export function useLmStudioModels(options?: { enabled?: boolean }) {
  const enabled = options?.enabled !== false;
  const [models, setModels] = useState<LmStudioModel[]>(cached?.models ?? []);
  const [loading, setLoading] = useState(enabled && !cached);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (force = false) => {
    if (inflight) return;
    if (!force && cached && Date.now() - cached.at < SWR_TTL_MS) {
      setModels(cached.models);
      setLoading(false);
      return;
    }
    inflight = true;
    setLoading(true);
    // Stale-while-revalidate: keep serving the stale list while refetching.
    if (cached) setModels(cached.models);
    try {
      const res = await modelsApi.lmstudio();
      const data = res.data ?? [];
      cached = { at: Date.now(), models: data };
      setModels(data);
      setError(null);
    } catch (err) {
      // LM Studio is optional — fail soft so other catalogs still work.
      console.warn('Failed to load LM Studio models:', err);
      cached = null;
      setModels([]);
      setError(err instanceof Error ? err.message : 'Failed to load LM Studio models');
    } finally {
      inflight = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void load();
  }, [enabled, load]);

  // Refresh when Settings saves/tests/loads (status-changed event), bypassing the TTL.
  useEffect(() => {
    if (!enabled) return;
    const handler = () => void load(true);
    window.addEventListener(LMSTUDIO_STATUS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(LMSTUDIO_STATUS_CHANGED_EVENT, handler);
  }, [enabled, load]);

  return { models, loading, error };
}
