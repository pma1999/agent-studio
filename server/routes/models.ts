import { Router, Response } from 'express';
import { AuthRequest } from '../middleware/auth.js';
import { getSettingValue } from './settings.js';
import { normalizeOpenRouterEndpoints } from '../providerRouting.js';
import { DEEPSEEK_BASE_URL, DEEPSEEK_CATALOG } from '../providers/index.js';
import {
  DEFAULT_LMSTUDIO_PROFILE_ID,
  normalizeCatalogEntry,
  toCatalogModel,
} from '../providers/lmstudio.js';
import {
  buildComplianceReport,
  ensureModelLoaded,
  getLmStudioSettings,
  lmstudioFetch,
  probeLmStudio,
  unloadLmStudioModel,
} from '../providers/lmstudioTransport.js';
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

// ---------------------------------------------------------------------------
// LM Studio (local server) — global-constraints §8 pinned endpoints.
// All four routes are authenticated exactly like their neighbors and key every
// transport call by the authenticated userId (tenant isolation).
// ---------------------------------------------------------------------------

function requireLmStudioModel(body: unknown): string | null {
  const model = (body as { model?: unknown } | null)?.model;
  return typeof model === 'string' && model.trim() ? model.trim() : null;
}

// GET /api/models/lmstudio - Live LM Studio catalog (cached ~30 s per user).
const lmStudioModelsCache = new Map<string, { data: unknown[]; timestamp: number }>();
const LMSTUDIO_MODELS_CACHE_TTL = 30_000;

router.get('/lmstudio', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const cached = lmStudioModelsCache.get(userId);
    if (cached && Date.now() - cached.timestamp < LMSTUDIO_MODELS_CACHE_TTL) {
      return res.json({ data: cached.data });
    }

    const probe = await probeLmStudio(userId);
    if (!probe.reachable || probe.transport === null) {
      // Fail-soft contract (§8): the frontend hook treats this as "offline".
      return res.status(503).json({ error: 'LM Studio is not reachable.' });
    }

    // §7 version detection: 0.4.x serves the rich native catalog; ≤0.3.x only
    // exposes the OpenAI-compatible list. normalizeCatalogEntry tolerates both.
    const catalogPath = probe.apiSurface === 'native-v1' ? '/api/v1/models' : '/v1/models';
    const response = await lmstudioFetch(userId, catalogPath, { timeoutMs: 10_000 });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return res.status(503).json({
        error:
          `Failed to fetch LM Studio models (${response.status})` +
          (detail ? `: ${detail.slice(0, 300)}` : ''),
      });
    }
    const json = (await response.json().catch(() => null)) as {
      models?: unknown[];
      data?: unknown[];
    } | null;
    const rawModels = Array.isArray(json?.models) ? json.models : Array.isArray(json?.data) ? json.data : [];
    const models = rawModels
      .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
      .map((entry) => toCatalogModel(normalizeCatalogEntry(entry)));

    lmStudioModelsCache.set(userId, { data: models, timestamp: Date.now() });
    return res.json({ data: models });
  } catch (err) {
    console.error('Error fetching LM Studio models:', err);
    return res
      .status(503)
      .json({ error: err instanceof Error ? err.message : 'Failed to reach LM Studio' });
  }
});

// GET /api/models/lmstudio/status - Connection/transport status for the UI.
// Never throws: unreachable is a valid 200 payload.
router.get('/lmstudio/status', async (req: AuthRequest, res: Response) => {
  const userId = req.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const probe = await probeLmStudio(userId, { force: true });
    const settings = getLmStudioSettings(userId);
    return res.json({
      reachable: probe.reachable,
      transport: probe.transport,
      apiSurface: probe.apiSurface,
      agentConnected: probe.agentConnected,
      baseUrl: settings.baseUrl,
      profile: settings.profileId,
    });
  } catch (err) {
    console.error('Error probing LM Studio status:', err);
    return res.json({
      reachable: false,
      transport: null,
      apiSurface: null,
      agentConnected: false,
      baseUrl: 'http://127.0.0.1:1234', // §9 default; settings were unreadable
      profile: DEFAULT_LMSTUDIO_PROFILE_ID,
    });
  }
});

// POST /api/models/lmstudio/load - Pre-load a model with the ACTIVE profile.
router.post('/lmstudio/load', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const model = requireLmStudioModel(req.body);
    if (!model) {
      return res.status(400).json({ error: 'model must be a non-empty string' });
    }

    const result = await ensureModelLoaded(userId, model);
    if (result.loaded && (result.mode === 'loaded' || result.mode === 'already')) {
      // §8 ok payload; instance/load_config are surfaced when the transport
      // provides them (EnsureLoadedResult carries none — fields stay omitted).
      return res.json({ ok: true });
    }
    if (result.mode === 'unsupported') {
      // ≤0.3.x has no REST load surface: explain the degradation + JIT fallback.
      return res.status(400).json({
        error: `${result.error ?? 'REST load unavailable.'} JIT loading will be used instead.`,
      });
    }
    if (result.mode === 'jit-fallback') {
      // Not pre-loadable (absent from the native catalog); do not claim success.
      return res.status(400).json({
        error: `${result.error ?? 'REST load unavailable.'} JIT loading will be used instead.`,
      });
    }
    return res.status(502).json({ error: result.error ?? 'Failed to load model in LM Studio' });
  } catch (err) {
    console.error('Error loading LM Studio model:', err);
    return res
      .status(502)
      .json({ error: err instanceof Error ? err.message : 'Failed to load model in LM Studio' });
  }
});

// POST /api/models/lmstudio/compliance - Active profile vs live load config.
router.post('/lmstudio/compliance', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const model = requireLmStudioModel(req.body);
    if (!model) {
      return res.status(400).json({ error: 'model must be a non-empty string' });
    }

    // Total per task-3: degraded surfaces keep ok:true with met:null knobs +
    // apiSurface so the UI can explain WHY compliance is unobservable.
    const report = await buildComplianceReport(userId, model);
    return res.json(report);
  } catch (err) {
    console.error('Error building LM Studio compliance report:', err);
    return res
      .status(500)
      .json({ error: err instanceof Error ? err.message : 'Failed to build compliance report' });
  }
});

// POST /api/models/lmstudio/unload - Eject all live instances of one model (§11).
router.post('/lmstudio/unload', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const model = requireLmStudioModel(req.body);
    if (!model) {
      return res.status(400).json({ error: 'model must be a non-empty string' });
    }

    const result = await unloadLmStudioModel(userId, model);
    if (result.status === 'unloaded' || result.status === 'not-loaded') {
      // §11 frozen 200 envelope; 'not-loaded' is SUCCESS (fail-soft idempotency).
      return res.json({
        ok: true,
        status: result.status,
        instances_unloaded: result.instancesUnloaded ?? 0,
      });
    }
    if (result.status === 'unsupported') {
      // ≤0.3.x has no REST unload surface either.
      return res
        .status(400)
        .json({ error: result.error ?? 'REST unload requires LM Studio 0.4.x.' });
    }
    return res
      .status(502)
      .json({ error: result.error ?? 'Failed to unload model in LM Studio' });
  } catch (err) {
    console.error('Error unloading LM Studio model:', err);
    return res
      .status(502)
      .json({ error: err instanceof Error ? err.message : 'Failed to unload model in LM Studio' });
  }
});

export default router;
