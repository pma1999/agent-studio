/**
 * Test script for web_fetch / Jina Reader.
 * Run: node scripts/test-web-fetch.mjs [url]
 * Default URL: https://es.wikipedia.org/wiki/Revoluci%C3%B3n_pasiva
 */

const JINA_BASE = 'https://r.jina.ai/';

async function testJinaDirect(url, usePathStyle = true, decodeFirst = false) {
  let targetUrl = url || 'https://es.wikipedia.org/wiki/Revoluci%C3%B3n_pasiva';
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
    return;
  }
  console.log('HTTP', res.status, '| body.code:', body.code, '| data type:', typeof body.data, '| data length:', body.data?.length ?? (typeof body.data === 'object' && body.data !== null ? JSON.stringify(body.data).length : 0));
  if (typeof body.data === 'string' && body.data.length > 0) {
    console.log('Data preview (200 chars):', body.data.slice(0, 200));
  } else if (typeof body.data === 'object' && body.data !== null) {
    console.log('data (object) keys:', Object.keys(body.data));
    console.log('data sample:', JSON.stringify(body.data).slice(0, 200));
  } else {
    console.log('Full body keys:', Object.keys(body));
    if (body.message) console.log('body.message:', body.message);
  }
}

async function testWithAccept(acceptHeader) {
  const targetUrl = 'https://es.wikipedia.org/wiki/Revoluci%C3%B3n_pasiva';
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

async function testWebFetchRun() {
  const url = process.argv[2] || 'https://es.wikipedia.org/wiki/Revoluci%C3%B3n_pasiva';
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
}

testWebFetchRun().catch((e) => {
  console.error(e);
  process.exit(1);
});
