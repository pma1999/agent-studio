/**
 * Frontend mirror of the backend provider scheme (server/providers/index.ts).
 *
 * DeepSeek-direct models are namespaced with a `deepseek:` prefix so a single
 * `model` string carries its provider. This module is the one place the UI needs
 * to recognise that scheme — for grouping, display, and disabling OpenRouter-only
 * affordances (provider routing).
 */

export const DEEPSEEK_PREFIX = 'deepseek:';

/** Synthetic author/group key used by the model selector for DeepSeek-direct models. */
export const DEEPSEEK_DIRECT_GROUP = 'deepseek-direct';

/** Brand accent for the DeepSeek-direct provider. */
export const DEEPSEEK_ACCENT = '#4D6BFE';

export function isDeepSeekDirectModel(modelId: string | null | undefined): boolean {
  return typeof modelId === 'string' && modelId.startsWith(DEEPSEEK_PREFIX);
}

/** Strips the `deepseek:` scheme for display (e.g. `deepseek:deepseek-v4-flash` → `deepseek-v4-flash`). */
export function stripDeepSeekPrefix(modelId: string): string {
  return modelId.startsWith(DEEPSEEK_PREFIX) ? modelId.slice(DEEPSEEK_PREFIX.length) : modelId;
}
