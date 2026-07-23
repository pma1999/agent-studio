/**
 * Plain-script test (repo convention: `tsx`, `node:assert`, no test-framework
 * dependency — matches `commandExecutor.test.ts`) covering the behaviors
 * called out in the task brief's Tests section, against a real temp-directory
 * workspace (genuine fs operations, not mocked — filesystem edge cases like
 * binary detection and delete-tier scans are exactly the kind of thing worth
 * verifying for real rather than through a fake).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createFileOpsExecutor,
  performGuardedWrite,
  DEFAULT_READ_LIMIT_LINES,
  DELETE_LARGE_ENTRY_THRESHOLD,
  MAX_LINE_LENGTH,
  MAX_LIST_ENTRIES,
  MAX_WRITE_FILE_BYTES,
  type FileOpsExecutorOptions,
} from './fileOpsExecutor.js';
import type { AgentToBackendMessage } from './transport.js';

function makeWorkspace(): string {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), 'agent-studio-fileops-'));
}

function makeExecutor(workspaceRoot: string, overrides: Partial<FileOpsExecutorOptions> = {}) {
  const sent: AgentToBackendMessage[] = [];
  const options: FileOpsExecutorOptions = {
    workspaceRoot,
    allowOutsideWorkspace: false,
    send: (message) => sent.push(message),
    confirmTier2: async () => 'approved',
    ...overrides,
  };
  return { executor: createFileOpsExecutor(options), sent };
}

function findLast<T extends AgentToBackendMessage['type']>(
  sent: AgentToBackendMessage[],
  type: T
): Extract<AgentToBackendMessage, { type: T }> {
  const found = [...sent].reverse().find((m) => m.type === type);
  assert.ok(found, `expected a message of type ${type}`);
  return found as Extract<AgentToBackendMessage, { type: T }>;
}

async function main() {
  // (a) Root-scoping hard-block for each op: outside the workspace root,
  // allowOutsideWorkspace disabled, must reject with no fs access attempted.
  {
    const workspaceRoot = makeWorkspace();
    const outsideDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'agent-studio-fileops-outside-'));
    const outsideFile = path.join(outsideDir, 'secret.txt');
    await fs.writeFile(outsideFile, 'outside content');
    const outsideRel = path.relative(workspaceRoot, outsideFile);

    {
      const { executor, sent } = makeExecutor(workspaceRoot);
      await executor.handleReadFileRequest({ type: 'read_file_request', requestId: 'r1', path: outsideRel });
      const response = findLast(sent, 'read_file_response');
      assert.equal(response.ok, false);
      assert.match(response.error!, /resolves outside the workspace root/);
    }
    {
      const { executor, sent } = makeExecutor(workspaceRoot);
      await executor.handleWriteFileRequest({ type: 'write_file_request', requestId: 'r2', path: outsideRel, content: 'x', hasBeenRead: true });
      const response = findLast(sent, 'write_file_response');
      assert.equal(response.ok, false);
      assert.match(response.error!, /resolves outside the workspace root/);
      assert.equal(await fs.readFile(outsideFile, 'utf8'), 'outside content', 'outside file must be untouched');
    }
    {
      const { executor, sent } = makeExecutor(workspaceRoot);
      await executor.handleEditFileRequest({
        type: 'edit_file_request',
        requestId: 'r3',
        path: outsideRel,
        oldString: 'outside',
        newString: 'changed',
        hasBeenRead: true,
      });
      const response = findLast(sent, 'edit_file_response');
      assert.equal(response.ok, false);
      assert.match(response.error!, /resolves outside the workspace root/);
      assert.equal(await fs.readFile(outsideFile, 'utf8'), 'outside content', 'outside file must be untouched');
    }
    {
      let confirmCalled = false;
      const { executor, sent } = makeExecutor(workspaceRoot, { confirmTier2: async () => { confirmCalled = true; return 'approved'; } });
      await executor.handleDeleteFileRequest({ type: 'delete_file_request', requestId: 'r4', path: outsideRel });
      const response = findLast(sent, 'delete_file_response');
      assert.equal(response.ok, false);
      assert.match(response.error!, /resolves outside the workspace root/);
      assert.equal(confirmCalled, false, 'hard-blocked delete must never call confirmTier2');
      assert.ok(fsSync.existsSync(outsideFile), 'outside file must survive a hard-blocked delete');
    }
    {
      const { executor, sent } = makeExecutor(workspaceRoot);
      await executor.handleListDirectoryRequest({ type: 'list_directory_request', requestId: 'r5', path: outsideRel === '' ? '..' : path.dirname(outsideRel) });
      const response = findLast(sent, 'list_directory_response');
      assert.equal(response.ok, false);
      assert.match(response.error!, /resolves outside the workspace root/);
    }
    console.log('(a) root-scoping hard-block for all five ops: OK');
  }

  // (b) read_file: offset/limit/truncation/binary-rejection.
  {
    const workspaceRoot = makeWorkspace();
    const filePath = path.join(workspaceRoot, 'lines.txt');
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    await fs.writeFile(filePath, lines.join('\n') + '\n');

    // Default offset/limit: whole file (limit > line count), not truncated.
    {
      const { executor, sent } = makeExecutor(workspaceRoot);
      await executor.handleReadFileRequest({ type: 'read_file_request', requestId: 'r6', path: 'lines.txt' });
      const response = findLast(sent, 'read_file_response');
      assert.equal(response.ok, true);
      assert.equal(response.totalLines, 10);
      assert.equal(response.startLine, 1);
      assert.equal(response.endLine, 10);
      assert.equal(response.truncated, false);
      assert.equal(response.content, lines.map((l, i) => `${i + 1}\t${l}`).join('\n'));
    }

    // offset + limit window.
    {
      const { executor, sent } = makeExecutor(workspaceRoot);
      await executor.handleReadFileRequest({ type: 'read_file_request', requestId: 'r7', path: 'lines.txt', offset: 3, limit: 2 });
      const response = findLast(sent, 'read_file_response');
      assert.equal(response.ok, true);
      assert.equal(response.startLine, 3);
      assert.equal(response.endLine, 4);
      assert.equal(response.truncated, true, 'stopping early because the line limit was reached before EOF');
      assert.equal(response.content, '3\tline 3\n4\tline 4');
    }

    // Per-line truncation marker.
    {
      const longLinePath = path.join(workspaceRoot, 'long.txt');
      const longLine = 'x'.repeat(MAX_LINE_LENGTH + 50);
      await fs.writeFile(longLinePath, longLine);
      const { executor, sent } = makeExecutor(workspaceRoot);
      await executor.handleReadFileRequest({ type: 'read_file_request', requestId: 'r8', path: 'long.txt' });
      const response = findLast(sent, 'read_file_response');
      assert.equal(response.ok, true);
      assert.ok(response.content!.includes('truncated after'), 'a long single line must carry a per-line truncation marker');
      assert.ok(
        !response.content!.includes('x'.repeat(longLine.length)),
        'the full untruncated run of x characters must not appear in the returned content'
      );
    }

    // Non-existent path.
    {
      const { executor, sent } = makeExecutor(workspaceRoot);
      await executor.handleReadFileRequest({ type: 'read_file_request', requestId: 'r9', path: 'missing.txt' });
      const response = findLast(sent, 'read_file_response');
      assert.equal(response.ok, false);
      assert.match(response.error!, /not found/i);
    }

    // Binary rejection: a NUL byte near the start of the file.
    {
      const binaryPath = path.join(workspaceRoot, 'binary.dat');
      await fs.writeFile(binaryPath, Buffer.from([0x48, 0x65, 0x00, 0x6c, 0x6f]));
      const { executor, sent } = makeExecutor(workspaceRoot);
      await executor.handleReadFileRequest({ type: 'read_file_request', requestId: 'r10', path: 'binary.dat' });
      const response = findLast(sent, 'read_file_response');
      assert.equal(response.ok, false);
      assert.match(response.error!, /binary/i);
    }

    console.log('(b) read_file offset/limit/truncation/binary-rejection: OK');
  }

  // (c) write_file: read-before-overwrite guard + new-file-needs-no-guard.
  {
    const workspaceRoot = makeWorkspace();

    // New file: no prior read needed.
    {
      const { executor, sent } = makeExecutor(workspaceRoot);
      await executor.handleWriteFileRequest({
        type: 'write_file_request',
        requestId: 'r11',
        path: 'new.txt',
        content: 'hello world',
        hasBeenRead: false,
      });
      const response = findLast(sent, 'write_file_response');
      assert.equal(response.ok, true);
      assert.equal(response.created, true);
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'new.txt'), 'utf8'), 'hello world');
    }

    // Nested path: parent directories created.
    {
      const { executor, sent } = makeExecutor(workspaceRoot);
      await executor.handleWriteFileRequest({
        type: 'write_file_request',
        requestId: 'r12',
        path: path.join('nested', 'dir', 'file.txt'),
        content: 'nested content',
        hasBeenRead: false,
      });
      const response = findLast(sent, 'write_file_response');
      assert.equal(response.ok, true);
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'nested', 'dir', 'file.txt'), 'utf8'), 'nested content');
    }

    // Existing file, hasBeenRead false: rejected, unchanged.
    {
      const { executor, sent } = makeExecutor(workspaceRoot);
      await executor.handleWriteFileRequest({
        type: 'write_file_request',
        requestId: 'r13',
        path: 'new.txt',
        content: 'overwritten',
        hasBeenRead: false,
      });
      const response = findLast(sent, 'write_file_response');
      assert.equal(response.ok, false);
      assert.match(response.error!, /already exists/);
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'new.txt'), 'utf8'), 'hello world', 'file must be unchanged');
    }

    // Existing file, hasBeenRead true: allowed, created:false.
    {
      const { executor, sent } = makeExecutor(workspaceRoot);
      await executor.handleWriteFileRequest({
        type: 'write_file_request',
        requestId: 'r14',
        path: 'new.txt',
        content: 'overwritten',
        hasBeenRead: true,
      });
      const response = findLast(sent, 'write_file_response');
      assert.equal(response.ok, true);
      assert.equal(response.created, false);
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'new.txt'), 'utf8'), 'overwritten');
    }

    // Oversized content rejected.
    {
      const { executor, sent } = makeExecutor(workspaceRoot);
      const oversized = 'a'.repeat(MAX_WRITE_FILE_BYTES + 1);
      await executor.handleWriteFileRequest({
        type: 'write_file_request',
        requestId: 'r15',
        path: 'huge.txt',
        content: oversized,
        hasBeenRead: false,
      });
      const response = findLast(sent, 'write_file_response');
      assert.equal(response.ok, false);
      assert.match(response.error!, /exceeding the/);
      assert.equal(fsSync.existsSync(path.join(workspaceRoot, 'huge.txt')), false, 'oversized write must not create the file');
    }

    console.log('(c) write_file read-before-overwrite guard + new-file case + size cap: OK');
  }

  // (c2) ARC-01 / RC-01 regression: write_file's existence-check-then-write
  // TOCTOU race. `performGuardedWrite` is exercised directly with `existed`
  // pinned to `false` while the target already exists on disk — this is
  // exactly what a real race produces (a stale "doesn't exist" snapshot
  // against a filesystem that already has the file), reproduced
  // deterministically rather than by trying to win a real, timing-dependent
  // race against the event loop.
  {
    const workspaceRoot = makeWorkspace();

    // The "race winner" already created the file; our stale snapshot still
    // says `existed: false`. hasBeenRead: false must now be re-evaluated
    // against reality and rejected — the race winner's content must survive
    // untouched (the core defect: this used to silently clobber it).
    {
      const filePath = path.join(workspaceRoot, 'raced.txt');
      await fs.writeFile(filePath, 'race winner content');
      const outcome = await performGuardedWrite(filePath, 'attacker content', false, false);
      assert.equal(outcome.ok, false);
      assert.match(outcome.error!, /already exists/);
      assert.equal(await fs.readFile(filePath, 'utf8'), 'race winner content', 'the raced-in file must survive untouched when hasBeenRead is false');
    }

    // Same race, but hasBeenRead: true (the model has legitimately read this
    // exact path earlier in the conversation) — the guard is already
    // satisfied by that conversation-level fact, so the write proceeds,
    // created: false (it did already exist).
    {
      const filePath = path.join(workspaceRoot, 'raced2.txt');
      await fs.writeFile(filePath, 'race winner content');
      const outcome = await performGuardedWrite(filePath, 'legitimate overwrite', true, false);
      assert.equal(outcome.ok, true);
      assert.equal(outcome.created, false);
      assert.equal(await fs.readFile(filePath, 'utf8'), 'legitimate overwrite');
    }

    // Non-raced control: existed:false snapshot matches reality (file truly
    // doesn't exist) — the exclusive-create path must still work normally.
    {
      const filePath = path.join(workspaceRoot, 'genuinely-new.txt');
      const outcome = await performGuardedWrite(filePath, 'brand new', false, false);
      assert.equal(outcome.ok, true);
      assert.equal(outcome.created, true);
      assert.equal(await fs.readFile(filePath, 'utf8'), 'brand new');
    }

    console.log('(c2) ARC-01 regression: write_file TOCTOU race closed via exclusive create + EEXIST re-guard: OK');
  }

  // (d) edit_file: not-found/multiple-matches/same-string/read-guard error
  // shapes and successful single/replace_all cases.
  {
    const workspaceRoot = makeWorkspace();
    const filePath = path.join(workspaceRoot, 'edit.txt');

    // Not found.
    {
      const { executor, sent } = makeExecutor(workspaceRoot);
      await executor.handleEditFileRequest({
        type: 'edit_file_request',
        requestId: 'r16',
        path: 'missing.txt',
        oldString: 'a',
        newString: 'b',
        hasBeenRead: true,
      });
      const response = findLast(sent, 'edit_file_response');
      assert.equal(response.ok, false);
      assert.match(response.error!, /use write_file to create it/);
    }

    await fs.writeFile(filePath, 'foo bar foo baz foo');

    // hasBeenRead false, even though the file exists.
    {
      const { executor, sent } = makeExecutor(workspaceRoot);
      await executor.handleEditFileRequest({
        type: 'edit_file_request',
        requestId: 'r17',
        path: 'edit.txt',
        oldString: 'foo',
        newString: 'qux',
        hasBeenRead: false,
      });
      const response = findLast(sent, 'edit_file_response');
      assert.equal(response.ok, false);
      assert.match(response.error!, /read this file first/);
      assert.equal(await fs.readFile(filePath, 'utf8'), 'foo bar foo baz foo', 'file must be unchanged');
    }

    // old_string not found.
    {
      const { executor, sent } = makeExecutor(workspaceRoot);
      await executor.handleEditFileRequest({
        type: 'edit_file_request',
        requestId: 'r18',
        path: 'edit.txt',
        oldString: 'nope',
        newString: 'qux',
        hasBeenRead: true,
      });
      const response = findLast(sent, 'edit_file_response');
      assert.equal(response.ok, false);
      assert.match(response.error!, /not found/);
    }

    // Multiple matches without replace_all.
    {
      const { executor, sent } = makeExecutor(workspaceRoot);
      await executor.handleEditFileRequest({
        type: 'edit_file_request',
        requestId: 'r19',
        path: 'edit.txt',
        oldString: 'foo',
        newString: 'qux',
        hasBeenRead: true,
      });
      const response = findLast(sent, 'edit_file_response');
      assert.equal(response.ok, false);
      assert.match(response.error!, /found 3 times/);
    }

    // Same old/new string.
    {
      const { executor, sent } = makeExecutor(workspaceRoot);
      await executor.handleEditFileRequest({
        type: 'edit_file_request',
        requestId: 'r20',
        path: 'edit.txt',
        oldString: 'bar',
        newString: 'bar',
        hasBeenRead: true,
      });
      const response = findLast(sent, 'edit_file_response');
      assert.equal(response.ok, false);
      assert.match(response.error!, /must differ/);
    }

    // Successful single replace.
    {
      const { executor, sent } = makeExecutor(workspaceRoot);
      await executor.handleEditFileRequest({
        type: 'edit_file_request',
        requestId: 'r21',
        path: 'edit.txt',
        oldString: 'bar',
        newString: 'BAR',
        hasBeenRead: true,
      });
      const response = findLast(sent, 'edit_file_response');
      assert.equal(response.ok, true);
      assert.equal(response.replacementsMade, 1);
      assert.equal(await fs.readFile(filePath, 'utf8'), 'foo BAR foo baz foo');
    }

    // Successful replace_all.
    {
      const { executor, sent } = makeExecutor(workspaceRoot);
      await executor.handleEditFileRequest({
        type: 'edit_file_request',
        requestId: 'r22',
        path: 'edit.txt',
        oldString: 'foo',
        newString: 'qux',
        replaceAll: true,
        hasBeenRead: true,
      });
      const response = findLast(sent, 'edit_file_response');
      assert.equal(response.ok, true);
      assert.equal(response.replacementsMade, 3);
      assert.equal(await fs.readFile(filePath, 'utf8'), 'qux BAR qux baz qux');
    }

    console.log('(d) edit_file error shapes + successful single/replace_all: OK');
  }

  // (e) delete_file: all three tiers, verified against real disk state (not
  // just the response field) per the named risk — a silent no-op here would
  // be the most serious defect in this task.
  {
    // Tier 0 (auto): small file inside the workspace root, deletes immediately
    // without ever calling confirmTier2.
    {
      const workspaceRoot = makeWorkspace();
      const filePath = path.join(workspaceRoot, 'auto.txt');
      await fs.writeFile(filePath, 'x');
      let confirmCalled = false;
      const { executor, sent } = makeExecutor(workspaceRoot, { confirmTier2: async () => { confirmCalled = true; return 'approved'; } });
      await executor.handleDeleteFileRequest({ type: 'delete_file_request', requestId: 'r23', path: 'auto.txt' });
      const response = findLast(sent, 'delete_file_response');
      assert.equal(response.ok, true);
      assert.equal(response.kind, 'file');
      assert.equal(confirmCalled, false, 'an in-root, small, non-recursive delete must not require confirmation');
      assert.equal(fsSync.existsSync(filePath), false, 'the file must actually be gone');
    }

    // Missing path.
    {
      const workspaceRoot = makeWorkspace();
      const { executor, sent } = makeExecutor(workspaceRoot);
      await executor.handleDeleteFileRequest({ type: 'delete_file_request', requestId: 'r24', path: 'missing.txt' });
      const response = findLast(sent, 'delete_file_response');
      assert.equal(response.ok, false);
      assert.match(response.error!, /does not exist/);
    }

    // Directory without recursive.
    {
      const workspaceRoot = makeWorkspace();
      const dirPath = path.join(workspaceRoot, 'somedir');
      await fs.mkdir(dirPath);
      const { executor, sent } = makeExecutor(workspaceRoot);
      await executor.handleDeleteFileRequest({ type: 'delete_file_request', requestId: 'r25', path: 'somedir' });
      const response = findLast(sent, 'delete_file_response');
      assert.equal(response.ok, false);
      assert.match(response.error!, /recursive:true/);
      assert.ok(fsSync.existsSync(dirPath), 'directory must survive a recursive-less delete attempt');
    }

    // Tier 2, approved: recursive delete inside the root, but with more
    // than DELETE_LARGE_ENTRY_THRESHOLD entries — confirmation requested and
    // approved, then actually deleted.
    {
      const workspaceRoot = makeWorkspace();
      const dirPath = path.join(workspaceRoot, 'bigdir');
      await fs.mkdir(dirPath);
      const fileCount = DELETE_LARGE_ENTRY_THRESHOLD + 10;
      for (let i = 0; i < fileCount; i++) {
        await fs.writeFile(path.join(dirPath, `f${i}.txt`), 'x');
      }
      let confirmCalled = false;
      let confirmDescription = '';
      const { executor, sent } = makeExecutor(workspaceRoot, {
        confirmTier2: async (description) => {
          confirmCalled = true;
          confirmDescription = description;
          return 'approved';
        },
      });
      await executor.handleDeleteFileRequest({ type: 'delete_file_request', requestId: 'r26', path: 'bigdir', recursive: true });
      const response = findLast(sent, 'delete_file_response');
      assert.equal(confirmCalled, true, 'a large recursive delete must require confirmation');
      assert.match(confirmDescription, /delete recursively/);
      assert.ok(sent.some((m) => m.type === 'command_awaiting_confirmation'), 'must send command_awaiting_confirmation before confirming');
      assert.equal(response.ok, true);
      assert.equal(response.kind, 'directory');
      assert.equal(fsSync.existsSync(dirPath), false, 'the directory must actually be gone after approval');
    }

    // Tier 2, declined: same large-recursive scenario, but declined — must
    // NOT delete anything.
    {
      const workspaceRoot = makeWorkspace();
      const dirPath = path.join(workspaceRoot, 'bigdir2');
      await fs.mkdir(dirPath);
      const fileCount = DELETE_LARGE_ENTRY_THRESHOLD + 10;
      for (let i = 0; i < fileCount; i++) {
        await fs.writeFile(path.join(dirPath, `f${i}.txt`), 'x');
      }
      const { executor, sent } = makeExecutor(workspaceRoot, { confirmTier2: async () => 'declined' });
      await executor.handleDeleteFileRequest({ type: 'delete_file_request', requestId: 'r27', path: 'bigdir2', recursive: true });
      const response = findLast(sent, 'delete_file_response');
      assert.equal(response.ok, false);
      assert.equal(response.confirmation, 'declined');
      assert.ok(fsSync.existsSync(dirPath), 'a declined delete must leave the directory fully intact');
      assert.equal(fsSync.readdirSync(dirPath).length, fileCount, 'no files may have been removed on decline');
    }

    // Tier 2, timeout: same scenario, confirmTier2 resolves 'timeout' — must
    // NOT delete anything.
    {
      const workspaceRoot = makeWorkspace();
      const dirPath = path.join(workspaceRoot, 'bigdir3');
      await fs.mkdir(dirPath);
      const fileCount = DELETE_LARGE_ENTRY_THRESHOLD + 10;
      for (let i = 0; i < fileCount; i++) {
        await fs.writeFile(path.join(dirPath, `f${i}.txt`), 'x');
      }
      const { executor, sent } = makeExecutor(workspaceRoot, { confirmTier2: async () => 'timeout' });
      await executor.handleDeleteFileRequest({ type: 'delete_file_request', requestId: 'r28', path: 'bigdir3', recursive: true });
      const response = findLast(sent, 'delete_file_response');
      assert.equal(response.ok, false);
      assert.equal(response.confirmation, 'timeout');
      assert.ok(fsSync.existsSync(dirPath), 'a timed-out delete must leave the directory fully intact');
      assert.equal(fsSync.readdirSync(dirPath).length, fileCount, 'no files may have been removed on timeout');
    }

    // Tier 2: outside workspace root with allowOutsideWorkspace true —
    // requires confirmation even though the target is small.
    {
      const workspaceRoot = makeWorkspace();
      const outsideDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'agent-studio-fileops-outside-del-'));
      const outsideFile = path.join(outsideDir, 'target.txt');
      await fs.writeFile(outsideFile, 'x');
      const outsideRel = path.relative(workspaceRoot, outsideFile);

      let confirmCalled = false;
      const { executor, sent } = makeExecutor(workspaceRoot, {
        allowOutsideWorkspace: true,
        confirmTier2: async () => {
          confirmCalled = true;
          return 'declined';
        },
      });
      await executor.handleDeleteFileRequest({ type: 'delete_file_request', requestId: 'r29', path: outsideRel });
      const response = findLast(sent, 'delete_file_response');
      assert.equal(confirmCalled, true, 'a delete outside the workspace root (even allowed) must still require confirmation');
      assert.equal(response.ok, false);
      assert.equal(response.confirmation, 'declined');
      assert.ok(fsSync.existsSync(outsideFile), 'declined out-of-root delete must leave the file intact');
    }

    console.log('(e) delete_file all three tiers, verified against real disk state: OK');
  }

  // (e2) ARC-02 / RC-02 regression: delete_file's classification-vs-actual-
  // delete TOCTOU race, specifically across the Tier-2 confirmation wait —
  // the more severe of the two findings, since that window is human-scale
  // (up to 60s), not sub-millisecond. `confirmTier2` is a real, user-supplied
  // async callback the real code genuinely awaits mid-flight; using it to
  // mutate the filesystem during that exact await window is a real,
  // deterministic reproduction of "the target changed while a human was
  // deciding" — not a synthetic bypass of the code under test.
  {
    // Large directory (needs confirmation due to size) shrinks to small
    // *during* the confirmation wait. Must abort rather than silently
    // deleting the now-different, no-longer-large target: the human
    // approved a description of a large delete that no longer describes
    // reality by the time the code would otherwise act on it.
    {
      const workspaceRoot = makeWorkspace();
      const dirPath = path.join(workspaceRoot, 'shrinks');
      await fs.mkdir(dirPath);
      const fileCount = DELETE_LARGE_ENTRY_THRESHOLD + 10;
      for (let i = 0; i < fileCount; i++) {
        await fs.writeFile(path.join(dirPath, `f${i}.txt`), 'x');
      }
      const { executor, sent } = makeExecutor(workspaceRoot, {
        confirmTier2: async () => {
          // Simulates "something else on this machine" changing the target
          // while the human is still deciding.
          const remaining = fsSync.readdirSync(dirPath);
          for (const name of remaining.slice(0, fileCount - 5)) {
            await fs.unlink(path.join(dirPath, name));
          }
          return 'approved';
        },
      });
      await executor.handleDeleteFileRequest({ type: 'delete_file_request', requestId: 'race1', path: 'shrinks', recursive: true });
      const response = findLast(sent, 'delete_file_response');
      assert.equal(response.ok, false);
      assert.match(response.error!, /changed since it was checked/);
      assert.ok(fsSync.existsSync(dirPath), 'the directory must survive an aborted, stale-classification delete');
      assert.equal(fsSync.readdirSync(dirPath).length, 5, 'the mutation made during the wait must be the only change — no delete occurred');
    }

    // Target is removed entirely during the confirmation wait (existence
    // changes, not just size). Must abort with a clear "no longer exists"
    // error rather than the raw ENOENT surfacing from an unguarded fs.rm.
    {
      const workspaceRoot = makeWorkspace();
      const dirPath = path.join(workspaceRoot, 'vanishes');
      await fs.mkdir(dirPath);
      const fileCount = DELETE_LARGE_ENTRY_THRESHOLD + 10;
      for (let i = 0; i < fileCount; i++) {
        await fs.writeFile(path.join(dirPath, `f${i}.txt`), 'x');
      }
      const { executor, sent } = makeExecutor(workspaceRoot, {
        confirmTier2: async () => {
          await fs.rm(dirPath, { recursive: true });
          return 'approved';
        },
      });
      await executor.handleDeleteFileRequest({ type: 'delete_file_request', requestId: 'race2', path: 'vanishes', recursive: true });
      const response = findLast(sent, 'delete_file_response');
      assert.equal(response.ok, false);
      assert.match(response.error!, /no longer exists/);
    }

    // Target's kind changes (directory replaced by a file of the same name)
    // during the wait. Must abort rather than running fs.rm/fs.unlink
    // against a completely different kind of object than was classified.
    {
      const workspaceRoot = makeWorkspace();
      const dirPath = path.join(workspaceRoot, 'kind-change');
      await fs.mkdir(dirPath);
      const fileCount = DELETE_LARGE_ENTRY_THRESHOLD + 10;
      for (let i = 0; i < fileCount; i++) {
        await fs.writeFile(path.join(dirPath, `f${i}.txt`), 'x');
      }
      const { executor, sent } = makeExecutor(workspaceRoot, {
        confirmTier2: async () => {
          await fs.rm(dirPath, { recursive: true });
          await fs.writeFile(dirPath, 'now a plain file, not the directory that was classified');
          return 'approved';
        },
      });
      await executor.handleDeleteFileRequest({ type: 'delete_file_request', requestId: 'race3', path: 'kind-change', recursive: true });
      const response = findLast(sent, 'delete_file_response');
      assert.equal(response.ok, false);
      assert.match(response.error!, /kind changed/);
      assert.equal(
        await fs.readFile(dirPath, 'utf8'),
        'now a plain file, not the directory that was classified',
        'the replacement file must survive an aborted, kind-mismatched delete'
      );
    }

    // Control: classification is stable throughout the wait (nothing
    // mutates) — the legitimate large-recursive-delete-with-confirmation
    // path (already covered in section (e)) must still actually delete,
    // proving the new re-validation does not itself block a genuine,
    // unchanged approval.
    {
      const workspaceRoot = makeWorkspace();
      const dirPath = path.join(workspaceRoot, 'stable');
      await fs.mkdir(dirPath);
      const fileCount = DELETE_LARGE_ENTRY_THRESHOLD + 10;
      for (let i = 0; i < fileCount; i++) {
        await fs.writeFile(path.join(dirPath, `f${i}.txt`), 'x');
      }
      const { executor, sent } = makeExecutor(workspaceRoot, { confirmTier2: async () => 'approved' });
      await executor.handleDeleteFileRequest({ type: 'delete_file_request', requestId: 'race4', path: 'stable', recursive: true });
      const response = findLast(sent, 'delete_file_response');
      assert.equal(response.ok, true);
      assert.equal(response.kind, 'directory');
      assert.equal(fsSync.existsSync(dirPath), false, 'an unchanged, legitimately-approved large delete must still actually delete');
    }

    console.log('(e2) ARC-02 regression: delete_file re-validates immediately before deleting, catching changes made during the confirmation wait: OK');
  }

  // (f) list_directory: basic listing, default path, and cap/truncation.
  {
    const workspaceRoot = makeWorkspace();
    await fs.writeFile(path.join(workspaceRoot, 'a.txt'), 'hello');
    await fs.mkdir(path.join(workspaceRoot, 'subdir'));

    // Basic listing with default path ('.').
    {
      const { executor, sent } = makeExecutor(workspaceRoot);
      await executor.handleListDirectoryRequest({ type: 'list_directory_request', requestId: 'r30', path: '.' });
      const response = findLast(sent, 'list_directory_response');
      assert.equal(response.ok, true);
      assert.equal(response.truncated, false);
      const byName = new Map(response.entries!.map((e) => [e.name, e]));
      assert.equal(byName.get('a.txt')?.type, 'file');
      assert.equal(byName.get('a.txt')?.sizeBytes, 5);
      assert.equal(byName.get('subdir')?.type, 'directory');
      assert.equal(byName.get('subdir')?.sizeBytes, undefined);
    }

    // Non-existent path.
    {
      const { executor, sent } = makeExecutor(workspaceRoot);
      await executor.handleListDirectoryRequest({ type: 'list_directory_request', requestId: 'r31', path: 'nope' });
      const response = findLast(sent, 'list_directory_response');
      assert.equal(response.ok, false);
      assert.match(response.error!, /does not exist/);
    }

    // Non-directory path.
    {
      const { executor, sent } = makeExecutor(workspaceRoot);
      await executor.handleListDirectoryRequest({ type: 'list_directory_request', requestId: 'r32', path: 'a.txt' });
      const response = findLast(sent, 'list_directory_response');
      assert.equal(response.ok, false);
      assert.match(response.error!, /not a directory/);
    }

    // Cap + truncation beyond MAX_LIST_ENTRIES. RC-01 fix note: `totalEntries`
    // is now a deliberate lower bound (exactly MAX_LIST_ENTRIES) once capped,
    // not the true full-directory count (1005 here) — this is itself
    // evidence the fix is real: the old readdir-based implementation always
    // materialized (and could therefore only ever report) the exact total;
    // reporting a lower bound is only possible because the new opendir-based
    // implementation genuinely stops enumerating once the cap is reached,
    // rather than having already read every entry before the cap could act.
    {
      const bigDir = path.join(workspaceRoot, 'bigdir');
      await fs.mkdir(bigDir);
      const count = MAX_LIST_ENTRIES + 5;
      await Promise.all(Array.from({ length: count }, (_, i) => fs.writeFile(path.join(bigDir, `f${i}`), '')));

      const { executor, sent } = makeExecutor(workspaceRoot);
      await executor.handleListDirectoryRequest({ type: 'list_directory_request', requestId: 'r33', path: 'bigdir' });
      const response = findLast(sent, 'list_directory_response');
      assert.equal(response.ok, true);
      assert.equal(response.truncated, true);
      assert.equal(response.totalEntries, MAX_LIST_ENTRIES, 'totalEntries must be a lower bound (what was actually enumerated), not the true 1005 total');
      assert.equal(response.entries!.length, MAX_LIST_ENTRIES);
    }

    console.log('(f) list_directory basic listing + default path + cap/truncation: OK');
  }

  // (g) RC-01 regression: `boundedScanDirectory` (delete's tier-classification
  // scan) and `handleListDirectoryRequest` both switched from `fs.readdir()`
  // (which materializes an entire directory's direct children into one
  // in-memory array before any per-entry cap can act) to `fs.opendir()`'s
  // streaming, early-break-capable async iteration. Proven directly by
  // spying on `fs.readdir` itself (both this test file and
  // `fileOpsExecutor.ts` import the same `node:fs/promises` module instance,
  // so a patched method is visible across both, confirmed empirically before
  // writing this test): if either code path still called the materializing
  // `fs.readdir`, this spy would record a nonzero call count.
  {
    const workspaceRoot = makeWorkspace();

    const bigListDir = path.join(workspaceRoot, 'spy-list');
    await fs.mkdir(bigListDir);
    const listCount = MAX_LIST_ENTRIES + 5;
    await Promise.all(Array.from({ length: listCount }, (_, i) => fs.writeFile(path.join(bigListDir, `f${i}`), '')));

    const bigDeleteDir = path.join(workspaceRoot, 'spy-delete');
    await fs.mkdir(bigDeleteDir);
    const deleteCount = DELETE_LARGE_ENTRY_THRESHOLD + 10;
    await Promise.all(Array.from({ length: deleteCount }, (_, i) => fs.writeFile(path.join(bigDeleteDir, `f${i}`), 'x')));

    const originalReaddir = fs.readdir;
    let readdirCalls = 0;
    (fs as unknown as { readdir: unknown }).readdir = async (...args: unknown[]) => {
      readdirCalls++;
      return (originalReaddir as (...a: unknown[]) => unknown)(...args);
    };

    try {
      const { executor: listExecutor, sent: listSent } = makeExecutor(workspaceRoot);
      await listExecutor.handleListDirectoryRequest({ type: 'list_directory_request', requestId: 'spy-list-req', path: 'spy-list' });
      const listResponse = findLast(listSent, 'list_directory_response');
      assert.equal(listResponse.ok, true);
      assert.equal(listResponse.truncated, true);

      const { executor: deleteExecutor, sent: deleteSent } = makeExecutor(workspaceRoot, { confirmTier2: async () => 'approved' });
      await deleteExecutor.handleDeleteFileRequest({ type: 'delete_file_request', requestId: 'spy-delete-req', path: 'spy-delete', recursive: true });
      const deleteResponse = findLast(deleteSent, 'delete_file_response');
      assert.equal(deleteResponse.ok, true);
    } finally {
      (fs as unknown as { readdir: unknown }).readdir = originalReaddir;
    }

    assert.equal(
      readdirCalls,
      0,
      'neither list_directory nor delete_file\'s size scan may call the materializing fs.readdir anymore — both must use fs.opendir'
    );
    console.log('(g) RC-01 regression: fs.opendir replaces fs.readdir at both call sites (spied, zero calls to fs.readdir): OK');
  }

  console.log('\nfileOpsExecutor: all tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
