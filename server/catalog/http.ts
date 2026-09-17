/**
 * Minimal upstream fetch for catalog sources: timeout, body read as text and
 * parsed by content (some gateways send JSON as `text/plain`), typed errors.
 */

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }

  /** 401/403: the credential is missing, invalid or not allowed. */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FetchTextOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function fetchText(url: string, opts: FetchTextOptions = {}): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: opts.headers,
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    throw new UpstreamError(`Request to ${new URL(url).host} failed: ${err instanceof Error ? err.message : String(err)}`, 0, '');
  }
  const body = await response.text().catch(() => '');
  if (!response.ok) {
    throw new UpstreamError(`${new URL(url).host} responded ${response.status}`, response.status, body.slice(0, 500));
  }
  return body;
}

export async function fetchJson<T = unknown>(url: string, opts: FetchTextOptions = {}): Promise<T> {
  const body = await fetchText(url, opts);
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new UpstreamError(`${new URL(url).host} returned a non-JSON body`, 200, body.slice(0, 500));
  }
}
