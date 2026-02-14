/**
 * HTTP tool: executes a user-defined HTTP request with the arguments from the model.
 * GET: arguments sent as query params. POST: arguments sent as JSON body.
 */

export interface HttpToolConfig {
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
}

const MAX_RESPONSE_BYTES = 100_000;
const TIMEOUT_MS = 30_000;

export async function runHttpTool(config: HttpToolConfig, args: Record<string, unknown>): Promise<string> {
  const url = config?.url?.trim();
  if (!url) {
    return JSON.stringify({ error: 'HTTP tool has no URL configured.' });
  }

  const method = (config.method || 'GET').toUpperCase() as 'GET' | 'POST';
  if (method !== 'GET' && method !== 'POST') {
    return JSON.stringify({ error: 'HTTP tool only supports GET or POST.' });
  }

  try {
    const parsed = new URL(url);
    if (['localhost', '127.0.0.1'].includes(parsed.hostname)) {
      return JSON.stringify({ error: 'HTTP tool cannot target localhost.' });
    }
  } catch {
    return JSON.stringify({ error: 'HTTP tool URL is invalid.' });
  }

  const headers: Record<string, string> = {
    'Accept': 'application/json, text/plain, */*',
    ...(config.headers || {}),
  };

  let finalUrl = url;
  let body: string | undefined;

  if (method === 'GET') {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(args)) {
      if (v !== undefined && v !== null) {
        params.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      }
    }
    const sep = url.includes('?') ? '&' : '?';
    finalUrl = params.toString() ? `${url}${sep}${params.toString()}` : url;
  } else {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    body = JSON.stringify(args);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(finalUrl, {
      method,
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const contentType = res.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json');
    let text = await res.text();

    if (text.length > MAX_RESPONSE_BYTES) {
      text = text.slice(0, MAX_RESPONSE_BYTES) + '\n...[truncated]';
    }

    if (!res.ok) {
      return JSON.stringify({
        error: `HTTP ${res.status}`,
        body: isJson ? tryParse(text) : text,
      });
    }

    if (isJson) {
      return text;
    }
    return JSON.stringify({ content: text });
  } catch (e) {
    clearTimeout(timeout);
    const msg = e instanceof Error ? e.message : String(e);
    return JSON.stringify({ error: msg });
  }
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
