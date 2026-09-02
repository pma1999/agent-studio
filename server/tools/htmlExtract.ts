import type { JSDOM } from 'jsdom';

export interface ExtractedContent {
  title?: string;
  content: string;
}

type Parsers = {
  JSDOM: typeof import('jsdom')['JSDOM'];
  Readability: typeof import('@mozilla/readability')['Readability'];
};

let parsersPromise: Promise<Parsers> | null = null;

/**
 * jsdom drags ~80 MB of RSS into the process the moment it is imported, and it
 * is only needed when a fetched page has to be reduced to article text — a path
 * most requests never take. Importing it on first use (and caching the promise)
 * keeps that memory off every boot, which matters because the deployed API is
 * billed on memory-time and sleeps between bursts of use.
 */
function loadParsers(): Promise<Parsers> {
  if (!parsersPromise) {
    parsersPromise = Promise.all([import('jsdom'), import('@mozilla/readability')])
      .then(([jsdom, readability]) => ({ JSDOM: jsdom.JSDOM, Readability: readability.Readability }))
      .catch((err) => {
        parsersPromise = null; // don't cache a failed load; the next call retries
        throw err;
      });
  }
  return parsersPromise;
}

/**
 * Extracts clean, readable article content from raw HTML using Readability.
 * Returns { error } (never throws) for unparseable HTML or pages with no
 * extractable article content (e.g. non-article pages, landing pages).
 */
export async function extractReadableContent(html: string, url: string): Promise<ExtractedContent | { error: string }> {
  let parsers: Parsers;
  try {
    parsers = await loadParsers();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `No se pudo cargar el extractor de contenido: ${msg}` };
  }

  let dom: JSDOM;
  try {
    dom = new parsers.JSDOM(html, { url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `No se pudo parsear el HTML: ${msg}` };
  }

  try {
    const reader = new parsers.Readability(dom.window.document);
    const article = reader.parse();
    if (!article || !article.textContent || article.textContent.trim().length === 0) {
      return { error: 'No se pudo extraer contenido legible del HTML (posible página sin artículo real).' };
    }
    const text = article.textContent.replace(/\n{3,}/g, '\n\n').trim();
    const content = article.title ? `# ${article.title}\n\n${text}` : text;
    return { title: article.title || undefined, content };
  } finally {
    dom.window.close();
  }
}
