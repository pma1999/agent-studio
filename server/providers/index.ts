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

import { providerOfModelId, upstreamIdOf, type ProviderId } from '../../shared/models/providers.js';

export type { ProviderId };

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
  supportsJsonSchema: true,
};

/**
 * Arnict (Direct). OpenAI-compatible `POST /v1/chat/completions` relayed
 * server-side with `Authorization: Bearer <key>`. Full-parity send allowlist:
 * model/messages/temperature/top_p/stop/max_tokens|XOR/stream/stream_options,
 * tools/tool_choice/parallel_tool_calls (OpenAI shape), response_format
 * json_schema (strict:true) via `supportsJsonSchema:true`, reasoning object
 * `{enabled,effort}` from the shared reasoning wire; never provider/plugins
 * or top-level reasoning fields.
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
  supportsJsonSchema: true,
};

/**
 * OpenCode Go (Direct). Gateway rooted at `OPENCODE_GO_BASE_URL` with
 * `Authorization: Bearer <key>` plus a `User-Agent` operational header.
 * `chatCompletionsUrl` is only the default wire: each model's transport comes
 * from the catalog (chat, Anthropic-shape `/messages` or `/responses`), and a
 * wrong wire can fail as an opaque 500, so it is never guessed.
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
  // Legacy `lmstudio:` ids resolve to the removed provider (rejected downstream), NEVER to openrouter.
  return providerOfModelId(modelId);
}

/** Strips the provider scheme prefix, yielding the id the upstream API expects. */
export function toUpstreamModelId(modelId: string): string {
  return upstreamIdOf(modelId);
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

/** Guard message when image content targets a model whose catalog inputs exclude images. */
export function textOnlyModelMessage(modelName: string): string {
  return `${modelName} is text-only; choose a model that accepts images for image content.`;
}

export function getProviderConfig(id: ProviderId): ProviderConfig {
  return CONFIGS[id];
}

/** Convenience: resolve a model id straight to its provider config. */
export function getProviderForModel(modelId: string | null | undefined): ProviderConfig {
  return CONFIGS[resolveProviderId(modelId)];
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
// OpenCode Go non-chat wires. Model lists, transports, prices and reasoning
// capabilities come from the model catalog (server/catalog); only the fixed
// endpoint facts and user-facing error text live here.
// ---------------------------------------------------------------------------

export const OPENCODE_GO_MESSAGES_URL = `${OPENCODE_GO_BASE_URL}/messages`;
export const OPENCODE_GO_RESPONSES_URL = `${OPENCODE_GO_BASE_URL}/responses`;
/** `anthropic-version` header value required on `POST /messages` (verified 2026-09-15). */
export const OPENCODE_GO_ANTHROPIC_VERSION = '2023-06-01';

/** Error text when OpenCode Go rejects a model on the wire the catalog chose. */
export function opencodeGoFormatMismatchMessage(upstream: string, detail: string): string {
  return `OpenCode Go rejected model ${upstream} on the ${detail ? `requested transport (${detail})` : 'requested transport'}. The model may need a different API format; pick one from the model list or refresh it.`;
}
