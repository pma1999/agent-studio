/**
 * Single source of truth for client deep-link paths (`/c/<id>`, `/s/<token>`)
 * and of the shared http(s)-only safety predicate for data-derived anchor hrefs.
 *
 * Pure functions only: no React, no DOM, no history-API calls here —
 * consumers own all side effects (URL writes, view switches).
 */

/** The two client URL shapes plus "everything else = app home". */
export type ParsedClientPath =
  | { kind: 'chat'; conversationId: string }
  | { kind: 'share'; token: string }
  | { kind: 'app' };

/**
 * Matches `/c/<segment>` or `/s/<segment>` where `<segment>` is one raw,
 * non-empty, slash-free path segment. Case-sensitive by design (`/C/x` is
 * not a deep link); percent-escape decoding happens separately below.
 */
const DEEP_LINK_PATTERN = /^\/([cs])\/([^/]+)$/;

/**
 * Parses a client pathname into its deep-link shape.
 *
 * - `/c/<id>`   → `{ kind: 'chat', conversationId }` (id kept verbatim, case-sensitive)
 * - `/s/<token>` → `{ kind: 'share', token }`
 * - everything else → `{ kind: 'app' }`: root, bare prefixes, empty ids, extra
 *   or trailing segments, and segments whose percent-escapes are malformed.
 *
 * Successfully decoded segments are decoded once (`/c/%61bc` → id `abc`).
 */
export function parseClientPath(pathname: string): ParsedClientPath {
  const match = DEEP_LINK_PATTERN.exec(pathname);
  if (!match) return { kind: 'app' };

  let segment: string;
  try {
    segment = decodeURIComponent(match[2]);
  } catch {
    // Malformed escape (e.g. `%ZZ`) — not a link we can trust; treat as app home.
    return { kind: 'app' };
  }

  return match[1] === 'c'
    ? { kind: 'chat', conversationId: segment }
    : { kind: 'share', token: segment };
}

/**
 * Builds the canonical chat deep-link path for a conversation id.
 * Throws on an empty id (programmer error guard).
 */
export function conversationPath(id: string): string {
  requireNonEmpty(id, 'conversationPath', 'conversation id');
  return `/c/${id}`;
}

/**
 * Builds the canonical share deep-link path for a share token.
 * Throws on an empty token (programmer error guard).
 */
export function sharePath(token: string): string {
  requireNonEmpty(token, 'sharePath', 'share token');
  return `/s/${token}`;
}

/**
 * The single enforced allowlist for data-derived citation hrefs (FMT8-02):
 * a value may become an anchor `href` ONLY if it is a string that parses as
 * an absolute URL whose protocol is exactly `'http:'` or `'https:'`. False
 * for everything else — non-strings, unparseable input, any other scheme,
 * protocol-relative and relative references.
 *
 * Edge decisions (encoded in scripts/test-url-safety.ts):
 * - Non-string input returns false; callers probe annotation shapes defensively.
 * - Scheme case follows the WHATWG parser (`HTTPS://x` parses to `'https:'`),
 *   so uppercase http(s) is accepted while mixed-case script schemes still
 *   normalize to their dangerous scheme and are rejected.
 * - No trim leniency: leading/trailing whitespace is rejected even though the
 *   parser would silently strip it, so the rendered href stays byte-identical
 *   to the validated input.
 */
export function isSafeHttpUrl(url: unknown): boolean {
  if (typeof url !== 'string' || url.trim() !== url) return false;
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function requireNonEmpty(value: string, fnName: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${fnName}: expected a non-empty ${label}, got ${String(value)}`);
  }
}
