import type { ArtifactKind, ChatArtifact } from '../types';

/**
 * Pure helpers for artifact wiring — node-only testable (no DOM deps).
 * Extracted for `scripts/test-artifact-wiring.ts` coverage and reuse in ChatView.
 * Gallery helpers (sort/filter/search/truncate/relative-time) are pure client-side
 * (no DOM, no zustand, no fetch) and testable with `tsx` headless.
 */

/** Build messageId -> artifacts map from a flat array (ignores artifacts without message_id). */
export function buildArtifactsByMessageIndex(artifacts: ChatArtifact[]): Map<string, ChatArtifact[]> {
  const map = new Map<string, ChatArtifact[]>();
  for (const art of artifacts) {
    if (!art.message_id) continue;
    const list = map.get(art.message_id);
    if (list) list.push(art);
    else map.set(art.message_id, [art]);
  }
  return map;
}

/**
 * Clamp panel width percentage to [30, 60]. Returns 38 for non-finite inputs
 * (38 is the default pct per T5 brief).
 */
export function clampPanelPct(n: number): number {
  if (!Number.isFinite(n)) return 38;
  return Math.min(60, Math.max(30, n));
}

/**
 * Auto-open rule: open the panel on the first artifact of a turn if
 * it wasn't already open and we haven't already auto-opened this turn.
 */
export function shouldAutoOpenPanel(panelOpen: boolean, alreadyOpenedThisTurn: boolean): boolean {
  return !panelOpen && !alreadyOpenedThisTurn;
}

/**
 * Sort artifacts by `updated_at` ISO string.
 * - `dir` defaults to `'asc'` (server `listConversationArtifacts` order).
 * - Stable: preserves input order when timestamps are equal.
 * - Does not mutate input (returns a shallow copy).
 * - Invalid ISO dates are treated as the smallest value (-Infinity), no throw.
 */
export function sortArtifactsByUpdatedAt(
  artifacts: ChatArtifact[],
  dir: 'asc' | 'desc' = 'asc',
): ChatArtifact[] {
  const copy = [...artifacts];
  // Pair with original index for stability and parsed timestamp
  const withMeta = copy.map((art, idx) => {
    const parsed = Date.parse(art.updated_at);
    const ts = Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
    return { art, idx, ts };
  });
  withMeta.sort((a, b) => {
    if (a.ts !== b.ts) return dir === 'asc' ? a.ts - b.ts : b.ts - a.ts;
    return a.idx - b.idx;
  });
  return withMeta.map((m) => m.art);
}

/**
 * Filter artifacts by exact `kind`. `'all'` returns a shallow copy without filtering.
 * Does not mutate input.
 */
export function filterArtifactsByKind(
  artifacts: ChatArtifact[],
  kind: ArtifactKind | 'all',
): ChatArtifact[] {
  if (kind === 'all') return [...artifacts];
  return artifacts.filter((a) => a.kind === kind);
}

/**
 * Case-insensitive substring search over `title`.
 * - Trims `query`; empty after trim => shallow copy of `artifacts` (no filter).
 * - No regex; special chars like `.*+?` are treated literally, no throw.
 * - Does not mutate input.
 */
export function searchArtifactsByTitle(artifacts: ChatArtifact[], query: string): ChatArtifact[] {
  const trimmed = query.trim();
  if (!trimmed) return [...artifacts];
  const lower = trimmed.toLowerCase();
  return artifacts.filter((a) => a.title.toLowerCase().includes(lower));
}

/**
 * Truncate `title` to `max` chars (default 64) with `…` if it exceeds `max`.
 * Server enforces `MAX_ARTIFACT_TITLE_CHARS=120`; this helper is visual-only.
 * Does not mutate input; empty string returns `""`.
 */
export function truncateTitle(title: string, max = 64): string {
  if (!title) return title;
  if (title.length <= max) return title;
  return title.slice(0, max) + '…';
}

/**
 * Format ISO `updated_at` as relative time in Spanish (with English "just now" for <60s).
 * - `<60s`            => "just now"
 * - `<60m`            => "hace ${m}m"
 * - `<24h`            => "hace ${h}h"
 * - `>=24h`           => "hace ${d}d"
 * - Invalid ISO       => "" (no throw)
 * - Future (`nowMs < parsed`) => "just now"
 * - `nowMs` is injectable for deterministic tests (defaults to `Date.now()`).
 */
export function formatRelativeTime(iso: string, nowMs: number = Date.now()): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return '';
  const diff = nowMs - parsed;
  if (diff < 0) return 'just now';
  if (diff < 60 * 1000) return 'just now';
  if (diff < 60 * 60 * 1000) return `hace ${Math.floor(diff / (60 * 1000))}m`;
  if (diff < 24 * 60 * 60 * 1000) return `hace ${Math.floor(diff / (60 * 60 * 1000))}h`;
  return `hace ${Math.floor(diff / (24 * 60 * 60 * 1000))}d`;
}
