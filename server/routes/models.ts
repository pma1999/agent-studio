import { Router, Response } from 'express';
import { nanoid } from 'nanoid';
import { AuthRequest } from '../middleware/auth.js';
import db from '../db.js';
import { getSettingValue } from './settings.js';
import { normalizeOpenRouterEndpoints } from '../providerRouting.js';
import { DEEPSEEK_BASE_URL, DEEPSEEK_CATALOG, LLAMACPP_PREFIX } from '../providers/index.js';
import {
  LLAMACPP_ACTIVE_PRESET_SCHEMA,
  LLAMACPP_CANONICAL_PRESETS,
  LLAMACPP_DEFAULT_KNOBS,
  LLAMACPP_MODEL_OVERRIDES_ROW_SCHEMA,
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
    });
  } catch (err) {
    console.error('Error reading llama.cpp config:', err);
    return res.status(500).json({ error: 'Failed to read the llama.cpp configuration.' });
  }
});

// POST /api/models/llamacpp/config — zod-validated persistence with key-level
// errors; each provided section replaces its whole settings row (omitted
// sections are untouched). Presets persist as CANONICAL ⊕ provided so the
// stored row always parses standalone (§3 Increment 2 discipline).
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
    };
    if (
      body.defaults === undefined
      && body.overrides === undefined
      && body.presets === undefined
      && body.activePreset === undefined
      && body.sampling === undefined
    ) {
      return res.status(400).json({
        error: 'Provide at least one of: defaults, overrides, presets, activePreset, sampling',
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

    if (defaultsRow !== null) upsertSetting(userId, 'llamacpp_load_defaults', defaultsRow);
    if (overridesRow !== null) upsertSetting(userId, 'llamacpp_model_overrides', overridesRow);
    if (presetsRow !== null) upsertSetting(userId, 'llamacpp_presets', presetsRow);
    if (activePresetRow !== null) upsertSetting(userId, 'llamacpp_active_preset', activePresetRow);
    if (samplingRow !== null) upsertSetting(userId, 'llamacpp_sampling', samplingRow);
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
