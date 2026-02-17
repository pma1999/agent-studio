/**
 * Jina Reader API client for the web_fetch builtin tool.
 * Converts URLs to LLM-friendly content (markdown/text) via r.jina.ai.
 * @see https://r.jina.ai/docs
 */

const JINA_READER_BASE = 'https://r.jina.ai/';
const DEFAULT_TIMEOUT_MS = 45_000;
const MIN_TIMEOUT_S = 1;
const MAX_TIMEOUT_S = 180;
const MAX_RETRIES = 2;
const INITIAL_BACKOFF_MS = 1_000;

/** Response format from Jina (CrawlerOptions.respondWith). */
export type JinaRespondWith =
  | 'content'
  | 'markdown'
  | 'html'
  | 'text'
  | 'pageshot'
  | 'screenshot'
  | 'vlm'
  | 'readerlm-v2';

/** How to resolve relative URLs. */
export type JinaBase = 'initial' | 'final';

/** Image retention mode. */
export type JinaRetainImages = 'none' | 'all' | 'alt' | 'all_p' | 'alt_p';

/** Link retention mode. */
export type JinaRetainLinks = 'none' | 'all' | 'text' | 'gpt-oss';

/** When to return the response (page load strategy). */
export type JinaRespondTiming =
  | 'html'
  | 'visible-content'
  | 'mutation-idle'
  | 'resource-idle'
  | 'media-idle'
  | 'network-idle';

/** Crawl engine. */
export type JinaEngine = 'browser' | 'direct' | 'cf-browser-rendering';

export interface JinaReaderOptions {
  /** Target URL to fetch (required). */
  url: string;
  /** Output format. Default: content. */
  respondWith?: JinaRespondWith;
  /** Base for relative URLs. Default: initial. */
  base?: JinaBase;
  /** Request timeout in seconds (1–180). */
  timeout?: number;
  /** Skip cache. */
  noCache?: boolean;
  /** Cache tolerance in seconds (when not noCache). */
  cacheTolerance?: number;
  /** CSS selector(s) to wait for before returning. */
  waitForSelector?: string | string[];
  /** CSS selector(s) for target content only (implies wait). */
  targetSelector?: string | string[];
  /** CSS selector(s) to remove from the page. */
  removeSelector?: string | string[];
  /** Keep image data URLs in markdown (no object-url transform). */
  keepImgDataUrl?: boolean;
  /** Generate alt text for images without meaningful alt. */
  withGeneratedAlt?: boolean;
  /** Retain images: none, all, alt, all_p, alt_p. Default: all. */
  retainImages?: JinaRetainImages;
  /** Retain links: none, all, text, gpt-oss. Default: all. */
  retainLinks?: JinaRetainLinks;
  /** Include a summary section for links. */
  withLinksSummary?: boolean;
  /** Include a summary section for images. */
  withImagesSummary?: boolean;
  /** Include iframe content in main document. */
  withIframe?: boolean;
  /** Include shadow DOM content. */
  withShadowDom?: boolean;
  /** Custom User-Agent. */
  userAgent?: string;
  /** Referer header. */
  referer?: string;
  /** Browser locale (e.g. en-US). */
  locale?: string;
  /** Crawl engine: browser, direct, cf-browser-rendering. */
  engine?: JinaEngine;
  /** When to respond (page load timing). Default: resource-idle. */
  respondTiming?: JinaRespondTiming;
  /** Token budget; request rejected if exceeded. */
  tokenBudget?: number;
  /** Custom proxy URL (http, https, socks4, socks5; auth: https://user:pass@host:port). */
  proxyUrl?: string;
  /** Jina proxy with optional country code. */
  proxy?: string;
  /** Respect robots.txt (optionally with bot UA). */
  robotsTxt?: string;
  /** Do not cache this result (DNT). */
  doNotTrack?: boolean;
  /** Jina API token for higher limits (optional). */
  apiKey?: string;
}

export interface JinaReaderResponse {
  data?: string;
  code?: number;
  status?: number;
  meta?: unknown;
  error?: string;
}

/** Allowed URL protocols for security. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Hosts that must not be requested (SSRF / internal). */
const BLOCKED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '169.254.169.254', // cloud metadata
]);

function isBlockedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(lower)) return true;
  if (lower.endsWith('.localhost') || lower.endsWith('.local')) return true;
  return false;
}

/**
 * Validates and normalizes the target URL. Returns an error message if invalid.
 */
export function validateUrl(input: string): { url: string } | { error: string } {
  const trimmed = (input ?? '').trim();
  if (!trimmed) {
    return { error: 'URL is required' };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { error: 'Invalid URL format' };
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { error: 'Only http and https URLs are allowed' };
  }
  if (isBlockedHost(url.hostname)) {
    return { error: 'Requests to local or internal hosts are not allowed' };
  }
  return { url: url.href };
}

function toArray(v: string | string[] | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v.length ? v : undefined;
  const s = String(v).trim();
  return s ? [s] : undefined;
}

function clampTimeout(seconds: number): number {
  if (Number.isNaN(seconds) || seconds < MIN_TIMEOUT_S) return MIN_TIMEOUT_S;
  if (seconds > MAX_TIMEOUT_S) return MAX_TIMEOUT_S;
  return Math.floor(seconds);
}

/**
 * Builds the request URL and headers for the Jina Reader API.
 */
