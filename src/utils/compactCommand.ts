/**
 * Pure `/compact` command parser (compact-ui).
 *
 * The command word matches case-insensitively; `focus` is the trimmed
 * remainder (empty → null). Only a trimmed SINGLE-LINE composer text of the
 * form `^/compact(\s+...)?$` is a command — multi-line pastes starting with
 * `/compact` are NOT commands, and the literal must lead the text.
 */

/** True when a slash-trigger token is exactly the reserved `compact` word (case-insensitive). */
export function isCompactSlashToken(token: string): boolean {
  return token.toLowerCase() === 'compact';
}

/**
 * Parse a trimmed composer text as a `/compact` command.
 * Returns `{focus}` (focus null when bare) or null when NOT a command.
 */
export function parseCompactCommand(text: string): { focus: string | null } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // Single-line-only: any newline (or carriage return) disqualifies.
  if (/[\r\n]/.test(trimmed)) return null;
  const match = /^\/compact(?:\s+(.+))?$/i.exec(trimmed);
  if (!match) return null;
  const rawFocus = match[1];
  if (rawFocus === undefined) return { focus: null };
  const focus = rawFocus.trim();
  return { focus: focus ? focus : null };
}
