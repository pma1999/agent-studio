import { extractReadableContent } from './htmlExtract.js';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export interface DirectFetchResult {
  content: string;
  title?: string;
}

/**
 * Fetches a URL directly (bypassing Jina Reader entirely) with a realistic desktop
 * browser User-Agent, then pipes successful HTML responses through
 * extractReadableContent(). Never throws for expected failure modes (network errors,
 * timeouts, non-2xx responses, non-HTML content types) — returns { error } instead.
 */
export async function fetchDirect(url: string, timeoutMs: number): Promise<DirectFetchResult | { error: string }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      error:
        msg.includes('abort') || msg.includes('timeout')
          ? `Fetch directo agotó el tiempo de espera (${timeoutMs}ms)`
          : `Fetch directo falló: ${msg}`,
    };
  }

  if (!res.ok) {
    return { error: `Fetch directo respondió con estado HTTP ${res.status}` };
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('html')) {
    return { error: `Fetch directo devolvió un content-type no soportado: ${contentType || '(desconocido)'}` };
  }

  const html = await res.text();
  return await extractReadableContent(html, url);
}
