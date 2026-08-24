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

export type ProviderId = 'openrouter' | 'deepseek' | 'codex' | 'lmstudio' | 'llamacpp';

export const DEEPSEEK_PREFIX = 'deepseek:';
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
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
};

/** Returns the provider that should serve a given namespaced model id. */
export function resolveProviderId(modelId: string | null | undefined): ProviderId {
  if (typeof modelId === 'string' && modelId.startsWith(DEEPSEEK_PREFIX)) return 'deepseek';
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
  if (providerId === 'deepseek' || providerId === 'lmstudio' || providerId === 'llamacpp') return effectiveModel;
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
