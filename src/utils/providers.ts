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

/** Synthetic author/group key used by the model selector for DeepSeek-direct models. */
export const DEEPSEEK_DIRECT_GROUP = 'deepseek-direct';

/** Synthetic author/group key used by the model selector for ChatGPT (Codex) models. */
export const CODEX_DIRECT_GROUP = 'codex-chatgpt';

/** Brand accent for the DeepSeek-direct provider. */
export const DEEPSEEK_ACCENT = '#4D6BFE';

/** Brand accent for the ChatGPT (Codex) provider. */
export const CODEX_ACCENT = '#10a37f';

export function isDeepSeekDirectModel(modelId: string | null | undefined): boolean {
  return typeof modelId === 'string' && modelId.startsWith(DEEPSEEK_PREFIX);
}

export function isCodexModel(modelId: string | null | undefined): boolean {
  return typeof modelId === 'string' && modelId.startsWith(CODEX_PREFIX);
}

/** Strips the `deepseek:` scheme for display (e.g. `deepseek:deepseek-v4-flash` → `deepseek-v4-flash`). */
export function stripDeepSeekPrefix(modelId: string): string {
  return modelId.startsWith(DEEPSEEK_PREFIX) ? modelId.slice(DEEPSEEK_PREFIX.length) : modelId;
}

/** Strips the `codex:` scheme for display (e.g. `codex:gpt-5.1-codex` → `gpt-5.1-codex`). */
export function stripCodexPrefix(modelId: string): string {
  return modelId.startsWith(CODEX_PREFIX) ? modelId.slice(CODEX_PREFIX.length) : modelId;
}