export function buildJinaReaderRequest(options: JinaReaderOptions): {
  url: string;
  headers: Record<string, string>;
} {
  const params = new URLSearchParams();
  params.set('url', options.url);

  if (options.respondWith) params.set('respondWith', options.respondWith);
  if (options.base) params.set('base', options.base);
  if (options.timeout !== undefined) params.set('timeout', String(clampTimeout(options.timeout)));
  if (options.noCache === true) params.set('noCache', 'true');
  if (options.cacheTolerance !== undefined) params.set('cacheTolerance', String(options.cacheTolerance));
  if (options.retainImages) params.set('retainImages', options.retainImages);
  if (options.retainLinks) params.set('retainLinks', options.retainLinks);
  if (options.keepImgDataUrl === true) params.set('keepImgDataUrl', 'true');
  if (options.withGeneratedAlt === true) params.set('withGeneratedAlt', 'true');
  if (options.withLinksSummary === true) params.set('withLinksSummary', 'true');
  if (options.withImagesSummary === true) params.set('withImagesSummary', 'true');
  if (options.withIframe === true) params.set('withIframe', 'true');
  if (options.withShadowDom === true) params.set('withShadowDom', 'true');
  if (options.userAgent) params.set('userAgent', options.userAgent);
  if (options.referer) params.set('referer', options.referer);
  if (options.locale) params.set('locale', options.locale);
  if (options.engine) params.set('engine', options.engine);
  if (options.respondTiming) params.set('respondTiming', options.respondTiming);
  if (options.tokenBudget !== undefined) params.set('tokenBudget', String(options.tokenBudget));
  if (options.proxyUrl) params.set('proxyUrl', options.proxyUrl);
  if (options.proxy) params.set('proxy', options.proxy);
  if (options.robotsTxt !== undefined) params.set('robotsTxt', options.robotsTxt);
  if (options.doNotTrack === true) params.set('doNotTrack', 'true');

  const waitFor = toArray(options.waitForSelector);
  if (waitFor?.length) params.set('waitForSelector', waitFor.join(','));
  const target = toArray(options.targetSelector);
  if (target?.length) params.set('targetSelector', target.join(','));
  const remove = toArray(options.removeSelector);
  if (remove?.length) params.set('removeSelector', remove.join(','));

  const url = `${JINA_READER_BASE}?${params.toString()}`;

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (options.apiKey?.trim()) {
    headers['Authorization'] = `Bearer ${options.apiKey.trim()}`;
  }

  return { url, headers };
}

function isRetryable(status: number, errMsg: string): boolean {
  if (status >= 500 && status < 600) return true;
  if (status === 429) return true;
  if (errMsg.includes('timeout') || errMsg.includes('abort') || errMsg.includes('ECONNRESET') || errMsg.includes('fetch')) return true;
  return false;
}

/**
 * Single attempt: fetch and parse. Caller handles retries.
 */
async function fetchOnce(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<{ res: Response; text: string }> {
  const res = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  return { res, text };
}

/**
 * Fetches the given URL via Jina Reader with retries (5xx, 429, timeouts). Returns extracted content or an error.
 */
export async function fetchWithJinaReader(options: JinaReaderOptions): Promise<JinaReaderResponse> {
  const validated = validateUrl(options.url);
  if ('error' in validated) {
    return { error: validated.error };
  }

  const { url, headers } = buildJinaReaderRequest({ ...options, url: validated.url });
  const timeoutSec = options.timeout !== undefined ? clampTimeout(options.timeout) : Math.floor(DEFAULT_TIMEOUT_MS / 1000);
  const timeoutMs = Math.min(timeoutSec * 1000, DEFAULT_TIMEOUT_MS + 5000);

  let lastError: JinaReaderResponse = { error: 'Unknown error' };
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { res, text } = await fetchOnce(url, headers, timeoutMs);
      let body: { code?: number; status?: number; data?: string; meta?: unknown; message?: string };
      try {
        body = JSON.parse(text) as typeof body;
      } catch {
        if (!res.ok) {
          lastError = { error: `Jina Reader error (${res.status}): ${text.slice(0, 300)}` };
          if (isRetryable(res.status, text) && attempt < MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, INITIAL_BACKOFF_MS * Math.pow(2, attempt)));
            continue;
          }
          return lastError;
        }
        return { error: 'Invalid JSON response from Jina Reader' };
      }

      if (!res.ok) {
        const msg = body?.message ?? text?.slice(0, 200) ?? res.statusText;
        lastError = { error: `Jina Reader error (${res.status}): ${msg}` };
        if (isRetryable(res.status, msg) && attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, INITIAL_BACKOFF_MS * Math.pow(2, attempt)));
          continue;
        }
        return lastError;
      }

      if (body?.code !== 200 && body?.code !== undefined) {
        lastError = {
          error: body?.message ?? `Jina returned code ${body?.code}`,
          code: body?.code,
          status: body?.status,
        };
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, INITIAL_BACKOFF_MS * Math.pow(2, attempt)));
          continue;
        }
        return lastError;
      }

      return {
        data: typeof body?.data === 'string' ? body.data : '',
        code: body?.code,
        status: body?.status,
        meta: body?.meta,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastError = {
        error: msg.includes('abort') || msg.includes('timeout') ? `Request timed out after ${timeoutSec}s` : `Request failed: ${msg}`,
      };
      if (isRetryable(0, msg) && attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, INITIAL_BACKOFF_MS * Math.pow(2, attempt)));
        continue;
      }
      return lastError;
    }
  }
  return lastError;
}
