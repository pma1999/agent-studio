import assert from 'node:assert/strict';
import { isSafeHttpUrl } from '../src/utils/url.js';

let failures = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}`);
    console.error(error);
  }
}

// ---------- Accepted: absolute http/https URLs only ----------

test('accepts plain http and https urls', () => {
  assert.equal(isSafeHttpUrl('http://example.com'), true);
  assert.equal(isSafeHttpUrl('https://example.com'), true);
});

test('accepts http/https with ports, paths, query, fragments', () => {
  assert.equal(isSafeHttpUrl('http://example.com:8080/page'), true);
  assert.equal(isSafeHttpUrl('https://example.com:443/a/b/c'), true);
  assert.equal(isSafeHttpUrl('https://example.com/search?q=citation&r=2'), true);
  assert.equal(isSafeHttpUrl('https://example.com/doc#section-3'), true);
  assert.equal(isSafeHttpUrl('https://example.com/p?x=1&y=2#frag'), true);
  assert.equal(isSafeHttpUrl('http://192.168.1.10:3000/status'), true);
});

test('accepts non-lowercase schemes via URL-parser normalization', () => {
  // WHATWG parsing lowercases the scheme, so HTTPS is still http(s)-allowlisted.
  assert.equal(isSafeHttpUrl('HTTPS://example.com/path'), true);
  assert.equal(isSafeHttpUrl('Http://Example.Com'), true);
});

// ---------- Rejected: dangerous schemes ----------

test('rejects javascript: urls including mixed case', () => {
  assert.equal(isSafeHttpUrl('javascript:alert(1)'), false);
  assert.equal(isSafeHttpUrl('JaVaScRiPt:alert(1)'), false);
  assert.equal(isSafeHttpUrl('JAVASCRIPT:alert(1)'), false);
});

test('rejects encoded/obfuscated javascript: payloads', () => {
  // Tab/newline stripped by the URL parser still resolves to the javascript: scheme.
  assert.equal(isSafeHttpUrl('jav\tascript:alert(1)'), false);
  assert.equal(isSafeHttpUrl('java\nscript:alert(1)'), false);
  // Scheme-invalid escapes/entities fall back to relative parsing -> no scheme -> throw.
  assert.equal(isSafeHttpUrl('jav%61script:alert(1)'), false);
  assert.equal(isSafeHttpUrl('&#106;avascript:alert(1)'), false);
});

test('rejects data: urls including text/html payloads', () => {
  assert.equal(isSafeHttpUrl('data:text/html,<h1>hi</h1>'), false);
  assert.equal(isSafeHttpUrl('data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='), false);
  assert.equal(isSafeHttpUrl('DATA:image/png;base64,iVBORw0KGgo='), false);
});

test('rejects vbscript:, file:, ftp:, mailto: and tel-like schemes', () => {
  assert.equal(isSafeHttpUrl('vbscript:msgbox("x")'), false);
  assert.equal(isSafeHttpUrl('VbScript:msgbox("x")'), false);
  assert.equal(isSafeHttpUrl('file:///etc/passwd'), false);
  assert.equal(isSafeHttpUrl('ftp://example.com/pub/file.txt'), false);
  assert.equal(isSafeHttpUrl('mailto:user@example.com'), false);
  assert.equal(isSafeHttpUrl('tel:+15551234567'), false);
  assert.equal(isSafeHttpUrl('sms:+15551234567'), false);
  assert.equal(isSafeHttpUrl('myapp://deep/link'), false);
});

// ---------- Rejected: non-absolute / malformed text ----------

test('rejects protocol-relative urls', () => {
  assert.equal(isSafeHttpUrl('//example.com/x'), false);
  assert.equal(isSafeHttpUrl('//evil.example.net/payload'), false);
});

test('rejects relative paths and bare domains', () => {
  assert.equal(isSafeHttpUrl('/relative/path'), false);
  assert.equal(isSafeHttpUrl('./sibling'), false);
  assert.equal(isSafeHttpUrl('../parent'), false);
  assert.equal(isSafeHttpUrl('example.com'), false);
  assert.equal(isSafeHttpUrl('www.example.com/docs?page=1'), false);
});

test('rejects whitespace-padded strings instead of trimming them away', () => {
  // Explicit decision: no trim leniency — the raw value must already be clean,
  // because the WHATWG parser silently strips edge spaces and we want the
  // rendered href to be byte-identical to the validated input.
  assert.equal(isSafeHttpUrl(' https://example.com '), false);
  assert.equal(isSafeHttpUrl('\nhttps://example.com\n'), false);
  assert.equal(isSafeHttpUrl('\thttps://example.com'), false);
  assert.equal(isSafeHttpUrl('javascript:alert(1) '), false);
});

test('rejects empty and blank strings', () => {
  assert.equal(isSafeHttpUrl(''), false);
  assert.equal(isSafeHttpUrl('   '), false);
});

// ---------- Rejected: non-string inputs (defensive contract) ----------

test('rejects non-string inputs', () => {
  assert.equal(isSafeHttpUrl(null), false);
  assert.equal(isSafeHttpUrl(undefined), false);
  assert.equal(isSafeHttpUrl(42), false);
  assert.equal(isSafeHttpUrl(0), false);
  assert.equal(isSafeHttpUrl(true), false);
  assert.equal(isSafeHttpUrl({ url: 'https://example.com' }), false);
  assert.equal(isSafeHttpUrl(['https://example.com']), false);
  assert.equal(isSafeHttpUrl(() => 'https://example.com'), false);
});

if (failures > 0) {
  console.error(`${failures} url safety test(s) failed`);
  process.exit(1);
}

console.log('url safety tests passed');
