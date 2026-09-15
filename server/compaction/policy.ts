/**
 * Compaction policy: budgets, model windows, estimator, suggest/thrash rules (pure).
 *
 * Window numbers mirror the `context_length` values in
 * server/providers/index.ts (DEEPSEEK_CATALOG, ABLITERATION_CATALOG,
 * ARNICT_CATALOG) — read from source, not from memory.
 */

// NOTE: the OpenCode keep-budget constants (default 8000, clamp 2000–15000)
// are gone with the verbatim tail — a checkpoint now archives the WHOLE
// visible slice since the previous on-thread checkpoint (see
// server/compaction/serialize.ts header). `keep_tokens` stays accepted on the
// route for wire compatibility, but it no longer selects anything.

// OpenCode safety reserve below the explicit input limit (G12/§6.4).
export const COMPACTION_BUFFER = 20000;

// OpenCode serializer truncation budget (G5).
export const TOOL_OUTPUT_MAX_CHARS = 2000;

// G4: THE max_tokens the route will send for the summary call (hard ceiling).
export const SUMMARY_MAX_TOKENS = 4096;

// UX gloss: proactive nudge ~60%, auto-fire ceiling ~90% (Codex 90% cap).
export const SUGGEST_PCT = 0.6;
export const AUTO_FIRE_PCT = 0.9;

// G12 v1 scope: estimator + advisory + counters ship, but auto-fire is
// explicitly deferred and MUST stay disabled. Reasons: `openrouter/*` ids (the
// majority of real conversations) have no reliable window; firing on a guessed
// window either burns calls or truncates silently; the recipe's own rule
// forbids auto-fire without a known limit. Unknown limit → limit:null,
// advisory off, manual /compact always allowed.
export const AUTO_COMPACT_ENABLED = false;

/**
 * Known model context windows. Everything else — including `openrouter/*`,
 * `codex:*`, and `llamacpp:*` ids — resolves to null (unknown: never auto-fire,
 * manual /compact still allowed).
 */
export const MODEL_WINDOWS: Record<string, number | null> = {
  'deepseek:deepseek-v4-flash': 1_000_000,
  'deepseek:deepseek-v4-pro': 1_000_000,
  'abliteration:abliterated-model': 262144,
  'abliteration:abliterated-model-large': 1_000_000,
  'abliteration:abliterated-model-large-v2': 1_000_000,
  'arnict:zai/glm-5.3-flash-uncensored': 1048576,
  'arnict:qwen/qwen3.8-27b': 262144,
};

/** Known window for a namespaced model id, or null when unknown. */
export function resolveWindow(modelId: string): number | null {
  if (typeof modelId !== 'string') return null;
  return MODEL_WINDOWS[modelId] ?? null;
}

// NOTE: token math mirrors the frozen `estimateTokens(text) = ceil(chars/4)`
// contract from sibling wave-1 module server/compaction/serialize.ts (G5: no
// tokenizer dependency). Duplicated here instead of a static import so this
// wave-1 module stays parallel-safe when the sibling is still mid-flight; both
// must keep the identical `ceil(chars/4)` formula.

/** Rough context estimate in tokens: ceil of total chars / 4 (G5). */
export function estimateContextUsage(
  systemChars: number,
  headChars: number,
  tailChars: number,
  toolsChars: number,
): number {
  return Math.ceil((systemChars + headChars + tailChars + toolsChars) / 4);
}

/**
 * OpenCode buffer rule: suggest when the estimate reaches the usable window
 * minus the safety reserve. `modelOutputHint` defaults to 4096 (same order as
 * SUMMARY_MAX_TOKENS); the reserve is max(hint, COMPACTION_BUFFER), so with
 * defaults the threshold is limit - 20000. Unknown limit (null) never suggests.
 */
export function shouldSuggest(
  tokens: number,
  limit: number | null,
  modelOutputHint = 4096,
): boolean {
  if (limit == null) return false;
  return tokens >= limit - Math.max(modelOutputHint, COMPACTION_BUFFER);
}

/** Claude thrash-guard shape: 3 immediate refills stop auto (G12 counts it). */
export function thrashStatus(consecutiveRefills: number): 'ok' | 'warn' | 'stop' {
  if (consecutiveRefills >= 3) return 'stop';
  if (consecutiveRefills >= 2) return 'warn';
  return 'ok';
}

/** Codex accuracy-warning copy: warn from the 2nd checkpoint on. */
export function needsAccuracyWarning(compactionCount: number): boolean {
  return compactionCount >= 2;
}
