/**
 * Pure SSRF gate for relayed HTTP traffic (global-constraints.md §6).
 *
 * Relayed requests may target ONLY an exact `host:port` entry from the
 * per-user LM Studio allowlist. Zero dependencies on purpose: this module
 * sits on a trust boundary and must stay trivially auditable.
 *
 * Rules enforced here (defense-in-depth with the agent-side loopback check):
 * - protocol must be exactly `http:` (never https, file, data, ...);
 * - no embedded credentials;
 * - no fragment;
 * - normalized `host:port` must equal one allowlist entry
 *   (`localhost` ≡ `127.0.0.1`; explicit IPv6 brackets tolerated).
 */

export const DEFAULT_PROXY_ALLOWLIST = ['127.0.0.1:1234', 'localhost:1234', '[::1]:1234'];

/** Reads env-style input: trims, lowercases, drops empties; falls back to the default when nothing usable remains. */
export function parseProxyAllowlist(raw: string | undefined): string[] {
  if (!raw) return [...DEFAULT_PROXY_ALLOWLIST];
  const entries = raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return entries.length > 0 ? entries : [...DEFAULT_PROXY_ALLOWLIST];
}

/** Loopback names collapse onto 127.0.0.1; surrounding IPv6 brackets are optional. */
function normalizeHost(host: string): string {
  const unbracketed = host.startsWith('[') && host.endsWith(']')
    ? host.slice(1, -1)
    : host;
  return unbracketed === 'localhost' ? '127.0.0.1' : unbracketed;
}

/**
 * Splits the LAST colon so bare IPv6 hosts (`::1:1234`) and bracketed ones
 * (`[::1]:1234`) both normalize to `::1:1234`. Returns null for entries
 * without an explicit non-empty port — those can never match and are dropped.
 */
function normalizeHostPort(entry: string): string | null {
  const separator = entry.lastIndexOf(':');
  if (separator <= 0) return null;
  const host = normalizeHost(entry.slice(0, separator));
  const port = entry.slice(separator + 1);
  return host && port ? `${host}:${port}` : null;
}

export function isRelayUrlAllowed(urlStr: string, allowlist: string[]): { allowed: boolean; reason?: string } {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return { allowed: false, reason: 'url is not an absolute, parseable URL' };
  }
  if (url.protocol !== 'http:') {
    return { allowed: false, reason: `protocol ${url.protocol} is not http:` };
  }
  if (url.username || url.password) {
    return { allowed: false, reason: 'embedded credentials are forbidden' };
  }
  if (url.hash) {
    return { allowed: false, reason: 'fragment is forbidden' };
  }

  // WHATWG URL keeps brackets in `.host` (`[::1]:1234`) and elides the port
  // when absent — both handled by the shared normalizer.
  const destination = normalizeHostPort(url.host.toLowerCase());
  if (!destination) {
    return { allowed: false, reason: 'url has no explicit port to match against the allowlist' };
  }

  const normalizedAllowlist = new Set<string>();
  for (const entry of allowlist) {
    const normalizedEntry = normalizeHostPort(entry.trim().toLowerCase());
    if (normalizedEntry) normalizedAllowlist.add(normalizedEntry);
  }
  if (!normalizedAllowlist.has(destination)) {
    return { allowed: false, reason: `destination ${destination} is not allowlisted` };
  }
  return { allowed: true };
}
