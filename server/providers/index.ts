/**
 * Provider registry — the single source of truth for which upstream LLM API a
 * request targets and which features that API supports.
 *
 * The app threads a single free-text `model` string through every layer
 * (agents.model, conversations.model, messages.model, general_chat_model,
 * council member_models, per-message/conversation overrides). Rather than add a
 * parallel `provider` column everywhere, the provider is encoded in the model id
 * with a scheme prefix:
 *
 *   - OpenRouter models keep their native ids: `anthropic/claude-3.5-sonnet`, `openrouter/auto`.
 *   - DeepSeek-direct models use the `deepseek:` prefix: `deepseek:deepseek-v4-flash`.
 *   - Abliteration-direct models use the `abliteration:` prefix: `abliteration:abliterated-model`.
 *   - ChatGPT (Codex app-server) models use the `codex:` prefix: `codex:gpt-5.1-codex`.
 *   - llama.cpp (local llama-server, spawned via the paired local agent) models use
 *     the `llamacpp:` prefix: `llamacpp:Qwen3.6-35B-A3B-UD-Q4_K_M`.
 *   - `lmstudio:*` ids from the REMOVED LM Studio provider still resolve to a
 *     retained `'lmstudio'` stub so they are recognized and rejected (HTTP 400 in
 *     chat/council) instead of silently falling through to OpenRouter (plan D8).
 *
 * `resolveProviderId` decides routing; `toUpstreamModelId` strips the prefix
 * before the id is sent upstream. The colon cleanly disambiguates from
 * OpenRouter's own `deepseek/...` slugs.
 */

export type ProviderId = 'openrouter' | 'deepseek' | 'codex' | 'lmstudio' | 'llamacpp' | 'abliteration' | 'arnict';

export const DEEPSEEK_PREFIX = 'deepseek:';
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const ABLITERATION_PREFIX = 'abliteration:';
export const ABLITERATION_BASE_URL = 'https://api.abliteration.ai';
export const ARNICT_PREFIX = 'arnict:';
export const ARNICT_BASE_URL = 'https://api.arnict.com';
export const CODEX_PREFIX = 'codex:';
export const LMSTUDIO_PREFIX = 'lmstudio:';
export const LLAMACPP_PREFIX = 'llamacpp:';

export interface ProviderConfig {
  id: ProviderId;
  /** Human label used in error messages and UI ("OpenRouter", "DeepSeek (Direct)"). */
  label: string;
  /** Full chat-completions endpoint. */
  chatCompletionsUrl: string;
  /** Settings key that stores this provider's API key (encrypted at rest). */
  apiKeySetting: string;
  buildHeaders(apiKey: string): Record<string, string>;
  /** OpenRouter `provider` routing preference. */
  supportsProviderRouting: boolean;
  /** OpenRouter `plugins` (PDF file-parser, response-healing). */
  supportsPlugins: boolean;
  /** OpenRouter `reasoning` object param (DeepSeek uses its own thinking switch instead). */
  supportsReasoningParam: boolean;
  /** OpenRouter `response_format: json_schema` structured outputs. */
  supportsJsonSchema: boolean;
}

const OPENROUTER_CONFIG: ProviderConfig = {
  id: 'openrouter',
  label: 'OpenRouter',
  chatCompletionsUrl: 'https://openrouter.ai/api/v1/chat/completions',
  apiKeySetting: 'openrouter_api_key',
  buildHeaders: (apiKey) => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'HTTP-Referer': 'http://localhost:5173',
    'X-Title': 'Agent Studio',
  }),
  supportsProviderRouting: true,
  supportsPlugins: true,
  supportsReasoningParam: true,
  supportsJsonSchema: true,
};

const DEEPSEEK_CONFIG: ProviderConfig = {
  id: 'deepseek',
  label: 'DeepSeek (Direct)',
  chatCompletionsUrl: `${DEEPSEEK_BASE_URL}/chat/completions`,
  apiKeySetting: 'deepseek_api_key',
  buildHeaders: (apiKey) => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  }),
  supportsProviderRouting: false,
  supportsPlugins: false,
  supportsReasoningParam: false,
  supportsJsonSchema: false,
};

const ABLITERATION_CONFIG: ProviderConfig = {
  id: 'abliteration',
  label: 'Abliteration (Direct)',
  chatCompletionsUrl: `${ABLITERATION_BASE_URL}/v1/chat/completions`,
  apiKeySetting: 'abliteration_api_key',
  buildHeaders: (apiKey) => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  }),
  supportsProviderRouting: false,
  supportsPlugins: false,
  supportsReasoningParam: false,
  supportsJsonSchema: true,
};

