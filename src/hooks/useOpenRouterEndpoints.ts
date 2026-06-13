import { useEffect, useState } from 'react';
import { modelsApi } from '../api/client';
import type { OpenRouterEndpoint } from '../types';
import { isDeepSeekDirectModel } from '../utils/providers';

export function useOpenRouterEndpoints(modelId: string | null | undefined, enabled = true) {
  const [endpoints, setEndpoints] = useState<OpenRouterEndpoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !modelId || modelId === 'openrouter/auto' || isDeepSeekDirectModel(modelId)) {
      setEndpoints([]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    modelsApi.openrouterEndpoints(modelId)
      .then((result) => {
        if (!cancelled) setEndpoints(result.data || []);
      })
      .catch((err) => {
        if (!cancelled) {
          setEndpoints([]);
          setError(err instanceof Error ? err.message : 'Failed to load endpoints');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [modelId, enabled]);

  return { endpoints, loading, error };
}
