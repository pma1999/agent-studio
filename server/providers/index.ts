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
 *   - OpenCode Go models use the `opencode-go:` prefix: `opencode-go:kimi-k3`.
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

export type ProviderId = 'openrouter' | 'deepseek' | 'codex' | 'lmstudio' | 'llamacpp' | 'abliteration' | 'arnict' | 'opencode-go';

export const DEEPSEEK_PREFIX = 'deepseek:';
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const ABLITERATION_PREFIX = 'abliteration:';
export const ABLITERATION_BASE_URL = 'https://api.abliteration.ai';
export const ARNICT_PREFIX = 'arnict:';
export const ARNICT_BASE_URL = 'https://api.arnict.com';
export const CODEX_PREFIX = 'codex:';
export const LMSTUDIO_PREFIX = 'lmstudio:';
export const LLAMACPP_PREFIX = 'llamacpp:';
export const OPENCODE_GO_PREFIX = 'opencode-go:';
export const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1';
export const OPENCODE_GO_CHAT_COMPLETIONS_URL = `${OPENCODE_GO_BASE_URL}/chat/completions`;
export const OPENCODE_GO_USER_AGENT = 'agent-studio/1.0';
export const OPENCODE_GO_DOCS_URL = 'https://opencode.ai/docs/go/';
export const OPENCODE_GO_VALIDATE_MODEL = 'mimo-v2.5';

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
 * server-side with `Authorization: Bearer <key>`. Full-parity send allowlist:
 * model/messages/temperature/top_p/stop/max_tokens|XOR/stream/stream_options,
 * tools/tool_choice/parallel_tool_calls (OpenAI shape), response_format
 * json_schema (strict:true) via `supportsJsonSchema:true`, reasoning object
 * `{enabled,effort,exclude}` via `buildArnictReasoning`; never
 * provider/plugins or top-level reasoning fields.
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
  supportsJsonSchema: true,
};

/**
 * OpenCode Go (Direct). OpenAI-compatible `POST /chat/completions` gateway
 * rooted at `OPENCODE_GO_BASE_URL` with `Authorization: Bearer <key>` plus a
 * `User-Agent` operational header (GC §1). Phase 1 serves ONLY the
 * chat-completions transport: ids in `OPENCODE_GO_NON_CHAT_TRANSPORT` must
 * hard-fail before any network call (T3/T4), never misroute. Flags F,F,F,F
 * (plan D3: smallest blast radius until a paid-key probe says otherwise).
 */
