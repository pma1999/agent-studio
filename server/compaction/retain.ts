/**
 * Codex-style retention of recent USER messages across a checkpoint (pure).
 *
 * Port of `openai/codex@main` `codex-rs/core/src/compact.rs`
 * `build_compacted_history_with_limit()` + `compacted_user_message()`:
 *
 *   selected = []; remaining = COMPACT_USER_MESSAGE_MAX_TOKENS (20_000)
 *   for message in user_messages.iter().rev():      // newest → oldest
 *       if remaining == 0 { break }
 *       tokens = approx_token_count(message)
 *       if tokens <= remaining { push(whole); remaining -= tokens }
 *       else { push(truncate_text(message, Tokens(remaining))); break }
 *   selected.reverse()                              // back to chronological
 *   history = selected(role "user") + summary(last)
 *
 * Faithful details worth keeping: only USER messages are eligible (assistant
 * prose and tool traffic are dropped — the summary is what carries them), a
 * previous summary is never re-collected (`is_summary_message`), the message
 * that does NOT fit is still included MIDDLE-truncated to the remaining budget
 * and then the walk stops, and the summary goes AFTER the retained messages so
 * the model reads it last, right before the new material.
 *
 * Deliberate deviation: Codex counts bytes (`APPROX_BYTES_PER_TOKEN = 4`); we
 * count JS string length with the frozen G5 estimator `ceil(chars/4)`, the same
 * one used everywhere else in this codebase.
 *
 * Faithfully inherited quirk: the truncation marker is added ON TOP of the
 * budget (Codex's `assemble_truncated_output` joins a left+right slice that
 * already spends `max_bytes`), so a selection can exceed its budget by the
 * marker — about 6 tokens against a 20 000 budget. Kept as-is so this port can
 * still be diffed against upstream.
 */

import { estimateTokens } from './serialize.js';
import { SUMMARY_PREFIX } from './prompt.js';

/** Codex `COMPACT_USER_MESSAGE_MAX_TOKENS`. */
export const RETAINED_USER_MAX_TOKENS = 20_000;

/** Codex `APPROX_BYTES_PER_TOKEN`, applied to chars per the note above. */
const CHARS_PER_TOKEN = 4;

/** Upper bound of one `…N tokens truncated…` marker (`…` + 7 digits + text). */
const MARKER_TOKEN_ALLOWANCE = 8;

export interface RetainCandidate {
  role: string;
  content?: unknown;
}

export interface RetainedMessage {
  role: 'user';
  content: string;
}

/** Codex `approx_bytes_for_tokens`, in chars. */
function charsForTokens(tokens: number): number {
  return Math.max(0, Math.floor(tokens)) * CHARS_PER_TOKEN;
}

/** Codex `split_budget`: left half floors, right half takes the remainder. */
function splitBudget(budget: number): [number, number] {
  const left = Math.floor(budget / 2);
  return [left, budget - left];
}

/**
 * Never cut a surrogate pair in half: a lone half renders as U+FFFD and can
 * break JSON transport. Shrinks the slice by one unit when it would split one.
 */
function safeHead(text: string, end: number): string {
  if (end <= 0) return '';
  const code = text.charCodeAt(end - 1);
  const trimmed = code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
  return text.slice(0, trimmed);
}

function safeTail(text: string, start: number): string {
  if (start >= text.length) return '';
  const code = text.charCodeAt(start);
  const shifted = code >= 0xdc00 && code <= 0xdfff ? start + 1 : start;
  return text.slice(shifted);
}

/**
 * Codex `truncate_middle_with_token_budget`: keeps the beginning AND the end,
 * replacing the middle with `…N tokens truncated…`. Keeping both ends matters
 * for a user message — the ask usually opens it and the constraints usually
 * close it.
 */
export function truncateMiddleToTokens(text: string, maxTokens: number): string {
  const maxChars = charsForTokens(maxTokens);
  const marker = (removedChars: number) =>
    `…${Math.ceil(removedChars / CHARS_PER_TOKEN)} tokens truncated…`;
  if (!text) return '';
  if (maxChars === 0) return marker(text.length);
  if (text.length <= maxChars) return text;
  const [leftBudget, rightBudget] = splitBudget(maxChars);
  const head = safeHead(text, leftBudget);
  const tail = safeTail(text, text.length - rightBudget);
  return `${head}${marker(text.length - maxChars)}${tail}`;
}

/** Text of a candidate row: plain string, or the text parts of array content. */
function candidateText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === 'string') {
        if (item) parts.push(item);
        continue;
      }
      const text = (item as { text?: unknown } | null)?.text;
      if (typeof text === 'string' && text) parts.push(text);
    }
    return parts.join('\n');
  }
  return '';
}

/** Codex `is_summary_message`: a stored checkpoint is never re-collected. */
function isSummaryMessage(text: string): boolean {
  return text.startsWith(SUMMARY_PREFIX);
}

/**
 * Budget for one checkpoint: Codex's 20 000 ceiling, additionally capped so the
 * replay can NEVER make the compacted view bigger than what the checkpoint
 * replaced (`summary + retained <= archived`).
 *
 * Why we need a cap Codex does not: Codex sizes its flat 20 000 against windows
 * it always knows, while `resolveWindow()` here returns null for every
 * `openrouter/*` id — the majority of real conversations. Without this, a thread
 * dominated by long pasted user messages (routine in this app) compacts to
 * `summary + every user paste`, which can exceed the pre-compaction view and
 * makes the checkpoint cost context instead of saving it.
 *
 * The cap only bites in that pathological case: any conversation whose archived
 * content exceeds the ceiling plus its summary keeps plain Codex behaviour.
 */
export function retentionBudgetFor(
  archivedRows: readonly RetainCandidate[],
  summaryContent: string,
  maxTokens: number = RETAINED_USER_MAX_TOKENS,
): number {
  let archived = 0;
  for (const row of archivedRows) {
    if (!row) continue;
    archived += estimateTokens(candidateText(row.content));
  }
  // The inherited marker overshoot (see the module header) would otherwise leak
  // past this cap, so the headroom pays for one marker up front — that is what
  // turns "should not grow the view" into a guarantee.
  const headroom = archived - estimateTokens(summaryContent ?? '') - MARKER_TOKEN_ALLOWANCE;
  return Math.max(0, Math.min(maxTokens, headroom));
}

/**
 * Picks the user messages to replay verbatim after a checkpoint, in
 * chronological order. `rows` are the thread rows the compaction cut (root →
 * leaf); everything that is not an eligible user message is ignored.
 */
export function selectRetainedUserMessages(
  rows: readonly RetainCandidate[],
  maxTokens: number = RETAINED_USER_MAX_TOKENS,
): RetainedMessage[] {
  const budget = Number.isFinite(maxTokens) ? Math.max(0, Math.floor(maxTokens)) : 0;
  if (budget === 0) return [];

  const candidates: string[] = [];
  for (const row of rows) {
    if (!row || row.role !== 'user') continue;
    const text = candidateText(row.content);
    if (!text.trim() || isSummaryMessage(text)) continue;
    candidates.push(text);
  }

  const selected: string[] = [];
  let remaining = budget;
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (remaining === 0) break;
    const text = candidates[i]!;
    const tokens = estimateTokens(text);
    if (tokens <= remaining) {
      selected.push(text);
      remaining -= tokens;
    } else {
      selected.push(truncateMiddleToTokens(text, remaining));
      break;
    }
  }
  selected.reverse();
  return selected.map((content) => ({ role: 'user' as const, content }));
}
