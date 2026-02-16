/**
 * Web search tool: calls external search API (Exa, Brave, or Tavily) using settings.
 * Returns JSON string of results for the model; also used to build annotations for citations.
 */

export interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
  extra_snippets?: string[];
}

/** Brave-specific query and location options (used when provider is brave). */
export interface BraveSearchOptions {
  freshness?: string;       // pd | pw | pm | py | YYYY-MM-DDtoYYYY-MM-DD
  country?: string;         // ISO 3166-1 alpha-2
  search_lang?: string;     // e.g. en, es, de
  ui_lang?: string;         // e.g. en-US
  extra_snippets?: boolean;
  result_filter?: string;  // comma-separated: web, news, faq, discussions, locations, infobox, videos, summarizer
  offset?: number;         // 0-9 for pagination
  safesearch?: 'off' | 'moderate' | 'strict';
  units?: 'metric' | 'imperial';
  // Location headers (for local intent)
  latitude?: number;
  longitude?: number;
  timezone?: string;        // IANA
  city?: string;
  state?: string;
  state_name?: string;
  country_header?: string;  // x-loc-country
  postal_code?: string;
}

export interface WebSearchOptions {
  provider?: string;
  apiKey?: string;
  maxResults?: number;
  brave?: BraveSearchOptions;
}

/** Normalized section item for news, faq, discussions, etc. */
export interface BraveSectionItem {
  title: string;
  url: string;
  description?: string;
  [key: string]: unknown;
}

/** Query metadata from Brave (spellcheck, pagination). */
export interface BraveQueryMeta {
  original?: string;
  altered?: string;
  more_results_available?: boolean;
}

/** Full Brave response shape (for LLM); results kept for compatibility and citations. */
export interface BraveSearchResponse {
  results: WebSearchResult[];
  error?: string;
  news?: BraveSectionItem[];
  faq?: BraveSectionItem[];
  discussions?: BraveSectionItem[];
  infobox?: BraveSectionItem[];
  locations?: BraveSectionItem[];
  query_meta?: BraveQueryMeta;
}

const EXA_API = 'https://api.exa.ai/search';

// Brave Free plan: 1 request per second (sliding window). Throttle + retries to avoid 429.
const BRAVE_MIN_INTERVAL_MS = 1000;
const BRAVE_MAX_RETRIES = 4;
const BRAVE_MAX_RATE_LIMIT_WAIT_MS = 60_000;

/** Earliest time (ms) the next Brave request may start. */
let braveNextStartTime = 0;
/** Serialized queue: each Brave request chains here and runs after the previous with ≥1s spacing. */
let braveTail: Promise<BraveSearchResponse> = Promise.resolve({ results: [] });

export type WebSearchReturn = BraveSearchResponse;

export async function runWebSearch(
  query: string,
  maxResults: number = 5,
  options: WebSearchOptions = {}
): Promise<WebSearchReturn> {
  const apiKey = options.apiKey;
  const provider = (options.provider || 'exa').toLowerCase();

  if (!apiKey?.trim()) {
    return {
      results: [],
      error: 'Web search is not configured. Please set a search API key in Settings (e.g. Exa, Brave, or Tavily).',
    };
  }

  if (provider === 'exa') {
    return runExaSearch(query, maxResults, apiKey);
  }

  if (provider === 'brave') {
    return runBraveSearch(query, maxResults, apiKey, options.brave);
  }

  if (provider === 'tavily') {
    return runTavilySearch(query, maxResults, apiKey);
  }

  return runExaSearch(query, maxResults, apiKey);
}

async function runExaSearch(query: string, numResults: number, apiKey: string): Promise<{ results: WebSearchResult[]; error?: string }> {
  try {
    const res = await fetch(EXA_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        query,
        numResults: Math.min(numResults, 10),
        contents: { text: true },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      return { results: [], error: `Exa search failed (${res.status}): ${errText.slice(0, 200)}` };
    }

    const data = (await res.json()) as { results?: { title?: string; url?: string; text?: string }[] };
    const results: WebSearchResult[] = (data.results || []).map((r) => ({
      title: r.title || '',
      url: r.url || '',
      snippet: r.text,
    }));
    return { results };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { results: [], error: `Web search error: ${msg}` };
  }
}

const BRAVE_SECTION_LIMIT = 10;

/**
 * Performs a single Brave API request. Used inside the throttled queue with retry logic.
 * Builds query params and optional x-loc-* headers from brave options.
 */
async function doBraveFetch(
  query: string,
  count: number,
  apiKey: string,
  brave?: BraveSearchOptions
): Promise<{ res: Response; bodyText: string }> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.min(count, 20)));

  if (brave) {
    if (brave.freshness) url.searchParams.set('freshness', brave.freshness);
    if (brave.country) url.searchParams.set('country', brave.country);
    if (brave.search_lang) url.searchParams.set('search_lang', brave.search_lang);
    if (brave.ui_lang) url.searchParams.set('ui_lang', brave.ui_lang);
    if (brave.extra_snippets === true) url.searchParams.set('extra_snippets', '1');
    if (brave.result_filter) url.searchParams.set('result_filter', brave.result_filter);
    if (brave.offset !== undefined && brave.offset >= 0 && brave.offset <= 9) {
      url.searchParams.set('offset', String(brave.offset));
    }
    if (brave.safesearch) url.searchParams.set('safesearch', brave.safesearch);
    if (brave.units) url.searchParams.set('units', brave.units);
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Subscription-Token': apiKey,
  };
  if (brave) {
    if (brave.latitude !== undefined && !Number.isNaN(brave.latitude)) {
      headers['x-loc-lat'] = String(brave.latitude);
    }
    if (brave.longitude !== undefined && !Number.isNaN(brave.longitude)) {
      headers['x-loc-long'] = String(brave.longitude);
    }
    if (brave.country_header) headers['x-loc-country'] = brave.country_header;
    if (brave.timezone) headers['x-loc-timezone'] = brave.timezone;
    if (brave.city) headers['x-loc-city'] = brave.city;
    if (brave.state) headers['x-loc-state'] = brave.state;
    if (brave.state_name) headers['x-loc-state-name'] = brave.state_name;
    if (brave.postal_code) headers['x-loc-postal-code'] = brave.postal_code;
  }

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  const bodyText = await res.text();
  return { res, bodyText };
}

