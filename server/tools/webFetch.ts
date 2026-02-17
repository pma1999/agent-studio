/**
 * web_fetch builtin: validation (Zod), rate limiting, response cache, pagination, outline.
 * Delegates actual HTTP to jinaReader; applies max_chars (model-chosen), offset pagination, and navigation outline.
 */

import { z } from 'zod';
import { fetchWithJinaReader, type JinaReaderOptions } from './jinaReader.js';
import { getSettingValue } from '../routes/settings.js';

const RESPOND_WITH = ['content', 'markdown', 'html', 'text', 'pageshot', 'screenshot', 'vlm', 'readerlm-v2'] as const;
const RETAIN_IMAGES = ['none', 'all', 'alt', 'all_p', 'alt_p'] as const;
const RETAIN_LINKS = ['none', 'all', 'text', 'gpt-oss'] as const;
const RESPOND_TIMING = ['html', 'visible-content', 'mutation-idle', 'resource-idle', 'media-idle', 'network-idle'] as const;
const ENGINE = ['browser', 'direct', 'cf-browser-rendering'] as const;

const MAX_CHARS_MIN = 1000;
const MAX_CHARS_MAX = 2_000_000;
const MAX_CHARS_DEFAULT = 200_000; // High default: models have large context windows

const OUTLINE_MAX_CHARS = 2500;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX_ENTRIES_PER_USER = 10;

export const webFetchArgsSchema = z.object({
  url: z.string().min(1, 'url is required').transform((s) => s.trim()),
  respond_with: z.enum(RESPOND_WITH).optional().default('markdown'),
  timeout_seconds: z.coerce.number().int().min(1).max(180).optional().default(45),
  no_cache: z.boolean().optional().default(false),
  max_chars: z.coerce.number().int().min(MAX_CHARS_MIN).max(MAX_CHARS_MAX).optional().default(MAX_CHARS_DEFAULT),
  offset: z.coerce.number().int().min(0).optional().default(0),
  wait_for_selector: z.string().optional().default('').transform((s) => (s ?? '').trim()),
  target_selector: z.string().optional().default('').transform((s) => (s ?? '').trim()),
  remove_selector: z.string().optional().default('').transform((s) => (s ?? '').trim()),
  user_agent: z.string().optional().default('').transform((s) => (s ?? '').trim()),
  referer: z.string().optional().default('').transform((s) => (s ?? '').trim()),
  locale: z.string().optional().default('').transform((s) => (s ?? '').trim()),
  retain_images: z.enum(RETAIN_IMAGES).optional(),
  retain_links: z.enum(RETAIN_LINKS).optional(),
  with_links_summary: z.boolean().optional().default(false),
  with_images_summary: z.boolean().optional().default(false),
  respond_timing: z.enum(RESPOND_TIMING).optional(),
  engine: z.enum(ENGINE).optional(),
});

export type WebFetchArgs = z.infer<typeof webFetchArgsSchema>;

/** Rate limit: max requests per window per user. */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 30;

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();

function isRateLimited(userId: string | undefined): boolean {
  const key = userId ?? 'anon';
  const now = Date.now();
  let entry = rateLimitMap.get(key);
  if (!entry) {
    rateLimitMap.set(key, { count: 1, windowStart: now });
    return false;
  }
  if (now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    entry = { count: 1, windowStart: now };
    rateLimitMap.set(key, entry);
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX_REQUESTS;
}

/** Sanitize URL for logs: return hostname only (no path/query). */
function domainForLog(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '(invalid)';
  }
}

/** Hash userId for logs (no PII). */
function hashUserId(userId: string | undefined): string {
  if (!userId) return 'anon';
  let h = 0;
  for (let i = 0; i < userId.length; i++) {
    h = (h << 5) - h + userId.charCodeAt(i);
    h |= 0;
  }
  return `u${Math.abs(h).toString(36)}`;
}

/** djb2-style hash for cache key. */
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

interface CacheEntry {
  content: string;
  outline: string;
  storedAt: number;
}

