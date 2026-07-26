import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-uploads-test-'));
process.env.DATABASE_PATH = path.join(testDirectory, 'agent-uploads.db');
process.env.DISABLE_AUTH = 'true';
delete process.env.JWT_SECRET;

const { default: db, ensureLocalUser, migrate } = await import('../server/db.js');
const { hashToken } = await import('../server/agentRelay/protocol.js');
const {
  registerAgentConnection,
  unregisterAgentConnection,
} = await import('../server/agentRelay/registry.js');
const { authMiddleware } = await import('../server/middleware/auth.js');
const agentFilesModule = await import('../server/routes/agentFiles.js');
const agentFilesRouter = agentFilesModule.default;
const { sanitizeFilename } = agentFilesModule;
const agentUploadsRouter = (await import('../server/routes/agentUploads.js')).default;

type AgentToBackendMessage = import('../server/agentRelay/protocol.js').AgentToBackendMessage;
type BackendToAgentMessage = import('../server/agentRelay/protocol.js').BackendToAgentMessage;
type AgentConnection = import('../server/agentRelay/registry.js').AgentConnection;

class FakeConnection implements AgentConnection {
  readonly sent: BackendToAgentMessage[] = [];
  private callbacks: Array<(message: AgentToBackendMessage) => void> = [];
  private connected = true;
  onClosed: (() => void) | undefined;

  constructor(private readonly onSend?: (message: BackendToAgentMessage) => void) {}

  isConnected() { return this.connected; }
  send(message: BackendToAgentMessage) {
    this.sent.push(message);
    this.onSend?.(message);
  }
  onMessage(callback: (message: AgentToBackendMessage) => void) {
    this.callbacks.push(callback);
  }
  close() {
    if (!this.connected) return;
    this.connected = false;
    this.onClosed?.();
  }
  receive(message: AgentToBackendMessage) {
    for (const callback of this.callbacks) callback(message);
  }
}

function connect(userId: string, connection: FakeConnection): FakeConnection {
  connection.onClosed = () => unregisterAgentConnection(userId, connection);
  registerAgentConnection(userId, connection);
  return connection;
}

function disconnect(userId: string, connection: FakeConnection | undefined): void {
  if (!connection) return;
  unregisterAgentConnection(userId, connection);
  connection.close();
}

migrate();
const userId = ensureLocalUser();
assert.ok(userId);
const agentToken = 'agent-uploads-test-token';
db.prepare(`
  INSERT INTO paired_agents (id, user_id, device_name, token_hash)
  VALUES (?, ?, ?, ?)
`).run('agent-uploads-test-agent', userId, 'Agent Uploads Test', hashToken(agentToken));

const conversationId = 'agent-uploads-conversation';
db.prepare(`
  INSERT INTO conversations (id, user_id, title, updated_at)
  VALUES (?, ?, ?, ?)
`).run(conversationId, userId, 'Agent uploads', '2000-01-01 00:00:00');

const app = express();
app.use('/api/conversations', authMiddleware, agentUploadsRouter);
app.use('/api/agent/files', agentFilesRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve, reject) => {
  server.once('listening', resolve);
  server.once('error', reject);
});
const address = server.address();
assert.ok(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;

const upload = (id: string, filename: string, body: Buffer) => fetch(
  `${origin}/api/conversations/${id}/agent-uploads`,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-File-Name-B64': Buffer.from(filename).toString('base64'),
    },
    body,
  },
);

