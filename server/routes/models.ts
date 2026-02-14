import { Router, Response } from 'express';
import { AuthRequest } from '../middleware/auth.js';

const router = Router();

// In-memory cache for OpenRouter models
let modelsCache: { data: any[]; timestamp: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// GET /api/models/openrouter - Fetch available OpenRouter models (cached)
router.get('/openrouter', async (_req: AuthRequest, res: Response) => {
  try {
    // Return cached data if still fresh
    if (modelsCache && Date.now() - modelsCache.timestamp < CACHE_TTL) {
      return res.json({ data: modelsCache.data });
    }

    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return res.status(response.status).json({
        error: `Failed to fetch OpenRouter models: ${response.statusText}`,
      });
    }

    const json = await response.json();
    const models = (json.data || []).map((m: any) => ({
      id: m.id,
      name: m.name,
      description: m.description || '',
      context_length: m.context_length || 0,
      pricing: {
        prompt: m.pricing?.prompt || '0',
        completion: m.pricing?.completion || '0',
      },
    }));

    // Update cache
    modelsCache = { data: models, timestamp: Date.now() };

    res.json({ data: models });
  } catch (err) {
    console.error('Error fetching OpenRouter models:', err);
    // Return stale cache if available
    if (modelsCache) {
      return res.json({ data: modelsCache.data });
    }
    res.status(500).json({ error: 'Failed to fetch OpenRouter models' });
  }
});

export default router;
