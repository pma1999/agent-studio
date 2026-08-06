import { useState, useEffect, useRef } from 'react';
import { modelsApi, chatgptApi } from '../api/client';
import type { OpenRouterModel } from '../types';

// ChatGPT (Codex) catalog depends on the user's account connection, so the
// module cache is keyed by connection state and refetched after (dis)connects.
let cached: { connected: boolean; models: OpenRouterModel[] } | null = null;

export function useCodexModels(options?: { enabled?: boolean }) {
  const enabled = options?.enabled !== false;
  const [models, setModels] = useState<OpenRouterModel[]>(cached?.models ?? []);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(enabled);
  const fetched = useRef(false);

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
    setLoading(true);
    chatgptApi
      .status()
      .then(async (status) => {
        if (status.allowed && status.connected) {
          const res = await modelsApi.codex();
          const data = res.data ?? [];
          cached = { connected: true, models: data };
          setModels(data);
          setConnected(true);
        } else {
          cached = { connected: false, models: [] };
          setConnected(false);
        }
        setLoading(false);
      })
      .catch((err) => {
        // ChatGPT is optional — fail soft so other catalogs still work.
        console.warn('Failed to load ChatGPT models:', err);
        cached = { connected: false, models: [] };
        setConnected(false);
        setLoading(false);
      });
  }, [enabled]);

  return { models, connected, loading };
}
