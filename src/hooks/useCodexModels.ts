import { useState, useEffect, useRef, useCallback } from 'react';
import { modelsApi, chatgptApi } from '../api/client';
import type { OpenRouterModel } from '../types';

/** Browser event fired by the Settings panel whenever the ChatGPT link state changes. */
export const CHATGPT_STATUS_CHANGED_EVENT = 'chatgpt:status-changed';

// ChatGPT (Codex) catalog depends on the user's account connection, so the
// module cache is invalidated by the status-changed event.
let cached: { connected: boolean; models: OpenRouterModel[] } | null = null;

export function useCodexModels(options?: { enabled?: boolean }) {
  const enabled = options?.enabled !== false;
  const [models, setModels] = useState<OpenRouterModel[]>(cached?.models ?? []);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(enabled);
  const fetched = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const status = await chatgptApi.status();
      if (status.allowed && status.connected) {
        const res = await modelsApi.codex();
        const data = res.data ?? [];
        cached = { connected: true, models: data };
        setModels(data);
        setConnected(true);
      } else {
        cached = { connected: false, models: [] };
        setModels([]);
        setConnected(false);
      }
    } catch (err) {
      // ChatGPT is optional — fail soft so other catalogs still work.
      console.warn('Failed to load ChatGPT models:', err);
      cached = { connected: false, models: [] };
      setModels([]);
      setConnected(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (cached) {
      setModels(cached.models);
      setConnected(cached.connected);
      setLoading(false);
      return;
    }
    if (fetched.current) return;
    fetched.current = true;
    load();
  }, [enabled, load]);

  // Refresh when the user connects/disconnects their ChatGPT account in Settings.
  useEffect(() => {
    if (!enabled) return;
    const handler = () => {
      fetched.current = true;
      load();
    };
    window.addEventListener(CHATGPT_STATUS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(CHATGPT_STATUS_CHANGED_EVENT, handler);
  }, [enabled, load]);

  return { models, connected, loading };
}
