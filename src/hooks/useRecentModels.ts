import { useState, useCallback, useEffect } from 'react';
import { RECENT_STORAGE_KEY, MAX_RECENT } from '../utils/modelUtils';

export interface RecentModel {
  id: string;
  name: string;
  usedAt: number;
}

function loadRecent(): RecentModel[] {
  try {
    const stored = localStorage.getItem(RECENT_STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

export function useRecentModels() {
  const [recent, setRecent] = useState<RecentModel[]>(loadRecent);

  const addRecent = useCallback((modelId: string, modelName: string) => {
    setRecent((prev) => {
      const filtered = prev.filter((m) => m.id !== modelId);
      const updated = [{ id: modelId, name: modelName, usedAt: Date.now() }, ...filtered].slice(
        0,
        MAX_RECENT
      );
      try {
        localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(updated));
      } catch {
        // ignore
      }
      return updated;
    });
  }, []);

  return { recent, addRecent };
}
