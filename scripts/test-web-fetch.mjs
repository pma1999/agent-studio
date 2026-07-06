/**
 * Test script for web_fetch / Jina Reader.
 * Run: node scripts/test-web-fetch.mjs [url]
 * Default URL: https://circulodepoesia.com/2015/03/walter-benjamin-tesis-sobre-el-concepto-de-historia
 */

const DEFAULT_URL = 'https://circulodepoesia.com/2015/03/walter-benjamin-tesis-sobre-el-concepto-de-historia';
const JINA_BASE = 'https://r.jina.ai/';
const WAYBACK_CDX_URL = 'https://web.archive.org/cdx';

async function testJinaDirect(url, usePathStyle = true, decodeFirst = false) {
  let targetUrl = url || DEFAULT_URL;
  if (decodeFirst) {
    try {
      targetUrl = decodeURIComponent(targetUrl);
    } catch (_) {}
  }
  let requestUrl;
  if (usePathStyle) {
    const encoded = encodeURIComponent(targetUrl);
    requestUrl = `${JINA_BASE}${encoded}?respondWith=markdown&timeout=45`;
  } else {
    const params = new URLSearchParams();
    params.set('url', targetUrl);
    params.set('respondWith', 'markdown');
    params.set('timeout', '45');
    requestUrl = `${JINA_BASE}?${params.toString()}`;
  }

  console.log('Request URL (first 120 chars):', requestUrl.slice(0, 120) + '...');
  const res = await fetch(requestUrl, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  const contentType = res.headers.get('content-type') || '';
  console.log('Content-Type:', contentType, '| body length:', text.length);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    console.log('Response (non-JSON) snippet:', text.slice(0, 400));
    return undefined;
  }
  console.log('HTTP', res.status, '| body.code:', body.code, '| data type:', typeof body.data, '| data length:', body.data?.length ?? (typeof body.data === 'object' && body.data !== null ? JSON.stringify(body.data).length : 0));
  if (typeof body.data === 'object' && body.data !== null) {
    console.log('Jina origin httpStatus:', body.data.httpStatus ?? '(absent)', '| warning:', body.data.warning ?? '(absent)');
  }
  if (typeof body.data === 'string' && body.data.length > 0) {
    console.log('Data preview (200 chars):', body.data.slice(0, 200));
  } else if (typeof body.data === 'object' && body.data !== null) {
    console.log('data (object) keys:', Object.keys(body.data));
    console.log('data sample:', JSON.stringify(body.data).slice(0, 200));
  } else {
    console.log('Full body keys:', Object.keys(body));
    if (body.message) console.log('body.message:', body.message);
  }
  return body;
}

async function testWithAccept(acceptHeader) {
  const targetUrl = DEFAULT_URL;
  let normalized = targetUrl;
  try {
    normalized = decodeURIComponent(targetUrl);
  } catch (_) {}
  const requestUrl = `${JINA_BASE}${encodeURIComponent(normalized)}?respondWith=markdown&timeout=45`;
  console.log('\n--- Test with Accept:', acceptHeader, '---');
  const res = await fetch(requestUrl, {
    method: 'GET',
    headers: { Accept: acceptHeader },
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  console.log('HTTP', res.status, 'Content-Type:', res.headers.get('content-type'), 'body length:', text.length);
  if (text.length > 0 && text.length < 500) console.log('Body:', text);
  else if (text.length >= 500) console.log('Body preview:', text.slice(0, 400));
}

/** Simulates our extraction: data can be string or object with .content */
function extractData(body) {
  if (typeof body?.data === 'string') return body.data;
  if (typeof body?.data === 'object' && body?.data !== null && typeof body.data.content === 'string') return body.data.content;
  return '';
}

async function testDirectFetch(url) {
  console.log('\n--- Direct fetch fallback precondition ---');
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
    },
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  console.log('HTTP', res.status, '| Content-Type:', res.headers.get('content-type') || '(none)', '| byte length:', Buffer.byteLength(text, 'utf8'));
}

async function testWaybackFallback(url) {
  console.log('\n--- Wayback fallback precondition ---');
  const params = new URLSearchParams();
  params.set('url', url);
  params.set('output', 'json');
  params.set('filter', 'statuscode:200');
  params.set('fl', 'timestamp,original,statuscode,mimetype');
  params.set('limit', '1');
  params.set('sort', 'reverse');
  const requestUrl = `${WAYBACK_CDX_URL}?${params.toString()}`;
  const res = await fetch(requestUrl, { signal: AbortSignal.timeout(60000) });
  const text = await res.text();
  console.log('CDX HTTP', res.status, '| body length:', text.length);

  let rows;
  try {
    rows = JSON.parse(text);
  } catch {
    console.log('CDX non-JSON preview:', text.slice(0, 300));
    return;
  }

  if (!Array.isArray(rows) || rows.length < 2 || !Array.isArray(rows[0]) || !Array.isArray(rows[1])) {
    console.log('No statuscode:200 Wayback snapshot found.');
    return;
  }

  const header = rows[0];
  const record = rows[1];
  const timestamp = record[header.indexOf('timestamp')];
  const statusCode = record[header.indexOf('statuscode')];
  const mimetype = record[header.indexOf('mimetype')];
  console.log('Wayback newest statuscode:200 snapshot:', timestamp, '| statuscode:', statusCode, '| mimetype:', mimetype);

  const snapshotUrl = `https://web.archive.org/web/${timestamp}id_/${url}`;
  const snapshot = await fetch(snapshotUrl, { signal: AbortSignal.timeout(60000) });
  const snapshotText = await snapshot.text();
  console.log('Wayback snapshot HTTP', snapshot.status, '| byte length:', Buffer.byteLength(snapshotText, 'utf8'));
}

async function testWebFetchRun() {
  const url = process.argv[2] || DEFAULT_URL;
  console.log('\n--- Testing Jina path-style WITH decode-first (fixed) ---');
  await testJinaDirect(url, true, true);

  console.log('\n--- Full flow: decode-first + extract data.content ---');
  let targetUrl = url;
  try {
    targetUrl = decodeURIComponent(targetUrl);
  } catch (_) {}
  const requestUrl = `${JINA_BASE}${encodeURIComponent(targetUrl)}?respondWith=markdown&timeout=45`;
  const res = await fetch(requestUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
  const body = JSON.parse(await res.text());
  const content = extractData(body);
  console.log('Extracted content length:', content.length);
  if (content.length > 0) console.log('Content preview:', content.slice(0, 250));

  await testDirectFetch(url);
  await testWaybackFallback(url);
}

testWebFetchRun().catch((e) => {
  console.error(e);
  process.exit(1);
});