/**
 * Arnict (Direct). OpenAI-compatible `POST /v1/chat/completions` relayed
 * server-side with `Authorization: Bearer <key>`. Wave-1 ships a plain POST:
 * no provider/plugins routing prefs, no reasoning object, no json_schema
 * (all flags false), following the ABLITERATION_CONFIG shape.
 */
const ARNICT_CONFIG: ProviderConfig = {
  id: 'arnict',
  label: 'Arnict (Direct)',
  chatCompletionsUrl: `${ARNICT_BASE_URL}/v1/chat/completions`,
  apiKeySetting: 'arnict_api_key',
  buildHeaders: (apiKey) => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  }),
  supportsProviderRouting: false,
  supportsPlugins: false,
  supportsReasoningParam: false,
  supportsJsonSchema: false,
};

/**
 * ChatGPT (Codex app-server). There is no chat-completions URL or API key: the
 * backend bridges to a per-user `codex app-server` process over JSON-RPC/stdio
 * and usage is billed to the user's ChatGPT plan. apiKeySetting is left empty
 * so generic key lookups fail closed; the codex code paths check the account
 * state instead. Structured output is supported via turn `outputSchema`.
 */
const CODEX_CONFIG: ProviderConfig = {
  id: 'codex',
  label: 'ChatGPT (Codex)',
  chatCompletionsUrl: '',
  apiKeySetting: '',
  buildHeaders: () => ({}),
  supportsProviderRouting: false,
  supportsPlugins: false,
  supportsReasoningParam: false,
  supportsJsonSchema: true,
};

/**
 * llama.cpp — a llama-server process spawned/supervised on the user's machine
 * through their paired local agent. The loopback endpoint (port resolved from
 * settings/env) is built per request, so chatCompletionsUrl stays '' here.
 * Requests WITHOUT an API key are valid (the spawn passes no `--api-key`); the
 * key setting below intentionally has NO settings row — the key GATE is
 * exempted for llamacpp instead of the lookup succeeding.
 */
const LLAMACPP_CONFIG: ProviderConfig = {
  id: 'llamacpp',
  label: 'llama.cpp (Local)',
  chatCompletionsUrl: '',
  apiKeySetting: 'llamacpp_api_key_unused',
  buildHeaders: () => ({ 'Content-Type': 'application/json' }),
  supportsProviderRouting: false,
  supportsPlugins: false,
  supportsReasoningParam: false,
  supportsJsonSchema: true,
};

/**
 * Removed LM Studio provider — retained ONLY so persisted `lmstudio:*` model
 * ids still resolve to a named provider and are REJECTED upstream of any
 * network call (HTTP 400 in chat.ts/councilExecutor.ts, plan D8) instead of
 * silently falling through to OpenRouter. No settings row or endpoint backs it.
 */
const LMSTUDIO_REMOVED_CONFIG: ProviderConfig = {
  id: 'lmstudio',
  label: 'LM Studio (removed)',
  chatCompletionsUrl: '', // never fetched — requests are rejected before any network call
  apiKeySetting: 'lmstudio_api_key_unused',
  buildHeaders: () => ({ 'Content-Type': 'application/json' }),
  supportsProviderRouting: false,
  supportsPlugins: false,
  supportsReasoningParam: false,
  supportsJsonSchema: true,
};

const CONFIGS: Record<ProviderId, ProviderConfig> = {
  openrouter: OPENROUTER_CONFIG,
  deepseek: DEEPSEEK_CONFIG,
  codex: CODEX_CONFIG,
  lmstudio: LMSTUDIO_REMOVED_CONFIG,
  llamacpp: LLAMACPP_CONFIG,
  abliteration: ABLITERATION_CONFIG,
  arnict: ARNICT_CONFIG,
};

/** Returns the provider that should serve a given namespaced model id. */
export function resolveProviderId(modelId: string | null | undefined): ProviderId {
  if (typeof modelId === 'string' && modelId.startsWith(DEEPSEEK_PREFIX)) return 'deepseek';
  if (typeof modelId === 'string' && modelId.startsWith(ABLITERATION_PREFIX)) return 'abliteration';
  if (typeof modelId === 'string' && modelId.startsWith(ARNICT_PREFIX)) return 'arnict';
  if (typeof modelId === 'string' && modelId.startsWith(CODEX_PREFIX)) return 'codex';
  // D8: retained so legacy ids resolve to 'lmstudio' (rejected downstream),
  // NEVER to openrouter.
  if (typeof modelId === 'string' && modelId.startsWith(LMSTUDIO_PREFIX)) return 'lmstudio';
  if (typeof modelId === 'string' && modelId.startsWith(LLAMACPP_PREFIX)) return 'llamacpp';
  return 'openrouter';
}

