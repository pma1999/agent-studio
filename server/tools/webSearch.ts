/**
 * Web search tool: calls external search API (Exa, Brave, or Tavily) using settings.
 * Returns JSON string of results for the model; also used to build annotations for citations.
 */

export interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export interface WebSearchOptions {
  provider?: string;
  apiKey?: string;
  maxResults?: number;
}

const EXA_API = 'https://api.exa.ai/search';

export async function runWebSearch(
  query: string,
  maxResults: number = 5,
  options: WebSearchOptions = {}
): Promise<{ results: WebSearchResult[]; error?: string }> {
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
    return runBraveSearch(query, maxResults, apiKey);
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

async function runBraveSearch(query: string, count: number, apiKey: string): Promise<{ results: WebSearchResult[]; error?: string }> {
  try {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(Math.min(count, 20)));

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': apiKey,
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      return { results: [], error: `Brave search failed (${res.status}): ${errText.slice(0, 200)}` };
    }

    const data = (await res.json()) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
    const results: WebSearchResult[] = (data.web?.results || []).map((r) => ({
      title: r.title || '',
      url: r.url || '',
      snippet: r.description,
    }));
    return { results };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { results: [], error: `Web search error: ${msg}` };
  }
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
