/**
 * Builtin tool definitions (OpenAI/OpenRouter format) and executors.
 * Only tools listed here can be used when type is "builtin".
 */

import { runWebSearch, type WebSearchResult, type BraveSearchOptions } from './webSearch.js';
import { runWebFetch } from './webFetch.js';
import {
  deleteFileTool,
  editFileTool,
  listDirectoryTool,
  readFileTool,
  writeFileTool,
} from './execFileOps.js';
import { getSettingValue } from '../routes/settings.js';

export type ToolExecutor = (args: Record<string, unknown>, config?: unknown, userId?: string, conversationId?: string) => Promise<string>;

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
  web_fetch: {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: `Fetch the main content of a web page as clean text or markdown via Jina Reader. Use when the user provides a URL to read, summarize, or analyze. Supports pagination for long pages: use max_chars to control segment size and offset to get the next segment; the response includes outline (structure/headings), total_length, next_offset, and has_more so you can navigate. First call with url (and optional max_chars); if has_more is true, call again with the same url and max_chars and offset set to the returned next_offset.
Optional: max_chars (1000-2000000, default 200000), offset (for pagination; use next_offset from previous response), respond_with (content|markdown|html|text), timeout_seconds (1-180), no_cache, wait_for_selector, target_selector, remove_selector, user_agent, referer, locale, retain_images, retain_links, with_links_summary, with_images_summary, respond_timing, engine (browser|direct|cf-browser-rendering).

Si la página objetivo parece bloqueada, muestra un captcha, un muro de pago o contenido vacío, la herramienta reintenta automáticamente con un fetch directo y, como último recurso, con una copia archivada de Wayback Machine, antes de fallar. Un resultado con error significa que se agotaron todos los métodos disponibles. Un resultado exitoso puede incluir source y source_note cuando el contenido provino de uno de estos métodos alternativos (por ejemplo, una copia de Wayback puede estar desactualizada).`,
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL of the page to fetch (required)' },
          max_chars: { type: 'number', description: 'Maximum characters to return per call (1000-2000000). Default 200000. Use with offset to paginate long pages.', default: 200000 },
          offset: { type: 'number', description: 'Character offset for pagination. Use 0 or omit for first segment; then use the next_offset from the response for the next segment.', default: 0 },
          respond_with: { type: 'string', description: 'Output format: content, markdown, html, or text', default: 'markdown' },
          timeout_seconds: { type: 'number', description: 'Timeout in seconds (1-180)', default: 45 },
          no_cache: { type: 'boolean', description: 'Bypass cache' },
          wait_for_selector: { type: 'string', description: 'CSS selector to wait for before returning' },
          target_selector: { type: 'string', description: 'CSS selector to extract only that part of the page' },
          remove_selector: { type: 'string', description: 'CSS selector of elements to remove (e.g. nav, ads)' },
          user_agent: { type: 'string', description: 'Custom User-Agent string' },
          referer: { type: 'string', description: 'Referer header' },
          locale: { type: 'string', description: 'Browser locale (e.g. en-US)' },
          retain_images: { type: 'string', description: 'none, all, alt, all_p, or alt_p' },
          retain_links: { type: 'string', description: 'none, all, text, or gpt-oss' },
          with_links_summary: { type: 'boolean', description: 'Include a summary section for links' },
          with_images_summary: { type: 'boolean', description: 'Include a summary section for images' },
          respond_timing: { type: 'string', description: 'When to return: html, visible-content, mutation-idle, resource-idle, media-idle, network-idle' },
          engine: { type: 'string', description: 'Crawl engine: browser, direct, or cf-browser-rendering' },
        },
        required: ['url'],
      },
    },
  },
  read_file: {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file from the connected local agent with line numbers (like cat -n) and offset/limit paging (defaults to the first 2000 lines). Binary files are rejected. Requires a connected local agent.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root.' },
          offset: { type: 'number', description: '1-based first line to read. Defaults to 1.' },
          limit: { type: 'number', description: 'Maximum number of lines to read. Defaults to 2000.' },
        },
        required: ['path'],
      },
    },
  },
  write_file: {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a text file with the exact content provided (without shell quoting); parent directories are created automatically. Before overwriting an existing file, you must read it first with read_file. Requires a connected local agent.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root.' },
          content: { type: 'string', description: 'Exact text content to write.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  edit_file: {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace an exact, unique text match in a file; set replace_all to replace every match. You must read an existing file first with read_file before editing it. Requires a connected local agent.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root.' },
          old_string: { type: 'string', description: 'Exact text to find.' },
          new_string: { type: 'string', description: 'Text to insert in place of the match.' },
          replace_all: { type: 'boolean', description: 'Replace all matches instead of requiring an exact unique match.' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  delete_file: {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file or directory; recursive is required for a non-empty directory. Deletes outside the workspace or large/recursive deletes require local human confirmation within 60 seconds. Requires a connected local agent.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File or directory path relative to the workspace root.' },
          recursive: { type: 'boolean', description: 'Allow deletion of a directory and its contents.' },
        },
        required: ['path'],
      },
    },
  },
  list_directory: {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List one level of a directory (non-recursively); defaults to the workspace root. Requires a connected local agent.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: "Directory path relative to the workspace root. Defaults to '.'." },
        },
        required: [],
      },
    },
  },
  run_command: {
    type: 'function',
    function: {
      name: 'run_command',
      description: "Execute a shell command in a real, persistent working environment (a paired local machine or an isolated cloud sandbox) to run scripts, install packages, inspect/edit files, or call CLIs. Returns stdout, stderr, and exit_code as JSON; a non-zero exit_code or non-empty stderr does not necessarily mean the command failed to run — inspect the output. Available backends: 'local' (the user's own paired machine — real files, installed tools, persists across calls) and 'sandbox' (an ephemeral isolated cloud VM — no access to the user's files, resets between conversations, requires the user's own sandbox account). Use backend='auto' (default) to let the system pick whichever is configured; specify 'local' or 'sandbox' only when the task specifically needs that environment's characteristics. Prefer the dedicated read_file/write_file/edit_file/delete_file tools over shell redirection or heredocs for creating/editing files.",
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute.' },
          cwd: { type: 'string', description: 'Working directory relative to the workspace root. Omit to use the default workspace root.' },
          backend: { type: 'string', description: "'auto' (default), 'local', or 'sandbox'." },
          timeout_seconds: { type: 'number', description: 'Max seconds to wait (default 120, hard ceiling 1800).' },
        },
        required: ['command'],
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

  async web_fetch(args: Record<string, unknown>, _config?: unknown, userId?: string): Promise<string> {
    const result = await runWebFetch(args, userId);
    if (result.error) {
      return JSON.stringify({ error: result.error, url: result.url });
    }
    return JSON.stringify({
      content: result.content,
      url: result.url,
      truncated: result.truncated,
      total_length: result.total_length,
      offset: result.offset,
      next_offset: result.next_offset,
      has_more: result.has_more,
      outline: result.outline,
      navigation_hint: result.navigation_hint,
      source: result.source,
      source_note: result.source_note,
    });
  },

  async read_file(args: Record<string, unknown>, _config?: unknown, userId?: string, conversationId?: string): Promise<string> {
    return readFileTool(args, userId!, conversationId);
  },

  async write_file(args: Record<string, unknown>, _config?: unknown, userId?: string, conversationId?: string): Promise<string> {
    return writeFileTool(args, userId!, conversationId);
  },

  async edit_file(args: Record<string, unknown>, _config?: unknown, userId?: string, conversationId?: string): Promise<string> {
    return editFileTool(args, userId!, conversationId);
  },

  async delete_file(args: Record<string, unknown>, _config?: unknown, userId?: string, conversationId?: string): Promise<string> {
    return deleteFileTool(args, userId!, conversationId);
  },

  async list_directory(args: Record<string, unknown>, _config?: unknown, userId?: string, conversationId?: string): Promise<string> {
    return listDirectoryTool(args, userId!, conversationId);
  },

  async run_command(): Promise<string> {
    return JSON.stringify({ error: 'run_command requires the interactive execution context; not available from Model Council in v1.' });
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