/** Strips the provider scheme prefix, yielding the id the upstream API expects. */
export function toUpstreamModelId(modelId: string): string {
  if (modelId.startsWith(DEEPSEEK_PREFIX)) return modelId.slice(DEEPSEEK_PREFIX.length);
  if (modelId.startsWith(ABLITERATION_PREFIX)) return modelId.slice(ABLITERATION_PREFIX.length);
  if (modelId.startsWith(ARNICT_PREFIX)) return modelId.slice(ARNICT_PREFIX.length);
  if (modelId.startsWith(CODEX_PREFIX)) return modelId.slice(CODEX_PREFIX.length);
  if (modelId.startsWith(LMSTUDIO_PREFIX)) return modelId.slice(LMSTUDIO_PREFIX.length);
  if (modelId.startsWith(LLAMACPP_PREFIX)) return modelId.slice(LLAMACPP_PREFIX.length);
  return modelId;
}

/** True when the model id targets the ChatGPT (Codex app-server) provider. */
export function isCodexModel(modelId: string | null | undefined): boolean {
  return resolveProviderId(modelId) === 'codex';
}

/** True when the model id targets the local llama.cpp (llama-server) provider. */
export function isLlamacppModel(modelId: string | null | undefined): boolean {
  return resolveProviderId(modelId) === 'llamacpp';
}

/**
 * Legacy classifier: true for ids from the REMOVED LM Studio provider. Kept so
 * consumers can recognize-and-error on persisted rows (plan D8); such ids must
 * never be routed anywhere.
 */
export function isLmStudioModel(modelId: string | null | undefined): boolean {
  return resolveProviderId(modelId) === 'lmstudio';
}

/** True when the model id targets the Abliteration-direct provider. */
export function isAbliterationModel(modelId: string | null | undefined): boolean {
  return resolveProviderId(modelId) === 'abliteration';
}

/** True when the model id targets the Arnict-direct provider. */
export function isArnictModel(modelId: string | null | undefined): boolean {
  return resolveProviderId(modelId) === 'arnict';
}

/** Exact shared guard message: tools are OpenRouter-only, never sent for arnict (GC §5). */
export const ARNICT_TOOLS_UNSUPPORTED_MESSAGE =
  'Tool calls are currently supported only with OpenRouter models, not Arnict (Direct).';

/** Exact shared guard message for text-only Abliteration large models (GC §5). */
export const ABLITERATION_LARGE_TEXT_ONLY_MESSAGE =
  'Abliteration large models are text-only; use abliteration:abliterated-model for image content.';

/** True for the two text-only Abliteration large upstream ids (GC §5). */
export function isAbliterationLargeModel(upstreamModelId: string | null | undefined): boolean {
  return upstreamModelId === 'abliterated-model-large' || upstreamModelId === 'abliterated-model-large-v2';
}

export function getProviderConfig(id: ProviderId): ProviderConfig {
  return CONFIGS[id];
}

/** Convenience: resolve a model id straight to its provider config. */
export function getProviderForModel(modelId: string | null | undefined): ProviderConfig {
  return CONFIGS[resolveProviderId(modelId)];
}

/**
 * Field name an assistant message must use to carry chain-of-thought back to the
 * provider. DeepSeek thinking mode REQUIRES `reasoning_content` on tool-call
 * turns (else it returns HTTP 400); OpenRouter uses `reasoning`.
 */
export function assistantReasoningField(id: ProviderId): 'reasoning' | 'reasoning_content' {
  return id === 'deepseek' ? 'reasoning_content' : 'reasoning';
}

/**
 * Model id to persist on `messages.model` / draft rows for a completed turn.
 *
 * Namespaced providers whose APIs echo the bare key back in the response
 * (`parsed.model`) must keep the NAMESPACED effective id — trusting the echo
 * would drop the scheme prefix from history. That applies to DeepSeek-direct,
 * llama.cpp (llama-server echoes `--alias`), and legacy lmstudio ids (which
 * are rejected before a response can exist). Every other provider records the
 * model the upstream actually served (OpenRouter may route to a variant),
 * falling back to the requested id when nothing was echoed.
 */
