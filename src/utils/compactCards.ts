import type { Message } from '../types';

/**
 * Compaction checkpoint placement for the message list (compact-indicator).
 *
 * A `role='compaction'` row is inserted with `parent_id` = the pre-compact
 * leaf, so it sits in the visible thread exactly where the compaction
 * happened. The UI renders one card per checkpoint AT that position: cards
 * never move to a "kept tail" boundary (there is no kept tail any more) and
 * older checkpoints keep their card when a newer one arrives.
 */

/** Rows that render as bubbles — `tool` rows live inside the activity timeline. */
export function isDisplayRow(message: Message): boolean {
  return message.role !== 'tool' && message.role !== 'compaction';
}

export interface CheckpointPlacement {
  /** Checkpoints keyed by the index (within the displayed rows) they precede. */
  before: Map<number, Message[]>;
  /** Checkpoints with no displayed row after them — render at the end of the list. */
  trailing: Message[];
}

/**
 * Maps every checkpoint of `activeThread` (root → leaf) to its render slot.
 * Indices refer to the array produced by `activeThread.filter(isDisplayRow)` —
 * the same array the list renders — so `before.get(i)` renders immediately
 * above row `i`. A checkpoint that ends the thread (the normal case right after
 * compacting) lands in `trailing`.
 */
export function placeCheckpoints(activeThread: Message[]): CheckpointPlacement {
  const before = new Map<number, Message[]>();
  const trailing: Message[] = [];
  let displayIndex = 0;
  let pending: Message[] = [];

  for (const message of activeThread) {
    if (message.role === 'compaction') {
      pending.push(message);
      continue;
    }
    if (!isDisplayRow(message)) continue;
    if (pending.length > 0) {
      before.set(displayIndex, pending);
      pending = [];
    }
    displayIndex++;
  }
  if (pending.length > 0) trailing.push(...pending);

  return { before, trailing };
}

/**
 * `compaction_meta` as it arrives from `GET /messages`: the server parses only
 * `annotations` / `tool_calls` / `attachments`, so this column is still the raw
 * TEXT column (typed `unknown`). Anything unparseable degrades to `{}` — a card
 * with missing stats, never a crash.
 */
export function readCompactionMeta(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Corrupt/legacy meta: fall through to empty.
  }
  return {};
}

/** Server `SUMMARY_PREFIX` (server/compaction/prompt.ts) — cited, never
 *  imported: server modules must not leak into the client bundle. */
export const SUMMARY_PREFIX_LOCAL =
  'Another language model summarized this conversation so it could continue in a smaller context. Use the summary as prior state; the verbatim tail after it is newest. Do not duplicate completed work. Summary:\n';

/** Checkpoint content without the model-facing prefix, or null when empty. */
export function checkpointSummaryText(content: unknown): string | null {
  if (typeof content !== 'string' || !content) return null;
  return content.startsWith(SUMMARY_PREFIX_LOCAL)
    ? content.slice(SUMMARY_PREFIX_LOCAL.length)
    : content;
}
