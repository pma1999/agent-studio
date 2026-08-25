/**
 * llama.cpp transport service — the single network/lifecycle seam for
 * everything llama-server-related (global-constraints.md §7/§8).
 *
 * Responsibilities:
 * - per-user settings resolution (setting > env > default) incl. the knob
 *   bag, per-model override rows, preset slots, active-preset pointer and
 *   sampling row (zod-repaired, corrupt ⇒ defaults+warn);
 * - reachability probe + transport auto-select (direct `/health` vs
 *   local-agent relay), cached ~10 s per user unless forced (§7);
 * - `fetch`-compatible llamacppFetch() over EITHER transport, with usage
 *   stamped ONLY for POST /v1/chat/completions (model read from OUR outbound
 *   body) so chat.ts/councilExecutor need zero accounting edits (§8);
 * - spawn/stop/swap lifecycle through the task-1 `llamacpp_*` frames:
 *   capability gate → resolve model path → status → swap(stop)+spawn →
 *   health wait ≥120 s; every entry point is total (never throws);
 * - idle sweep singleton (60 s, unref'd) with the exported runLlamacppIdleSweep
 *   test seam honoring idle minutes ('0'=off) and in-flight counters.
 *
 * Failure semantics mirror lmstudioTransport: direct fetches behave like plain
 * `fetch` (connection errors reject); the relay path maps pre-terminal
 * failures (disconnect/timeout/abort/status 0) to explanatory shapes —
 * 502 JSON from llamacppFetch, `{mode:'failed',error}` from ensure — and a
 * mid-stream relay failure surfaces as a stream error after the terminal.
 *
 * T9 streaming: a relay exchange whose first body byte arrives with the
 * terminal frame still outstanding is handed to the caller IMMEDIATELY as a
 * 200 `text/event-stream` Response (both callers are POST
 * /v1/chat/completions SSE readers) so progressive delivery survives the
 * relay leg; a later status-0 terminal surfaces as that body's read failure.
 * Exchanges where the terminal leads — or lands within one short grace
 * window of the whole byte burst — keep the exact buffered mappings above.
 */

import { nanoid } from 'nanoid';
import {
  cancelHttpProxyRequest,
  getAgentCapabilities,
  isAgentConnected,
  registerLlamacppExitHook,
  sendHttpProxyRequest,
  sendLlamacppRequest,
  type HttpProxyResult,
} from '../agentRelay/registry.js';
import { buildEffectiveAllowlist, isRelayUrlAllowed } from '../agentRelay/httpProxyAllowlist.js';
import { getSettingValue } from '../routes/settings.js';
import {
  LLAMACPP_ACTIVE_PRESET_DEFAULT,
  LLAMACPP_ACTIVE_PRESET_SCHEMA,
  LLAMACPP_CANONICAL_PRESETS,
  LLAMACPP_DEFAULT_KNOBS,
  LLAMACPP_MODEL_OVERRIDES_ROW_SCHEMA,
  LLAMACPP_MODEL_SAMPLING_ROW_SCHEMA,
  LLAMACPP_PRESETS_ROW_SCHEMA,
  LLAMACPP_SAMPLING_DEFAULTS,
  LLAMACPP_SAMPLING_ROW_SCHEMA,
  buildLlamaServerArgv,
  collapseShardEntries,
  mergeKnobLayers,
  mergeSamplingLayers,
  parseKnobs,
  type LlamacppKnobs,
  type LlamacppKnobOverrides,
  type LlamacppModelEntry,
  type LlamacppPresetId,
  type LlamacppPresetsRow,
  type LlamacppSampling,
  type LlamacppSamplingOverride,
} from './llamacpp.js';

// ---------------------------------------------------------------------------
// Constants (global-constraints §3/§7/§8)
// ---------------------------------------------------------------------------

const PROBE_TIMEOUT_MS = 1500;
/** ~10 s per-user probe cache (§7 seam preserved). */
export const PROBE_CACHE_TTL_MS = 10_000;
/** Registry timeouts are ceilings; callers bound long streams via signals. */
const DEFAULT_RELAY_REQUEST_TIMEOUT_MS = 600_000;
/**
 * T9 shape-decision grace window: after a relay body's FIRST byte, wait this
 * long for the terminal frame before declaring the exchange 'streamed'.
 * Buffered bodies (error JSON, /health) arrive as chunk(s)+terminal in one
 * burst well inside the window and keep their precise terminal-led mapping;
 * genuine streams hold the terminal outstanding for seconds to minutes.
 */
const RELAY_SHAPE_GRACE_MS = 50;
/** §5/§8: readiness timeout ≥120 s for a cold 20+ GB GGUF load. */
const DEFAULT_HEALTH_WAIT_MS = 120_000;
const HEALTH_POLL_INTERVAL_MS = 500;
const HEALTH_PROBE_TIMEOUT_MS = 1500;
/** Catalog cache 30 s/user (§5), invalidated by force. */
const MODEL_CATALOG_CACHE_TTL_MS = 30_000;
/** Defensive server-side echo of the agent-side scan cap (§2). */
const MODEL_CATALOG_MAX_ENTRIES = 2000;
const IDLE_SWEEP_INTERVAL_MS = 60_000;
/** The ONLY HTTP path that counts as model usage (§8); management traffic never matches. */
const INFERENCE_PATH = '/v1/chat/completions';
const LLAMACPP_CAPABILITY = 'llamacpp';
/** Frozen §2 capability-gate rejection message. */
export const LLAMACPP_CAPABILITY_ERROR =
  'Local agent does not support llama.cpp — update the local agent.';

const DEFAULT_PORT = 8712;
const DEFAULT_IDLE_UNLOAD_MINUTES = 45;
const SCAN_TIMEOUT_MS = 15_000;
const STATUS_TIMEOUT_MS = 5_000;
const SPAWN_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 15_000;
/** Grace window handed to the agent's soft→hard stop sequencing (§2). */
const STOP_GRACE_MS = 5_000;

// ---------------------------------------------------------------------------
// Settings resolution (§3 precedence: setting > env > default)
// ---------------------------------------------------------------------------

export interface LlamacppResolvedConfig {
  /** Absolute path to llama-server; null when unconfigured (NO default). */
  exePath: string | null;
  /** Absolute models directory; null when unconfigured (NO default). */
  modelsDir: string | null;
  port: number;
  /** Idle unload minutes; 0 disables the sweep for this user. */
  idleUnloadMinutes: number;
  /** Canonical bag ⊕ validated `llamacpp_load_defaults` row. */
  knobs: LlamacppKnobs;
  /** Validated `llamacpp_model_overrides` rows (invalid entries dropped). */
  overrides: Record<string, LlamacppKnobOverrides>;
  /**
   * Validated `llamacpp_presets` slots as STORED (partials; missing keys fall
   * through to the lower merge layer). Absent/corrupt rows ⇒ the §3 canonical
   * presets (corrupt additionally warns).
   */
  presets: LlamacppPresetsRow;
  /** Resolved active-preset pointer (invalid stored value ⇒ 'equilibrado' + warn). */
  activePreset: LlamacppPresetId;
  /** Resolved `llamacpp_sampling` row (corrupt ⇒ canonical defaults + warn). */
  sampling: LlamacppSampling;
  /**
   * §10 Increment 2d — validated `llamacpp_model_sampling` rows AS STORED
   * (absent row ⇒ {}; corrupt ⇒ {} + warn).
   */
  modelSampling: Record<string, LlamacppSamplingOverride>;
}