const OPENCODE_GO_CONFIG: ProviderConfig = {
  id: 'opencode-go',
  label: 'OpenCode Go',
  chatCompletionsUrl: OPENCODE_GO_CHAT_COMPLETIONS_URL,
  apiKeySetting: 'opencode_go_api_key',
  buildHeaders: (apiKey) => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'User-Agent': OPENCODE_GO_USER_AGENT,
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
  'opencode-go': OPENCODE_GO_CONFIG,
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
  if (typeof modelId === 'string' && modelId.startsWith(OPENCODE_GO_PREFIX)) return 'opencode-go';
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
  if (modelId.startsWith(OPENCODE_GO_PREFIX)) return modelId.slice(OPENCODE_GO_PREFIX.length);
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

/** True when the model id targets the OpenCode Go provider. */
export function isOpencodeGoModel(modelId: string | null | undefined): boolean {
  return resolveProviderId(modelId) === 'opencode-go';
}

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
  if (providerId === 'deepseek' || providerId === 'lmstudio' || providerId === 'llamacpp' || providerId === 'abliteration' || providerId === 'arnict' || providerId === 'opencode-go') return effectiveModel;
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
// Arnict-direct catalog / reasoning / cost (GC §§3,4,6, keyed full-parity)
// Docs: https://arnict.com/models + /pricing + /docs/models (2026-09-13);
// contract pinned by plans/arnict-full-parity/integration-arnict-keyed.md
// (veredicto ENVÍO, VERIFIED-keyed 2026-09-13). Static catalog (GET
// /v1/models is key-gated; DeepSeek/Abliteration precedent); Bearer auth;
// reasoning via object `reasoning:{enabled,effort,exclude}`; static per-token
// pricing because usage frames carry no `cost` field.
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

/** Allowed `reasoning.effort` values for arnict (GC §3, VERIFIED-keyed; `none` = off). */
const ARNICT_ALLOWED_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Builds the Arnict reasoning object from the app's reasoning toggle
 * (GC §3). Toggle off or effort `'none'` → `{enabled:false}`; allowed
 * effort → `{enabled:true, effort}` (+ `exclude:true` solo si
 * `exclude === true`); cualquier otro valor o null con toggle on →
 * `{enabled:true}` bare (fail-safe, nunca 400). Nunca emite
 * `reasoning_effort`, `thinking`, `effort` top-level, `max_tokens` dentro
 * de `reasoning`, ni boolean.
 */
export function buildArnictReasoning(
  reasoningEnabled: boolean,
  effort: string | null | undefined,
  exclude?: boolean,
): Record<string, unknown> {
  if (!reasoningEnabled) return { enabled: false };
  if (effort === 'none') return { enabled: false };
  if (typeof effort === 'string' && ARNICT_ALLOWED_EFFORTS.has(effort)) {
    const out: Record<string, unknown> = { enabled: true, effort };
    if (exclude === true) out.exclude = true;
    return out;
  }
  return { enabled: true };
}

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

// ---------------------------------------------------------------------------
// OpenCode Go catalog / transports / cost / replay (GC §§1,3,5,6,7, phase-1)
// Transport table: https://opencode.ai/docs/go/ (fetched 2026-09-15,
// "Last updated: Sep 14, 2026"; docs win over api.json on Qwen rows, Gotcha 2).
// Context windows: https://models.opencode.ai/api.json key `opencode-go`
// (fetched 2026-09-15, 36 models) `limit.context` per model.
// Pricing: docs "Usage limits" price table ($ per 1M tokens, same fetch);
// per-token decimals = $/1M / 1M. DeepSeek peak/off-peak rows are booked at
// the off-peak (base) rate (R3/D10: windows are dollar-based, usage carries
// no `cost`). Phase-2 tranche (T1): 8 `messages` + 5 `responses` rows from the
// docs endpoint table in docs order (`grok-4.5` api.json-only, last) with
// api.json `limit.context` + docs base-rate price + docs $/mo limit per row
// (`grok-4.5`: no known limit → `priceNote`, no `monthlyLimitUsd`).
// 29-vs-38: the 9 ids with no sendable transport stay out of the catalog in
// `OPENCODE_GO_LIST_EXCLUDED` with reason (fail-closed list); 29 = 38 − 9.
// Static catalog: only chat-transport ids with a sourced price
// (fail-closed catalog, GC §3); unknown `opencode-go:` ids fail OPEN on send
// with the §7 mismatch mapping (T3).
// ---------------------------------------------------------------------------

export const OPENCODE_GO_MESSAGES_URL = `${OPENCODE_GO_BASE_URL}/messages`;
export const OPENCODE_GO_RESPONSES_URL = `${OPENCODE_GO_BASE_URL}/responses`;
/** `anthropic-version` header value required on `POST /messages` (docs prose, VERIFIED 401-shape 2026-09-15). */
export const OPENCODE_GO_ANTHROPIC_VERSION = '2023-06-01';
/** Catalog version: `YYYY-MM-DD.N` per entry count (GC; bump on every catalog change). */
export const OPENCODE_GO_CATALOG_VERSION = '2026-09-15.29';

export type OpenCodeGoTransport = 'chat' | 'messages' | 'responses';

/**
 * Bare chat-transport ids (fase-1 allowlist): docs endpoint-table rows on
 * `POST /chat/completions` ∩ api.json — `mimo-v2.5` is chat and the
 * cheapest chat-transport id by the static price table (output $0.28/1M,
 * then input $0.14/1M), so `OPENCODE_GO_VALIDATE_MODEL` is `'mimo-v2.5'`.
 */
export const OPENCODE_GO_CHAT_TRANSPORT_MODELS: ReadonlySet<string> = new Set([
  'glm-5.3-flash',
  'glm-5.3',
  'glm-5.2',
  'glm-5.1',
  'kimi-k3',
  'kimi-k2.7-code',
  'kimi-k2.6',
  'longcat-2.0',
  'deepseek-v4.1-flash',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'deepseek-v4-flash-vision-exp',
  'mimo-v2.5',
  'mimo-v2.5-pro',
  'hy4-preview',
  'hy3',
]);

/**
 * Bare ids served over a phase-2 transport (docs table rows + api.json
 * `provider.npm` overrides: `@ai-sdk/anthropic` → 'messages',
 * `@ai-sdk/openai` → 'responses'; docs win on Qwen rows). `grok-4.5` comes
 * solely from the api.json `@ai-sdk/openai` override (no docs row).
 */
export const OPENCODE_GO_NON_CHAT_TRANSPORT: ReadonlyMap<string, 'messages' | 'responses'> = new Map([
  ['minimax-m3', 'messages'],
  ['minimax-m2.7', 'messages'],
  ['minimax-m2.5', 'messages'],
  ['qwen3.8-max', 'messages'],
  ['qwen3.8-flash', 'messages'],
  ['qwen3.7-max', 'messages'],
  ['qwen3.7-plus', 'messages'],
  ['qwen3.6-plus', 'messages'],
  ['grok-4.6', 'responses'],
  ['gpt-5.6-luna', 'responses'],
  ['muse-spark-1.3-contributor', 'responses'],
  ['muse-spark-1.2-contributor', 'responses'],
  ['grok-4.5', 'responses'],
]);

/**
 * Transport for a Go model id (accepts the bare upstream id or the
 * namespaced `opencode-go:` form). `'unknown'` = fail-open on send with the
 * §7 mismatch mapping, never a silent misroute.
 */
export function opencodeGoTransportFor(upstreamModel: string): OpenCodeGoTransport | 'unknown' {
  const bare = upstreamModel.startsWith(OPENCODE_GO_PREFIX)
    ? upstreamModel.slice(OPENCODE_GO_PREFIX.length)
    : upstreamModel;
  const nonChat = OPENCODE_GO_NON_CHAT_TRANSPORT.get(bare);
  if (nonChat) return nonChat;
  if (OPENCODE_GO_CHAT_TRANSPORT_MODELS.has(bare)) return 'chat';
  return 'unknown';
}

/** Phase-2 hard-fail message for a known non-chat-transport model (GC §7, frozen literal). */
export function opencodeGoWrongTransportMessage(upstream: string, t: 'messages' | 'responses'): string {
  return `Model ${upstream} is served by OpenCode Go over POST ${t === 'messages' ? '/messages (Anthropic shape)' : '/responses (Responses API)'}, which is phase-2 and not supported yet. Use a chat-transport model such as opencode-go:kimi-k3.`;
}

/** Fail-open mismatch message when chat-completions rejects an unknown id (GC §7, frozen literal). */
export function opencodeGoFormatMismatchMessage(upstream: string, detail: string): string {
  return `OpenCode Go rejected model ${upstream} on the chat-completions transport (${detail}). It likely needs a phase-2 transport; use a chat-transport model such as opencode-go:kimi-k3.`;
}

export interface OpencodeGoCatalogModel {
  id: string; // namespaced, e.g. 'opencode-go:kimi-k3'
  name: string;
  description: string;
  context_length: number;
  pricing: { prompt: string; completion: string };
  transport: OpenCodeGoTransport;
  /** True only once the transport is send-enabled (chat: T1; messages: T4; responses: T5). */
  sendable: boolean;
  /** Docs $/mes limit; absent only when unknown (`grok-4.5`) — then `priceNote` explains. */
  monthlyLimitUsd?: number;
  priceNote?: string;
}

export const OPENCODE_GO_CATALOG: OpencodeGoCatalogModel[] = [
  {
    id: `${OPENCODE_GO_PREFIX}glm-5.3-flash`,
    name: 'GLM-5.3-Flash',
    description:
      'Fast low-cost GLM. 1M context, tool calls.',
    context_length: 1000000,
    pricing: { prompt: '0.00000015', completion: '0.0000005' }, // $0.15 / $0.50 per 1M
    transport: 'chat',
    sendable: true,
    monthlyLimitUsd: 60, // docs usage-limits $/mes limit
  },
  {
    id: `${OPENCODE_GO_PREFIX}glm-5.3`,
    name: 'GLM-5.3',
    description:
      'Flagship GLM. 1M context, tool calls.',
    context_length: 1000000,
    pricing: { prompt: '0.0000014', completion: '0.0000044' }, // $1.40 / $4.40 per 1M
    transport: 'chat',
    sendable: true,
    monthlyLimitUsd: 15, // docs usage-limits $/mes limit
  },
  {
    id: `${OPENCODE_GO_PREFIX}glm-5.2`,
    name: 'GLM-5.2',
    description:
      'GLM generation. 1M context, tool calls.',
    context_length: 1000000,
    pricing: { prompt: '0.0000014', completion: '0.0000044' }, // $1.40 / $4.40 per 1M
    transport: 'chat',
    sendable: true,
    monthlyLimitUsd: 60, // docs usage-limits $/mes limit
  },
  {
    id: `${OPENCODE_GO_PREFIX}glm-5.1`,
    name: 'GLM-5.1',
    description:
      'GLM generation. 202K context, tool calls.',
    context_length: 202752,
    pricing: { prompt: '0.0000014', completion: '0.0000044' }, // $1.40 / $4.40 per 1M
    transport: 'chat',
    sendable: true,
    monthlyLimitUsd: 60, // docs usage-limits $/mes limit
  },
  {
    id: `${OPENCODE_GO_PREFIX}kimi-k3`,
    name: 'Kimi K3',
    description:
      'Flagship Kimi. 1M context, tool calls.',
    context_length: 1048576,
    pricing: { prompt: '0.000003', completion: '0.000015' }, // $3.00 / $15.00 per 1M
    transport: 'chat',
    sendable: true,
    monthlyLimitUsd: 15, // docs usage-limits $/mes limit
  },
  {
    id: `${OPENCODE_GO_PREFIX}kimi-k2.7-code`,
    name: 'Kimi K2.7 Code',
    description:
      'Kimi coding model. 256K context, tool calls.',
    context_length: 262144,
    pricing: { prompt: '0.00000095', completion: '0.000004' }, // $0.95 / $4.00 per 1M
    transport: 'chat',
    sendable: true,
    monthlyLimitUsd: 60, // docs usage-limits $/mes limit
  },
  {
    id: `${OPENCODE_GO_PREFIX}kimi-k2.6`,
    name: 'Kimi K2.6',
    description:
      'Kimi generation. 256K context, tool calls.',
    context_length: 262144,
    pricing: { prompt: '0.00000095', completion: '0.000004' }, // $0.95 / $4.00 per 1M
    transport: 'chat',
    sendable: true,
    monthlyLimitUsd: 60, // docs usage-limits $/mes limit
  },
  {
    id: `${OPENCODE_GO_PREFIX}longcat-2.0`,
    name: 'LongCat-2.0',
    description:
      'Long-context model. 1M context, tool calls.',
    context_length: 1000000,
    pricing: { prompt: '0.0000003', completion: '0.0000012' }, // $0.30 / $1.20 per 1M
    transport: 'chat',
    sendable: true,
    monthlyLimitUsd: 60, // docs usage-limits $/mes limit
  },
  {
    id: `${OPENCODE_GO_PREFIX}deepseek-v4.1-flash`,
    name: 'DeepSeek V4.1 Flash',
    description:
      'Fast DeepSeek V4. 1M context, tool calls. Peak/off-peak billed at base rate.',
    context_length: 1000000,
    pricing: { prompt: '0.00000015', completion: '0.0000006' }, // $0.15 / $0.60 per 1M off-peak (base)
    transport: 'chat',
    sendable: true,
    monthlyLimitUsd: 15, // docs usage-limits $/mes limit
  },
  {
    id: `${OPENCODE_GO_PREFIX}deepseek-v4-pro`,
    name: 'DeepSeek V4 Pro',
    description:
      'Highest-quality DeepSeek V4. 1M context, tool calls. Peak/off-peak billed at base rate.',
    context_length: 1000000,
    pricing: { prompt: '0.00000066', completion: '0.00000198' }, // $0.66 / $1.98 per 1M off-peak (base)
    transport: 'chat',
    sendable: true,
    monthlyLimitUsd: 15, // docs usage-limits $/mes limit
  },
  {
    id: `${OPENCODE_GO_PREFIX}deepseek-v4-flash`,
    name: 'DeepSeek V4 Flash',
    description:
      'Fast, low-cost DeepSeek V4. 1M context, tool calls. Peak/off-peak billed at base rate.',
    context_length: 1000000,
    pricing: { prompt: '0.00000015', completion: '0.0000006' }, // $0.15 / $0.60 per 1M off-peak (base)
    transport: 'chat',
    sendable: true,
    monthlyLimitUsd: 30, // docs usage-limits $/mes limit
  },
  {
    id: `${OPENCODE_GO_PREFIX}deepseek-v4-flash-vision-exp`,
    name: 'DeepSeek V4 Flash Vision Exp',
    description:
      'DeepSeek V4 Flash with vision. 1M context, tool calls. Peak/off-peak billed at base rate.',
    context_length: 1000000,
    pricing: { prompt: '0.00000015', completion: '0.0000006' }, // $0.15 / $0.60 per 1M off-peak (base)
    transport: 'chat',
    sendable: true,
    monthlyLimitUsd: 15, // docs usage-limits $/mes limit
  },
  {
    id: `${OPENCODE_GO_PREFIX}mimo-v2.5`,
    name: 'MiMo-V2.5',
    description:
      'MiMo generation. 1M context, tool calls.',
    context_length: 1000000,
    pricing: { prompt: '0.00000014', completion: '0.00000028' }, // $0.14 / $0.28 per 1M
    transport: 'chat',
    sendable: true,
    monthlyLimitUsd: 60, // docs usage-limits $/mes limit
  },
  {
    id: `${OPENCODE_GO_PREFIX}mimo-v2.5-pro`,
    name: 'MiMo-V2.5-Pro',
    description:
      'MiMo pro generation. 1M context, tool calls.',
    context_length: 1048576,
    pricing: { prompt: '0.000000435', completion: '0.00000087' }, // $0.435 / $0.87 per 1M
    transport: 'chat',
    sendable: true,
    monthlyLimitUsd: 15, // docs usage-limits $/mes limit
  },
  {
    id: `${OPENCODE_GO_PREFIX}hy4-preview`,
    name: 'Hy4 preview',
    description:
      'Hy preview model. 1M context, tool calls.',
    context_length: 1024000,
    pricing: { prompt: '0.000000834', completion: '0.000002501' }, // $0.834 / $2.501 per 1M
    transport: 'chat',
    sendable: true,
    monthlyLimitUsd: 30, // docs usage-limits $/mes limit
  },
  {
    id: `${OPENCODE_GO_PREFIX}hy3`,
    name: 'Hy3',
    description:
      'Hy generation. 256K context, tool calls.',
    context_length: 256000,
    pricing: { prompt: '0.00000014', completion: '0.00000058' }, // $0.14 / $0.58 per 1M
    transport: 'chat',
    sendable: true,
    monthlyLimitUsd: 60, // docs usage-limits $/mes limit
  },
  // -- Phase-2 tranche (T1 catalog; T4 send-enables the 8 messages rows,
  // T5 the 5 responses rows): docs endpoint-table
  // order, 8 messages + 5 responses (`grok-4.5` api.json-only, last). Context
  // from api.json `limit.context`, pricing = docs base/off-peak $/1M rate,
  // limit = docs $/mes. Tiered rows book the base tier (T2 models write/tiers).
  {
    id: `${OPENCODE_GO_PREFIX}minimax-m3`,
    name: 'MiniMax M3',
    description:
      'MiniMax generation. 1M context, messages transport (phase-2).',
    context_length: 1000000,
    pricing: { prompt: '0.0000003', completion: '0.0000012' }, // $0.30 / $1.20 per 1M
    transport: 'messages',
    sendable: true,
    monthlyLimitUsd: 60, // docs usage-limits $/mes limit (>512K x2, T2)
  },
  {
    id: `${OPENCODE_GO_PREFIX}minimax-m2.7`,
    name: 'MiniMax M2.7',
    description:
      'MiniMax generation. 200K context, messages transport (phase-2).',
    context_length: 204800,
    pricing: { prompt: '0.0000003', completion: '0.0000012' }, // $0.30 / $1.20 per 1M
    transport: 'messages',
    sendable: true,
    monthlyLimitUsd: 60, // docs usage-limits $/mes limit
  },
  {
    id: `${OPENCODE_GO_PREFIX}minimax-m2.5`,
    name: 'MiniMax M2.5',
    description:
      'MiniMax generation. 200K context, messages transport (phase-2).',
    context_length: 204800,
    pricing: { prompt: '0.0000003', completion: '0.0000012' }, // $0.30 / $1.20 per 1M (docs read wins: 0.06)
    transport: 'messages',
    sendable: true,
    monthlyLimitUsd: 60, // docs usage-limits $/mes limit
  },
  {
    id: `${OPENCODE_GO_PREFIX}qwen3.8-max`,
    name: 'Qwen3.8 Max',
    description:
      'Qwen generation. 1M context, messages transport (phase-2).',
    context_length: 1000000,
    pricing: { prompt: '0.000002', completion: '0.000006' }, // $2.00 / $6.00 per 1M
    transport: 'messages',
    sendable: true,
    monthlyLimitUsd: 15, // docs usage-limits $/mes limit
  },
  {
    id: `${OPENCODE_GO_PREFIX}qwen3.8-flash`,
    name: 'Qwen3.8 Flash',
    description:
      'Fast Qwen generation. 1M context, messages transport (phase-2).',
    context_length: 1000000,
    pricing: { prompt: '0.00000015', completion: '0.00000047' }, // $0.15 / $0.47 per 1M
    transport: 'messages',
    sendable: true,
    monthlyLimitUsd: 30, // docs usage-limits $/mes limit
  },
  {
    id: `${OPENCODE_GO_PREFIX}qwen3.7-max`,
    name: 'Qwen3.7 Max',
    description:
      'Qwen generation. 1M context, messages transport (phase-2).',
    context_length: 1000000,
    pricing: { prompt: '0.0000025', completion: '0.0000075' }, // $2.50 / $7.50 per 1M
    transport: 'messages',
    sendable: true,
    monthlyLimitUsd: 30, // docs usage-limits $/mes limit
  },
  {
    id: `${OPENCODE_GO_PREFIX}qwen3.7-plus`,
    name: 'Qwen3.7 Plus',
    description:
      'Qwen generation. 1M context, messages transport (phase-2).',
    context_length: 1000000,
    pricing: { prompt: '0.0000004', completion: '0.0000016' }, // base tier <=256K $0.40 / $1.60 per 1M
    transport: 'messages',
    sendable: true,
    monthlyLimitUsd: 60, // docs usage-limits $/mes limit (>256K 1.20/4.80, T2)
  },
  {
    id: `${OPENCODE_GO_PREFIX}qwen3.6-plus`,
    name: 'Qwen3.6 Plus',
    description:
      'Qwen generation. 1M context, messages transport (phase-2).',
    context_length: 1000000,
    pricing: { prompt: '0.0000005', completion: '0.000003' }, // base tier <=256K $0.50 / $3.00 per 1M
    transport: 'messages',
    sendable: true,
    monthlyLimitUsd: 60, // docs usage-limits $/mes limit (>256K 2.00/6.00, T2)
  },
  {
    id: `${OPENCODE_GO_PREFIX}grok-4.6`,
    name: 'Grok-4.6',
    description:
      'Grok generation. 500K context, responses transport (phase-2).',
    context_length: 500000,
    pricing: { prompt: '0.000002', completion: '0.000006' }, // base tier <=200K $2.00 / $6.00 per 1M
    transport: 'responses',
    sendable: true,
    monthlyLimitUsd: 15, // docs usage-limits $/mes limit (>200K x2, T2)
  },
  {
    id: `${OPENCODE_GO_PREFIX}gpt-5.6-luna`,
    name: 'GPT-5.6 Luna',
    description:
      'GPT Luna generation. 1M context, responses transport (phase-2).',
    context_length: 1050000,
    pricing: { prompt: '0.0000002', completion: '0.0000012' }, // base tier <=272K $0.20 / $1.20 per 1M
    transport: 'responses',
    sendable: true,
    monthlyLimitUsd: 15, // docs usage-limits $/mes limit (>272K 0.40/1.80, T2)
  },
  {
    id: `${OPENCODE_GO_PREFIX}muse-spark-1.3-contributor`,
    name: 'Muse Spark 1.3 Contributor',
    description:
      'Muse Spark contributor build. 1M context, responses transport (phase-2).',
    context_length: 1048576,
    pricing: { prompt: '0.0000001', completion: '0.0000002' }, // $0.10 / $0.20 per 1M
    transport: 'responses',
    sendable: true,
    monthlyLimitUsd: 60, // docs usage-limits $/mes limit
  },
  {
    id: `${OPENCODE_GO_PREFIX}muse-spark-1.2-contributor`,
    name: 'Muse Spark 1.2 Contributor',
    description:
      'Muse Spark contributor build. 1M context, responses transport (phase-2).',
    context_length: 1048576,
    pricing: { prompt: '0.0000001', completion: '0.0000002' }, // $0.10 / $0.20 per 1M
    transport: 'responses',
    sendable: true,
    monthlyLimitUsd: 60, // docs usage-limits $/mes limit
  },
  {
    id: `${OPENCODE_GO_PREFIX}grok-4.5`,
    name: 'Grok-4.5',
    description:
      'Grok generation. 500K context, responses transport (phase-2).',
    context_length: 500000,
    pricing: { prompt: '0.000002', completion: '0.000006' }, // api.json base tier <=200K $2 / $6 per 1M
    transport: 'responses',
    sendable: true,
    priceNote: 'Deprecated upstream, sin fila en docs: limite $ mensual desconocido (UNVERIFIED, probe T3 pendiente)',
  },
];

/**
 * Bare ids observable but NOT listable: deprecated api.json rows with no docs
 * endpoint-table row, one api.json-only id missing from live, and two
 * live-only ids with no official metadata. Inventing them context or price is
 * forbidden — they resolve `unknown` (fail-open) until a keyed T3 probe.
 */
export const OPENCODE_GO_LIST_EXCLUDED: ReadonlyMap<string, string> = new Map([
  ['glm-5', 'deprecated en api.json, sin fila en docs endpoint table (UNVERIFIED, probe T3 pendiente)'],
  ['kimi-k2.5', 'deprecated en api.json, sin fila en docs endpoint table (UNVERIFIED, probe T3 pendiente)'],
  ['mimo-v2-omni', 'deprecated en api.json, sin fila en docs endpoint table (UNVERIFIED, probe T3 pendiente)'],
  ['mimo-v2-pro', 'deprecated en api.json, sin fila en docs endpoint table (UNVERIFIED, probe T3 pendiente)'],
  ['omen-alpha', 'deprecated en api.json, sin fila en docs endpoint table (UNVERIFIED, probe T3 pendiente)'],
  ['qwen3.5-plus', 'deprecated en api.json, sin fila en docs endpoint table (UNVERIFIED, probe T3 pendiente)'],
  ['ox-alpha-free', 'deprecated en api.json ($0 "Unlimited"), ausente en live /v1/models: posible retirado (UNVERIFIED, probe T3 pendiente)'],
  ['deepseek-flash', 'sin metadata oficial (UNVERIFIED, probe T3 pendiente)'],
  ['hy3-preview', 'sin metadata oficial (UNVERIFIED, probe T3 pendiente)'],
]);

/** Per-1M-token pricing used to compute cost (Go usage frames carry no `cost` field).
 * Base rows are docs "Usage limits" off-peak $/1M (docs win over api.json:
 * `minimax-m2.5` cached-read 0.06), re-checked live 2026-09-15 ("Last updated:
 * Sep 14, 2026"; DeepSeek V4.1 promo "4x · Ends Sep 20" still active, billed
 * at base until expiry). `write` = docs "Cached Write" $/1M where declared.
 * `tier` = absolute above-threshold row (contextTokens > upToTokens bills
 * `above`; the edge belongs to the base tier; absent contextTokens bills base).
 * Tiers are absolute rows, not one multiplier: qwen3.6-plus is in x4 but out
 * x2, gpt-5.6-luna is out x1.5 but in/read/write x2. `peakDoubles` marks the 4
 * DeepSeek chat rows whose Peak tariff is exactly x2 in/out/read (docs Peak
 * rows VERIFIED live); only those rows read `opts.peak`. */
export interface OpencodeGoPrice {
  inHit: number; // input, cache hit (docs "Cached Read" $/1M)
  inMiss: number; // input, cache miss (docs "Input" $/1M, base rate)
  out: number; // output (docs "Output" $/1M, base rate)
  write?: number; // input creating a cache entry (docs "Cached Write" $/1M)
  tier?: { upToTokens: number; above: { inHit: number; inMiss: number; out: number; write?: number } };
  peakDoubles?: boolean; // DeepSeek only: opts.peak bills in/out/read x2
}

export const OPENCODE_GO_PRICING: Record<string, OpencodeGoPrice> = {
  'glm-5.3-flash': { inHit: 0.03, inMiss: 0.15, out: 0.5 },
  'glm-5.3': { inHit: 0.26, inMiss: 1.4, out: 4.4 },
  'glm-5.2': { inHit: 0.26, inMiss: 1.4, out: 4.4 },
  'glm-5.1': { inHit: 0.26, inMiss: 1.4, out: 4.4 },
  'kimi-k3': { inHit: 0.3, inMiss: 3.0, out: 15.0 },
  'kimi-k2.7-code': { inHit: 0.19, inMiss: 0.95, out: 4.0 },
  'kimi-k2.6': { inHit: 0.16, inMiss: 0.95, out: 4.0 },
  'longcat-2.0': { inHit: 0.006, inMiss: 0.3, out: 1.2 },
  'deepseek-v4.1-flash': { inHit: 0.003, inMiss: 0.15, out: 0.6, peakDoubles: true },
  'deepseek-v4-pro': { inHit: 0.022, inMiss: 0.66, out: 1.98, peakDoubles: true },
  'deepseek-v4-flash': { inHit: 0.003, inMiss: 0.15, out: 0.6, peakDoubles: true },
  'deepseek-v4-flash-vision-exp': { inHit: 0.003, inMiss: 0.15, out: 0.6, peakDoubles: true },
  'mimo-v2.5': { inHit: 0.0028, inMiss: 0.14, out: 0.28 },
  'mimo-v2.5-pro': { inHit: 0.003625, inMiss: 0.435, out: 0.87 },
  'hy4-preview': { inHit: 0.042, inMiss: 0.834, out: 2.501 },
  'hy3': { inHit: 0.035, inMiss: 0.14, out: 0.58 },
  'minimax-m3': {
    inHit: 0.06, inMiss: 0.3, out: 1.2,
    tier: { upToTokens: 512000, above: { inHit: 0.12, inMiss: 0.6, out: 2.4 } }, // recipe >512K x2
  },
  'minimax-m2.7': { inHit: 0.06, inMiss: 0.3, out: 1.2, write: 0.375 },
  'minimax-m2.5': { inHit: 0.06, inMiss: 0.3, out: 1.2, write: 0.375 },
  'qwen3.8-max': { inHit: 0.25, inMiss: 2.0, out: 6.0, write: 2.5 },
  'qwen3.8-flash': { inHit: 0.016, inMiss: 0.15, out: 0.47, write: 0.2 },
  'qwen3.7-max': { inHit: 0.5, inMiss: 2.5, out: 7.5, write: 3.125 },
  'qwen3.7-plus': {
    inHit: 0.04, inMiss: 0.4, out: 1.6, write: 0.5,
    tier: { upToTokens: 256000, above: { inHit: 0.12, inMiss: 1.2, out: 4.8, write: 1.5 } },
  },
  'qwen3.6-plus': {
    inHit: 0.05, inMiss: 0.5, out: 3.0, write: 0.625,
    tier: { upToTokens: 256000, above: { inHit: 0.2, inMiss: 2.0, out: 6.0, write: 2.5 } },
  },
  'grok-4.6': {
    inHit: 0.5, inMiss: 2.0, out: 6.0,
    tier: { upToTokens: 200000, above: { inHit: 1.0, inMiss: 4.0, out: 12.0 } },
  },
  'gpt-5.6-luna': {
    inHit: 0.02, inMiss: 0.2, out: 1.2, write: 0.25,
    tier: { upToTokens: 272000, above: { inHit: 0.04, inMiss: 0.4, out: 1.8, write: 0.5 } },
  },
  'muse-spark-1.3-contributor': { inHit: 0.002, inMiss: 0.1, out: 0.2 },
  'muse-spark-1.2-contributor': { inHit: 0.002, inMiss: 0.1, out: 0.2 },
  'grok-4.5': {
    inHit: 0.3, inMiss: 2.0, out: 6.0, // api.json-only, no docs row (UNVERIFIED, probe T3 pendiente)
    tier: { upToTokens: 200000, above: { inHit: 0.6, inMiss: 4.0, out: 12.0 } },
  },
};

export interface OpencodeGoUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  prompt_cache_write_tokens?: number; // input tokens creating a cache entry (T4/T5 map Anthropic cache_creation_input_tokens here)
}