/** Normalize a Brave API section (e.g. news.results) to BraveSectionItem[], capped. */
function normalizeSection(
  items: unknown[],
  limit: number = BRAVE_SECTION_LIMIT
): BraveSectionItem[] {
  const out: BraveSectionItem[] = [];
  for (let i = 0; i < Math.min(items.length, limit); i++) {
    const r = items[i] as Record<string, unknown> | null;
    if (!r || typeof r !== 'object') continue;
    out.push({
      title: (r.title as string) ?? (r.name as string) ?? '',
      url: (r.url as string) ?? '',
      description: (r.description as string) ?? (r.snippet as string),
    });
  }
  return out;
}

function runBraveSearch(
  query: string,
  count: number,
  apiKey: string,
  brave?: BraveSearchOptions
): Promise<BraveSearchResponse> {
  const run = async (): Promise<BraveSearchResponse> => {
    try {
      const waitMs = Math.max(0, braveNextStartTime - Date.now());
      if (waitMs > 0) {
        await new Promise((r) => setTimeout(r, waitMs));
      }
      braveNextStartTime = Date.now() + BRAVE_MIN_INTERVAL_MS;

      let lastErrText = '';
      for (let attempt = 0; attempt <= BRAVE_MAX_RETRIES; attempt++) {
        const { res, bodyText } = await doBraveFetch(query, count, apiKey, brave);
        lastErrText = bodyText.slice(0, 200);

        if (res.ok) {
          try {
            const data = JSON.parse(bodyText) as {
              web?: { results?: { title?: string; url?: string; description?: string; extra_snippets?: string[] }[] };
              news?: { results?: unknown[] };
              faq?: { results?: unknown[] };
              discussions?: { results?: unknown[] };
              infobox?: { results?: unknown[] };
              locations?: { results?: unknown[] };
              query?: { original?: string; altered?: string; more_results_available?: boolean };
            };
            const webList = data.web?.results ?? [];
            const results: WebSearchResult[] = webList.map((r) => ({
              title: r.title ?? '',
              url: r.url ?? '',
              snippet: r.description,
              ...(r.extra_snippets?.length ? { extra_snippets: r.extra_snippets } : undefined),
            }));
            const news = normalizeSection((data.news?.results as unknown[]) ?? []);
            const faq = normalizeSection((data.faq?.results as unknown[]) ?? []);
            const discussions = normalizeSection((data.discussions?.results as unknown[]) ?? []);
            const infobox = normalizeSection((data.infobox?.results as unknown[]) ?? []);
            const locations = normalizeSection((data.locations?.results as unknown[]) ?? []);
            const query_meta = data.query
              ? {
                  original: data.query.original,
                  altered: data.query.altered,
                  more_results_available: data.query.more_results_available,
                }
              : undefined;
            const response: BraveSearchResponse = {
              results,
              ...(news.length ? { news } : undefined),
              ...(faq.length ? { faq } : undefined),
              ...(discussions.length ? { discussions } : undefined),
              ...(infobox.length ? { infobox } : undefined),
              ...(locations.length ? { locations } : undefined),
              ...(query_meta && (query_meta.original != null || query_meta.altered != null || query_meta.more_results_available != null) ? { query_meta } : undefined),
            };
            return response;
          } catch {
            return { results: [], error: `Brave search failed: invalid JSON` };
          }
        }

        if (res.status !== 429 || attempt === BRAVE_MAX_RETRIES) {
          return { results: [], error: `Brave search failed (${res.status}): ${lastErrText}` };
        }

        const resetSec = res.headers.get('X-RateLimit-Reset');
        let waitRetryMs = 1000 * Math.pow(2, attempt);
        if (resetSec !== null && resetSec !== '') {
          const sec = parseInt(resetSec, 10);
          if (!Number.isNaN(sec) && sec >= 1 && sec <= 120) {
            waitRetryMs = Math.min(sec * 1000, BRAVE_MAX_RATE_LIMIT_WAIT_MS);
          }
        }
        await new Promise((r) => setTimeout(r, waitRetryMs));
      }

      return { results: [], error: `Brave search failed (429): ${lastErrText}` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { results: [], error: `Web search error: ${msg}` };
    }
  };

  const myTurn = braveTail.then(() => run(), () => run());
  braveTail = myTurn;
  return myTurn;
}

async function runTavilySearch(query: string, maxResults: number, apiKey: string): Promise<{ results: WebSearchResult[]; error?: string }> {
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: Math.min(maxResults, 10),
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      return { results: [], error: `Tavily search failed (${res.status}): ${errText.slice(0, 200)}` };
    }

    const data = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
    const results: WebSearchResult[] = (data.results || []).map((r) => ({
      title: r.title || '',
      url: r.url || '',
      snippet: r.content,
    }));
    return { results };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { results: [], error: `Web search error: ${msg}` };
  }
}
