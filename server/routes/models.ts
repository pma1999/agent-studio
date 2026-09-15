import { Router, Response } from 'express';
import { nanoid } from 'nanoid';
import { AuthRequest } from '../middleware/auth.js';
import db from '../db.js';
import { getSettingValue } from './settings.js';
import { normalizeOpenRouterEndpoints } from '../providerRouting.js';
import { ABLITERATION_BASE_URL, ABLITERATION_CATALOG, ARNICT_BASE_URL, ARNICT_CATALOG, DEEPSEEK_BASE_URL, DEEPSEEK_CATALOG, LLAMACPP_PREFIX, OPENCODE_GO_BASE_URL, OPENCODE_GO_CATALOG, OPENCODE_GO_CATALOG_VERSION, OPENCODE_GO_CHAT_COMPLETIONS_URL, OPENCODE_GO_PREFIX, OPENCODE_GO_USER_AGENT, OPENCODE_GO_VALIDATE_MODEL } from '../providers/index.js';
import {
  LLAMACPP_ACTIVE_PRESET_SCHEMA,
  LLAMACPP_CANONICAL_PRESETS,
  LLAMACPP_DEFAULT_KNOBS,
  LLAMACPP_MODEL_OVERRIDES_ROW_SCHEMA,
  LLAMACPP_MODEL_SAMPLING_ROW_SCHEMA,
  LLAMACPP_PRESET_IDS,
  LLAMACPP_SAMPLING_ROW_SCHEMA,
  KNOB_OVERRIDE_SCHEMA,
  mergeKnobLayers,
  parseKnobs,
  type LlamacppPresetId,
} from '../providers/llamacpp.js';
import {
  ensureLlamacppRunning,
  getLlamacppStatus,
  LLAMACPP_CAPABILITY_ERROR,
  listLlamacppModels,
  resolveLlamacppConfig,
  stopLlamacpp,
} from '../providers/llamacppTransport.js';
import { getAgentCapabilities, sendLlamacppRequest } from '../agentRelay/registry.js';
import type { BackendToAgentMessage } from '../agentRelay/protocol.js';
import { listChatgptModels, CodexForbiddenError } from '../codex/instanceManager.js';
import { lookupSupportedEfforts } from '../../shared/reasoningEfforts.js';

const router = Router();

