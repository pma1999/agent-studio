import assert from 'node:assert/strict';
import {
  conversationPath,
  parseClientPath,
  sharePath,
} from '../src/utils/url.js';

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

test('canonical chat path parses to chat kind with verbatim id', () => {
  assert.deepEqual(parseClientPath('/c/abc123'), { kind: 'chat', conversationId: 'abc123' });
  // Id is case-sensitive and kept verbatim inside the segment.
  assert.deepEqual(parseClientPath('/c/AbC-xY_z9'), { kind: 'chat', conversationId: 'AbC-xY_z9' });
});

test('canonical share path parses to share kind with verbatim token', () => {
  assert.deepEqual(parseClientPath('/s/tok123'), { kind: 'share', token: 'tok123' });
  assert.deepEqual(parseClientPath('/s/ToKeN-_42'), { kind: 'share', token: 'ToKeN-_42' });
});

test('root path parses to app kind', () => {
  assert.deepEqual(parseClientPath('/'), { kind: 'app' });
});

test('bare prefixes parse to app kind', () => {
  assert.deepEqual(parseClientPath('/c'), { kind: 'app' });
  assert.deepEqual(parseClientPath('/s'), { kind: 'app' });
});

test('empty ids parse to app kind', () => {
  assert.deepEqual(parseClientPath('/c/'), { kind: 'app' });
  assert.deepEqual(parseClientPath('/s/'), { kind: 'app' });
});

test('extra segments parse to app kind', () => {
  assert.deepEqual(parseClientPath('/c/a/b'), { kind: 'app' });
  assert.deepEqual(parseClientPath('/s/a/b'), { kind: 'app' });
});

test('trailing slashes parse to app kind', () => {
  assert.deepEqual(parseClientPath('/c/abc/'), { kind: 'app' });
  assert.deepEqual(parseClientPath('/s/tok/'), { kind: 'app' });
});

test('successfully decoded segments are decoded', () => {
  assert.deepEqual(parseClientPath('/c/%61bc'), { kind: 'chat', conversationId: 'abc' });
  assert.deepEqual(parseClientPath('/c/%E4%B8%AD'), { kind: 'chat', conversationId: '中' });
  assert.deepEqual(parseClientPath('/s/%74%6F%6B'), { kind: 'share', token: 'tok' });
});

test('invalid percent escapes parse to app kind', () => {
  assert.deepEqual(parseClientPath('/c/%ZZ'), { kind: 'app' });
  assert.deepEqual(parseClientPath('/s/%ZZ'), { kind: 'app' });
  assert.deepEqual(parseClientPath('/c/%E4%B8'), { kind: 'app' }); // truncated multibyte escape
});

test('prefix matching is case-sensitive', () => {
  assert.deepEqual(parseClientPath('/C/abc'), { kind: 'app' });
  assert.deepEqual(parseClientPath('/S/tok'), { kind: 'app' });
});

test('builders produce canonical paths', () => {
  assert.equal(conversationPath('abc123'), '/c/abc123');
  assert.equal(sharePath('tok123'), '/s/tok123');
});

test('builders reject empty strings with TypeError', () => {
  assert.throws(() => conversationPath(''), TypeError);
  assert.throws(() => sharePath(''), TypeError);
});

if (failures > 0) {
  console.error(`${failures} url sync test(s) failed`);
  process.exit(1);
}

console.log('url sync tests passed');
