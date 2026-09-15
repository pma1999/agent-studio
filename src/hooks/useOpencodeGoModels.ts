import { useState, useEffect, useRef } from 'react';
import { modelsApi } from '../api/client';
import type { OpenRouterModel } from '../types';

// OpenCode Go-direct catalog is static on the server; cache it module-wide like OpenRouter models.
let cachedModels: OpenRouterModel[] | null = null;

export function useOpencodeGoModels(options?: { enabled?: boolean }) {
  const enabled = options?.enabled !== false;
  const [models, setModels] = useState<OpenRouterModel[]>(cachedModels ?? []);
  const [loading, setLoading] = useState(!cachedModels && enabled);
  const [error, setError] = useState<string | null>(null);
  const fetched = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    if (cachedModels) {
      setModels(cachedModels);
      setLoading(false);
      setError(null);
      return;
    }
    if (fetched.current) return;
    fetched.current = true;
    setLoading(true);
    setError(null);
    modelsApi
      .opencodego()
      .then((res) => {
        const data = res.data ?? [];
        cachedModels = data;
        setModels(data);
        setLoading(false);
      })
      .catch((err) => {
        // OpenCode Go is optional — fail soft so the OpenRouter list still works.
        setError(err instanceof Error ? err.message : 'Failed to load OpenCode Go models');
        setLoading(false);
      });
  }, [enabled]);

  return { models, loading, error };
}
