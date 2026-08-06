import { Router, Response } from 'express';
import { AuthRequest } from '../middleware/auth.js';
import { getSettingValue } from './settings.js';
import { normalizeOpenRouterEndpoints } from '../providerRouting.js';
import { DEEPSEEK_BASE_URL, DEEPSEEK_CATALOG } from '../providers/index.js';
import { listChatgptModels, CodexForbiddenError } from '../codex/instanceManager.js';

const router = Router();

// In-memory cache for OpenRouter models
let modelsCache: { data: any[]; timestamp: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const ENDPOINTS_CACHE_TTL = 60 * 1000; // 1 minute
const endpointsCache = new Map<string, { data: unknown[]; timestamp: number }>();

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

// GET /api/models/openrouter/endpoints?model=author/slug - Fetch OpenRouter endpoints for a concrete model
router.get('/openrouter/endpoints', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const model = typeof req.query.model === 'string' ? req.query.model.trim() : '';
    if (!model) {
      return res.status(400).json({ error: 'model query parameter is required' });
    }
    if (model === 'openrouter/auto') {
      return res.status(400).json({ error: 'Endpoint selection requires a concrete model' });
    }

    const slash = model.indexOf('/');
    if (slash <= 0 || slash === model.length - 1) {
      return res.status(400).json({ error: 'model must be an OpenRouter id like author/slug' });
    }

    const apiKey = getSettingValue(userId, 'openrouter_api_key');
    if (!apiKey?.trim()) {
      return res.status(400).json({ error: 'OpenRouter API key not configured' });
    }

    const cacheKey = `${userId}:${model}`;
    const cached = endpointsCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < ENDPOINTS_CACHE_TTL) {
      return res.json({ data: cached.data });
    }

    const author = model.slice(0, slash);
    const slug = model.slice(slash + 1);
    const response = await fetch(
      `https://openrouter.ai/api/v1/models/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/endpoints`,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      return res.status(response.status).json({
        error: errorText || `Failed to fetch OpenRouter endpoints: ${response.statusText}`,
      });
    }

    const json = await response.json();
    const endpoints = normalizeOpenRouterEndpoints(json);
    endpointsCache.set(cacheKey, { data: endpoints, timestamp: Date.now() });
    res.json({ data: endpoints });
  } catch (err) {
    console.error('Error fetching OpenRouter endpoints:', err);
    res.status(500).json({ error: 'Failed to fetch OpenRouter endpoints' });
  }
});

// GET /api/models/deepseek - Curated DeepSeek-direct catalog (static; no key needed)
router.get('/deepseek', (_req: AuthRequest, res: Response) => {
  res.json({ data: DEEPSEEK_CATALOG });
});

// GET /api/models/codex - Models available to the user's connected ChatGPT account
const codexModelsCache = new Map<string, { data: unknown[]; timestamp: number }>();
const CODEX_MODELS_CACHE_TTL = 60_000; // 1 minute

router.get('/codex', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const cached = codexModelsCache.get(userId);
    if (cached && Date.now() - cached.timestamp < CODEX_MODELS_CACHE_TTL) {
      return res.json({ data: cached.data });
    }

    const models = await listChatgptModels(userId);
    codexModelsCache.set(userId, { data: models, timestamp: Date.now() });
    res.json({ data: models });
  } catch (err) {
    if (err instanceof CodexForbiddenError) {
      return res.status(403).json({ error: err.message });
    }
    console.error('Error fetching Codex models:', err);
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to fetch Codex models' });
  }
});
// GET /api/models/deepseek/validate - Verify the saved DeepSeek key and report balance
router.get('/deepseek/validate', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const apiKey = getSettingValue(userId, 'deepseek_api_key');
    if (!apiKey?.trim()) {
      return res.status(400).json({ error: 'DeepSeek API key not configured' });
    }

    const response = await fetch(`${DEEPSEEK_BASE_URL}/user/balance`, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      const status = response.status === 401 || response.status === 403 ? 401 : response.status;
      return res.status(status).json({
        ok: false,
        error: status === 401 ? 'Invalid DeepSeek API key' : errorText || `DeepSeek error (${response.status})`,
      });
    }

    const json = (await response.json().catch(() => ({}))) as {
      is_available?: boolean;
      balance_infos?: Array<{ currency?: string; total_balance?: string }>;
    };
    const info = json.balance_infos?.[0];
    res.json({
      ok: true,
      is_available: json.is_available ?? true,
      ...(info?.total_balance != null ? { balance: info.total_balance, currency: info.currency ?? 'USD' } : {}),
    });
  } catch (err) {
    console.error('Error validating DeepSeek key:', err);
    res.status(500).json({ ok: false, error: 'Failed to reach DeepSeek' });
  }
});

export default router;