function readSetting(userId: string, key: string): string {
  try {
    return getSettingValue(userId, key).trim();
  } catch {
    return ''; // fail soft to env/default like every other provider read
  }
}

function envValue(key: string): string | undefined {
  const raw = process.env[key]?.trim();
  return raw ? raw : undefined;
}

function scalarOr(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

/** Parses one JSON settings row; null when absent/unparseable (caller warns). */
function parseJsonRow(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function warnOnce(message: string): void {
  console.warn(`[llamacppTransport] ${message}`);
}

/**
 * Resolves the `llamacpp_presets` row (§3 Increment 2). Absent row ⇒ the
 * canonical presets silently (nothing stored yet); corrupt/invalid row ⇒
 * canonical + warn, never throws. Validated slots are exposed AS STORED —
 * missing keys fall through to the lower merge layer at spawn time.
 */
function resolvePresetsRow(userId: string): LlamacppPresetsRow {
  const raw = parseJsonRow(readSetting(userId, 'llamacpp_presets'));
  if (raw === null) return structuredCanonicalPresets();
  if (raw === undefined) {
    warnOnce('corrupt llamacpp_presets setting ignored; using canonical presets.');
    return structuredCanonicalPresets();
  }
  const parsed = LLAMACPP_PRESETS_ROW_SCHEMA.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  warnOnce(
    `invalid llamacpp_presets ignored (${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'schema mismatch'}); using canonical presets.`,
  );
  return structuredCanonicalPresets();
}

function structuredCanonicalPresets(): LlamacppPresetsRow {
  return {
    rapido: { ...LLAMACPP_CANONICAL_PRESETS.rapido },
    equilibrado: { ...LLAMACPP_CANONICAL_PRESETS.equilibrado },
    profundo: { ...LLAMACPP_CANONICAL_PRESETS.profundo },
  };
}

/** Resolves the `llamacpp_active_preset` scalar; invalid ⇒ 'equilibrado' + warn. */
function resolveActivePreset(userId: string): LlamacppPresetId {
  const raw = readSetting(userId, 'llamacpp_active_preset');
  if (!raw) return LLAMACPP_ACTIVE_PRESET_DEFAULT;
  const parsed = LLAMACPP_ACTIVE_PRESET_SCHEMA.safeParse(raw);
  if (parsed.success) return parsed.data;
  warnOnce(`invalid llamacpp_active_preset "${raw}" ignored; using "${LLAMACPP_ACTIVE_PRESET_DEFAULT}".`);
  return LLAMACPP_ACTIVE_PRESET_DEFAULT;
}

/**
 * Resolves the `llamacpp_sampling` row (§3 Increment 2). Absent row ⇒ the
 * canonical defaults silently; corrupt/invalid row ⇒ canonical + warn,
 * never throws. INDEPENDENT of presets (identical across all three by spec).
 */
function resolveSamplingRow(userId: string): LlamacppSampling {
  const raw = parseJsonRow(readSetting(userId, 'llamacpp_sampling'));
  if (raw === null) return { ...LLAMACPP_SAMPLING_DEFAULTS };
  if (raw === undefined) {
    warnOnce('corrupt llamacpp_sampling setting ignored; using canonical sampling defaults.');
    return { ...LLAMACPP_SAMPLING_DEFAULTS };
  }
  const parsed = LLAMACPP_SAMPLING_ROW_SCHEMA.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  warnOnce(
    `invalid llamacpp_sampling ignored (${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'schema mismatch'}); using canonical sampling defaults.`,
  );
  return { ...LLAMACPP_SAMPLING_DEFAULTS };
}

/**
 * Resolves the `llamacpp_model_sampling` row (§10 Increment 2d): validated
 * per-model sampling partials exposed AS STORED. Absent row ⇒ {} SILENTLY;
 * corrupt/schema-invalid row ⇒ {} + warn (repair-to-empty, mirroring the
 * `llamacpp_model_overrides` discipline), never throws.
 */
function resolveModelSamplingRow(userId: string): Record<string, LlamacppSamplingOverride> {
  const raw = parseJsonRow(readSetting(userId, 'llamacpp_model_sampling'));
  if (raw === null) return {};
  if (raw === undefined) {
    warnOnce('corrupt llamacpp_model_sampling setting ignored; treating as empty.');
    return {};
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warnOnce('invalid llamacpp_model_sampling ignored (not an object); treating as empty.');
    return {};
  }
  const parsed = LLAMACPP_MODEL_SAMPLING_ROW_SCHEMA.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  warnOnce(
    `invalid llamacpp_model_sampling ignored (${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'schema mismatch'}); treating as empty.`,
  );
  return {};
}

export function resolveLlamacppConfig(userId: string): LlamacppResolvedConfig {
  const exePath = readSetting(userId, 'llamacpp_exe_path')
    || envValue('LLAMACPP_EXE_PATH')
    || null;
  const modelsDir = readSetting(userId, 'llamacpp_models_dir')
    || envValue('LLAMACPP_MODELS_DIR')
    || null;
  const port = scalarOr(
    readSetting(userId, 'llamacpp_port') || envValue('LLAMACPP_PORT'),
    DEFAULT_PORT,
    1,
    65_535,
  );
  const idleUnloadMinutes = scalarOr(
    readSetting(userId, 'llamacpp_idle_unload_minutes') || envValue('LLAMACPP_IDLE_UNLOAD_MINUTES'),
    DEFAULT_IDLE_UNLOAD_MINUTES,
    0,
    1_000_000_000,
  );

  // Global knob row: validated as a whole (§3 — corrupt/partially-invalid
  // rows ⇒ canonical defaults + console.warn, never throw).
  let knobs: LlamacppKnobs = { ...LLAMACPP_DEFAULT_KNOBS };
  const knobsRaw = parseJsonRow(readSetting(userId, 'llamacpp_load_defaults'));
  if (knobsRaw === undefined) {
    warnOnce('corrupt llamacpp_load_defaults setting ignored; using canonical defaults.');
  } else if (knobsRaw !== null) {
    const parsed = parseKnobs(knobsRaw);
    if (parsed.ok) knobs = mergeKnobLayers(knobs, parsed.knobs);
    else warnOnce(`invalid llamacpp_load_defaults ignored (${parsed.error}); using canonical defaults.`);
  }

  // Per-model overrides row: validated as a whole (Record<modelKey, partial>);
  // corruption or any invalid entry ⇒ {} + warn, never throw.
  let overrides: Record<string, LlamacppKnobOverrides> = {};
  const overridesRaw = parseJsonRow(readSetting(userId, 'llamacpp_model_overrides'));
  if (overridesRaw === undefined) {
    warnOnce('corrupt llamacpp_model_overrides setting ignored; treating as empty.');
  } else if (overridesRaw !== null && typeof overridesRaw === 'object' && !Array.isArray(overridesRaw)) {
    const parsed = LLAMACPP_MODEL_OVERRIDES_ROW_SCHEMA.safeParse(overridesRaw);
    if (parsed.success) {
      overrides = parsed.data;
    } else {
      const issue = parsed.error.issues[0];
      warnOnce(`invalid llamacpp_model_overrides ignored (${issue?.message ?? 'schema mismatch'}); treating as empty.`);
    }
  }

  // §3 Increment 2 rows: preset slots, the active pointer and the independent
  // sampling row — same fail-soft repair discipline, never throw. §10
  // Increment 2d adds the per-model sampling rows (absent ⇒ {}, corrupt ⇒
  // {} + warn).
  const presets = resolvePresetsRow(userId);
  const activePreset = resolveActivePreset(userId);
  const sampling = resolveSamplingRow(userId);
  const modelSampling = resolveModelSamplingRow(userId);

  return { exePath, modelsDir, port, idleUnloadMinutes, knobs, overrides, presets, activePreset, sampling, modelSampling };
}

/**
 * §10 shared sampling resolver family — THE single source consumed by chat.ts
 * AND councilExecutor.ts alike; no asymmetric per-consumer branch is permitted.
 *
 * Resolution v3 (Increment 2d): global `llamacpp_sampling` row ⊕
 * `llamacpp_model_sampling[modelKey]` (per-key override; keys absent from the
 * model layer keep their global value). A null/undefined modelKey, or a model
 * with no stored layer, resolves to the global row verbatim. Corrupt rows
 * follow the ratified warn+repair discipline inside the row resolvers.
 *
 * Increment 2d note: the former global-only `resolveLlamacppSampling(userId)`
 * export was folded into THIS family — both injection sites name their already-
 * resolved upstream model key explicitly, so no separate global-only resolver
 * remains.
 */
export function resolveLlamacppSamplingForModel(
  userId: string,
  modelKey: string | null | undefined,
): LlamacppSampling {
  const base = resolveSamplingRow(userId);
  if (!modelKey) return base;
  const layer = resolveModelSamplingRow(userId)[modelKey];
  if (!layer) return base;
  return mergeSamplingLayers(base, layer);
}

// ---------------------------------------------------------------------------
// Capability gate (§2 — fires in EVERY entry point)
// ---------------------------------------------------------------------------

function hasLlamacppCapability(userId: string): boolean {
  return getAgentCapabilities(userId)?.includes(LLAMACPP_CAPABILITY) ?? false;
}

// ---------------------------------------------------------------------------
// Probe + transport selection (§7)
// ---------------------------------------------------------------------------

export interface LlamacppProbe {
  reachable: boolean;
  transport: 'direct' | 'relay' | null;
  agentConnected: boolean;
  capabilitySupported: boolean;
  /** Present when the resolved port was refused by the §7 allowlist before sending. */
  blockedReason?: string;
}

const probeCache = new Map<string, { probe: LlamacppProbe; timestamp: number }>();

export async function probeLlamacpp(
  userId: string,
  opts: { force?: boolean; /** Test seam: deterministic cache-clock (runXSweep idiom). */ nowMs?: number } = {},
): Promise<LlamacppProbe> {
  const now = opts.nowMs ?? Date.now();
  if (!opts.force) {
    const hit = probeCache.get(userId);
    if (hit && now - hit.timestamp < PROBE_CACHE_TTL_MS) return hit.probe;
  }
  const probe = await computeProbe(userId);
  probeCache.set(userId, { probe, timestamp: Date.now() });
  return probe;
}

async function computeProbe(userId: string): Promise<LlamacppProbe> {
  const config = resolveLlamacppConfig(userId);
  const agentConnected = isAgentConnected(userId);
  const capabilitySupported = hasLlamacppCapability(userId);
  const healthUrl = `http://127.0.0.1:${config.port}/health`;

  // 1) Direct loopback reachability (≤1.5 s; never proxies through the agent).
  try {
    const direct = await fetch(healthUrl, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (direct.ok) {
      return { reachable: true, transport: 'direct', agentConnected, capabilitySupported };
    }
  } catch {
    // fall through to relay probing
  }

  // 2) Relay through the paired local agent — gated on the declared
  //    capability FIRST, then the SSRF allowlist BEFORE any send (§7).
  if (!agentConnected || !capabilitySupported) {
    return { reachable: false, transport: null, agentConnected, capabilitySupported };
  }
  const verdict = isRelayUrlAllowed(healthUrl, buildEffectiveAllowlist(config.port));
  if (!verdict.allowed) {
    return {
      reachable: false,
      transport: null,
      agentConnected,
      capabilitySupported,
      blockedReason: verdict.reason,
    };
  }
  // A dead-but-connected agent degrades to "unreachable", never throws.
  try {
    const { result } = await relayExchange(userId, config.port, { path: '/health', timeoutMs: PROBE_TIMEOUT_MS });
    if (result.ok && result.status === 200) {
      return { reachable: true, transport: 'relay', agentConnected, capabilitySupported };
    }
  } catch {
    // fall through to unreachable
  }
  return { reachable: false, transport: null, agentConnected, capabilitySupported };
}

// ---------------------------------------------------------------------------
// Relay streaming core (reuses the generic http_proxy_* machinery AS-IS; §2)
// ---------------------------------------------------------------------------

interface RelayExchangeInit {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal | null;
}

interface RelayStreamHandle {
  requestId: string;
  stream: ReadableStream<Uint8Array>;
  /** Resolves with the terminal frame, or rejects on abort/disconnect/timeout before it. */
  terminal: Promise<HttpProxyResult>;
  /**
   * T9 exchange shape — resolves 'streamed' once a body byte has flowed with
   * the terminal still outstanding past the grace window (the upstream
   * committed to a streamed body), or 'buffered' when the terminal settles
   * first / within the window of the byte burst (the whole exchange is
   * describable by its terminal frame). Never rejects.
   */
  shape: Promise<'streamed' | 'buffered'>;
}

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'error' in error) {
    const message = (error as { error?: unknown }).error;
    if (typeof message === 'string') return message;
  }
  return error instanceof Error ? error.message : String(error);
}

function relayUrl(port: number, path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

function relayStream(
  userId: string,
  port: number,
  path: string,
  init: RelayExchangeInit,
): RelayStreamHandle {
  const url = relayUrl(port, path);
  const requestId = `http_proxy_${nanoid()}`;

  // T9 shape signal (see RelayStreamHandle). Never rejects; EVERY exit path
  // below resolves it exactly once so llamacppFetch can never hang on it.
  let resolveShape!: (shape: 'streamed' | 'buffered') => void;
  const shape = new Promise<'streamed' | 'buffered'>((resolve) => {
    resolveShape = resolve;
  });
  let sawBodyByte = false;
  /** Set SYNCHRONOUSLY when the terminal promise settles (resolve OR reject). */
  let terminalSettled = false;

  // F3-02 / §7 choke point: EVERY outbound relay request re-checks the
  // effective allowlist immediately before send — a cached probe verdict may
  // be up to ~10 s stale when settings change mid-window. Refusal mirrors a
  // status-0 transport failure so every caller maps it to today's explanatory
  // failure shape (502 JSON / degraded payload) with no frame on the wire.
  const sendVerdict = isRelayUrlAllowed(url, buildEffectiveAllowlist(port));
  if (!sendVerdict.allowed) {
    console.warn(`[llamacppTransport] relay request blocked by allowlist (${url}): ${sendVerdict.reason}`);
    const blocked: HttpProxyResult = {
      ok: false,
      status: 0,
      error: `blocked by relay allowlist: ${sendVerdict.reason}`,
    };
    return {
      requestId,
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error(blocked.error));
        },
      }),
      terminal: Promise.resolve(blocked),
      shape: Promise.resolve('buffered'),
    };
  }

  const method = init.method ?? 'GET';
  const body = init.body ?? null;
  const timeoutMs = init.timeoutMs ?? DEFAULT_RELAY_REQUEST_TIMEOUT_MS;
  const headers = { 'Content-Type': 'application/json', ...(init.headers ?? {}) };
  const external = init.signal ?? null;
  const encoder = new TextEncoder();

  let resolveTerminal!: (result: HttpProxyResult) => void;
  let rejectTerminal!: (error: Error) => void;
  const terminal = new Promise<HttpProxyResult>((resolve, reject) => {
    resolveTerminal = (result) => {
      terminalSettled = true;
      resolve(result);
    };
    rejectTerminal = (error) => {
      terminalSettled = true;
      reject(error);
    };
  });

  let settled = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  const detach = () => {
    try {
      external?.removeEventListener('abort', onExternalAbort);
    } catch {
      /* noop */
    }
  };
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    rejectTerminal(error);
    try {
      controllerRef?.error(error);
    } catch {
      /* stream already closed */
    }
    // No byte ever flowed ⇒ the caller is still awaiting the shape; send it
    // down the terminal-led path, whose `await handle.terminal` re-raises
    // this same rejection (pre-T9 observable shape).
    if (!sawBodyByte) resolveShape('buffered');
    detach();
  };
  const onExternalAbort = () => {
    fail(abortError());
    // Best-effort cancel toward the agent; ignored if the pending already ended.
    cancelHttpProxyRequest(userId, requestId);
  };

  if (external?.aborted) {
    const error = abortError();
    settled = true;
    rejectTerminal(error);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(error);
      },
    });
    return { requestId, terminal, shape: Promise.resolve('buffered'), stream };
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controllerRef = controller;
      external?.addEventListener('abort', onExternalAbort, { once: true });
      let result: HttpProxyResult;
      try {
        result = await sendHttpProxyRequest(
          userId,
          requestId,
          { url, method, headers, body, timeoutMs },
          (text) => {
            if (!sawBodyByte) {
              sawBodyByte = true;
              // T9: decide the exchange shape after a short grace window. A
              // buffered body arrives as chunk(s)+terminal in ONE burst (the
              // terminal wins ⇒ keep today's terminal-led status/error
              // mapping); a genuinely streamed body leaves the terminal
              // outstanding well past the window.
              setTimeout(
                () => resolveShape(terminalSettled ? 'buffered' : 'streamed'),
                RELAY_SHAPE_GRACE_MS,
              );
            }
            try {
              controller.enqueue(encoder.encode(text));
            } catch {
              /* stream already closed or errored */
            }
          },
        );
      } catch (err) {
        fail(new Error(errorMessage(err)));
        return;
      }
      if (settled) return; // an abort raced ahead; keep its rejection authoritative
      settled = true;
      resolveTerminal(result);
      detach();
      if (sawBodyByte && result.status === 0) {
        // T9: the body already streamed past the grace window, so the caller
        // holds a 200/SSE Response; map the relay-level failure — what the
        // buffered path reports as explanatory 502 JSON — onto the body
        // itself (documented mid-stream failure semantic).
        try {
          controller.error(new Error(result.error ?? 'llama.cpp request failed through the local-agent relay.'));
        } catch {
          /* stream already closed or errored */
        }
        return;
      }
      if (!sawBodyByte) resolveShape('buffered');
      try {
        controller.close();
      } catch {
        /* already errored */
      }
    },
    cancel() {
      // Consumer tore down the body early: tell the agent to stop fetching.
      cancelHttpProxyRequest(userId, requestId);
    },
  });

  return { requestId, terminal, shape, stream };
}

