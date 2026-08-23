import { useEffect, useState } from 'react';
import { useStore } from '../stores/store';
import { mcpServersApi } from '../api/client';
import { confirmMcpApproval } from './useChat';

/**
 * Reopen reconciliation (RC4 — plan.md S6): when this conversation has NO local
 * stream entry but the server reports a live turn (`active_turn_id`), poll the
 * read endpoints until the turn closes so the reopened view shows the draft
 * growing with a "generating…" affordance and can still recover pending MCP
 * approvals. GC12: GET endpoints only (messages, conversations list,
 * pending-approvals) on an adaptive schedule 2s × 15 → 4s × 30 → 8s thereafter.
 */

const FAST_INTERVAL_MS = 2_000;
const FAST_TICKS = 15;
const MEDIUM_INTERVAL_MS = 4_000;
const MEDIUM_TICKS = 30;
const SLOW_INTERVAL_MS = 8_000;
/** Refresh the conversations list (titles / updated_at) every Nth poll tick. */
const CONVERSATIONS_REFRESH_EVERY_N_TICKS = 3;
// Transient GET failures (e.g. a 429 from the global limiter) must NOT be read
// as "turn closed": keep polling at the schedule's slowest cadence and give up
// only after this many consecutive failures (~40s). Any success resets the count.
const FAILURE_RETRY_MS = SLOW_INTERVAL_MS;
const MAX_CONSECUTIVE_FAILURES = 5;

export interface TurnReconciliation {
  /** True while the server-side turn for this conversation is being tracked via polling. */
  reconciling: boolean;
}

export function useTurnReconciliation(conversationId: string | null): TurnReconciliation {
  const [reconciling, setReconciling] = useState(false);
  // TR5-02: every piece of loop state lives in THIS effect run's closure, never

  useEffect(() => {
    let disposed = true; // flipped false below once this run is live
    let timerId: number | null = null;
    let tickInFlight = false;
    let completedTicks = 0;
    let consecutiveFailures = 0;
    const shownApprovalIds = new Set<string>();
    disposed = false;
    setReconciling(false);

    if (!conversationId) return;

    const getState = () => useStore.getState();

    const clearTimer = () => {
      if (timerId !== null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
    };

    // Schedule is a function of COMPLETED ticks: the first 15 intervals are 2s,
    // the next 30 are 4s, everything after that is 8s (GC12).
    const scheduleNext = () => {
      clearTimer();
      const delay = completedTicks < FAST_TICKS
        ? FAST_INTERVAL_MS
        : completedTicks < FAST_TICKS + MEDIUM_TICKS
          ? MEDIUM_INTERVAL_MS
          : SLOW_INTERVAL_MS;
      timerId = window.setTimeout(() => void runTick(), delay);
    };

    const checkPendingApprovals = async () => {
      try {
        const { approvals } = await mcpServersApi.listPendingApprovals(conversationId);
        if (disposed) return;
        for (const approval of approvals) {
          if (shownApprovalIds.has(approval.id)) continue;
          shownApprovalIds.add(approval.id);
          // SAME dialog flow as live streaming; resolution is fire-and-forget
          // exactly like the live path (fail-closed expiry stays server-side).
          const approved = confirmMcpApproval(approval);
          void mcpServersApi.resolveApproval(approval.id, approved).catch(() => {});
        }
      } catch (err) {
        console.error('Failed to check pending MCP approvals:', err);
      }
    };

    const runTick = async () => {
      if (disposed || tickInFlight) return;
      tickInFlight = true;
      try {
        const prevTail = getState().messages[getState().messages.length - 1];
        // Silent reload: grows the persisted draft text AND returns the turn
        // truth (one GET carries both facts atomically). The store drops the
        // result when this conversation is no longer the active one.
        const payload = await getState().loadMessages(conversationId, { silent: true });
        if (disposed) return;
        // An unpersisted client-side error bubble (e.g. a 409 surfaced through
        // the standard onError path while this turn is live) is never returned
        // by the server; re-attach it so the tick's reload cannot silently
        // erase the user's error feedback.
        if (
          payload &&
          prevTail?.role === 'assistant' &&
          prevTail.id.startsWith('temp-error-') &&
          !getState().messages.some((m) => m.id === prevTail.id)
        ) {
          useStore.setState((s) => ({ messages: [...s.messages, prevTail], activeLeafId: prevTail.id }));
        }
        // TR5-01: undefined means the GET itself failed or was dropped as stale
        // (limiter 429, network blip) — NOT that the turn closed. Keep polling
        // with backoff and a bounded consecutive-failure cap; only an explicit
        // falsy active_turn_id in a SUCCESSFUL payload ends reconciliation.
        if (!payload) {
          consecutiveFailures += 1;
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            setReconciling(false);
            return;
          }
          if (disposed) return; // never resurrect a loop for an old conversation
          clearTimer();
          timerId = window.setTimeout(() => void runTick(), FAILURE_RETRY_MS);
          return;
        }
        consecutiveFailures = 0;
        if (!payload.active_turn_id) {
          // Turn closed: this tick's reload already delivered every row with
          // its terminal generation_status, so it IS the final silent reload.
          setReconciling(false);
          return;
        }
        completedTicks += 1;
        if (completedTicks % CONVERSATIONS_REFRESH_EVERY_N_TICKS === 0) {
          void getState().loadConversations();
        }
        // Approvals are only relevant while nothing local owns the stream.
        if (!getState().streamsByConversation[conversationId]) {
          await checkPendingApprovals();
          if (disposed) return;
        }
        scheduleNext();
      } finally {
        tickInFlight = false;
      }
    };

    // Entry evaluation: decide whether this conversation needs reconciliation.
    // A live local stream (switch-away-and-back without refresh) owns the view
    // through its own callbacks — poll mode must not engage there.
    const evaluate = async () => {
      if (getState().streamsByConversation[conversationId]) return;
      tickInFlight = true;
      try {
        const payload = await getState().loadMessages(conversationId, { silent: true });
        if (disposed) return;
        if (payload?.active_turn_id) {
          setReconciling(true);
          scheduleNext();
        }
      } finally {
        tickInFlight = false;
      }
    };

    // Handoff watch: keep "poll mode only without a local stream entry" true at
    // all times. A fresh send creates an entry (stop polling); an entry ending
    // while the server may still hold the turn (e.g. Stop raced the finalize)
    // re-evaluates so the loop converges instead of leaving a stale view.
    const unsubscribe = useStore.subscribe((state, prev) => {
      if (disposed) return;
      const had = !!prev.streamsByConversation[conversationId];
      const has = !!state.streamsByConversation[conversationId];
      if (!had && has) {
        clearTimer();
        setReconciling(false);
      } else if (had && !has && !tickInFlight) {
        void evaluate();
      }
    });

    void evaluate();

    return () => {
      disposed = true;
      clearTimer();
      unsubscribe();
    };
  }, [conversationId]);

  return { reconciling };
}