export function persistedModelId(
  providerId: ProviderId,
  effectiveModel: string,
  actualModelFromResponse: string | null,
): string {
  if (providerId === 'deepseek' || providerId === 'lmstudio' || providerId === 'llamacpp' || providerId === 'abliteration' || providerId === 'arnict') return effectiveModel;
  return actualModelFromResponse ?? effectiveModel;
}

/**
 * Resolves the `content` field for a replayed assistant history row.
 *
 * DeepSeek's `/chat/completions` endpoint rejects an assistant message whose
 * `content` is `null` and which carries no `tool_calls` with HTTP 400
 * ("Invalid assistant message: content or tool_calls must be set") — this can
 * happen for rows persisted with empty content (e.g. an interrupted stream).
 * `content: null` is only valid when `tool_calls` is also present on the same
 * message (the legitimate pure-tool-call turn); otherwise an empty string
 * must be sent instead of `null`.
 */
export function resolveAssistantHistoryContent(content: string, hasToolCalls: boolean): string | null {
  return hasToolCalls ? (content || null) : (content || '');
}

// ---------------------------------------------------------------------------
// DeepSeek thinking mode (OpenAI-compatible format)
// Docs: https://api-docs.deepseek.com/guides/thinking_mode
//   - Toggle: top-level `thinking: { type: 'enabled' | 'disabled' }` (default enabled)
//   - Effort: top-level `reasoning_effort: 'high' | 'max'` (low/medium → high, xhigh → max)
//   - Thinking mode ignores temperature/top_p/penalties (no error)
// ---------------------------------------------------------------------------

/** Maps the app's reasoning-effort vocabulary to DeepSeek's accepted values. */
export function mapDeepSeekEffort(effort: string | null | undefined): 'high' | 'max' | undefined {
  switch (effort) {
    case 'max':
    case 'xhigh':
      return 'max';
    case 'high':
    case 'medium':
    case 'low':
    case 'minimal':
      return 'high';
    default:
      return undefined; // 'none'/unknown → rely on DeepSeek's default effort
  }
}

/** Builds the DeepSeek thinking-mode request fields from the app's reasoning toggle. */
export function buildDeepSeekThinking(
  reasoningEnabled: boolean,
  effort: string | null | undefined
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    thinking: { type: reasoningEnabled ? 'enabled' : 'disabled' },
  };
  if (reasoningEnabled) {
    const mapped = mapDeepSeekEffort(effort);
    if (mapped) out.reasoning_effort = mapped;
  }
  return out;
}

// ---------------------------------------------------------------------------
// DeepSeek model catalog (curated/static)
//
// Pricing per https://api-docs.deepseek.com (Models & Pricing). The OpenRouter
// model shape expresses pricing as a per-TOKEN decimal string, so we mirror that.
// NOTE: prices may drift — update the table below if DeepSeek changes them. The
// legacy ids `deepseek-chat` / `deepseek-reasoner` (non-thinking / thinking of
// V4 Flash) are deprecated by DeepSeek on 2026-07-24; kept here only for cost
// lookups, not surfaced in the catalog.
// ---------------------------------------------------------------------------

export interface DeepSeekCatalogModel {
  id: string; // namespaced, e.g. 'deepseek:deepseek-v4-flash'
  name: string;
  description: string;
  context_length: number;
  pricing: { prompt: string; completion: string };
}

export const DEEPSEEK_CATALOG: DeepSeekCatalogModel[] = [
  {
    id: `${DEEPSEEK_PREFIX}deepseek-v4-flash`,
    name: 'DeepSeek V4 Flash',
    description:
      'Fast, low-cost DeepSeek V4. 1M context, up to 384K output, tool calls + JSON output. Thinking mode toggles with Reasoning.',
    context_length: 1_000_000,
    pricing: { prompt: '0.00000014', completion: '0.00000028' }, // $0.14 / $0.28 per 1M (cache miss)
  },
  {
    id: `${DEEPSEEK_PREFIX}deepseek-v4-pro`,
    name: 'DeepSeek V4 Pro',
    description:
      'Highest-quality DeepSeek V4. 1M context, up to 384K output, tool calls + JSON output. Thinking mode toggles with Reasoning.',
    context_length: 1_000_000,
    pricing: { prompt: '0.000000435', completion: '0.00000087' }, // $0.435 / $0.87 per 1M (cache miss)
  },
];

