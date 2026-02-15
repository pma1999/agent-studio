import { useState, useEffect, useRef } from 'react';
import { modelsApi } from '../api/client';
import type { OpenRouterModel } from '../types';

let cachedModels: OpenRouterModel[] | null = null;

export function useOpenRouterModels(options?: { enabled?: boolean }) {
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
      .openrouter()
      .then((res) => {
        const data = res.data ?? [];
        cachedModels = data;
        setModels(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load models');
        setLoading(false);
      });
  }, [enabled]);

  return { models, loading, error };
}
