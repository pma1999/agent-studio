import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

export interface ExtractedContent {
  title?: string;
  content: string;
}

/**
 * Extracts clean, readable article content from raw HTML using Readability.
 * Returns { error } (never throws) for unparseable HTML or pages with no
 * extractable article content (e.g. non-article pages, landing pages).
 */
export function extractReadableContent(html: string, url: string): ExtractedContent | { error: string } {
  let dom: JSDOM;
  try {
    dom = new JSDOM(html, { url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `No se pudo parsear el HTML: ${msg}` };
  }

  try {
    const reader = new Readability(dom.window.document);
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