let activeConnection: FakeConnection | undefined;
try {
  // Regression for RC-01 (final-review.md): sanitizeFilename must strip every
  // Windows-forbidden filename/path character, not just `/`, `\`, and control
  // chars — an un-stripped `:` lets an inbound filename address an NTFS
  // alternate data stream instead of creating a new file.
  const forbiddenCharsSanitized = sanitizeFilename(
    Buffer.from('bad:name<tag>"pipe|q?*.txt').toString('base64'),
  );
  assert.doesNotMatch(forbiddenCharsSanitized, /[:<>"|?*]/);

  const disconnectedResponse = await upload(
    conversationId,
    'disconnected.bin',
    Buffer.alloc(32 * 1024, 7),
  );
  assert.equal(disconnectedResponse.status, 409);
  assert.deepEqual(
    await disconnectedResponse.json(),
    { error: 'local agent is not connected' },
  );

  activeConnection = connect(userId, new FakeConnection());
  const missingResponse = await upload(
    'missing-conversation',
    'not-staged.txt',
    Buffer.from('must not be staged'),
  );
  assert.equal(missingResponse.status, 404);
  assert.deepEqual(await missingResponse.json(), { error: 'Conversation not found' });
  assert.equal(activeConnection.sent.length, 0);
  disconnect(userId, activeConnection);
  activeConnection = undefined;

  const errorLayers = (
    agentUploadsRouter as unknown as {
      stack: Array<{
        handle: (
          error: unknown,
          req: Request,
          res: Response,
          next: NextFunction,
        ) => unknown;
      }>;
    }
  ).stack.filter((layer) => layer.handle.length === 4);
  assert.equal(errorLayers.length, 1);
  let oversizedStatus: number | undefined;
  let oversizedBody: unknown;
  const oversizedResponse = {
    status(status: number) {
      oversizedStatus = status;
      return this;
    },
    json(body: unknown) {
      oversizedBody = body;
      return this;
    },
  } as unknown as Response;
  errorLayers[0].handle(
    { type: 'entity.too.large' },
    {} as Request,
    oversizedResponse,
    (() => assert.fail('entity.too.large must be handled')) as NextFunction,
  );
  assert.equal(oversizedStatus, 413);
  assert.deepEqual(oversizedBody, { error: 'File exceeds the 100 MiB size limit' });

  const content = Buffer.from('successful agent upload');
  let stagedId = '';
  activeConnection = connect(userId, new FakeConnection((message) => {
    if (message.type !== 'receive_file_request') return;
    stagedId = message.fileId;
    const connection = activeConnection!;
    void (async () => {
      try {
        const fetchResponse = await fetch(
          `${origin}/api/agent/files/inbound/${message.fileId}`,
          { headers: { Authorization: `Bearer ${agentToken}` } },
        );
        assert.equal(fetchResponse.status, 200);
        assert.equal(fetchResponse.headers.get('content-type'), 'text/plain');
        assert.deepEqual(Buffer.from(await fetchResponse.arrayBuffer()), content);
        connection.receive({
          type: 'receive_file_response',
          requestId: message.requestId,
          ok: true,
          writtenPath: 'uploads/example.txt',
          bytesWritten: content.length,
        });
      } catch (error) {
        connection.receive({
          type: 'receive_file_response',
          requestId: message.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }));

  const successResponse = await upload(conversationId, '/example.txt', content);
  assert.equal(successResponse.status, 200);
  const successBody = await successResponse.json() as {
    message: {
      id: string;
      content: string;
      attachments: Array<{ filename: string; deliveredPath: string }>;
      annotations: unknown;
      tool_calls: unknown;
      provider_routing: unknown;
    };
  };
  assert.equal(
    successBody.message.content,
    'Sent file "example.txt" to your computer — now available at "uploads/example.txt" in your workspace.',
  );
  assert.deepEqual(
    successBody.message.attachments,
    [{ filename: 'example.txt', deliveredPath: 'uploads/example.txt' }],
  );
  assert.equal(successBody.message.annotations, null);
  assert.equal(successBody.message.tool_calls, null);
  assert.equal(successBody.message.provider_routing, null);
  const storedMessage = db.prepare(
    'SELECT content, attachments FROM messages WHERE id = ?',
  ).get(successBody.message.id) as { content: string; attachments: string } | undefined;
  assert.ok(storedMessage);
  assert.equal(storedMessage.content, successBody.message.content);
  assert.deepEqual(JSON.parse(storedMessage.attachments), successBody.message.attachments);
  const updatedConversation = db.prepare(
    'SELECT updated_at FROM conversations WHERE id = ?',
  ).get(conversationId) as { updated_at: string };
  assert.notEqual(updatedConversation.updated_at, '2000-01-01 00:00:00');
  assert.ok(stagedId);
  const secondFetch = await fetch(`${origin}/api/agent/files/inbound/${stagedId}`, {
    headers: { Authorization: `Bearer ${agentToken}` },
  });
  assert.equal(secondFetch.status, 404);
  assert.deepEqual(
    await secondFetch.json(),
    { error: 'Staged file not found, already fetched, or expired' },
  );
  disconnect(userId, activeConnection);
  activeConnection = undefined;

  const messagesBeforeFailure = (
    db.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }
  ).count;
  activeConnection = connect(userId, new FakeConnection((message) => {
    if (message.type !== 'receive_file_request') return;
    const connection = activeConnection!;
    queueMicrotask(() => connection.receive({
      type: 'receive_file_response',
      requestId: message.requestId,
      ok: false,
      error: 'disk full',
    }));
  }));
  const failureResponse = await upload(conversationId, 'failure.txt', Buffer.from('failure'));
  assert.equal(failureResponse.status, 502);
  assert.deepEqual(await failureResponse.json(), { error: 'disk full' });
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count,
    messagesBeforeFailure,
  );
  disconnect(userId, activeConnection);
  activeConnection = undefined;

  activeConnection = connect(userId, new FakeConnection((message) => {
    if (message.type !== 'receive_file_request') return;
    const connection = activeConnection!;
    queueMicrotask(() => connection.close());
  }));
  const disconnectedMidFlight = await upload(
    conversationId,
    'lost-response.txt',
    Buffer.from('possibly landed'),
  );
  assert.equal(disconnectedMidFlight.status, 502);
  assert.deepEqual(
    await disconnectedMidFlight.json(),
    { error: 'local agent disconnected mid-command' },
  );
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count,
    messagesBeforeFailure,
  );
} finally {
  disconnect(userId, activeConnection);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  db.close();
  fs.rmSync(testDirectory, { recursive: true, force: true });
}

console.log('agent upload tests passed');
