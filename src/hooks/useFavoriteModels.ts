import { useState, useCallback, useEffect } from 'react';
import { FAVORITES_STORAGE_KEY } from '../utils/modelUtils';

function loadFavorites(): string[] {
  try {
    const saved = localStorage.getItem(FAVORITES_STORAGE_KEY);
    return saved ? JSON.parse(saved) : [];
  } catch {
    return [];
  }
}

export function useFavoriteModels() {
  const [favorites, setFavorites] = useState<string[]>(loadFavorites);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === FAVORITES_STORAGE_KEY && e.newValue !== null) {
        try {
          setFavorites(JSON.parse(e.newValue));
        } catch {
          // ignore
        }
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const toggleFavorite = useCallback((modelId: string) => {
    setFavorites((prev) => {
      const next = prev.includes(modelId)
        ? prev.filter((id) => id !== modelId)
        : [...prev, modelId];
      try {
        localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  return { favorites, toggleFavorite };
}