interface BufferedExchange {
  result: HttpProxyResult;
  text: string;
}

async function relayExchange(
  userId: string,
  port: number,
  init: RelayExchangeInit & { path: string },
): Promise<BufferedExchange> {
  const handle = relayStream(userId, port, init.path, init);
  const decoder = new TextDecoder();
  let text = '';
  const drainStarted = (async () => {
    const reader = handle.stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  })();
  // F3-01: attach the safety catch IMMEDIATELY at creation — when the terminal
  // promise rejects below (disconnect/timeout/abort), a pending reader.read()
  // rejects too, and an orphaned drain promise would be a process-fatal
  // unhandled rejection.
  void drainStarted.catch(() => undefined);
  const result = await handle.terminal;
  await drainStarted.catch(() => undefined);
  return { result, text };
}

// ---------------------------------------------------------------------------
// Usage tracking (global-constraints §8 — zero chat.ts accounting edits)
//
// Keyed `${userId}\u0000${modelKey}`. Stamped at exactly two places:
//   1. `ensureLlamacppRunning` success (chat.ts's pre-flight at stream start);
//   2. `llamacppFetch` when path === INFERENCE_PATH and OUR OWN outbound
//      `init.body` carries a model id.
// An in-flight counter per entry blocks idle eviction while a stream lives.
// ---------------------------------------------------------------------------