/** Cache key: options that affect response body (not max_chars, offset, timeout, no_cache). */
function cacheKeyFrom(userId: string | undefined, url: string, parsed: WebFetchArgs): string {
  const canonical = JSON.stringify({
    url,
    respond_with: parsed.respond_with,
    wait_for_selector: parsed.wait_for_selector,
    target_selector: parsed.target_selector,
    remove_selector: parsed.remove_selector,
  });
  return `${userId ?? 'anon'}:${hashString(canonical)}`;
}

const responseCache = new Map<string, CacheEntry>();

function getCached(key: string): CacheEntry | undefined {
  const entry = responseCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.storedAt > CACHE_TTL_MS) {
    responseCache.delete(key);
    return undefined;
  }
  return entry;
}

function setCached(key: string, entry: CacheEntry, userId: string | undefined): void {
  if (userId) {
    const prefix = `${userId}:`;
    const userKeys = [...responseCache.keys()].filter((k) => k.startsWith(prefix));
    if (userKeys.length >= CACHE_MAX_ENTRIES_PER_USER) {
      const byTime = userKeys
        .map((k) => ({ k, at: responseCache.get(k)!.storedAt }))
        .sort((a, b) => a.at - b.at);
      for (let i = 0; i < byTime.length - CACHE_MAX_ENTRIES_PER_USER + 1; i++) {
        responseCache.delete(byTime[i].k);
      }
    }
  }
  responseCache.set(key, entry);
}

/** Extract navigation outline: headings for markdown, or first N chars. */
function extractOutline(content: string, respondWith: string, maxChars: number): string {
  const limit = Math.min(maxChars, OUTLINE_MAX_CHARS);
  if (respondWith === 'markdown' || respondWith === 'content') {
    const headingRe = /^#{1,6}\s+.+$/gm;
    const matches = content.match(headingRe);
    if (matches && matches.length > 0) {
      const outline = matches.join('\n').slice(0, limit);
      if (outline.length > 0) return outline;
    }
  }
  return content.slice(0, limit);
}

function buildOptions(parsed: WebFetchArgs, apiKey: string | undefined): JinaReaderOptions {
  const opt: JinaReaderOptions = {
    url: parsed.url,
    respondWith: parsed.respond_with,
    timeout: parsed.timeout_seconds,
    noCache: parsed.no_cache || undefined,
    apiKey: apiKey?.trim() || undefined,
  };
  if (parsed.wait_for_selector) opt.waitForSelector = parsed.wait_for_selector;
  if (parsed.target_selector) opt.targetSelector = parsed.target_selector;
  if (parsed.remove_selector) opt.removeSelector = parsed.remove_selector;
  if (parsed.user_agent) opt.userAgent = parsed.user_agent;
  if (parsed.referer) opt.referer = parsed.referer;
  if (parsed.locale) opt.locale = parsed.locale;
  if (parsed.retain_images) opt.retainImages = parsed.retain_images;
  if (parsed.retain_links) opt.retainLinks = parsed.retain_links;
  if (parsed.with_links_summary) opt.withLinksSummary = true;
  if (parsed.with_images_summary) opt.withImagesSummary = true;
  if (parsed.respond_timing) opt.respondTiming = parsed.respond_timing;
  if (parsed.engine) opt.engine = parsed.engine;
  return opt;
}

export interface WebFetchResult {
  content: string;
  url: string;
  truncated?: boolean;
  total_length?: number;
  offset?: number;
  next_offset?: number;
  has_more?: boolean;
  outline?: string;
  navigation_hint?: string;
  error?: string;
}

const PAGINATION_ERROR =
  'No hay página en caché para esta URL. Llama primero a web_fetch con esta URL (offset=0 o sin offset), luego usa el next_offset devuelto para el siguiente segmento.';

/**
 * Run web_fetch: validate, rate limit, then fetch or serve from cache; apply max_chars/offset and return outline + pagination metadata.
 */
