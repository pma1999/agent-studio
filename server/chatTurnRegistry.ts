/**
 * In-memory registry of live chat turns.
 *
 * Single-instance reality (one Node process per deployment): turn lifecycle
 * truth in the DB is `conversations.active_turn_id` + draft
 * `messages.generation_status`; this registry is the process-memory side that
 * lets Stop / orphan-timeout / shutdown reach the exact in-flight turn.
 *
 * Guarantees:
 * - `onAbort` fires synchronously (better-sqlite3 lets abort paths finalize
 *   drafts with plain synchronous writes) and at most once per turn.
 * - A turn is detached from every map BEFORE its callback runs, so double
 *   aborts are single-fire and late timers/clears are inert no-ops.
 * - Every timer is unref'd so a pending orphan timeout can never hang the
 *   process or the test suite.
 */

export interface ActiveTurn {
  turnId: string;
  userId: string;
  conversationId: string;
  controller: AbortController;
  onAbort: (reason: 'stop' | 'orphan-timeout' | 'shutdown') => void;
}

type AbortReason = 'stop' | 'orphan-timeout' | 'shutdown';

const DEFAULT_ORPHAN_TURN_TIMEOUT_MS = 600_000; // 10 minutes

/** Read once at module load; overridable for tests via setOrphanTimeoutForTests. */
function resolveInitialTimeoutMs(): number {
  const raw = process.env.CHAT_ORPHAN_TURN_TIMEOUT_MS;
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    console.warn(`[chatTurnRegistry] Ignoring invalid CHAT_ORPHAN_TURN_TIMEOUT_MS="${raw}"`);
  }
  return DEFAULT_ORPHAN_TURN_TIMEOUT_MS;
}

let orphanTurnTimeoutMs = resolveInitialTimeoutMs();

const turns = new Map<string, ActiveTurn>();
const turnsByConversation = new Map<string, string>();
const orphanTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelOrphanTimer(turnId: string): void {
  const timer = orphanTimers.get(turnId);
  if (timer !== undefined) {
    clearTimeout(timer);
    orphanTimers.delete(turnId);
  }
}

/** Remove a turn from all maps + cancel its timer. Returns the detached turn. */
function detachTurn(turnId: string): ActiveTurn | undefined {
  cancelOrphanTimer(turnId);
  const turn = turns.get(turnId);
  if (!turn) return undefined;
  turns.delete(turnId);
  if (turnsByConversation.get(turn.conversationId) === turnId) {
    turnsByConversation.delete(turn.conversationId);
  }
  return turn;
}

/**
 * Finalize an aborted turn: run its registered callback first, synchronously,
 * so drafts are flushed/finalized before anything else observes the aborted
 * signal; then abort the controller to cancel any remaining upstream work.
 * A throwing onAbort must not skip the controller abort nor break sibling
 * turns during shutdown.
 */
function finalizeAbortedTurn(turn: ActiveTurn, reason: AbortReason): void {
  try {
    turn.onAbort(reason);
  } catch (error) {
    console.error(`[chatTurnRegistry] onAbort(${reason}) failed for turn ${turn.turnId}:`, error);
  }
  turn.controller.abort();
}

export function registerTurn(turn: ActiveTurn): boolean {
  if (turns.has(turn.turnId)) {
    return false;
  }
  turns.set(turn.turnId, turn);
  turnsByConversation.set(turn.conversationId, turn.turnId);
  return true;
}

/**
 * The last client went away: start (or restart) the one-shot orphan grace
 * timer for this turn. Re-marking cancels the previous timer instead of
 * stacking a second one.
 */
export function markTurnDisconnected(turnId: string): void {
  if (!turns.has(turnId)) {
    return;
  }
  cancelOrphanTimer(turnId);
  const timer = setTimeout(() => {
    orphanTimers.delete(turnId);
    const turn = detachTurn(turnId);
    if (turn) {
      finalizeAbortedTurn(turn, 'orphan-timeout');
    }
  }, orphanTurnTimeoutMs);
  timer.unref();
  orphanTimers.set(turnId, timer);
}

export function findTurnByConversation(conversationId: string): ActiveTurn | undefined {
  const turnId = turnsByConversation.get(conversationId);
  return turnId === undefined ? undefined : turns.get(turnId);
}

/** Explicit stop / orphan-timeout. Returns false when the turn is unknown. */
export function abortTurn(turnId: string, reason: 'stop' | 'orphan-timeout'): boolean {
  const turn = detachTurn(turnId);
  if (!turn) {
    return false;
  }
  finalizeAbortedTurn(turn, reason);
  return true;
}

/** Normal turn completion: forget the turn and kill any pending orphan timer. */
export function clearTurn(turnId: string): void {
  detachTurn(turnId);
}

/** Shutdown hook target: abort every live turn exactly once. */
export function abortAllTurns(): void {
  const pending = [...turns.values()];
  turns.clear();
  turnsByConversation.clear();
  for (const timer of orphanTimers.values()) {
    clearTimeout(timer);
  }
  orphanTimers.clear();
  for (const turn of pending) {
    finalizeAbortedTurn(turn, 'shutdown');
  }
}

/** Test-only: override the orphan grace period for fast timer tests. */
export function setOrphanTimeoutForTests(ms: number): void {
  orphanTurnTimeoutMs = ms;
}
