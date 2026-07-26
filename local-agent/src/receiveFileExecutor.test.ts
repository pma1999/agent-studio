import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createReceiveFileExecutor,
  MAX_RECEIVE_FILE_BYTES,
  type DownloadFn,
  type ReceiveFileExecutorOptions,
} from './receiveFileExecutor.js';
import type { AgentToBackendMessage } from './transport.js';

function makeWorkspace(): string {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), 'agent-studio-receive-file-'));
}

function makeExecutor(
  workspaceRoot: string,
  downloadFn: DownloadFn,
  overrides: Partial<ReceiveFileExecutorOptions> = {}
) {
  const sent: AgentToBackendMessage[] = [];
  const options: ReceiveFileExecutorOptions = {
    workspaceRoot,
    backendUrl: 'https://backend.example.test',
    token: 'test-token',
    send: (message) => sent.push(message),
    downloadFn,
    ...overrides,
  };
  return { executor: createReceiveFileExecutor(options), sent };
}

function findLast<T extends AgentToBackendMessage['type']>(
  sent: AgentToBackendMessage[],
  type: T
): Extract<AgentToBackendMessage, { type: T }> {
  const found = [...sent].reverse().find((message) => message.type === type);
  assert.ok(found, `expected a message of type ${type}`);
  return found as Extract<AgentToBackendMessage, { type: T }>;
}

async function testDeclaredSizeOverCapRejectsWithoutDownloading(): Promise<void> {
  const workspace = makeWorkspace();
  let downloadCalls = 0;
  const { executor, sent } = makeExecutor(workspace, async () => {
    downloadCalls += 1;
    return { ok: true, content: Buffer.from('unexpected') };
  });

  await executor.handleReceiveFileRequest({
    type: 'receive_file_request',
    requestId: 'oversize-1',
    fileId: 'file-1',
    filename: 'huge.bin',
    sizeBytes: MAX_RECEIVE_FILE_BYTES + 1,
    mimeType: 'application/octet-stream',
  });

  assert.equal(downloadCalls, 0);
  const response = findLast(sent, 'receive_file_response');
  assert.equal(response.ok, false);
  assert.match(response.error ?? '', new RegExp(`${MAX_RECEIVE_FILE_BYTES}-byte`));
}

async function testCollisionAvoidanceNeverOverwrites(): Promise<void> {
  const workspace = makeWorkspace();
  const uploadsDir = path.join(workspace, 'uploads');
  fsSync.mkdirSync(uploadsDir, { recursive: true });
  const originalContent = 'original,csv,content';
  fsSync.writeFileSync(path.join(uploadsDir, 'report.csv'), originalContent);

  const newContent = Buffer.from('new,csv,content');
  const { executor, sent } = makeExecutor(workspace, async () => ({ ok: true, content: newContent }));

  await executor.handleReceiveFileRequest({
    type: 'receive_file_request',
    requestId: 'collision-1',
    fileId: 'file-2',
    filename: 'report.csv',
    sizeBytes: newContent.length,
    mimeType: 'text/csv',
  });

  const response = findLast(sent, 'receive_file_response');
  assert.equal(response.ok, true);
  assert.match(response.writtenPath ?? '', /uploads\/report \(1\)\.csv$/);
  assert.equal(fsSync.readFileSync(path.join(uploadsDir, 'report.csv'), 'utf8'), originalContent);
  assert.equal(fsSync.readFileSync(path.join(uploadsDir, 'report (1).csv')).toString(), 'new,csv,content');
}

async function testNoCollisionUsesPlainName(): Promise<void> {
  const workspace = makeWorkspace();
  const content = Buffer.from('fresh,csv,content');
  const { executor, sent } = makeExecutor(workspace, async () => ({ ok: true, content }));

  await executor.handleReceiveFileRequest({
    type: 'receive_file_request',
    requestId: 'no-collision-1',
    fileId: 'file-3',
    filename: 'report.csv',
    sizeBytes: content.length,
    mimeType: 'text/csv',
  });

  const response = findLast(sent, 'receive_file_response');
  assert.equal(response.ok, true);
  assert.match(response.writtenPath ?? '', /uploads\/report\.csv$/);
}

async function testActualContentExceedsCapEvenThoughDeclaredDidNot(): Promise<void> {
  const workspace = makeWorkspace();
  const oversizedContent = Buffer.alloc(MAX_RECEIVE_FILE_BYTES + 1, 1);
  const { executor, sent } = makeExecutor(workspace, async () => ({ ok: true, content: oversizedContent }));

  await executor.handleReceiveFileRequest({
    type: 'receive_file_request',
    requestId: 'lied-size-1',
    fileId: 'file-4',
    filename: 'sneaky.bin',
    sizeBytes: 10,
    mimeType: 'application/octet-stream',
  });

  const response = findLast(sent, 'receive_file_response');
  assert.equal(response.ok, false);
  assert.match(response.error ?? '', new RegExp(`${MAX_RECEIVE_FILE_BYTES}-byte`));
  assert.equal(fsSync.existsSync(path.join(workspace, 'uploads', 'sneaky.bin')), false);
}

async function testDownloadFailureIsReportedAndNothingWritten(): Promise<void> {
  const workspace = makeWorkspace();
  const { executor, sent } = makeExecutor(workspace, async () => ({
    ok: false,
    error: 'download failed (HTTP 404)',
  }));

  await executor.handleReceiveFileRequest({
    type: 'receive_file_request',
    requestId: 'failure-1',
    fileId: 'file-5',
    filename: 'missing.txt',
    sizeBytes: 5,
    mimeType: 'text/plain',
  });

  assert.deepEqual(findLast(sent, 'receive_file_response'), {
    type: 'receive_file_response',
    requestId: 'failure-1',
    ok: false,
    error: 'download failed (HTTP 404)',
  });
  assert.equal(fsSync.existsSync(path.join(workspace, 'uploads', 'missing.txt')), false);
}