// In-memory cache for OpenRouter models
let modelsCache: { data: any[]; timestamp: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const ENDPOINTS_CACHE_TTL = 60 * 1000; // 1 minute
const endpointsCache = new Map<string, { data: unknown[]; timestamp: number }>();

// OpenCode Go drift monitor (T6): compares the live keyless `GET /v1/models`
// id set against the frozen `OPENCODE_GO_CATALOG` and logs new/missing ids.
// Info-only: never mutates `data`, never sends a key or query params, single
// page, throttled to one check per hour, fail-open (degraded warn, never 500).
const OPENCODE_GO_DRIFT_TTL_MS = 60 * 60 * 1000; // 1 hour (soft throttle)
const OPENCODE_GO_DRIFT_TIMEOUT_MS = 5_000;
let opencodeGoDriftLastCheck = 0;

async function maybeLogOpencodeGoDrift(): Promise<void> {
  const now = Date.now();
  if (now - opencodeGoDriftLastCheck < OPENCODE_GO_DRIFT_TTL_MS) return;
  opencodeGoDriftLastCheck = now;
  const version = OPENCODE_GO_CATALOG_VERSION;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), OPENCODE_GO_DRIFT_TIMEOUT_MS);
    try {
      const res = await fetch(`${OPENCODE_GO_BASE_URL}/models`, { signal: ctrl.signal });
      if (!res.ok) {
        console.warn(`[opencode-go] drift check degraded (version ${version}): live list HTTP ${res.status}`);
        return;
      }
      // Upstream lies about Content-Type (text/plain on JSON bodies): read as
      // text first, then parse by content, not by header.
      const raw = await res.text();
      let json: { data?: unknown };
      try {
        json = JSON.parse(raw) as { data?: unknown };
      } catch {
        console.warn(`[opencode-go] drift check degraded (version ${version}): live body is not JSON`);
        return;
      }
      const liveIds = Array.isArray(json.data)
        ? json.data
            .map((entry) =>
              entry !== null && typeof entry === 'object' && 'id' in entry
                ? (entry as { id?: unknown }).id
                : undefined,
            )
            .filter((id): id is string => typeof id === 'string')
        : [];
      const catalogBare = new Set(
        OPENCODE_GO_CATALOG.map((entry) =>
          entry.id.startsWith(OPENCODE_GO_PREFIX)
            ? entry.id.slice(OPENCODE_GO_PREFIX.length)
            : entry.id,
        ),
      );
      const liveSet = new Set(liveIds);
      const added = liveIds.filter((id) => !catalogBare.has(id));
      const missing = [...catalogBare].filter((id) => !liveSet.has(id));
      if (added.length === 0 && missing.length === 0) {
        console.info(`[opencode-go] drift check ok (version ${version}): live matches catalog (${liveIds.length} ids)`);
      } else {
        console.info(
          `[opencode-go] drift detected (version ${version}): new [${added.join(', ')}] missing [${missing.join(', ')}]`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.warn(`[opencode-go] drift check degraded (version ${version}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Pure mapper for one upstream catalog entry. Verbatim passthrough of
 * `reasoning.{supported_efforts, mandatory, default_effort}`; `null` when the
 * upstream entry carries no `reasoning` object. Extracted pure for testability.
 */
export function mapOpenRouterCatalogEntry(m: any): {
  id: string;
  name: string;
  description: string;
  context_length: number;
  pricing: { prompt: string; completion: string };
  reasoning: {
    supported_efforts?: string[] | null;
    mandatory?: boolean | null;
    default_effort?: string | null;
  } | null;
} {
  const reasoning = m?.reasoning;
  return {
    id: m.id,
    name: m.name,
    description: m.description || '',
    context_length: m.context_length || 0,
    pricing: {
      prompt: m.pricing?.prompt || '0',
      completion: m.pricing?.completion || '0',
    },
    reasoning:
      reasoning === null || reasoning === undefined || typeof reasoning !== 'object'
        ? null
        : {
            supported_efforts: Array.isArray(reasoning.supported_efforts)
              ? [...reasoning.supported_efforts]
              : (reasoning.supported_efforts ?? null),
            mandatory: reasoning.mandatory ?? null,
            default_effort: reasoning.default_effort ?? null,
          },
  };
}

/**
 * Read a model's supported efforts from the in-memory proxy cache. Never
 * fetches: `null` when the cache is cold, the model is absent, or it carries
 * no list (all fail-open cases for the T2 clamp).
 */
export function getCachedOpenRouterSupportedEfforts(modelId: string): string[] | null {
  if (!modelsCache) return null;
  return lookupSupportedEfforts(modelsCache.data, modelId);
}

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
    const models = (json.data || []).map(mapOpenRouterCatalogEntry);

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

// GET /api/models/abliteration - Curated Abliteration-direct catalog (static; no key needed)
router.get('/abliteration', (_req: AuthRequest, res: Response) => {
  res.json({ data: ABLITERATION_CATALOG });
});

// GET /api/models/arnict - Curated Arnict-direct catalog (static; no key needed)
router.get('/arnict', (_req: AuthRequest, res: Response) => {
  res.json({ data: ARNICT_CATALOG });
});

// GET /api/models/opencodego - Curated OpenCode Go catalog (static; no key needed)
// `meta` is additive (version/count/fetchedAt); old clients reading only `data` keep working.
router.get('/opencodego', (_req: AuthRequest, res: Response) => {
  void maybeLogOpencodeGoDrift();
  res.json({
    data: OPENCODE_GO_CATALOG,
    meta: {
      version: OPENCODE_GO_CATALOG_VERSION,
      count: OPENCODE_GO_CATALOG.length,
      fetchedAt: new Date().toISOString(),
    },
  });
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
// GET /api/models/abliteration/validate - Verify the saved Abliteration key via credits balance
router.get('/abliteration/validate', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const apiKey = getSettingValue(userId, 'abliteration_api_key');
    if (!apiKey?.trim()) {
      return res.status(400).json({ error: 'Abliteration API key not configured' });
    }

    const response = await fetch(`${ABLITERATION_BASE_URL}/v1/credits`, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      const errJson = (await response.json().catch(() => ({}))) as {
        error?: { code?: unknown; message?: unknown };
      };
      const code = typeof errJson.error?.code === 'string' ? errJson.error.code : '';
      if (code === 'missing_api_key' || code === 'invalid_api_key') {
        return res.status(401).json({ ok: false, error: 'Invalid Abliteration API key' });
      }
      if (response.status === 402 || code === 'billing_error') {
        return res.status(402).json({
          ok: false,
          error: 'Insufficient Abliteration credits — top up at abliteration.ai/console',
        });
      }
      const message =
        typeof errJson.error?.message === 'string' && errJson.error.message
          ? errJson.error.message
          : `Abliteration error (${response.status})`;
      return res.status(response.status).json({ ok: false, error: message });
    }

    const json = (await response.json().catch(() => ({}))) as {
      data?: { total_credits?: unknown; total_usage?: unknown };
    };
    res.json({
      ok: true,
      total_credits: json.data?.total_credits,
      total_usage: json.data?.total_usage,
    });
  } catch (err) {
    console.error('Error validating Abliteration key:', err);
    res.status(500).json({ ok: false, error: 'Failed to reach Abliteration' });
  }
});
// GET /api/models/opencodego/validate - Verify the saved OpenCode Go key with a
// minimal 1-token POST probe. GET /models needs no auth upstream, so it cannot
// validate honestly; this probe costs ~1 completion token per call.
router.get('/opencodego/validate', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const apiKey = getSettingValue(userId, 'opencode_go_api_key');
    if (!apiKey?.trim()) {
      return res.status(400).json({ error: 'OpenCode Go API key not configured' });
    }

    const response = await fetch(OPENCODE_GO_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent': OPENCODE_GO_USER_AGENT,
        'x-opencode-session': `validate-${nanoid()}`,
      },
      body: JSON.stringify({
        model: OPENCODE_GO_VALIDATE_MODEL,
        messages: [{ role: 'user', content: 'ok' }],
        max_tokens: 1,
        stream: false,
      }),
    });

    if (!response.ok) {
      // Upstream lies about Content-Type (text/plain on JSON bodies): read as
      // text first, then parse by content, not by header.
      const raw = await response.text().catch(() => '');
      let code = '';
      let message = '';
      try {
        const errJson = JSON.parse(raw) as {
          error?: { type?: unknown; code?: unknown; message?: unknown };
        };
        const errObj = errJson?.error;
        if (errObj !== null && typeof errObj === 'object') {
          if (typeof errObj.code === 'string') code = errObj.code;
          else if (typeof errObj.type === 'string') code = errObj.type;
          if (typeof errObj.message === 'string') message = errObj.message;
        }
      } catch {
        // Non-JSON body (e.g. 404 HTML): surface status + body prefix below.
      }
      if (
        response.status === 401
        || code === 'AuthError'
        || /invalid api key/i.test(message)
      ) {
        return res.status(401).json({
          ok: false,
          error: 'Invalid OpenCode Go API key. Check your key in Settings → OpenCode Go.',
        });
      }
      if (response.status === 402 || response.status === 429) {
        return res.status(response.status).json({
          ok: false,
          error:
            'OpenCode Go usage limit reached for this model. Check usage in the OpenCode console (https://opencode.ai/docs/go/) or enable the Zen-balance fallback there.',
        });
      }
      const detail = message || (raw ? raw.slice(0, 300) : '');
      return res.status(response.status).json({
        ok: false,
        error: detail
          ? `OpenCode Go error (${response.status}): ${detail}`
          : `OpenCode Go error (${response.status})`,
      });
    }

    res.json({ ok: true, model: OPENCODE_GO_VALIDATE_MODEL });
  } catch (err) {
    console.error('Error validating OpenCode Go key:', err);
    res.status(500).json({ ok: false, error: 'Failed to reach OpenCode Go' });
  }
});
// GET /api/models/arnict/validate - Verify the saved Arnict key via keyed GET /v1/models probe
router.get('/arnict/validate', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const apiKey = getSettingValue(userId, 'arnict_api_key');
    if (!apiKey?.trim()) {
      return res.status(400).json({ error: 'Arnict API key not configured' });
    }

    const response = await fetch(`${ARNICT_BASE_URL}/v1/models`, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      const errJson = (await response.json().catch(() => ({}))) as {
        error?: { code?: unknown; message?: unknown };
      };
      const code = typeof errJson.error?.code === 'string' ? errJson.error.code : '';
      const message =
        typeof errJson.error?.message === 'string' && errJson.error.message
          ? errJson.error.message
          : '';
      if (response.status === 401 || code === 'invalid_api_key') {
        return res.status(401).json({ ok: false, error: 'Invalid Arnict API key' });
      }
      if (code === 'insufficient_quota') {
        return res.status(429).json({
          ok: false,
          error: 'Insufficient Arnict credits — top up at arnict.com',
        });
      }
      if (code === 'rate_limit_exceeded' || response.status === 429) {
        return res.status(429).json({
          ok: false,
          error: 'Arnict rate limit exceeded — retry later',
        });
      }
      if (
        response.status === 403
        || code === 'key_expired'
        || code === 'ip_not_allowed'
        || code === 'model_not_allowed'
        || code === 'account_suspended'
        || code === 'account_blocked'
      ) {
        return res.status(403).json({
          ok: false,
          error: message || 'Arnict key expired or restricted',
        });
      }
      return res
        .status(response.status)
        .json({ ok: false, error: message || `Arnict error (${response.status})` });
    }

    // Success payload VERIFIED-keyed (2026-09-13): live GET /v1/models returns
    // an OpenAI-compatible list with no `owned_by`, so read ids from
    // `data[].id` only. Live may list 4 ids; the app catalog stays at 2 by plan.
    const json = (await response.json().catch(() => ({}))) as {
      data?: unknown;
    };
    const ids = Array.isArray(json.data)
      ? json.data
          .map((entry) =>
            entry !== null && typeof entry === 'object' && 'id' in entry
              ? (entry as { id?: unknown }).id
              : undefined,
          )
          .filter((id): id is string => typeof id === 'string')
      : [];
    res.json({ ok: true, models: ids.length, ids });
  } catch (err) {
    console.error('Error validating Arnict key:', err);
    res.status(500).json({ ok: false, error: 'Failed to reach Arnict' });
  }
});

// ---------------------------------------------------------------------------
// llama.cpp (local llama-server via the paired local agent) — global-constraints
// §5 pinned endpoints. All routes are authenticated exactly like their
// neighbors, key every transport call by the authenticated userId (tenant
// isolation), and gate on the agent's declared 'llamacpp' capability FIRST
// (§2: an outdated agent gets the exact update message instead of a confusing
// timeout). Route handlers NEVER throw.
//
// Frontend-facing literals chosen here for task 4 to mirror (server does not
// own the frontend file): selector group id 'llamacpp-local'; status-changed
// window event name 'llamacpp:status-changed'.
// ---------------------------------------------------------------------------

/** §2 frozen capability-gate rejection message lives in llamacppTransport. */

/**
 * Capability gate + auth guard for every llamacpp action route. Returns the
 * authenticated userId, or has already responded (401 / 503) when null.
 * GET /llamacpp/status deliberately does NOT pass through here: its §5
 * contract is a never-throw payload that REPORTS capabilitySupported so users
 * with outdated agents can see why nothing works.
 */
function llamacppGate(req: AuthRequest, res: Response): string | null {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  if (!(getAgentCapabilities(userId)?.includes('llamacpp') ?? false)) {
    res.status(503).json({ error: LLAMACPP_CAPABILITY_ERROR });
    return null;
  }
  return userId;
}

function upsertSetting(userId: string, key: string, value: string): void {
  db.prepare(`
    INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
  `).run(userId, key, value);
}

// GET /api/models/llamacpp — scanned .gguf catalog (cached ~30 s per user,
// invalidated by start/stop; a fresh scan re-populates it).
const llamacppCatalogCache = new Map<string, { data: unknown[]; timestamp: number }>();
const LLAMACPP_CATALOG_TTL_MS = 30_000;

router.get('/llamacpp', async (req: AuthRequest, res: Response) => {
  const userId = llamacppGate(req, res);
  if (!userId) return;
  try {
    const cached = llamacppCatalogCache.get(userId);
    if (cached && Date.now() - cached.timestamp < LLAMACPP_CATALOG_TTL_MS) {
      return res.json({ data: cached.data });
    }

    // Capability-missing / no-agent / scan failure all land here as throws ⇒
    // fail-soft 503 {error} per §5.
    const entries = await listLlamacppModels(userId);
    const status = await getLlamacppStatus(userId);
    const data = entries.map((entry) => ({
      id: `${LLAMACPP_PREFIX}${entry.key}`,
      name: entry.key,
      description: '',
      context_length: 0, // unknown locally; frontend tolerates zero metadata
      pricing: { prompt: '0', completion: '0' }, // local: 'local' price column
      path: entry.path,
      ...(entry.sizeBytes !== undefined ? { size_bytes: entry.sizeBytes } : {}),
      shards: entry.shards,
      mtp_capable: entry.mtpCapable,
      loaded: status.running && status.modelKey === entry.key,
    }));

    llamacppCatalogCache.set(userId, { data, timestamp: Date.now() });
    return res.json({ data });
  } catch (err) {
    console.error('Error scanning llama.cpp models:', err);
    return res.status(503).json({
      error: err instanceof Error ? err.message : 'Failed to scan the llama.cpp models directory.',
    });
  }
});

// GET /api/models/llamacpp/status - never-throw §5 payload; capability state is
// REPORTED (capabilitySupported) rather than gated so old agents get a usable answer.
router.get('/llamacpp/status', async (req: AuthRequest, res: Response) => {
  const userId = req.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    return res.json(await getLlamacppStatus(userId));
  } catch (err) {
    console.error('Error building llama.cpp status:', err);
    return res.json({
      agentConnected: false,
      capabilitySupported: false,
      running: false,
      pid: null,
      modelPath: null,
      modelKey: null,
      port: null,
      transport: null,
      healthy: null,
      startedAt: null,
      lastExitCode: null,
      argv: null,
      mtpActive: false,
      pendingRestart: false,
    });
  }
});

// POST /api/models/llamacpp/start — swap-then-spawn-then-health-wait (≥120 s
// budget inside ensureLlamacppRunning). Request-level overrides merge LAST but
// are NOT persisted (precedence request > model > global > default).
router.post('/llamacpp/start', async (req: AuthRequest, res: Response) => {
  const userId = llamacppGate(req, res);
  if (!userId) return;
  try {
    const body = (req.body ?? {}) as { model?: unknown; overrides?: unknown };
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!model) {
      return res.status(400).json({ error: 'model must be a non-empty string (the stripped llamacpp key)' });
    }
    if (body.overrides !== undefined && (typeof body.overrides !== 'object' || body.overrides === null || Array.isArray(body.overrides))) {
      return res.status(400).json({ error: 'overrides must be an object when provided' });
    }
    let requestOverrides: Record<string, unknown> | undefined;
    if (body.overrides !== undefined) {
      const parsed = parseKnobs(body.overrides);
      if (!parsed.ok) {
        return res.status(400).json({ error: `Invalid overrides: ${parsed.error}` });
      }
      requestOverrides = parsed.knobs;
    }

    // Model-not-found is a client error (400); distinguish it from spawn /
    // health failures (502) before handing off to the transport.
    let entries;
    try {
      entries = await listLlamacppModels(userId);
    } catch (err) {
      return res.status(503).json({
        error: err instanceof Error ? err.message : 'Failed to scan the llama.cpp models directory.',
      });
    }
    if (!entries.some((entry) => entry.key === model)) {
      return res.status(400).json({ error: `Model "${model}" was not found in the scanned llama.cpp models directory.` });
    }

    const startedAt = Date.now();
    const result = await ensureLlamacppRunning(
      userId,
      model,
      requestOverrides ? { overrides: requestOverrides } : {},
    );
    const waitedMs = Date.now() - startedAt;
    if (
      result.running
      && typeof result.pid === 'number'
      && typeof result.port === 'number'
      && Array.isArray(result.argv)
    ) {
      llamacppCatalogCache.delete(userId); // §5 cache invalidation (loaded flags)
      return res.json({ ok: true, pid: result.pid, port: result.port, argv: result.argv, waitedMs });
    }
    return res.status(502).json({ error: result.error ?? 'Failed to start llama-server.' });
  } catch (err) {
    console.error('Error starting llama-server:', err);
    return res.status(502).json({
      error: err instanceof Error ? err.message : 'Failed to start llama-server.',
    });
  }
});

// POST /api/models/llamacpp/stop — FROZEN §5 envelope; idempotent ('not-running'
// is success). Failure ⇒ 502 {error}; state truth lives in /status either way.
router.post('/llamacpp/stop', async (req: AuthRequest, res: Response) => {
  const userId = llamacppGate(req, res);
  if (!userId) return;
  try {
    const result = await stopLlamacpp(userId);
    if (result.ok) {
      llamacppCatalogCache.delete(userId); // §5 cache invalidation (loaded flags)
      return res.json({ ok: true, status: result.status });
    }
    return res.status(502).json({ error: result.error ?? 'Failed to stop llama-server.' });
  } catch (err) {
    console.error('Error stopping llama-server:', err);
    return res.status(502).json({
      error: err instanceof Error ? err.message : 'Failed to stop llama-server.',
    });
  }
});

// GET /api/models/llamacpp/config — effective config view (resolved scalars +
// validated knob/preset/sampling rows) for the settings UI/diagnostics.
router.get('/llamacpp/config', async (req: AuthRequest, res: Response) => {
  const userId = llamacppGate(req, res);
  if (!userId) return;
  try {
    const config = resolveLlamacppConfig(userId);
    return res.json({
      ok: true,
      exePath: config.exePath,
      modelsDir: config.modelsDir,
      port: config.port,
      idleUnloadMinutes: config.idleUnloadMinutes,
      defaults: config.knobs,
      overrides: config.overrides,
      presets: config.presets,
      activePreset: config.activePreset,
      sampling: config.sampling,
      // §10 Increment 2d: resolved per-model sampling map (validated row
      // AS STORED; absent/corrupt row ⇒ {}).
      modelSampling: config.modelSampling,
    });
  } catch (err) {
    console.error('Error reading llama.cpp config:', err);
    return res.status(500).json({ error: 'Failed to read the llama.cpp configuration.' });
  }
});

// POST /api/models/llamacpp/config — zod-validated persistence with key-level
// errors; each provided section replaces its whole settings row (omitted
// sections are untouched). Presets persist as CANONICAL ⊕ provided so the
// stored row always parses standalone (§3 Increment 2 discipline); the §10
// Increment 2d `modelSampling` section persists VERBATIM after validation.
router.post('/llamacpp/config', async (req: AuthRequest, res: Response) => {
  const userId = llamacppGate(req, res);
  if (!userId) return;
  try {
    const body = (req.body ?? {}) as {
      defaults?: unknown;
      overrides?: unknown;
      presets?: unknown;
      activePreset?: unknown;
      sampling?: unknown;
      modelSampling?: unknown;
    };
    if (
      body.defaults === undefined
      && body.overrides === undefined
      && body.presets === undefined
      && body.activePreset === undefined
      && body.sampling === undefined
      && body.modelSampling === undefined
    ) {
      return res.status(400).json({
        error: 'Provide at least one of: defaults, overrides, presets, activePreset, sampling, modelSampling',
      });
    }
    if (body.defaults !== undefined && (typeof body.defaults !== 'object' || body.defaults === null || Array.isArray(body.defaults))) {
      return res.status(400).json({ error: 'defaults must be an object when provided' });
    }
    if (body.overrides !== undefined && (typeof body.overrides !== 'object' || body.overrides === null || Array.isArray(body.overrides))) {
      return res.status(400).json({ error: 'overrides must be an object keyed by model name when provided' });
    }
    if (body.presets !== undefined && (typeof body.presets !== 'object' || body.presets === null || Array.isArray(body.presets))) {
      return res.status(400).json({ error: 'presets must be an object when provided' });
    }
    if (body.sampling !== undefined && (typeof body.sampling !== 'object' || body.sampling === null || Array.isArray(body.sampling))) {
      return res.status(400).json({ error: 'sampling must be an object when provided' });
    }
    if (body.modelSampling !== undefined && (typeof body.modelSampling !== 'object' || body.modelSampling === null || Array.isArray(body.modelSampling))) {
      return res.status(400).json({ error: 'modelSampling must be an object keyed by model name when provided' });
    }

    let defaultsRow: string | null = null;
    if (body.defaults !== undefined) {
      const parsed = parseKnobs(body.defaults);
      if (!parsed.ok) {
        // parseKnobs errors read like "ctx: Expected number" — key-level detail.
        return res.status(400).json({ error: `defaults.${parsed.error}` });
      }
      // Persist the FULL canonical bag (⊕ saved layer) so the row always parses standalone.
      defaultsRow = JSON.stringify(mergeKnobLayers(LLAMACPP_DEFAULT_KNOBS, parsed.knobs));
    }
    let overridesRow: string | null = null;
    if (body.overrides !== undefined) {
      const parsed = LLAMACPP_MODEL_OVERRIDES_ROW_SCHEMA.safeParse(body.overrides);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue && issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return res.status(400).json({ error: `Invalid overrides at "${where}": ${issue?.message ?? 'schema mismatch'}` });
      }
      overridesRow = JSON.stringify(parsed.data);
    }
    let presetsRow: string | null = null;
    if (body.presets !== undefined) {
      // Per-slot CANONICAL ⊕ provided (§3: omitted keys keep their canonical
      // value), so single-preset saves work and the stored row always parses
      // standalone. Unknown slot ids and bad knob bags reject key-level.
      const provided = body.presets as Record<string, unknown>;
      const mergedSlots: Record<LlamacppPresetId, Record<string, unknown>> = {
        rapido: { ...LLAMACPP_CANONICAL_PRESETS.rapido },
        equilibrado: { ...LLAMACPP_CANONICAL_PRESETS.equilibrado },
        profundo: { ...LLAMACPP_CANONICAL_PRESETS.profundo },
      };
      let presetsError: string | null = null;
      for (const [slotId, slotValue] of Object.entries(provided)) {
        const idCheck = LLAMACPP_ACTIVE_PRESET_SCHEMA.safeParse(slotId);
        if (!idCheck.success) {
          presetsError = `presets.${slotId}: Unknown preset id (must be one of ${LLAMACPP_PRESET_IDS.join(', ')})`;
          break;
        }
        const slotCheck = KNOB_OVERRIDE_SCHEMA.safeParse(slotValue);
        if (!slotCheck.success) {
          const issue = slotCheck.error.issues[0];
          const where = issue && issue.path.length > 0 ? issue.path.join('.') : '(root)';
          presetsError = `presets.${slotId}.${where}: ${issue?.message ?? 'schema mismatch'}`;
          break;
        }
        mergedSlots[idCheck.data] = { ...mergedSlots[idCheck.data], ...slotCheck.data };
      }
      if (presetsError !== null) return res.status(400).json({ error: presetsError });
      presetsRow = JSON.stringify(mergedSlots);
    }
    let activePresetRow: string | null = null;
    if (body.activePreset !== undefined) {
      const parsed = LLAMACPP_ACTIVE_PRESET_SCHEMA.safeParse(body.activePreset);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return res.status(400).json({ error: `activePreset: ${issue?.message ?? 'must be one of rapido, equilibrado, profundo'}` });
      }
      activePresetRow = parsed.data;
    }
    let samplingRow: string | null = null;
    if (body.sampling !== undefined) {
      const parsed = LLAMACPP_SAMPLING_ROW_SCHEMA.safeParse(body.sampling);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue && issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return res.status(400).json({ error: `sampling.${where}: ${issue?.message ?? 'schema mismatch'}` });
      }
      samplingRow = JSON.stringify(parsed.data); // validated row verbatim
    }
    let modelSamplingRow: string | null = null;
    if (body.modelSampling !== undefined) {
      // §10 Increment 2d: Record<modelKey, Partial<samplingRow>> — every entry
      // strictly validated with key-level detail (`modelSampling.<key>.temp: …`)
      // and the whole validated row persisted VERBATIM.
      const parsed = LLAMACPP_MODEL_SAMPLING_ROW_SCHEMA.safeParse(body.modelSampling);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue && issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return res.status(400).json({ error: `modelSampling.${where}: ${issue?.message ?? 'schema mismatch'}` });
      }
      modelSamplingRow = JSON.stringify(parsed.data);
    }

    if (defaultsRow !== null) upsertSetting(userId, 'llamacpp_load_defaults', defaultsRow);
    if (overridesRow !== null) upsertSetting(userId, 'llamacpp_model_overrides', overridesRow);
    if (presetsRow !== null) upsertSetting(userId, 'llamacpp_presets', presetsRow);
    if (activePresetRow !== null) upsertSetting(userId, 'llamacpp_active_preset', activePresetRow);
    if (samplingRow !== null) upsertSetting(userId, 'llamacpp_sampling', samplingRow);
    if (modelSamplingRow !== null) upsertSetting(userId, 'llamacpp_model_sampling', modelSamplingRow);
    return res.json({ ok: true });
  } catch (err) {
    console.error('Error saving llama.cpp config:', err);
    return res.status(500).json({ error: 'Failed to save the llama.cpp configuration.' });
  }
});

// GET /api/models/llamacpp/logs?maxBytes=8192 — bounded tail of the tracked
// child's merged stdout+stderr. Fail-soft: ANY failure degrades to the empty
// envelope instead of erroring the log viewer.
const LLAMACPP_LOGS_DEFAULT_MAX_BYTES = 8192;
const LLAMACPP_LOGS_TIMEOUT_MS = 10_000;

router.get('/llamacpp/logs', async (req: AuthRequest, res: Response) => {
  const userId = llamacppGate(req, res);
  if (!userId) return;
  try {
    const requested = Number(req.query.maxBytes ?? LLAMACPP_LOGS_DEFAULT_MAX_BYTES);
    // Clamp into the protocol's 1..65536 range; non-numeric falls to the default.
    const maxBytes = Number.isInteger(requested) && requested >= 1
      ? Math.min(requested, 65_536)
      : LLAMACPP_LOGS_DEFAULT_MAX_BYTES;

    const status = await getLlamacppStatus(userId);
    if (!status.running) {
      return res.json({ ok: true, text: '', truncated: false });
    }
    const response = await sendLlamacppRequest<{ ok: boolean; text?: string; truncated?: boolean; error?: string }>(
      userId,
      { type: 'llamacpp_logs_request', requestId: `llamacpp_${nanoid()}`, maxBytes } as BackendToAgentMessage & { requestId: string },
      LLAMACPP_LOGS_TIMEOUT_MS,
    );
    if (!response.ok) {
      console.warn(`[models] llama.cpp logs unavailable: ${response.error ?? 'unknown error'}`);
      return res.json({ ok: true, text: '', truncated: false });
    }
    return res.json({ ok: true, text: response.text ?? '', truncated: response.truncated ?? false });
  } catch (err) {
    console.warn('[models] llama.cpp logs fetch failed (fail-soft):', err instanceof Error ? err.message : String(err));
    return res.json({ ok: true, text: '', truncated: false });
  }
});

export default router;
