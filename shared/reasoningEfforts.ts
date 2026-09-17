/**
 * Canonical reasoning-effort vocabulary, ordering, filtering and clamping.
 *
 * Single owner of the effort order (`REASONING_EFFORT_ORDER`) and of the two
 * pure rules every consumer must agree on: which efforts a model supports
 * (`filterSupportedEfforts`) and which effort is actually sent when the
 * requested one does not apply (`clampReasoningEffort`). The UI hint and the
 * server pre-flight clamp share this module so they can never diverge.
 *
 * Zero-dependency by design (no imports from `server/` or `src/`) so both the
 * backend (`server/routes/*.ts`, suffix `.js` import) and the client can
 * import it via relative path. Precedent: `shared/commandSafety.ts`.
 *
 * Vocabulary note: the value is `max` ("Ultra" is only a UI label). The
 * literal `'ultra'` does not exist; it is never compared, whitelisted, or
 * returned by this module.
 */

/** Canonical order, low → high. Frozen: cross-task contract (T2/T3). */
export const REASONING_EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Any value the repo accepts as a reasoning effort, on or off. */
export type ReasoningEffortValue = (typeof REASONING_EFFORT_ORDER)[number] | 'none';

const ORDER_INDEX: ReadonlyMap<string, number> = new Map(
  REASONING_EFFORT_ORDER.map((value, index) => [value, index]),
);

/** True for the 6 ordered efforts plus `'none'`; false for `'ultra'` and any other garbage. */
export function isReasoningEffort(v: unknown): v is ReasoningEffortValue {
  return typeof v === 'string' && (v === 'none' || ORDER_INDEX.has(v));
}

/**
 * Keep only known vocabulary, in canonical order, deduplicated.
 *
 * - `null`/`undefined` (unknown — model absent, cold cache, no list) → `null`
 *   (callers show all 6 / fail open).
 * - `[]` → `[]` (known: no valued effort applies).
 * - Upstream garbage (including `'ultra'`) is discarded, so it never appears
 *   in the output. `'none'`, if ever present upstream, sorts first.
 */
export function filterSupportedEfforts(
  supported: readonly string[] | null | undefined,
): ReasoningEffortValue[] | null {
  if (supported == null) return null;
  const seen = new Set<ReasoningEffortValue>();
  for (const value of supported) {
    if (isReasoningEffort(value)) seen.add(value);
  }
  const rank = (value: ReasoningEffortValue): number =>
    value === 'none' ? -1 : (ORDER_INDEX.get(value) ?? -1);
  return [...seen].sort((a, b) => rank(a) - rank(b));
}

type OrderedEffort = (typeof REASONING_EFFORT_ORDER)[number];

/**
 * Resolve the effort to actually send.
 *
 * - `'none'` → `'none'`; absent (`null`/`undefined`) → `null` (passthrough:
 *   nothing requested, nothing to clamp).
 * - Unknown list (`null`/`undefined`) → requested as-is (fail-open: cold
 *   cache, `openrouter/auto`, legacy values and new models never break a turn).
 * - Known-empty list (`[]`, or only garbage/`'none'` upstream) + a valued
 *   effort → `null` (omit `effort`, i.e. bare `{enabled:true}`).
 * - Valid but unsupported → nearest supported below, else nearest above.
 * - Garbage (outside the union, e.g. `'ultra'`) + known list → `'medium'` when
 *   supported, else the central element, floored (`sorted[floor((n-1)/2)]`) —
 *   deterministic for any input.
 */
export function clampReasoningEffort(
  requested: string | null | undefined,
  supported: readonly string[] | null | undefined,
): string | null {
  if (requested == null) return null;
  if (requested === 'none') return 'none';
  const filtered = filterSupportedEfforts(supported);
  if (filtered === null) return requested;
  const levels = filtered.filter((v): v is OrderedEffort => v !== 'none');
  if (levels.length === 0) return null;
  if (ORDER_INDEX.has(requested)) {
    if (levels.includes(requested as OrderedEffort)) return requested;
    const index = ORDER_INDEX.get(requested) ?? 0;
    let lower: OrderedEffort | null = null;
    for (const level of levels) {
      if ((ORDER_INDEX.get(level) ?? 0) < index) lower = level;
    }
    if (lower !== null) return lower;
    return levels[0];
  }
  if (levels.includes('medium')) return 'medium';
  return levels[Math.floor((levels.length - 1) / 2)];
}