export interface OpencodeGoCostOpts {
  contextTokens?: number; // request context size: picks the tier (absent = base tier, never fails)
  peak?: boolean; // DeepSeek Peak window: x2 in/out/read on peakDoubles rows, ignored elsewhere
}

/**
 * Best-effort cost (USD) for an OpenCode Go response, using the static price
 * table and the cache hit/miss/write token split. Write tokens are input that
 * created cache (priced at the row `write` rate, else at `inMiss`) and are
 * never double-counted inside miss. Returns 0 for unknown models or
 * absent usage. Callers only use it when `usage.cost === undefined` — the
 * upstream value, if ever present, is never overwritten.
 */
export function computeOpencodeGoCost(
  usage: OpencodeGoUsage | null | undefined,
  upstreamModel: string,
  opts?: OpencodeGoCostOpts,
): number {
  const price = OPENCODE_GO_PRICING[upstreamModel];
  if (!price || !usage) return 0;
  let inHit = price.inHit;
  let inMiss = price.inMiss;
  let out = price.out;
  let write = price.write;
  if (price.tier && opts?.contextTokens !== undefined && opts.contextTokens > price.tier.upToTokens) {
    inHit = price.tier.above.inHit;
    inMiss = price.tier.above.inMiss;
    out = price.tier.above.out;
    write = price.tier.above.write;
  }
  if (price.peakDoubles && opts?.peak) {
    inHit *= 2;
    inMiss *= 2;
    out *= 2;
  }
  const hit = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  const created = Math.max(usage.prompt_cache_write_tokens ?? 0, 0);
  const miss = usage.prompt_cache_miss_tokens ?? Math.max((usage.prompt_tokens ?? 0) - hit - created, 0);
  const outTokens = usage.completion_tokens ?? 0;
  return (hit * inHit + miss * inMiss + created * (write ?? inMiss) + outTokens * out) / 1_000_000;
}

