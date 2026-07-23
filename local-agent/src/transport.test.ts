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

  console.log('\ntransport: all parseBackendMessage file-op tests passed');
}

main();
