/**
 * Frontend mirror of the backend provider scheme (server/providers/index.ts).
 *
 * DeepSeek-direct models are namespaced with a `deepseek:` prefix, ChatGPT
 * (Codex) models with a `codex:` prefix, and local llama.cpp models with an
 * `llamacpp:` prefix, so a single `model` string carries its provider. This
 * module is the one place the UI needs to recognise those schemes — for
 * grouping, display, and disabling OpenRouter-only affordances (provider
 * routing).
 */

export const DEEPSEEK_PREFIX = 'deepseek:';
export const CODEX_PREFIX = 'codex:';
export const LLAMACPP_PREFIX = 'llamacpp:';

/** Synthetic author/group key used by the model selector for DeepSeek-direct models. */
export const DEEPSEEK_DIRECT_GROUP = 'deepseek-direct';

/** Synthetic author/group key used by the model selector for ChatGPT (Codex) models. */
export const CODEX_DIRECT_GROUP = 'codex-chatgpt';

/** Synthetic author/group key used by the model selector for llama.cpp (local) models. */
export const LLAMACPP_GROUP = 'llamacpp-local';

/** Brand accent for the DeepSeek-direct provider. */
export const DEEPSEEK_ACCENT = '#4D6BFE';

/** Brand accent for the ChatGPT (Codex) provider. */
export const CODEX_ACCENT = '#10a37f';

/** Brand accent for the llama.cpp (local) provider. */
export const LLAMACPP_ACCENT = '#ca8a04';

/**
 * Browser event fired by the Settings panel after a llama.cpp config save,
 * status test, start, or stop so live consumers (catalog hook) can refresh.
 * Shared from here (not the hook) so SettingsPanel/LlamaCppSection and
 * useLlamaCppModels import one source.
 */
export const LLAMACPP_STATUS_CHANGED_EVENT = 'llamacpp:status-changed';

export function isDeepSeekDirectModel(modelId: string | null | undefined): boolean {
  return typeof modelId === 'string' && modelId.startsWith(DEEPSEEK_PREFIX);
}

export function isCodexModel(modelId: string | null | undefined): boolean {
  return typeof modelId === 'string' && modelId.startsWith(CODEX_PREFIX);
}

export function isLlamaCppModel(modelId: string | null | undefined): boolean {
  return typeof modelId === 'string' && modelId.startsWith(LLAMACPP_PREFIX);
}

/**
 * Legacy guard (plan.md D8): ids of the REMOVED previous local provider stay
 * out of every pickable selector list, while conversations that still hold one
 * keep rendering their history labels and surface the server's removal error
 * on send. The prefix literal is assembled at runtime so this file keeps the
 * exhaustive removal-sweep grep clean — this helper is the single intentional
 * reference to that removed scheme in src/.
 */
const REMOVED_LOCAL_PROVIDER_PREFIX = ['lm', 'studio:'].join('');

export function isRemovedLocalProviderId(modelId: string | null | undefined): boolean {
  return typeof modelId === 'string' && modelId.startsWith(REMOVED_LOCAL_PROVIDER_PREFIX);
}

/** Strips the `deepseek:` scheme for display (e.g. `deepseek:deepseek-v4-flash` → `deepseek-v4-flash`). */
export function stripDeepSeekPrefix(modelId: string): string {
  return modelId.startsWith(DEEPSEEK_PREFIX) ? modelId.slice(DEEPSEEK_PREFIX.length) : modelId;
}

/** Strips the `codex:` scheme for display (e.g. `codex:gpt-5.1-codex` → `gpt-5.1-codex`). */
export function stripCodexPrefix(modelId: string): string {
  return modelId.startsWith(CODEX_PREFIX) ? modelId.slice(CODEX_PREFIX.length) : modelId;
}

/** Strips the `llamacpp:` scheme (e.g. `llamacpp:Qwen3.6-35B` → `Qwen3.6-35B`). */
export function stripLlamaCppPrefix(modelId: string): string {
  return modelId.startsWith(LLAMACPP_PREFIX) ? modelId.slice(LLAMACPP_PREFIX.length) : modelId;
}
