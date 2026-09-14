import assert from 'node:assert/strict';

import { parseCompactCommand, isCompactSlashToken } from '../src/utils/compactCommand.js';

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

test("parseCompactCommand('/compact') -> {focus:null}", () => {
  assert.deepEqual(parseCompactCommand('/compact'), { focus: null });
});

test("parseCompactCommand('/compact focus on auth') preserves focus", () => {
  assert.deepEqual(parseCompactCommand('/compact focus on auth'), { focus: 'focus on auth' });
});

test('leading/trailing whitespace ok', () => {
  assert.deepEqual(parseCompactCommand('  /compact  '), { focus: null });
  assert.deepEqual(parseCompactCommand('  /compact   focus words  '), { focus: 'focus words' });
});

test("parseCompactCommand('/Compact  X') -> focus 'X' (case-insensitive)", () => {
  assert.deepEqual(parseCompactCommand('/Compact  X'), { focus: 'X' });
  assert.deepEqual(parseCompactCommand('/COMPACT'), { focus: null });
});

test("rejects '/compacts', '/compactx'", () => {
  assert.equal(parseCompactCommand('/compacts'), null);
  assert.equal(parseCompactCommand('/compactx'), null);
});

test("rejects '/ compact' (space after slash)", () => {
  assert.equal(parseCompactCommand('/ compact'), null);
});

test("rejects multi-line '/compact\\nsecond line'", () => {
  assert.equal(parseCompactCommand('/compact\nsecond line'), null);
  assert.equal(parseCompactCommand('/compact focus\nsecond'), null);
});

test("rejects 'please /compact' (not leading)", () => {
  assert.equal(parseCompactCommand('please /compact'), null);
});

test("rejects '' and whitespace-only", () => {
  assert.equal(parseCompactCommand(''), null);
  assert.equal(parseCompactCommand('   '), null);
});

test('isCompactSlashToken reservation', () => {
  assert.equal(isCompactSlashToken('compact'), true);
  assert.equal(isCompactSlashToken('Compact'), true);
  assert.equal(isCompactSlashToken('COMPACT'), true);
  assert.equal(isCompactSlashToken('compacts'), false);
  assert.equal(isCompactSlashToken('compactx'), false);
  assert.equal(isCompactSlashToken('skill'), false);
  assert.equal(isCompactSlashToken(''), false);
});

if (failures > 0) {
  console.error(`${failures} test(s) FAILED`);
  process.exit(1);
}
console.log('compact-command: OK');
