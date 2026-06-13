/**
 * Ephemeral "current date/time" context for a chat turn.
 *
 * This string changes every second, so it MUST NOT live at the start of the
 * system prompt: prefix caching (DeepSeek context cache, Anthropic/OpenAI prompt
 * caching) matches from the first token, and a volatile prefix invalidates the
 * cache on every request. Inject this into the *current* user turn instead, so
 * the system prompt + prior history stay a stable, fully cacheable prefix.
 */

const DATE_TIME_OPTS: Intl.DateTimeFormatOptions = {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
};

/** True if the string is a valid IANA timezone (e.g. Europe/Madrid, America/New_York). */
export function isValidTimezone(tz: string): boolean {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  const s = tz.trim();
  if (s.length < 2 || s.length > 40) return false;
  if (!/^[A-Za-z0-9_+\-/]+$/.test(s)) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: s });
    return true;
  } catch {
    return false;
  }
}

/** Builds the bracketed date/time context line for the user's timezone (falls back to UTC). */
export function buildDateTimeContext(userTimezone?: string | null): string {
  const now = new Date();
  const utcStr = now.toLocaleString('en-GB', { ...DATE_TIME_OPTS, timeZone: 'UTC' });
  if (userTimezone && isValidTimezone(userTimezone)) {
    const localStr = now.toLocaleString('en-GB', { ...DATE_TIME_OPTS, timeZone: userTimezone });
    return `[Context: Current date and time (user's local time) — ${localStr} (${userTimezone}). UTC: ${utcStr}. Use this for time-sensitive answers.]`;
  }
  return `[Context: Current date and time — ${utcStr} UTC. Use this for time-sensitive answers.]`;
}

/**
 * Appends the date/time context to the current (last) user message of a chat
 * messages array, in place. Handles both plain-string and multimodal content.
 * Keeps the system prompt and prior history untouched so they remain cacheable.
 */
export function injectDateTimeIntoCurrentTurn(
  messages: Array<{ role: string; content?: string | unknown[] | null }>,
  dateTimeContext: string
): void {
  const lastIdx = messages.length - 1;
  if (lastIdx < 0 || messages[lastIdx].role !== 'user') return;
  const current = messages[lastIdx];
  if (Array.isArray(current.content)) {
    // Multimodal: append the context as an extra text part.
    current.content = [...current.content, { type: 'text', text: dateTimeContext }];
  } else {
    const base = typeof current.content === 'string' ? current.content : '';
    current.content = base ? `${base}\n\n${dateTimeContext}` : dateTimeContext;
  }
}
