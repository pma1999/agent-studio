/**
 * Builtin tool definitions (OpenAI/OpenRouter format) and executors.
 * Only tools listed here can be used when type is "builtin".
 */

import { runWebSearch, type WebSearchResult } from './webSearch.js';
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
      description: 'Search the web for current information. Use when the user asks about recent events, facts, or when you need up-to-date or external information.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          max_results: { type: 'number', description: 'Maximum number of results (default 5)', default: 5 },
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
    const maxResults = typeof args.max_results === 'number' ? Math.min(args.max_results, 10) : 5;

    const apiKey = userId ? getSettingValue(userId, 'search_api_key') : '';
    const provider = userId ? getSettingValue(userId, 'search_provider') || 'exa' : 'exa';

    const result = await runWebSearch(query, maxResults, {
      apiKey,
      provider,
    });

    if (result.error) {
      return JSON.stringify({ error: result.error, results: [] });
    }
    return JSON.stringify(result.results);
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