/** Per-1M-token pricing used to compute cost (DeepSeek does not return a `cost` field). */
interface DeepSeekPrice {
  inHit: number; // input, cache hit
  inMiss: number; // input, cache miss
  out: number; // output
}

const DEEPSEEK_PRICING: Record<string, DeepSeekPrice> = {
  'deepseek-v4-flash': { inHit: 0.0028, inMiss: 0.14, out: 0.28 },
  'deepseek-v4-pro': { inHit: 0.003625, inMiss: 0.435, out: 0.87 },
  // Legacy aliases map to V4 Flash pricing for robustness until 2026-07-24.
  'deepseek-chat': { inHit: 0.0028, inMiss: 0.14, out: 0.28 },
  'deepseek-reasoner': { inHit: 0.0028, inMiss: 0.14, out: 0.28 },
};

interface DeepSeekUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

/**
 * Best-effort cost (USD) for a DeepSeek response, using the static price table
 * and the cache hit/miss token split DeepSeek reports. Returns 0 for unknown models.
 */
export function computeDeepSeekCost(usage: DeepSeekUsage | null | undefined, upstreamModelId: string): number {
  const price = DEEPSEEK_PRICING[upstreamModelId];
  if (!price || !usage) return 0;
  const hit = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  const miss = usage.prompt_cache_miss_tokens ?? Math.max((usage.prompt_tokens ?? 0) - hit, 0);
  const out = usage.completion_tokens ?? 0;
  return (hit * price.inHit + miss * price.inMiss + out * price.out) / 1_000_000;
}

/** Cache-hit tokens from a DeepSeek usage object (for the app's cached_tokens metric). */
export function deepSeekCachedTokens(usage: DeepSeekUsage | null | undefined): number {
  if (!usage) return 0;
  return usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
}

// ---------------------------------------------------------------------------
// Abliteration-direct catalog / reasoning / cost (GC §§3-6, static wave-1)
// Docs: https://abliteration.ai/pricing + docs.abliteration.ai (2026-09-02);
// contract pinned to live spec v0.1.0. Static catalog (no per-request fetch);
// Bearer auth; reasoning via top-level `reasoning_effort`; static per-token
// pricing because usage frames carry no `cost` field.
// ---------------------------------------------------------------------------

export interface AbliterationCatalogModel {
  id: string; // namespaced, e.g. 'abliteration:abliterated-model'
  name: string;
  description: string;
  context_length: number;
  pricing: { prompt: string; completion: string };
}

export const ABLITERATION_CATALOG: AbliterationCatalogModel[] = [
  {
    id: `${ABLITERATION_PREFIX}abliterated-model`,
    name: 'Abliterated Model',
    description:
      'General multimodal default. Text + image input, text output. Fallback for image content.',
    context_length: 262144,
    pricing: { prompt: '0.000001', completion: '0.000003' }, // $1.00 / $3.00 per 1M
  },
  {
    id: `${ABLITERATION_PREFIX}abliterated-model-large`,
    name: 'Abliterated Model Large',
    description:
      'Large text-only model. Does not accept image content; use abliteration:abliterated-model for image content.',
    context_length: 1000000,
    pricing: { prompt: '0.000003', completion: '0.000005' }, // $3.00 / $5.00 per 1M
  },
  {
    id: `${ABLITERATION_PREFIX}abliterated-model-large-v2`,
    name: 'Abliterated Model Large V2',
    description:
      'Default large text-only model. Does not accept image content; use abliteration:abliterated-model for image content.',
    context_length: 1000000,
    pricing: { prompt: '0.000003', completion: '0.000005' }, // $3.00 / $5.00 per 1M
  },
];

const ABLITERATION_ALLOWED_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Builds the Abliteration reasoning request field from the app's reasoning
 * toggle (GC §4). Toggle on → `reasoning_effort` verbatim iff effort is an
 * allowed value; otherwise omit (fail-safe, never 422). Never sends
 * `ultracode`, `thinking`, `include_reasoning`, or the OpenRouter
 * `reasoning:{}` object.
 */
export function buildAbliterationReasoning(
  reasoningEnabled: boolean,
  effort: string | null | undefined,
): Record<string, unknown> {
  if (!reasoningEnabled) return {};
  if (typeof effort === 'string' && ABLITERATION_ALLOWED_EFFORTS.has(effort)) {
    return { reasoning_effort: effort };
  }
  return {};
}

/** Per-1M-token pricing used to compute cost (Abliteration usage carries no `cost` field). */
interface AbliterationPrice {
  inHit: number; // input, cache hit (10% of miss rate)
  inMiss: number; // input, cache miss
  out: number; // output
}

