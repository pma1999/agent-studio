/**
 * Compaction policy: budgets, estimator, suggest/thrash rules (pure).
 *
 * Model context windows come from the model catalog (`CatalogModel.contextLength`);
 * callers resolve them and pass the number in.
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
// explicitly deferred and MUST stay disabled: firing on a stale or guessed
// window either burns calls or truncates silently, and the recipe's own rule
// forbids auto-fire without a known limit. Unknown limit → limit:null,
// advisory off, manual /compact always allowed.
export const AUTO_COMPACT_ENABLED = false;

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
