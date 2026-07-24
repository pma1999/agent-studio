import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createSendFileExecutor,
  MAX_SEND_FILE_BYTES,
  type SendFileExecutorOptions,
  type UploadFn,
} from './sendFileExecutor.js';
import type { AgentToBackendMessage } from './transport.js';

function makeWorkspace(): string {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), 'agent-studio-send-file-'));
}

function makeExecutor(
  workspaceRoot: string,
  uploadFn: UploadFn,
  overrides: Partial<SendFileExecutorOptions> = {}
) {
  const sent: AgentToBackendMessage[] = [];
  const options: SendFileExecutorOptions = {
    workspaceRoot,
    allowOutsideWorkspace: false,
    backendUrl: 'https://backend.example.test',
    token: 'test-token',
    send: (message) => sent.push(message),
    uploadFn,
    ...overrides,
  };
  return { executor: createSendFileExecutor(options), sent };
}

function findLast<T extends AgentToBackendMessage['type']>(
  sent: AgentToBackendMessage[],
  type: T
): Extract<AgentToBackendMessage, { type: T }> {
  const found = [...sent].reverse().find((message) => message.type === type);
  assert.ok(found, `expected a message of type ${type}`);
  return found as Extract<AgentToBackendMessage, { type: T }>;
}

async function testRootScoping(): Promise<void> {
  const workspace = makeWorkspace();
  let uploadCalls = 0;
  const { executor, sent } = makeExecutor(workspace, async () => {
    uploadCalls += 1;
    return { ok: false, error: 'unexpected upload' };
  });

  await executor.handleSendFileRequest({ type: 'send_file_request', requestId: 'outside-1', path: '../outside.txt' });

  assert.equal(uploadCalls, 0);
  const response = findLast(sent, 'send_file_response');
  assert.equal(response.type, 'send_file_response');
  assert.equal(response.requestId, 'outside-1');
  assert.equal(response.ok, false);
  assert.match(response.error ?? '', /resolves outside the workspace root/);
}

async function testSizeConstantAndBinarySafeRead(): Promise<void> {
  assert.equal(MAX_SEND_FILE_BYTES, 100 * 1024 * 1024);
  const workspace = makeWorkspace();
  const content = Buffer.from([0, 255, 1, 2, 3]);
  const filePath = path.join(workspace, 'binary.bin');
  fsSync.writeFileSync(filePath, content);
  let receivedContent: Buffer | undefined;
  const { executor, sent } = makeExecutor(workspace, async (params) => {
    receivedContent = params.content;
    return {
      ok: true,
      fileId: 'binary-file',
      filename: 'binary.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: content.length,
      expiresAt: '2030-01-01T00:00:00.000Z',
    };
  });

  await executor.handleSendFileRequest({ type: 'send_file_request', requestId: 'binary-1', path: 'binary.bin' });

  assert.deepEqual(receivedContent, content);
  assert.equal(findLast(sent, 'send_file_response').ok, true);
}

async function testMissingAndDirectoryPaths(): Promise<void> {
  const workspace = makeWorkspace();
  let uploadCalls = 0;
  const uploadFn: UploadFn = async () => {
    uploadCalls += 1;
    return { ok: false, error: 'unexpected upload' };
  };
  const { executor, sent } = makeExecutor(workspace, uploadFn);
  fsSync.mkdirSync(path.join(workspace, 'folder'));

  await executor.handleSendFileRequest({ type: 'send_file_request', requestId: 'missing-1', path: 'missing.txt' });
  const missingResponse = findLast(sent, 'send_file_response');
  assert.equal(missingResponse.ok, false);
  assert.match(missingResponse.error ?? '', /missing\.txt/);

  await executor.handleSendFileRequest({ type: 'send_file_request', requestId: 'directory-1', path: 'folder' });
  const directoryResponse = findLast(sent, 'send_file_response');
  assert.equal(directoryResponse.ok, false);
  assert.match(directoryResponse.error ?? '', /is a directory/);
  assert.equal(uploadCalls, 0);
}

async function testSuccessUsesBackendResponseAndWaitsForUpload(): Promise<void> {
  const workspace = makeWorkspace();
  const content = Buffer.from('hello world');
  fsSync.writeFileSync(path.join(workspace, 'chart.png'), content);
  const events: string[] = [];
  const uploadFn: UploadFn = async (params) => {
    events.push('upload');
    assert.equal(params.backendUrl, 'https://backend.example.test');
    assert.equal(params.token, 'test-token');
    assert.equal(params.filename, 'chart.png');
    assert.deepEqual(params.content, content);
    assert.ok(params.signal instanceof AbortSignal);
    return {
      ok: true,
      fileId: 'f1',
      filename: 'chart.png',
      mimeType: 'image/png',
      sizeBytes: 11,
      expiresAt: '2030-01-01T00:00:00.000Z',
    };
  };
  const { executor, sent } = makeExecutor(workspace, uploadFn, {
    backendUrl: 'https://backend.example.test',
    token: 'test-token',
    send: (message) => {
      events.push('send');
      sent.push(message);
    },
  });

  await executor.handleSendFileRequest({ type: 'send_file_request', requestId: 'success-1', path: 'chart.png' });

  assert.deepEqual(events, ['upload', 'send']);
  assert.deepEqual(findLast(sent, 'send_file_response'), {
    type: 'send_file_response',
    requestId: 'success-1',
    ok: true,
    fileId: 'f1',
    filename: 'chart.png',
    mimeType: 'image/png',
    sizeBytes: 11,
    expiresAt: '2030-01-01T00:00:00.000Z',
  });
}

async function testUploadFailureIsReported(): Promise<void> {
  const workspace = makeWorkspace();
  fsSync.writeFileSync(path.join(workspace, 'chart.png'), 'hello world');
  const { executor, sent } = makeExecutor(workspace, async () => ({
    ok: false,
    error: 'upload failed (HTTP 500)',
  }));

  await executor.handleSendFileRequest({ type: 'send_file_request', requestId: 'failure-1', path: 'chart.png' });

  assert.deepEqual(findLast(sent, 'send_file_response'), {
    type: 'send_file_response',
    requestId: 'failure-1',
    ok: false,
    error: 'upload failed (HTTP 500)',
  });
}

await testRootScoping();
await testSizeConstantAndBinarySafeRead();
await testMissingAndDirectoryPaths();
await testSuccessUsesBackendResponseAndWaitsForUpload();
await testUploadFailureIsReported();

console.log('sendFileExecutor tests passed');
