/**
 * Builtin tool definitions (OpenAI/OpenRouter format) and executors.
 * Only tools listed here can be used when type is "builtin".
 */

import { runWebSearch, type WebSearchResult, type BraveSearchOptions } from './webSearch.js';
import { getSettingValue } from '../routes/settings.js';

export type ToolExecutor = (args: Record<string, unknown>, config?: unknown, userId?: string) => Promise<string>;

export interface OpenAIToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description?: string; default?: unknown }>;
      required?: string[];
    };
  };
}

const BUILTIN_DEFINITIONS: Record<string, OpenAIToolDef> = {
  web_search: {
    type: 'function',
    function: {
      name: 'web_search',
      description: `Search the web for current information. Use for recent events, facts, or external sources.
When the search provider is Brave you can use:
- Query operators: exact phrase in quotes, exclude with minus (-term), site:domain.com, filetype:pdf.
- Optional parameters: freshness (pd=24h, pw=7d, pm=31d, py=year, or YYYY-MM-DDtoYYYY-MM-DD), country (ISO 2-letter, e.g. US, ES), search_lang (e.g. en, es), extra_snippets for more context per result, result_filter (comma-separated: web, news, faq, discussions, locations, infobox, videos, summarizer), offset (0-9) for the next page when the response has more_results_available, safesearch (off, moderate, strict). For local intent you can pass latitude/longitude or country/region/city/postal_code.`,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          max_results: { type: 'number', description: 'Maximum number of results (default 5)', default: 5 },
          freshness: { type: 'string', description: '(Brave) pd=24h, pw=7d, pm=31d, py=year, or YYYY-MM-DDtoYYYY-MM-DD' },
          country: { type: 'string', description: '(Brave) ISO 3166-1 alpha-2 country code (e.g. US, ES)' },
          search_lang: { type: 'string', description: '(Brave) Language code (e.g. en, es, de)' },
          extra_snippets: { type: 'boolean', description: '(Brave) Request extra snippets per result' },
          result_filter: { type: 'string', description: '(Brave) Comma-separated: web, news, faq, discussions, locations, infobox, videos, summarizer' },
          offset: { type: 'number', description: '(Brave) Pagination offset 0-9; use when more_results_available is true' },
          safesearch: { type: 'string', description: '(Brave) off, moderate, or strict' },
          latitude: { type: 'number', description: '(Brave) Latitude for local intent' },
          longitude: { type: 'number', description: '(Brave) Longitude for local intent' },
        },
        required: ['query'],
      },
    },
  },
  get_current_time: {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: 'Get the current date and time in ISO 8601 format. Use when the user asks for the current time, date, or timezone.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
};

const executors: Record<string, ToolExecutor> = {
  async web_search(args: Record<string, unknown>, _config?: unknown, userId?: string): Promise<string> {
    const query = typeof args.query === 'string' ? args.query : String(args.query ?? '');
    const maxResults = typeof args.max_results === 'number' ? Math.min(args.max_results, 20) : 5;

    const apiKey = userId ? getSettingValue(userId, 'search_api_key') : '';
    const provider = (userId ? getSettingValue(userId, 'search_provider') || 'exa' : 'exa').toLowerCase();

    let braveOptions: BraveSearchOptions | undefined;
    if (provider === 'brave') {
      braveOptions = {};
      if (typeof args.freshness === 'string' && args.freshness.trim()) braveOptions.freshness = args.freshness.trim();
      if (typeof args.country === 'string' && args.country.trim()) braveOptions.country = args.country.trim();
      if (typeof args.search_lang === 'string' && args.search_lang.trim()) braveOptions.search_lang = args.search_lang.trim();
      if (args.extra_snippets === true) braveOptions.extra_snippets = true;
      if (typeof args.result_filter === 'string' && args.result_filter.trim()) braveOptions.result_filter = args.result_filter.trim();
      if (typeof args.offset === 'number' && args.offset >= 0 && args.offset <= 9) braveOptions.offset = args.offset;
      if (typeof args.safesearch === 'string' && ['off', 'moderate', 'strict'].includes(args.safesearch)) {
        braveOptions.safesearch = args.safesearch as 'off' | 'moderate' | 'strict';
      }
      if (typeof args.latitude === 'number' && !Number.isNaN(args.latitude)) braveOptions.latitude = args.latitude;
      if (typeof args.longitude === 'number' && !Number.isNaN(args.longitude)) braveOptions.longitude = args.longitude;
    }

    const result = await runWebSearch(query, maxResults, {
      apiKey,
      provider,
      brave: braveOptions,
    });

    if (result.error) {
      return JSON.stringify({ error: result.error, results: result.results ?? [] });
    }
    return JSON.stringify(result);
  },

  async get_current_time(_args?: Record<string, unknown>, _config?: unknown, _userId?: string): Promise<string> {
    return JSON.stringify({ iso: new Date().toISOString() });
  },
};

export function getBuiltinDefinition(name: string): OpenAIToolDef | undefined {
  return BUILTIN_DEFINITIONS[name];
}

export function getBuiltinExecutor(name: string): ToolExecutor | undefined {
  return executors[name];
}

export function getAllBuiltinNames(): string[] {
  return Object.keys(BUILTIN_DEFINITIONS);
}

export function isBuiltin(name: string): boolean {
  return name in BUILTIN_DEFINITIONS;
}

/**
 * Build annotations array from web_search result for citation links in the UI.
 */
export function annotationsFromWebSearchResults(results: WebSearchResult[]): { type: string; url: string; title?: string; start_index: number; end_index: number }[] {
  return results.slice(0, 20).map((r, i) => ({
    type: 'url_citation',
    url: r.url,
    title: r.title,
    start_index: i * 10,
    end_index: i * 10 + 5,
  }));
}