async function testSuccessReportsBytesWrittenAndForwardSlashPath(): Promise<void> {
  const workspace = makeWorkspace();
  const content = Buffer.from('hello world');
  const events: string[] = [];
  const downloadFn: DownloadFn = async (params) => {
    events.push('download');
    assert.equal(params.backendUrl, 'https://backend.example.test');
    assert.equal(params.token, 'test-token');
    assert.equal(params.fileId, 'file-6');
    assert.ok(params.signal instanceof AbortSignal);
    return { ok: true, content };
  };
  const { executor, sent } = makeExecutor(workspace, downloadFn, {
    send: (message) => {
      events.push('send');
      sent.push(message);
    },
  });

  await executor.handleReceiveFileRequest({
    type: 'receive_file_request',
    requestId: 'success-1',
    fileId: 'file-6',
    filename: 'chart.png',
    sizeBytes: content.length,
    mimeType: 'image/png',
  });

  assert.deepEqual(events, ['download', 'send']);
  const response = findLast(sent, 'receive_file_response');
  assert.equal(response.ok, true);
  assert.equal(response.bytesWritten, content.length);
  assert.ok(response.writtenPath, 'expected a writtenPath');
  assert.doesNotMatch(response.writtenPath as string, /\\/);
  assert.equal(response.writtenPath, 'uploads/chart.png');
  assert.equal(fsSync.readFileSync(path.join(workspace, 'uploads', 'chart.png')).toString(), 'hello world');
}

async function testForbiddenWindowsCharsAreStrippedFromFilename(): Promise<void> {
  const workspace = makeWorkspace();
  const content = Buffer.from('sanitized name content');
  const { executor, sent } = makeExecutor(workspace, async () => ({ ok: true, content }));

  await executor.handleReceiveFileRequest({
    type: 'receive_file_request',
    requestId: 'forbidden-chars-1',
    fileId: 'file-7',
    filename: 'bad:name<tag>"pipe|q?*.txt',
    sizeBytes: content.length,
    mimeType: 'text/plain',
  });

  const response = findLast(sent, 'receive_file_response');
  assert.equal(response.ok, true);
  assert.doesNotMatch(response.writtenPath ?? '', /[:<>"|?*]/);
}

// Regression for RC-01 (final-review.md): on Windows/NTFS, an un-stripped
// colon turns "report.csv:payload.exe" into a write against an *alternate
// data stream* of the existing report.csv rather than a new file — the
// wx/O_EXCL collision-avoidance write succeeds silently, no EEXIST, and the
// hidden payload is invisible to a directory listing. This reproduces the
// reviewer's empirical repro as an automated test: pre-create uploads/report.csv
// with known content, then attempt to deliver a file whose (would-be)
// sanitized-on-the-server name is report.csv:payload.exe, and assert the
// pre-existing file's content is untouched and a new, distinctly-named file
// was written instead.
async function testAlternateDataStreamFilenameNeverTouchesExistingFileContent(): Promise<void> {
  const workspace = makeWorkspace();
  const uploadsDir = path.join(workspace, 'uploads');
  fsSync.mkdirSync(uploadsDir, { recursive: true });
  const originalContent = 'original,csv,content';
  fsSync.writeFileSync(path.join(uploadsDir, 'report.csv'), originalContent);

  const maliciousContent = Buffer.from('MALICIOUS-PAYLOAD-BYTES');
  const { executor, sent } = makeExecutor(workspace, async () => ({ ok: true, content: maliciousContent }));

  await executor.handleReceiveFileRequest({
    type: 'receive_file_request',
    requestId: 'ads-1',
    fileId: 'file-8',
    filename: 'report.csv:payload.exe',
    sizeBytes: maliciousContent.length,
    mimeType: 'application/octet-stream',
  });

  const response = findLast(sent, 'receive_file_response');
  assert.equal(response.ok, true);
  assert.doesNotMatch(response.writtenPath ?? '', /:/);
  // The pre-existing file's visible content must remain completely
  // untouched — no alternate data stream ever gets a chance to attach to it.
  assert.equal(fsSync.readFileSync(path.join(uploadsDir, 'report.csv'), 'utf8'), originalContent);
  // A new, distinctly-named file must have been written instead of an ADS.
  const writtenName = path.basename(response.writtenPath as string);
  assert.notEqual(writtenName, 'report.csv');
  assert.equal(
    fsSync.readFileSync(path.join(uploadsDir, writtenName)).toString(),
    'MALICIOUS-PAYLOAD-BYTES',
  );
  // The decisive check: an alternate data stream is invisible to a directory
  // listing (that's the entire danger — it hides from `list_directory`).
  // A real, ordinary sibling file must be enumerable alongside report.csv.
  const entries = fsSync.readdirSync(uploadsDir);
  assert.ok(
    entries.includes(writtenName),
    `expected "${writtenName}" to be visible via readdirSync; got [${entries.join(', ')}]`,
  );
  assert.deepEqual([...entries].sort(), ['report.csv', writtenName].sort());
}

await testDeclaredSizeOverCapRejectsWithoutDownloading();
await testCollisionAvoidanceNeverOverwrites();
await testNoCollisionUsesPlainName();
await testActualContentExceedsCapEvenThoughDeclaredDidNot();
await testDownloadFailureIsReportedAndNothingWritten();
await testSuccessReportsBytesWrittenAndForwardSlashPath();
await testForbiddenWindowsCharsAreStrippedFromFilename();
await testAlternateDataStreamFilenameNeverTouchesExistingFileContent();

console.log('receiveFileExecutor tests passed');
