/**
 * web_fetch builtin: validation (Zod), rate limiting, observability, and orchestration.
 * Delegates actual HTTP to jinaReader; applies response size limit and logging.
 */

import { z } from 'zod';
import { fetchWithJinaReader, type JinaReaderOptions } from './jinaReader.js';
import { getSettingValue } from '../routes/settings.js';

const RESPOND_WITH = ['content', 'markdown', 'html', 'text', 'pageshot', 'screenshot', 'vlm', 'readerlm-v2'] as const;
const RETAIN_IMAGES = ['none', 'all', 'alt', 'all_p', 'alt_p'] as const;
const RETAIN_LINKS = ['none', 'all', 'text', 'gpt-oss'] as const;
const RESPOND_TIMING = ['html', 'visible-content', 'mutation-idle', 'resource-idle', 'media-idle', 'network-idle'] as const;
const ENGINE = ['browser', 'direct', 'cf-browser-rendering'] as const;

export const webFetchArgsSchema = z.object({
  url: z.string().min(1, 'url is required').transform((s) => s.trim()),
  respond_with: z.enum(RESPOND_WITH).optional().default('markdown'),
  timeout_seconds: z.coerce.number().int().min(1).max(180).optional().default(45),
  no_cache: z.boolean().optional().default(false),
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

/** Max characters to return; larger responses are truncated with a note. */
export const WEB_FETCH_MAX_CONTENT_LENGTH = 500_000;

/** Rate limit: max requests per window per user. */
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
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
  error?: string;
}

/**
 * Run web_fetch: validate args, check rate limit, call Jina, apply max length, log.
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

  const options = buildOptions(parsed.data, apiKey);
  const response = await fetchWithJinaReader(options);
  const durationMs = Date.now() - start;
  const domain = domainForLog(parsed.data.url);

  if (response.error) {
    console.log(`[web_fetch] ${userHash} ${domain} ${durationMs}ms error=${response.error.slice(0, 80)}`);
    return { content: '', url: parsed.data.url, error: response.error };
  }

  let content = response.data ?? '';
  let truncated = false;
  if (content.length > WEB_FETCH_MAX_CONTENT_LENGTH) {
    content = content.slice(0, WEB_FETCH_MAX_CONTENT_LENGTH) + `\n\n[... content truncated at ${WEB_FETCH_MAX_CONTENT_LENGTH} characters]`;
    truncated = true;
  }

  console.log(`[web_fetch] ${userHash} ${domain} ${durationMs}ms ok size=${content.length}${truncated ? ' truncated' : ''}`);
  return { content, url: parsed.data.url, truncated: truncated || undefined };
}
