import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import express from 'express';

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-files-test-'));
const testDbPath = path.join(testDirectory, 'agent-files.db');
process.env.DATABASE_PATH = testDbPath;
process.env.JWT_SECRET = 'agent-files-test-jwt-secret';

const { default: db, ensureLocalUser, migrate } = await import('../server/db.js');
const { hashToken } = await import('../server/agentRelay/protocol.js');
const {
  MAX_SEND_FILE_BYTES,
  getActiveAgentFile,
  saveAgentFile,
  sweepExpiredAgentFiles,
} = await import('../server/agentFiles/storage.js');
const { inferMimeType } = await import('../server/utils/mimeTypes.js');
const agentFilesRouter = (await import('../server/routes/agentFiles.js')).default;
const agentRouter = (await import('../server/routes/agent.js')).default;

migrate();
const userId = ensureLocalUser();
assert.ok(userId);
db.prepare(`
  INSERT INTO paired_agents (id, user_id, device_name, token_hash)
  VALUES (?, ?, ?, ?)
`).run('agent-files-test-agent', userId, 'Agent Files Test', hashToken('test-token'));

const app = express();
app.use('/api/agent/files', agentFilesRouter);
app.use('/api/agent', agentRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve, reject) => {
  server.once('listening', resolve);
  server.once('error', reject);
});
const address = server.address();
assert.ok(address && typeof address === 'object');
const baseUrl = `http://127.0.0.1:${address.port}/api/agent/files`;

try {
  for (const authorization of [undefined, 'Bearer garbage']) {
    const response = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name-B64': Buffer.from('chart.png').toString('base64'),
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: Buffer.from('hello world'),
    });
    assert.equal(response.status, 401);
  }

  const uploadResponse = await fetch(`${baseUrl}/upload`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/octet-stream',
      'X-File-Name-B64': Buffer.from('chart.png').toString('base64'),
    },
    body: Buffer.from('hello world'),
  });
  assert.equal(uploadResponse.status, 201);
  const upload = await uploadResponse.json() as {
    fileId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    expiresAt: string;
  };
  assert.equal(upload.filename, 'chart.png');
  assert.equal(upload.mimeType, 'image/png');
  assert.equal(upload.sizeBytes, 11);
  assert.equal(Number.isNaN(new Date(upload.expiresAt).getTime()), false);

  const downloadResponse = await fetch(`${baseUrl}/${upload.fileId}/download`);
  assert.equal(downloadResponse.status, 200);
  assert.equal(Buffer.from(await downloadResponse.arrayBuffer()).toString(), 'hello world');
  assert.equal(downloadResponse.headers.get('content-type'), 'image/png');
  assert.match(downloadResponse.headers.get('content-disposition') ?? '', /attachment/);
  assert.match(downloadResponse.headers.get('content-disposition') ?? '', /chart\.png/);

  const originalCreateReadStream = fs.createReadStream;
  const originalConsoleError = console.error;
  let streamErrorLogged = false;
  fs.createReadStream = (() => {
    const stream = new PassThrough();
    queueMicrotask(() => stream.emit('error', new Error('simulated read failure')));
    return stream;
  }) as typeof fs.createReadStream;
  console.error = (...args: unknown[]) => {
    streamErrorLogged ||= String(args[0]).includes('Failed to stream agent file');
  };
  try {
    const streamErrorResponse = await fetch(`${baseUrl}/${upload.fileId}/download`);
    assert.equal(streamErrorResponse.status, 500);
    assert.deepEqual(await streamErrorResponse.json(), { error: 'Failed to read file' });
    assert.equal(streamErrorLogged, true);
  } finally {
    fs.createReadStream = originalCreateReadStream;
    console.error = originalConsoleError;
  }

  assert.equal((await fetch(`${baseUrl}/does-not-exist/download`)).status, 404);
  assert.equal(MAX_SEND_FILE_BYTES, 100 * 1024 * 1024);

  const mediumBody = Buffer.alloc(200 * 1024, 7);
  const mediumResponse = await fetch(`${baseUrl}/upload`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/octet-stream',
      'X-File-Name-B64': Buffer.from('medium.bin').toString('base64'),
    },
    body: mediumBody,
  });
  assert.equal(mediumResponse.status, 201);

  const expiring = saveAgentFile({
    userId,
    agentId: 'agent-files-test-agent',
    filename: 'expired.txt',
    content: Buffer.from('expired'),
  });
  db.prepare('UPDATE agent_files SET expires_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 1_000).toISOString(), expiring.id);
  assert.equal(getActiveAgentFile(expiring.id), undefined);
  sweepExpiredAgentFiles();
  assert.equal(fs.existsSync(expiring.storagePath), false);
  assert.equal(
    db.prepare('SELECT id FROM agent_files WHERE id = ?').get(expiring.id),
    undefined,
  );

  assert.equal(
    inferMimeType('a.docx'),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  );
  assert.equal(inferMimeType('a.unknownext'), 'application/octet-stream');
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  db.close();
  fs.rmSync(testDirectory, { recursive: true, force: true });
}

console.log('agent file tests passed');
