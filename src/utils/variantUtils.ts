import type { Message } from '../types';

/**
 * Last assistant message belonging to the same turn as `userMessage`.
 * Prefers an exact variant_seq match; falls back to the last assistant of the
 * turn when seq is missing on either side; legacy messages (no turn_id) fall
 * back to the first assistant right after the user message.
 */
export function findVariantAssistantMessage(messages: Message[], userMessage: Message): Message | null {
  const turnId = userMessage.turn_id;

  if (!turnId) {
    // Legacy messages predate turn_id: assume the assistant right after the user message.
    const idx = messages.findIndex((m) => m.id === userMessage.id);
    if (idx === -1) return null;
    for (let i = idx + 1; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === 'assistant') return m;
      if (m.role === 'user') break;
    }
    return null;
  }

  const seq = userMessage.variant_seq;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant' || m.turn_id !== turnId) continue;
    if (
      seq !== undefined &&
      seq !== null &&
      m.variant_seq !== undefined &&
      m.variant_seq !== null &&
      m.variant_seq !== seq
    ) {
      continue;
    }
    return m;
  }
  return null;
}

/** Model id of the assistant response for `userMessage`'s variant, if any. */
export function findVariantAssistantModel(messages: Message[], userMessage: Message): string | null {
  return findVariantAssistantMessage(messages, userMessage)?.model ?? null;
}

/** Compact relative time, e.g. "5 min ago". */
export function formatVariantTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  if (diffMs < 0) return 'just now';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