interface UsageEntry {
  lastUsedAt: number;
  /** Live streams consuming this model; > 0 blocks idle eviction. */
  inFlight: number;
}

const usageTracking = new Map<string, UsageEntry>();

function usageTrackingKey(userId: string, modelKey: string): string {
  return `${userId}\u0000${modelKey}`;
}

function stampLlamacppUsage(userId: string, modelKey: string): void {
  const key = usageTrackingKey(userId, modelKey);
  const entry = usageTracking.get(key);
  if (entry) entry.lastUsedAt = Date.now();
  else usageTracking.set(key, { lastUsedAt: Date.now(), inFlight: 0 });
}

/** Test/observability seam: snapshot of the usage-tracking map. */
export function getLlamacppUsageSnapshot(): Array<{
  userId: string;
  modelKey: string;
  lastUsedAt: number;
  inFlight: number;
}> {
  return [...usageTracking.entries()].map(([key, entry]) => ({
    userId: key.split('\u0000')[0],
    modelKey: key.slice(key.indexOf('\u0000') + 1),
    lastUsedAt: entry.lastUsedAt,
    inFlight: entry.inFlight,
  }));
}

function forgetAllUsage(userId: string): void {
  const prefix = `${userId}\u0000`;
  for (const key of [...usageTracking.keys()]) {
    if (key.startsWith(prefix)) usageTracking.delete(key);
  }
}

/**
 * Stamps last-use and raises the in-flight counter; returns an idempotent
 * releaser that lowers it exactly once.
 */
