import { extractReadableContent } from './htmlExtract.js';

const CDX_BASE = 'https://web.archive.org/cdx/search/cdx';

export interface WaybackFetchResult {
  content: string;
  title?: string;
  /** Wayback CDX timestamp, format "yyyyMMddHHmmss", e.g. "20150317140825". */
  snapshotTimestamp: string;
}

interface CdxLookupResult {
  timestamp: string;
  originalUrl: string;
}

/**
 * Looks up the newest statuscode:200 snapshot for a URL via the Wayback CDX API.
 */
async function findNewestSnapshot(url: string, timeoutMs: number): Promise<CdxLookupResult | { error: string }> {
  const params = new URLSearchParams({
    url,
    output: 'json',
    filter: 'statuscode:200',
    limit: '10',
  });
  let res: Response;
  try {
    res = await fetch(`${CDX_BASE}?${params.toString()}`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `Wayback CDX falló: ${msg}` };
  }
  if (!res.ok) {
    return { error: `Wayback CDX respondió con estado HTTP ${res.status}` };
  }
  let rows: unknown;
  try {
    rows = JSON.parse(await res.text());
  } catch {
    return { error: 'Respuesta de Wayback CDX no es JSON válido' };
  }
  // CDX JSON shape: first row is the header (column names); remaining rows are data arrays.
  if (!Array.isArray(rows) || rows.length < 2) {
    return { error: 'No se encontró ninguna copia archivada de esta URL en Wayback Machine' };
  }
  const header = rows[0] as string[];
  const tsIdx = header.indexOf('timestamp');
  const origIdx = header.indexOf('original');
  if (tsIdx === -1 || origIdx === -1) {
    return { error: 'Formato de respuesta de Wayback CDX inesperado' };
  }
  const dataRows = rows.slice(1) as string[][];
  // Do not assume any particular row order from the API; timestamps are "yyyyMMddHHmmss"
  // strings, so lexicographic comparison equals chronological comparison — pick the max.
  let newest = dataRows[0];
  for (const row of dataRows) {
    if (row[tsIdx] > newest[tsIdx]) newest = row;
  }
  return { timestamp: newest[tsIdx], originalUrl: newest[origIdx] };
}

/**
 * Last-resort fallback: looks up the newest archived snapshot of a URL and fetches it
 * directly from web.archive.org (never via Jina — Jina blocks anonymous access to
 * web.archive.org entirely), then pipes the HTML through extractReadableContent().
 */
export async function fetchFromWayback(
  url: string,
  cdxTimeoutMs: number,
  snapshotTimeoutMs: number
): Promise<WaybackFetchResult | { error: string }> {
  const lookup = await findNewestSnapshot(url, cdxTimeoutMs);
  if ('error' in lookup) return lookup;

  const snapshotUrl = `https://web.archive.org/web/${lookup.timestamp}/${lookup.originalUrl}`;
  let res: Response;
  try {
    res = await fetch(snapshotUrl, { signal: AbortSignal.timeout(snapshotTimeoutMs) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `Wayback snapshot fetch falló: ${msg}` };
  }
  if (!res.ok) {
    return { error: `Wayback snapshot respondió con estado HTTP ${res.status}` };
  }
  const html = await res.text();
  const extracted = extractReadableContent(html, snapshotUrl);
  if ('error' in extracted) return extracted;
  return { ...extracted, snapshotTimestamp: lookup.timestamp };
}

/** Formats a Wayback CDX timestamp ("yyyyMMddHHmmss") as "yyyy-MM-dd" for display. */
export function formatWaybackTimestamp(timestamp: string): string {
  if (!/^\d{8,14}$/.test(timestamp)) return timestamp;
  return `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`;
}
