import type { ChatArtifact } from '../types';

/**
 * Pure helpers for artifact wiring — node-only testable (no DOM deps).
 * Extracted for `scripts/test-artifact-wiring.ts` coverage and reuse in ChatView.
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