function beginLlamacppInference(userId: string, modelKey: string): () => void {
  const key = usageTrackingKey(userId, modelKey);
  let entry = usageTracking.get(key);
  if (!entry) {
    entry = { lastUsedAt: Date.now(), inFlight: 0 };
    usageTracking.set(key, entry);
  }
  entry.lastUsedAt = Date.now();
  entry.inFlight += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = usageTracking.get(key);
    if (!current) return;
    current.inFlight = Math.max(0, current.inFlight - 1);
  };
}

/**
 * Model id carried by OUR OWN outbound chat-completions body (chat.ts builds
 * it via JSON.stringify from requestBody.model — never model output or tool
 * arguments). Null for anything that is not a POST with a non-empty model.
 */
function inferenceTargetFromInit(method: string, body: string | null): string | null {
  if (method !== 'POST') return null;
  if (typeof body !== 'string' || body.length === 0) return null;
  try {
    const model = (JSON.parse(body) as { model?: unknown } | null)?.model;
    return typeof model === 'string' && model.trim() ? model : null;
  } catch {
    return null;
  }
}

/**
 * Wraps a direct-transport Response body in a passthrough stream that releases
 * the in-flight counter when the body fully closes, errors, or is cancelled —
 * `.getReader()/.text()/.json()` observability is preserved verbatim because
 * the wrapper is an ordinary ReadableStream of the same chunks.
 */