/** Cache-hit tokens from a Go usage object (for the app's cached_tokens metric). */
export function opencodeGoCachedTokens(usage: OpencodeGoUsage | null | undefined): number {
  if (!usage) return 0;
  return usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
}

/**
 * Bare ids whose trace replays as `reasoning_content` (api.json `opencode-go`
 * `interleaved.field: reasoning_content`, fetched 2026-09-15; plan D5). Every
 * other Go model replays as `reasoning`. Phase-1 sends no reasoning field;
 * this only names the history-replay field (T3/T4).
 */
export const OPENCODE_GO_REASONING_CONTENT_MODELS: ReadonlySet<string> = new Set([
  'longcat-2.0',
  'deepseek-v4-flash-vision-exp',
  'kimi-k2.6',
  'glm-5.2',
  'deepseek-v4-flash',
  'kimi-k2.7-code',
  'ox-alpha-free',
  'deepseek-v4.1-flash',
  'omen-alpha',
  'kimi-k3',
  'glm-5.3-flash',
  'mimo-v2-pro',
  'glm-5',
  'mimo-v2-omni',
  'kimi-k2.5',
  'glm-5.1',
  'deepseek-v4-pro',
  'glm-5.3',
  'mimo-v2.5',
  'mimo-v2.5-pro',
]);

/** History-replay reasoning field for a Go model (accepts bare or namespaced id). */
export function opencodeGoHistoryReasoningField(upstreamModel: string): 'reasoning' | 'reasoning_content' {
  const bare = upstreamModel.startsWith(OPENCODE_GO_PREFIX)
    ? upstreamModel.slice(OPENCODE_GO_PREFIX.length)
    : upstreamModel;
  return OPENCODE_GO_REASONING_CONTENT_MODELS.has(bare) ? 'reasoning_content' : 'reasoning';
}
