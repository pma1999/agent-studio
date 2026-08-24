/**
 * Frontend mirror of the backend provider scheme (server/providers/index.ts).
 *
 * DeepSeek-direct models are namespaced with a `deepseek:` prefix and ChatGPT
 * (Codex) models with a `codex:` prefix, so a single `model` string carries its
 * provider. This module is the one place the UI needs to recognise those
 * schemes — for grouping, display, and disabling OpenRouter-only affordances
 * (provider routing).
 */

export const DEEPSEEK_PREFIX = 'deepseek:';
export const CODEX_PREFIX = 'codex:';
export const LMSTUDIO_PREFIX = 'lmstudio:';

/** Synthetic author/group key used by the model selector for DeepSeek-direct models. */
export const DEEPSEEK_DIRECT_GROUP = 'deepseek-direct';

/** Synthetic author/group key used by the model selector for ChatGPT (Codex) models. */
export const CODEX_DIRECT_GROUP = 'codex-chatgpt';

/** Synthetic author/group key used by the model selector for LM Studio (local) models. */
export const LMSTUDIO_GROUP = 'lmstudio-local';

/** Brand accent for the DeepSeek-direct provider. */
export const DEEPSEEK_ACCENT = '#4D6BFE';

/** Brand accent for the ChatGPT (Codex) provider. */
export const CODEX_ACCENT = '#10a37f';

/** Brand accent for the LM Studio (local) provider. */
export const LMSTUDIO_ACCENT = '#7c3aed';

/**
 * Browser event fired by the Settings panel after an LM Studio save, connection
 * test, or model load so live consumers (catalog hook) can refresh. Shared from
 * here (not the hook) so SettingsPanel and useLmStudioModels import one source.
 */
export const LMSTUDIO_STATUS_CHANGED_EVENT = 'lmstudio:status-changed';

export function isDeepSeekDirectModel(modelId: string | null | undefined): boolean {
  return typeof modelId === 'string' && modelId.startsWith(DEEPSEEK_PREFIX);
}

export function isCodexModel(modelId: string | null | undefined): boolean {
  return typeof modelId === 'string' && modelId.startsWith(CODEX_PREFIX);
}

export function isLmStudioModel(modelId: string | null | undefined): boolean {
  return typeof modelId === 'string' && modelId.startsWith(LMSTUDIO_PREFIX);
}

/** Strips the `deepseek:` scheme for display (e.g. `deepseek:deepseek-v4-flash` → `deepseek-v4-flash`). */
export function stripDeepSeekPrefix(modelId: string): string {
  return modelId.startsWith(DEEPSEEK_PREFIX) ? modelId.slice(DEEPSEEK_PREFIX.length) : modelId;
}

/** Strips the `codex:` scheme for display (e.g. `codex:gpt-5.1-codex` → `gpt-5.1-codex`). */
export function stripCodexPrefix(modelId: string): string {
  return modelId.startsWith(CODEX_PREFIX) ? modelId.slice(CODEX_PREFIX.length) : modelId;
}

/** Strips the `lmstudio:` scheme (e.g. `lmstudio:qwen3-8b` → `qwen3-8b`). */
export function stripLmStudioPrefix(modelId: string): string {
  return modelId.startsWith(LMSTUDIO_PREFIX) ? modelId.slice(LMSTUDIO_PREFIX.length) : modelId;
}