function trackDirectResponseBody(response: Response, release: () => void): Response {
  const body = response.body;
  if (!body) {
    release();
    return response;
  }
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    release();
  };
  const reader = body.getReader();
  const trackedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          releaseOnce(); // body fully closed
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        releaseOnce(); // body errored
        controller.error(err instanceof Error ? err : new Error(String(err)));
      }
    },
    cancel(reason) {
      releaseOnce(); // consumer tore the body down early
      return reader.cancel(reason);
    },
  });
  return new Response(trackedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

// ---------------------------------------------------------------------------
// Public fetch seam (transport auto-select per call, §7)
// ---------------------------------------------------------------------------

function headerRecord(init?: HeadersInit): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  new Headers(init ?? undefined).forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function llamacppFetch(
  userId: string,
  path: string,
  init: RequestInit & { body?: string | null } = {},
): Promise<Response> {
  if (!path.startsWith('/')) {
    throw new Error(`llamacppFetch path must begin with '/': got "${path}"`);
  }
  const probe = await probeLlamacpp(userId);
  const config = resolveLlamacppConfig(userId);

  const method: 'GET' | 'POST' = (init.method ?? 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
  const body = typeof init.body === 'string' ? init.body : null;
  const headers = headerRecord(init.headers);
  const signal = init.signal ?? null;

  // §8 usage signal: ONLY real inference traffic stamps/counts. Management
  // calls ride buffered exchanges / scan frames and never match this seam.
  const inferenceModel = path === INFERENCE_PATH ? inferenceTargetFromInit(method, body) : null;
  const releaseInFlight = inferenceModel !== null ? beginLlamacppInference(userId, inferenceModel) : null;

  if (probe.transport === 'direct') {
    try {
      const response = await fetch(relayUrl(config.port, path), {
        method,
        headers,
        body,
        signal: signal ?? undefined,
      });
      if (!releaseInFlight) return response;
      return trackDirectResponseBody(response, releaseInFlight);
    } catch (err) {
      releaseInFlight?.(); // fetch-level failure lowers the counter too
      throw err;
    }
  }

  if (probe.transport === 'relay') {
    const url = relayUrl(config.port, path);
    const verdict = isRelayUrlAllowed(url, buildEffectiveAllowlist(config.port));
    if (!verdict.allowed) {
      console.warn(`[llamacppTransport] relay fetch blocked by allowlist (${url}): ${verdict.reason}`);
      releaseInFlight?.();
      return jsonResponse(502, {
        error: 'llama.cpp target is not allowed through the local-agent relay.',
        reason: verdict.reason,
      });
    }
    const handle = relayStream(userId, config.port, path, { method, headers, body, signal });
    if (releaseInFlight) {
      // §8 relay hook (unchanged by T9): every chunk precedes the terminal
      // frame, so terminal settlement — resolve OR reject — IS the
      // body-close event for this transport. Cancel/abort paths always end
      // in a settlement or rejection, so the counter can never leak.
      void handle.terminal.then(
        () => undefined,
        () => undefined,
      ).then(() => releaseInFlight());
    }
    // T9 streaming gate: wait only for the exchange SHAPE, never blindly for
    // the terminal. A streamed body hands its Response over at first byte
    // (+ grace window) so the SSE writer reads progressively; a terminal-led
    // (buffered) exchange keeps today's exact mappings below.
    const shape = await handle.shape;
    if (shape === 'buffered') {
      // Rejects here when the relay failed before/at the terminal frame
      // without a streamed body (disconnect, timeout, abort) — same
      // observable shape as a failed upstream fetch.
      const result = await handle.terminal;
      if (result.status === 0) {
        return jsonResponse(502, {
          error: result.error ?? 'llama.cpp request failed through the local-agent relay.',
        });
      }
      return new Response(handle.stream, {
        status: result.status,
        headers: { 'content-type': result.contentType ?? 'application/octet-stream' },
      });
    }
    // Streamed: both callers are POST /v1/chat/completions SSE readers, so a
    // body-led exchange is 200 text/event-stream by construction (INFERENCE_
    // PATH). A later status-0 terminal is mapped to a readable-stream error
    // inside relayStream (the buffered path's 502 analog); an ok:false
    // terminal carrying the real upstream status still ends the body exactly
    // as the buffered path did (clean close after the partial bytes).
    return new Response(handle.stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  releaseInFlight?.();
  return jsonResponse(502, {
    error: probe.blockedReason
      ? 'llama.cpp target is not allowed through the local-agent relay.'
      : 'llama.cpp is not reachable.',
    ...(probe.blockedReason ? { reason: probe.blockedReason } : {}),
  });
}

// ---------------------------------------------------------------------------
// Model discovery (scan frame → shard collapse → 30 s cache; §5)
// ---------------------------------------------------------------------------

interface ScanResponsePayload {
  ok: boolean;
  error?: string;
  entries?: Array<{ path: string; name: string; sizeBytes?: number }>;
  truncated?: boolean;
  [key: string]: unknown;
}

const catalogCache = new Map<string, { entries: LlamacppModelEntry[]; timestamp: number }>();

export async function listLlamacppModels(
  userId: string,
  opts: { force?: boolean; nowMs?: number } = {},
): Promise<Array<LlamacppModelEntry>> {
  if (!hasLlamacppCapability(userId)) {
    throw new Error(LLAMACPP_CAPABILITY_ERROR);
  }
  const config = resolveLlamacppConfig(userId);
  if (!config.modelsDir) {
    throw new Error('llama.cpp models directory is not configured (set llamacpp_models_dir or LLAMACPP_MODELS_DIR).');
  }

  const now = opts.nowMs ?? Date.now();
  if (!opts.force) {
    const hit = catalogCache.get(userId);
    if (hit && now - hit.timestamp < MODEL_CATALOG_CACHE_TTL_MS) return hit.entries;
  }

  const response = await sendLlamacppFrame<ScanResponsePayload>(
    userId,
    { type: 'llamacpp_scan_request', requestId: newRequestId(), dir: config.modelsDir },
    SCAN_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new Error(response.error ?? 'Scanning the llama.cpp models directory failed.');
  }
  // Server-side shard collapse (§2: the agent lists raw files only).
  const entries = collapseShardEntries(response.entries ?? []).slice(0, MODEL_CATALOG_MAX_ENTRIES);
  catalogCache.set(userId, { entries, timestamp: Date.now() });
  return entries;
}

// ---------------------------------------------------------------------------
// Lifecycle: status / ensure / stop / last-launch bookkeeping (§5/§8)
// ---------------------------------------------------------------------------

interface AgentStatusPayload {
  running: boolean;
  pid?: number | null;
  exePath?: string | null;
  args?: string[] | null;
  host?: string;
  port?: number | null;
  startedAt?: number | null;
  lastExitCode?: number | null;
  lastExitAt?: number | null;
  [key: string]: unknown;
}

/** Locally tracked child state — reconciled via status frames; updated by exit pushes. */
interface TrackedChild {
  running: boolean;
  pid: number | null;
  port: number | null;
  modelKey: string | null;
  modelPath: string | null;
  argv: string[] | null;
  startedAt: number | null;
  lastExitCode: number | null;
  lastExitAt: number | null;
}

const trackedChildren = new Map<string, TrackedChild>();
const lastLaunchByUser = new Map<string, { argv: string[]; modelKey: string }>();

function newRequestId(): string {
  return `llamacpp_${nanoid()}`;
}

/**
 * Thin wrapper around the task-1 sender: converts its `{error}` rejections
 * (disconnect/timeout/duplicate) into Errors so the total (never-throw)
 * service entry points can catch uniformly.
 */
async function sendLlamacppFrame<T extends Record<string, unknown>>(
  userId: string,
  request: Extract<Parameters<typeof sendLlamacppRequest>[1], { requestId: string }>,
  timeoutMs: number,
): Promise<T> {
  try {
    return await sendLlamacppRequest<T>(userId, request, timeoutMs);
  } catch (err) {
    throw new Error(errorMessage(err));
  }
}

async function requestTrackedStatus(userId: string): Promise<AgentStatusPayload> {
  return sendLlamacppFrame<AgentStatusPayload>(
    userId,
    { type: 'llamacpp_status_request', requestId: newRequestId() },
    STATUS_TIMEOUT_MS,
  );
}

function valueAfterFlag(args: string[] | null | undefined, flag: string): string | null {
  if (!args) return null;
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

function mtpActiveInArgs(args: string[] | null | undefined): boolean {
  if (!args) return false;
  const index = args.indexOf('--spec-type');
  return index >= 0 && args[index + 1] === 'draft-mtp';
}

/**
 * §5 Increment 2 amendment — computed `pendingRestart`: true iff the child is
 * running AND the argv `ensureLlamacppRunning` would spawn NOW differs from
 * the running child's actual args. The candidate is derived from PERSISTED
 * settings ONLY (defaults ⊕ active preset ⊕ per-model override; request-level
 * overrides are excluded because they are not persisted) over the running
 * args' own --model/--alias values, the resolved port, and an mtpCapable flag
 * read from the model path's BASENAME split on BOTH '/' and '\' (paths
 * originate on the agent host OS). No agent scan frame is issued.
 *
 * Accepted bias (R-pendingrestart-fp): a start issued with ad-hoc request
 * overrides, or a corrupt-row repair, makes candidate ≠ spawned argv and the
 * chip reads TRUE until the next persisted-settings spawn — honest by design.
 * Argv-only comparison: an exe-path/models-dir change while running does NOT
 * raise the chip; /status's exePath field stays the truth surface there.
 */
export function computePendingRestart(opts: {
  running: boolean;
  runningArgs: string[] | null;
  config: LlamacppResolvedConfig;
}): boolean {
  if (!opts.running) return false;
  const runningArgs = opts.runningArgs;
  if (!runningArgs || runningArgs.length === 0) return false;
  const modelPath = valueAfterFlag(runningArgs, '--model');
  const modelKey = valueAfterFlag(runningArgs, '--alias');
  if (!modelPath || !modelKey) return false; // unknown argv ⇒ false
  const basename = modelPath.split(/[/\\]/).pop() ?? '';
  const mtpCapable = /mtp/i.test(basename);
  const knobs = mergeKnobLayers(
    opts.config.knobs,
    opts.config.presets[opts.config.activePreset],
    opts.config.overrides[modelKey],
  );
  const candidate = buildLlamaServerArgv({ modelPath, modelKey, port: opts.config.port, knobs, mtpCapable }).args;
  return candidate.length !== runningArgs.length || candidate.some((arg, index) => arg !== runningArgs[index]);
}

function syncTrackedFromStatus(userId: string, status: AgentStatusPayload): TrackedChild {
  const previous = trackedChildren.get(userId);
  const child: TrackedChild = {
    running: status.running,
    pid: status.pid ?? null,
    port: status.port ?? null,
    modelPath: valueAfterFlag(status.args, '--model') ?? (status.running ? previous?.modelPath ?? null : null),
    modelKey: valueAfterFlag(status.args, '--alias') ?? (status.running ? previous?.modelKey ?? null : null),
    argv: status.args ?? null,
    startedAt: status.startedAt ?? null,
    lastExitCode: status.lastExitCode ?? null,
    lastExitAt: status.lastExitAt ?? null,
  };
  trackedChildren.set(userId, child);
  return child;
}

function statusPayloadFromTracked(
  userId: string,
  agentConnected: boolean,
  capabilitySupported: boolean,
): {
  agentConnected: boolean;
  capabilitySupported: boolean;
  running: boolean;
  pid: number | null;
  modelPath: string | null;
  modelKey: string | null;
  port: number | null;
  transport: 'direct' | 'relay' | null;
  healthy: boolean | null;
  startedAt: number | null;
  lastExitCode: number | null;
  argv: string[] | null;
  mtpActive: boolean;
  pendingRestart: boolean;
} {
  const tracked = trackedChildren.get(userId);
  return {
    agentConnected,
    capabilitySupported,
    running: tracked?.running ?? false,
    pid: tracked?.pid ?? null,
    modelPath: tracked?.modelPath ?? null,
    modelKey: tracked?.modelKey ?? null,
    port: tracked?.port ?? null,
    transport: null,
    healthy: null,
    startedAt: tracked?.startedAt ?? null,
    lastExitCode: tracked?.lastExitCode ?? null,
    argv: tracked?.argv ?? null,
    mtpActive: mtpActiveInArgs(tracked?.argv),
    pendingRestart: computePendingRestart({
      running: tracked?.running ?? false,
      runningArgs: tracked?.argv ?? null,
      config: resolveLlamacppConfig(userId),
    }),
  };
}

export interface LlamacppStatusPayload {
  agentConnected: boolean;
  capabilitySupported: boolean;
  running: boolean;
  pid: number | null;
  modelPath: string | null;
  modelKey: string | null;
  port: number | null;
  transport: 'direct' | 'relay' | null;
  healthy: boolean | null;
  startedAt: number | null;
  lastExitCode: number | null;
  argv: string[] | null;
  mtpActive: boolean;
  pendingRestart: boolean;
}

/**
 * NEVER-THROWS §5 status payload. When the agent is connected and capable the
 * truth is re-synced from a `llamacpp_status_request` (§8: stale local state
 * is never trusted); otherwise the locally tracked state (exit pushes included)
 * is reported with transport/healthy null.
 */
export async function getLlamacppStatus(userId: string): Promise<LlamacppStatusPayload> {
  const agentConnected = isAgentConnected(userId);
  const capabilitySupported = hasLlamacppCapability(userId);
  if (!agentConnected || !capabilitySupported) {
    return statusPayloadFromTracked(userId, agentConnected, capabilitySupported);
  }
  try {
    const status = await requestTrackedStatus(userId);
    const child = syncTrackedFromStatus(userId, status);
    let transport: 'direct' | 'relay' | null = null;
    let healthy: boolean | null = null;
    try {
      const probe = await probeLlamacpp(userId);
      transport = probe.transport;
      healthy = status.running ? probe.reachable : null;
    } catch {
      // probe failures degrade to null observability, never throw
    }
    return {
      agentConnected,
      capabilitySupported,
      running: status.running,
      pid: status.pid ?? null,
      modelPath: valueAfterFlag(status.args, '--model'),
      modelKey: valueAfterFlag(status.args, '--alias'),
      port: status.port ?? null,
      transport,
      healthy,
      startedAt: status.startedAt ?? null,
      lastExitCode: status.lastExitCode ?? null,
      argv: status.args ?? null,
      mtpActive: mtpActiveInArgs(status.args),
      pendingRestart: computePendingRestart({
        running: status.running,
        runningArgs: status.args ?? null,
        config: resolveLlamacppConfig(userId),
      }),
    };
  } catch {
    // Status frame lost (timeout/disconnect race): tracked state is the best answer.
    return statusPayloadFromTracked(userId, agentConnected, capabilitySupported);
  }
}

/** Last successfully launched child for the routes' diagnostics; null otherwise. */
export function getLastLaunchArgs(userId: string): { argv: string[]; modelKey: string } | null {
  return lastLaunchByUser.get(userId) ?? null;
}

export interface EnsureLlamacppResult {
  running: boolean;
  mode: 'already' | 'started' | 'swapped' | 'failed';
  pid?: number;
  argv?: string[];
  port?: number;
  error?: string;
}

/**
 * Transport-aware readiness wait (§5 "polls /health until 200", §7).
 *
 * The spawned child binds loopback on the AGENT's machine, so when the backend
 * is remote (Railway + paired agent) the backend's OWN 127.0.0.1 can never
 * answer. Each tick therefore tries the direct loopback first and — once a
 * direct attempt has failed at SOCKET level while a capable agent is paired —
 * keeps polling GET /health through the SAME seam llamacppFetch rides
 * (`relayExchange` → http_proxy frames against the resolved port, whose
 * effective allowlist always contains it). A direct transport-level failure
 * only latches while the relay stays viable; if the agent vanishes mid-wait,
 * polling falls back to direct until the budget expires.
 *
 * Per-attempt ceilings (HEALTH_PROBE_TIMEOUT_MS) keep every try inside the
 * overall ≥120 s budget; the function is total and never throws.
 */
async function pollHealth(userId: string, port: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, budgetMs);
  const url = relayUrl(port, '/health');
  /** Latched on the first socket-level direct failure: the backend's own loopback cannot see the child. */
  let directUnreachable = false;
  for (;;) {
    const relayViable = isAgentConnected(userId) && hasLlamacppCapability(userId);
    if (!directUnreachable || !relayViable) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS) });
        if (response.ok) return true; // 200 {"status":"ok"} — 503 keeps polling (§3)
      } catch {
        // Connect refused / unroutable: direct cannot reach the child. When a
        // capable agent is paired, continue through the relay path instead of
        // burning the budget against an address that will never answer.
        if (relayViable) directUnreachable = true;
      }
    }
    if (directUnreachable && relayViable) {
      try {
        const { result } = await relayExchange(userId, port, {
          path: '/health',
          timeoutMs: HEALTH_PROBE_TIMEOUT_MS,
        });
        if (result.ok && result.status === 200) return true;
      } catch {
        // Attempt timed out or the agent dropped mid-wait — keep trying until
        // the budget expires (viability is re-evaluated every tick).
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(HEALTH_POLL_INTERVAL_MS, remaining)));
  }
}

