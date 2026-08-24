/**
 * Plain-script test (repo convention: `tsx`, `node:assert`, no test-framework
 * dependency — matches `commandExecutor.test.ts`) covering the hard
 * acceptance criterion from `task-05-brief.md`: `parseBackendMessage()` must
 * gain its own runtime `case` for each of the five new `*_request` types.
 * Widening the TS unions alone is NOT sufficient — a raw JSON string must
 * come back non-null and correctly typed through the real
 * `parseBackendMessage` function (not by constructing message objects
 * directly, which would never exercise this code path).
 *
 * Each type is asserted twice: once with every optional field present, once
 * with optional fields omitted — a validator that checks the wrong property
 * name for an optional field (e.g. `message.offest` instead of
 * `message.offset`) would silently reject the "optionals present" shape while
 * still passing the "optionals absent" shape, so both must be covered.
 */

import assert from 'node:assert/strict';
import { parseBackendMessage } from './transport.js';

function main(): void {
  // read_file_request
  {
    const full = parseBackendMessage(
      JSON.stringify({ type: 'read_file_request', requestId: 'r1', path: 'a.txt', offset: 5, limit: 100 })
    ) as any;
    assert.ok(full, 'read_file_request (full) must not be null');
    assert.equal(full.type, 'read_file_request');
    assert.equal(full.requestId, 'r1');
    assert.equal(full.path, 'a.txt');
    assert.equal(full.offset, 5);
    assert.equal(full.limit, 100);

    const minimal = parseBackendMessage(JSON.stringify({ type: 'read_file_request', requestId: 'r2', path: 'b.txt' })) as any;
    assert.ok(minimal, 'read_file_request (minimal) must not be null');
    assert.equal(minimal.offset, undefined);
    assert.equal(minimal.limit, undefined);
    console.log('read_file_request: parsed (full + minimal): OK');
  }

  // write_file_request
  {
    const full = parseBackendMessage(
      JSON.stringify({ type: 'write_file_request', requestId: 'r3', path: 'a.txt', content: 'hello', hasBeenRead: true })
    ) as any;
    assert.ok(full, 'write_file_request must not be null');
    assert.equal(full.content, 'hello');
    assert.equal(full.hasBeenRead, true);
    console.log('write_file_request: parsed: OK');
  }

  // edit_file_request
  {
    const full = parseBackendMessage(
      JSON.stringify({
        type: 'edit_file_request',
        requestId: 'r4',
        path: 'a.txt',
        oldString: 'foo',
        newString: 'bar',
        replaceAll: true,
        hasBeenRead: true,
      })
    ) as any;
    assert.ok(full, 'edit_file_request (full) must not be null');
    assert.equal(full.oldString, 'foo');
    assert.equal(full.newString, 'bar');
    assert.equal(full.replaceAll, true);
    assert.equal(full.hasBeenRead, true);

    const minimal = parseBackendMessage(
      JSON.stringify({ type: 'edit_file_request', requestId: 'r5', path: 'a.txt', oldString: 'foo', newString: 'bar', hasBeenRead: false })
    ) as any;
    assert.ok(minimal, 'edit_file_request (minimal) must not be null');
    assert.equal(minimal.replaceAll, undefined);
    assert.equal(minimal.hasBeenRead, false);
    console.log('edit_file_request: parsed (full + minimal): OK');
  }

  // delete_file_request
  {
    const full = parseBackendMessage(
      JSON.stringify({ type: 'delete_file_request', requestId: 'r6', path: 'a.txt', recursive: true })
    ) as any;
    assert.ok(full, 'delete_file_request (full) must not be null');
    assert.equal(full.recursive, true);

    const minimal = parseBackendMessage(JSON.stringify({ type: 'delete_file_request', requestId: 'r7', path: 'a.txt' })) as any;
    assert.ok(minimal, 'delete_file_request (minimal) must not be null');
    assert.equal(minimal.recursive, undefined);
    console.log('delete_file_request: parsed (full + minimal): OK');
  }

  // list_directory_request
  {
    const parsed = parseBackendMessage(JSON.stringify({ type: 'list_directory_request', requestId: 'r8', path: '.' })) as any;
    assert.ok(parsed, 'list_directory_request must not be null');
    assert.equal(parsed.path, '.');
    console.log('list_directory_request: parsed: OK');
  }

  // Shape mismatches must still return null (existing tolerance, not weakened).
  {
    assert.equal(parseBackendMessage(JSON.stringify({ type: 'read_file_request', requestId: 'r9' })), null, 'missing path must be rejected');
    assert.equal(
      parseBackendMessage(JSON.stringify({ type: 'write_file_request', requestId: 'r10', path: 'a.txt', content: 'x' })),
      null,
      'missing hasBeenRead must be rejected'
    );
    assert.equal(parseBackendMessage(JSON.stringify({ type: 'unknown_type' })), null, 'unknown type must still return null');
    console.log('malformed file-op frames still rejected: OK');
  }

  // http_proxy_request — hand-mirrored from global-constraints.md §5.
  {
    const full = parseBackendMessage(
      JSON.stringify({
        type: 'http_proxy_request',
        requestId: 'px-1',
        url: 'http://127.0.0.1:1234/v1/models',
        method: 'GET',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: '{"prompt":"hi"}',
        timeoutMs: 1000,
      })
    ) as any;
    assert.ok(full, 'http_proxy_request (full) must not be null');
    assert.equal(full.type, 'http_proxy_request');
    assert.equal(full.requestId, 'px-1');
    assert.equal(full.url, 'http://127.0.0.1:1234/v1/models');
    assert.equal(full.method, 'GET');
    assert.deepEqual(full.headers, { 'Content-Type': 'application/json', Authorization: 'Bearer t' });
    assert.equal(full.body, '{"prompt":"hi"}');
    assert.equal(full.timeoutMs, 1000);

    const minimal = parseBackendMessage(
      JSON.stringify({ type: 'http_proxy_request', requestId: 'px-2', url: 'http://localhost:1234/x', method: 'POST', headers: {}, timeoutMs: 5 })
    ) as any;
    assert.ok(minimal, 'http_proxy_request (body omitted) must be accepted');
    assert.equal(minimal.body, null, 'omitted body must normalize to null');
    assert.equal(minimal.method, 'POST');

    const explicitNull = parseBackendMessage(
      JSON.stringify({ type: 'http_proxy_request', requestId: 'px-3', url: 'http://127.0.0.1:1/x', method: 'GET', headers: {}, body: null, timeoutMs: 5 })
    ) as any;
    assert.ok(explicitNull, 'explicit null body must be accepted');

    const malformed = [
      { type: 'http_proxy_request', requestId: 'px-4', method: 'DELETE', headers: {}, body: null, timeoutMs: 5 }, // bad method
      { type: 'http_proxy_request', requestId: 'px-5', headers: {}, body: null, timeoutMs: 5 }, // missing url
      { type: 'http_proxy_request', requestId: 'px-6', url: 'http://127.0.0.1:1/x', method: 'GET', headers: {}, body: null, timeoutMs: 0 }, // timeoutMs <= 0
      { type: 'http_proxy_request', requestId: 'px-7', url: 'http://127.0.0.1:1/x', method: 'GET', headers: {}, body: null, timeoutMs: -3 },
      { type: 'http_proxy_request', requestId: 'px-8', url: 'http://127.0.0.1:1/x', method: 'GET', body: null, timeoutMs: 5 }, // missing headers
      { type: 'http_proxy_request', requestId: 'px-9', url: 'http://127.0.0.1:1/x', method: 'GET', headers: [], body: null, timeoutMs: 5 }, // array headers
      {
        type: 'http_proxy_request',
        requestId: 'px-10',
        url: 'http://127.0.0.1:1/x',
        method: 'GET',
        headers: { A: 42 },
        body: null,
        timeoutMs: 5,
      }, // non-string header value
      { type: 'http_proxy_request', requestId: 'px-11', url: 'http://127.0.0.1:1/x', method: 'GET', headers: {}, body: 42, timeoutMs: 5 }, // bad body
    ];
    for (const [index, frame] of malformed.entries()) {
      assert.equal(parseBackendMessage(JSON.stringify(frame)), null, `malformed http_proxy_request variant ${index} must be rejected`);
    }
    console.log('http_proxy_request: parsed (full/minimal/null-body) + malformed rejected: OK');
  }

  // http_proxy_cancel
  {
    const parsed = parseBackendMessage(JSON.stringify({ type: 'http_proxy_cancel', requestId: 'px-c1' })) as any;
    assert.ok(parsed, 'http_proxy_cancel must not be null');
    assert.equal(parsed.type, 'http_proxy_cancel');
    assert.equal(parsed.requestId, 'px-c1');
    assert.equal(
      parseBackendMessage(JSON.stringify({ type: 'http_proxy_cancel' })),
      null,
      'cancel without requestId must be rejected'
    );
    console.log('http_proxy_cancel: parsed + malformed rejected: OK');
  }

  console.log('\ntransport: all parseBackendMessage file-op tests passed');
}

main();