const ABLITERATION_PRICING: Record<string, AbliterationPrice> = {
  'abliterated-model': { inHit: 0.1, inMiss: 1.0, out: 3.0 },
  'abliterated-model-large': { inHit: 0.3, inMiss: 3.0, out: 5.0 },
  'abliterated-model-large-v2': { inHit: 0.3, inMiss: 3.0, out: 5.0 },
};

interface AbliterationUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

/**
 * Best-effort cost (USD) for an Abliteration response, using the static price
 * table and the cache hit/miss token split. Returns 0 for unknown models.
 */
export function computeAbliterationCost(
  usage: AbliterationUsage | null | undefined,
  upstreamModelId: string,
): number {
  const price = ABLITERATION_PRICING[upstreamModelId];
  if (!price || !usage) return 0;
  const hit = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0;
  const miss = Math.max((usage.prompt_tokens ?? 0) - hit, 0);
  const out = usage.completion_tokens ?? 0;
  return (hit * price.inHit + miss * price.inMiss + out * price.out) / 1_000_000;
}

/** Cache-hit tokens from an Abliteration usage object (for the app's cached_tokens metric). */
export function abliterationCachedTokens(usage: AbliterationUsage | null | undefined): number {
  if (!usage) return 0;
  return usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0;
}

// ---------------------------------------------------------------------------
// Arnict-direct catalog / cost (GC §§3,6, static wave-1)
// Docs: https://arnict.com/models + /pricing + /docs/models (2026-09-13);
// contract pinned by plans/arnict-provider/integration-arnict.md. Static
// catalog (GET /v1/models is key-gated; DeepSeek/Abliteration precedent);
// Bearer auth; static per-token pricing because usage frames carry no `cost`
// field. Success-payload field reads (`data[].id`) are per-docs
// UNVERIFIED until the first keyed probe.
// ---------------------------------------------------------------------------

export interface ArnictCatalogModel {
  id: string; // namespaced, e.g. 'arnict:zai/glm-5.3-flash-uncensored'
  name: string;
  description: string;
  context_length: number;
  pricing: { prompt: string; completion: string };
}

export const ARNICT_CATALOG: ArnictCatalogModel[] = [
  {
    id: `${ARNICT_PREFIX}zai/glm-5.3-flash-uncensored`,
    name: 'GLM 5.3 Flash Uncensored',
    description:
      'Fast uncensored flagship model. Text, image and video input, text output.',
    context_length: 1048576,
    pricing: { prompt: '0.000000125', completion: '0.0000005' }, // $0.125 / $0.50 per 1M
  },
  {
    id: `${ARNICT_PREFIX}qwen/qwen3.8-27b`,
    name: 'Qwen 3.8 27B',
    description:
      'Free launch-week model. Text and image input, text output.',
    context_length: 262144,
    pricing: { prompt: '0', completion: '0' }, // free during launch week
  },
];

/** Per-1M-token pricing used to compute cost (Arnict usage carries no `cost` field). */
interface ArnictPrice {
  in: number; // input, cache miss
  cachedIn: number; // input, cache hit
  out: number; // output
}

const ARNICT_PRICING: Record<string, ArnictPrice> = {
  'zai/glm-5.3-flash-uncensored': { in: 0.125, cachedIn: 0.05, out: 0.5 },
  'qwen/qwen3.8-27b': { in: 0, cachedIn: 0, out: 0 },
};

export interface ArnictUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

/**
 * Best-effort cost (USD) for an Arnict response, using the static price table.
 * Cached input tokens bill at the cached rate, the remainder at the input
 * rate, output at the output rate. Returns 0 for unknown models or absent usage.
 */
export function computeArnictCost(
  usage: ArnictUsage | null | undefined,
  upstreamModelId: string,
): number {
  const price = ARNICT_PRICING[upstreamModelId];
  if (!price || !usage) return 0;
  const hit = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const miss = Math.max((usage.prompt_tokens ?? 0) - hit, 0);
  const out = usage.completion_tokens ?? 0;
  return (hit * price.cachedIn + miss * price.in + out * price.out) / 1_000_000;
}

/** Cache-hit tokens from an Arnict usage object (for the app's cached_tokens metric). */
export function arnictCachedTokens(usage: ArnictUsage | null | undefined): number {
  if (!usage) return 0;
  return usage.prompt_tokens_details?.cached_tokens ?? 0;
}