/**
 * Chat pre-flight (§6/§8): makes sure the requested model IS the one loaded
 * child, swapping (stop → spawn) when needed. Capability gate → resolve model
 * path → status frame → health wait → usage stamp. Total: never throws,
 * never aborts a request — failures come back as {mode:'failed', error}.
 */
export async function ensureLlamacppRunning(
  userId: string,
  modelKey: string,
  opts: { overrides?: Partial<LlamacppKnobs>; waitHealthMs?: number } = {},
): Promise<EnsureLlamacppResult> {
  const failed = (error: string): EnsureLlamacppResult => ({ running: false, mode: 'failed', error });
  try {
    if (!hasLlamacppCapability(userId)) return failed(LLAMACPP_CAPABILITY_ERROR);

    const config = resolveLlamacppConfig(userId);
    if (!config.exePath) {
      return failed('llama.cpp executable is not configured (set llamacpp_exe_path or LLAMACPP_EXE_PATH).');
    }

    let entry: LlamacppModelEntry | undefined;
    try {
      entry = (await listLlamacppModels(userId)).find((candidate) => candidate.key === modelKey);
    } catch (err) {
      return failed(errorMessage(err));
    }
    if (!entry) {
      return failed(`Model "${modelKey}" was not found in the scanned llama.cpp models directory.`);
    }

    // Resolution order v2 (§3 Increment 2): request > model override >
    // ACTIVE PRESET > global load-defaults > canonical default. The preset
    // layer reaches argv exclusively through the merged knob bag (§4).
    const knobs = mergeKnobLayers(
      config.knobs,
      config.presets[config.activePreset],
      config.overrides[modelKey],
      opts.overrides,
    );
    const { args } = buildLlamaServerArgv({
      modelPath: entry.path,
      modelKey,
      port: config.port,
      knobs,
      mtpCapable: entry.mtpCapable,
    });

    const status = await requestTrackedStatus(userId);
    const sameChildAlready =
      status.running
      && valueAfterFlag(status.args, '--model') === entry.path
      && valueAfterFlag(status.args, '--port') === String(config.port);
    if (sameChildAlready) {
      syncTrackedFromStatus(userId, status);
      stampLlamacppUsage(userId, modelKey); // §8 usage stamp #1
      return {
        running: true,
        mode: 'already',
        ...(status.pid != null ? { pid: status.pid } : {}),
        argv: status.args ?? args,
        port: config.port,
      };
    }

    let swapped = false;
    if (status.running) {
      if (typeof status.pid !== 'number') {
        return failed('The agent reports a running llama-server without a usable pid; stop it manually.');
      }
      // §8 decision 11: swap-on-start ALWAYS stops first — no 409 path exists.
      const stopResponse = await sendLlamacppFrame<{ ok: boolean; forced?: boolean; error?: string }>(
        userId,
        { type: 'llamacpp_stop', requestId: newRequestId(), pid: status.pid, graceMs: STOP_GRACE_MS },
        STOP_TIMEOUT_MS,
      );
      if (!stopResponse.ok) {
        return failed(`Failed to stop the previously loaded model${stopResponse.error ? `: ${stopResponse.error}` : ''}.`);
      }
      trackedChildren.set(userId, {
        running: false, pid: null, port: config.port, modelKey: null, modelPath: null,
        argv: null, startedAt: null, lastExitCode: null, lastExitAt: Date.now(),
      });
      swapped = true;
    }

    const spawnResponse = await sendLlamacppFrame<{ ok: boolean; pid?: number; error?: string }>(
      userId,
      {
        type: 'llamacpp_spawn',
        requestId: newRequestId(),
        exePath: config.exePath,
        host: '127.0.0.1',
        port: config.port,
        args,
      },
      SPAWN_TIMEOUT_MS,
    );
    if (!spawnResponse.ok || typeof spawnResponse.pid !== 'number') {
      return failed(spawnResponse.error ?? 'Spawning llama-server failed on the local agent.');
    }

    const waitBudgetMs = opts.waitHealthMs ?? DEFAULT_HEALTH_WAIT_MS;
    const healthy = await pollHealth(userId, config.port, waitBudgetMs);
    if (!healthy) {
      return failed(`llama-server did not become healthy within ${waitBudgetMs} ms (see /api/models/llamacpp/logs).`);
    }

    // Success: record launch facts + §8 usage stamp.
    lastLaunchByUser.set(userId, { argv: args, modelKey });
    trackedChildren.set(userId, {
      running: true,
      pid: spawnResponse.pid,
      port: config.port,
      modelKey,
      modelPath: entry.path,
      argv: args,
      startedAt: Date.now(),
      lastExitCode: null,
      lastExitAt: null,
    });
    stampLlamacppUsage(userId, modelKey);
    return { running: true, mode: swapped ? 'swapped' : 'started', pid: spawnResponse.pid, argv: args, port: config.port };
  } catch (err) {
    return failed(errorMessage(err));
  }
}