export async function runWebFetch(
  rawArgs: Record<string, unknown>,
  userId: string | undefined
): Promise<WebFetchResult> {
  const start = Date.now();
  const userHash = hashUserId(userId);
  const apiKey = userId ? getSettingValue(userId, 'jina_api_key') : undefined;

  const parsed = webFetchArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    const issues = 'issues' in parsed.error ? (parsed.error as { issues: { message: string }[] }).issues : [];
    const msg = issues.map((iss) => iss.message).join('; ') || parsed.error.message || 'Invalid arguments';
    const domain = typeof rawArgs.url === 'string' ? domainForLog(String(rawArgs.url)) : '(none)';
    console.log(`[web_fetch] ${userHash} ${domain} ${Date.now() - start}ms error=validation ${msg}`);
    return { content: '', url: '', error: msg };
  }

  if (isRateLimited(userId)) {
    const domain = domainForLog(parsed.data.url);
    console.log(`[web_fetch] ${userHash} ${domain} ${Date.now() - start}ms error=rate_limited`);
    return {
      content: '',
      url: parsed.data.url,
      error: `Rate limit exceeded. Max ${RATE_LIMIT_MAX_REQUESTS} requests per minute.`,
    };
  }

  const { url, max_chars, offset } = parsed.data;
  const cacheKey = cacheKeyFrom(userId, url, parsed.data);

  // Pagination request (offset > 0): must be served from cache
  if (offset > 0) {
    const cached = parsed.data.no_cache ? undefined : getCached(cacheKey);
    if (!cached) {
      console.log(`[web_fetch] ${userHash} ${domainForLog(url)} ${Date.now() - start}ms error=cache_miss offset=${offset}`);
      return { content: '', url, error: PAGINATION_ERROR };
    }
    const totalLength = cached.content.length;
    const nextOffset = Math.min(offset + max_chars, totalLength);
    const chunk = cached.content.slice(offset, nextOffset);
    const hasMore = nextOffset < totalLength;
    const navigationHint = hasMore
      ? `Para el siguiente segmento, llama de nuevo con offset=${nextOffset} y el mismo url y max_chars.`
      : undefined;
    console.log(`[web_fetch] ${userHash} ${domainForLog(url)} ${Date.now() - start}ms ok fromCache offset=${offset} total=${totalLength}`);
    return {
      content: chunk,
      url,
      truncated: hasMore,
      total_length: totalLength,
      offset,
      next_offset: nextOffset,
      has_more: hasMore,
      outline: cached.outline,
      navigation_hint: navigationHint,
    };
  }

  // offset === 0: try cache first (unless no_cache), else fetch from Jina
  let fullContent = '';
  let outline = '';
  let fromCache = false;

  if (!parsed.data.no_cache) {
    const cached = getCached(cacheKey);
    if (cached) {
      fullContent = cached.content;
      outline = cached.outline;
      fromCache = true;
    }
  }

  if (!fromCache) {
    const options = buildOptions(parsed.data, apiKey);
    const response = await fetchWithJinaReader(options);
    const durationMs = Date.now() - start;
    const domain = domainForLog(url);

    if (response.error) {
      console.log(`[web_fetch] ${userHash} ${domain} ${durationMs}ms error=${response.error.slice(0, 80)}`);
      return { content: '', url, error: response.error };
    }

    fullContent = response.data ?? '';
    outline = extractOutline(fullContent, parsed.data.respond_with, OUTLINE_MAX_CHARS);

    if (!parsed.data.no_cache) {
      setCached(cacheKey, { content: fullContent, outline, storedAt: Date.now() }, userId);
    }
  }

  const totalLength = fullContent.length;
  const nextOffset = Math.min(offset + max_chars, totalLength);
  const chunk = fullContent.slice(0, nextOffset);
  const hasMore = nextOffset < totalLength;
  const navigationHint = hasMore
    ? `Para el siguiente segmento, llama de nuevo con offset=${nextOffset} y el mismo url y max_chars.`
    : undefined;

  const durationMs = Date.now() - start;
  console.log(`[web_fetch] ${userHash} ${domainForLog(url)} ${durationMs}ms ok ${fromCache ? 'fromCache' : 'fetched'} total=${totalLength} offset=0`);

  return {
    content: chunk,
    url,
    truncated: hasMore,
    total_length: totalLength,
    offset: 0,
    next_offset: nextOffset,
    has_more: hasMore,
    outline,
    navigation_hint: navigationHint,
  };
}