export interface StopLlamacppResult {
  ok: boolean;
  status: 'stopped' | 'not-running';
  error?: string;
}

/**
 * Idempotent, TOTAL stop: asks the agent to terminate the tracked child via a
 * status frame + stop frame pair. Nothing running is a SUCCESS ('not-running').
 * Success clears the user's usage-tracking entries (single-slot semantics).
 */
export async function stopLlamacpp(userId: string): Promise<StopLlamacppResult> {
  try {
    if (!hasLlamacppCapability(userId)) {
      return { ok: false, status: 'not-running', error: LLAMACPP_CAPABILITY_ERROR };
    }
    const status = await requestTrackedStatus(userId);
    if (!status.running || typeof status.pid !== 'number') {
      trackedChildren.set(userId, {
        running: false, pid: null, port: null, modelKey: null, modelPath: null,
        argv: null, startedAt: null, lastExitCode: status.lastExitCode ?? null, lastExitAt: null,
      });
      forgetAllUsage(userId);
      return { ok: true, status: 'not-running' };
    }
    const stopResponse = await sendLlamacppFrame<{ ok: boolean; forced?: boolean; error?: string }>(
      userId,
      { type: 'llamacpp_stop', requestId: newRequestId(), pid: status.pid, graceMs: STOP_GRACE_MS },
      STOP_TIMEOUT_MS,
    );
    if (!stopResponse.ok) {
      return { ok: false, status: 'not-running', error: stopResponse.error ?? 'Stopping llama-server failed.' };
    }
    trackedChildren.set(userId, {
      running: false, pid: null, port: null, modelKey: null, modelPath: null,
      argv: null, startedAt: null, lastExitCode: null, lastExitAt: Date.now(),
    });
    forgetAllUsage(userId);
    return { ok: true, status: 'stopped' };
  } catch (err) {
    return { ok: false, status: 'not-running', error: errorMessage(err) };
  }
}

// Unsolicited exit pushes (§2/§8) keep the tracked state honest while the
// connection is alive; a following status frame re-syncs authoritatively.
registerLlamacppExitHook((userId, event) => {
  const tracked = trackedChildren.get(userId);
  if (tracked) {
    tracked.running = false;
    tracked.lastExitCode = event.exitCode;
    tracked.lastExitAt = Date.now();
  } else {
    trackedChildren.set(userId, {
      running: false,
      pid: event.pid,
      port: null,
      modelKey: null,
      modelPath: null,
      argv: null,
      startedAt: null,
      lastExitCode: event.exitCode,
      lastExitAt: Date.now(),
    });
  }
});

// ---------------------------------------------------------------------------
// Idle sweep (§8 — module singleton + exported test seam)
// ---------------------------------------------------------------------------

let idleSweepTimer: ReturnType<typeof setInterval> | null = null;

/** Lazy singleton (§8): ONE interval per process, `.unref()`'d so it can never hold the process open; safe across repeated imports. */
function ensureIdleSweepTimer(): void {
  if (idleSweepTimer !== null) return;
  idleSweepTimer = setInterval(() => {
    void runLlamacppIdleSweep().catch(() => undefined);
  }, IDLE_SWEEP_INTERVAL_MS);
  idleSweepTimer.unref?.();
}
ensureIdleSweepTimer();

/**
 * One idle-sweep tick (§8), exported as a TEST SEAM: pass `nowMs` to make the
 * idle math deterministic. Per tracked user honoring their
 * `llamacpp_idle_unload_minutes` ('0' skips the user entirely), entries idle
 * STRICTLY longer than N minutes are best-effort unloaded (unload = stop
 * frame), skipping any key with an in-flight counter > 0. Tracking entries are
 * deleted after success/'not-running'; failed entries stay for the next tick.
 * The whole tick is wrapped so it can never throw. Returns entries ejected.
 */
export async function runLlamacppIdleSweep(nowMs: number = Date.now()): Promise<number> {
  let ejected = 0;
  try {
    const snapshot = [...usageTracking.entries()].map(([key, entry]) => ({ key, entry }));
    const userIds = [...new Set(snapshot.map(({ key }) => key.split('\u0000')[0]))];
    for (const userId of userIds) {
      let thresholdMs: number;
      try {
        const minutes = resolveLlamacppConfig(userId).idleUnloadMinutes;
        if (!(minutes > 0)) continue; // '0' disables per-user idle unload
        thresholdMs = minutes * 60_000;
      } catch {
        continue;
      }
      for (const { key, entry } of snapshot) {
        if (!key.startsWith(`${userId}\u0000`)) continue;
        if (entry.inFlight > 0) continue; // never eject under a live stream
        if (nowMs - entry.lastUsedAt <= thresholdMs) continue; // strictly > N minutes
        let outcome: StopLlamacppResult | null = null;
        try {
          outcome = await stopLlamacpp(userId);
        } catch {
          outcome = null; // stopLlamacpp is total, but never let a tick throw
        }
        if (outcome && outcome.ok) {
          usageTracking.delete(key); // §8: drop tracking after success/not-running
          ejected += 1;
        }
      }
    }
  } catch {
    // whole-tick guard: sweep failures must never crash the process
  }
  return ejected;
}
