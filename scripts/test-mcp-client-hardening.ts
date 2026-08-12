import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDbPath = path.join(process.cwd(), `.mcp-client-hardening-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = testDbPath;
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'mcp-client-hardening-key-material-32-bytes';
const previousBackendStdio = process.env.MCP_ALLOW_BACKEND_STDIO;
process.env.MCP_ALLOW_BACKEND_STDIO = 'true';

const { default: db, migrate } = await import('../server/db.js');
migrate();
const {
  McpToolCatalogChangedError,
  callMcpToolDetailed,
  createAndConnectMcpClient,
  getMcpToolCatalogStatus,
  listMcpTools,
} = await import('../server/mcp/client.js');
const { normalizeMcpConfig } = await import('../server/mcp/config.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const hardeningFixture = path.join(here, 'fixtures', 'mcp-hardening-server.mjs');
let checks = 0;

async function check(name: string, test: () => Promise<void>): Promise<void> {
  await test();
  checks += 1;
  console.log(`ok - ${name}`);
}

async function within<T>(label: string, promise: Promise<T>, timeoutMs = 6_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForStale(client: Parameters<typeof getMcpToolCatalogStatus>[0]): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (getMcpToolCatalogStatus(client).stale) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('tools/list_changed was not observed');
}

async function readRequestBody(request: IncomingMessage): Promise<Uint8Array | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return chunks.length > 0 ? new Uint8Array(Buffer.concat(chunks)) : undefined;
}

interface HangingDeleteFixture {
  url: string;
  server: HttpServer;
  deleteSeen: Promise<void>;
}

async function startHangingDeleteFixture(): Promise<HangingDeleteFixture> {
  let resolveDelete!: () => void;
  const deleteSeen = new Promise<void>((resolve) => { resolveDelete = resolve; });
  const server = createServer(async (request, response) => {
    if (request.url !== '/mcp') {
      response.statusCode = 404;
      response.end();
      return;
    }
    if (request.method === 'DELETE') {
      resolveDelete();
      // Intentionally never answer. client.close() must abort this request.
      return;
    }
    const body = await readRequestBody(request);
    const message = body ? JSON.parse(Buffer.from(body).toString('utf8')) as { id?: unknown; method?: unknown } : {};
    if (request.method !== 'POST') {
      response.statusCode = 400;
      response.end('Only POST and DELETE are supported by this fixture');
      return;
    }
    if (message.method === 'server/discover') {
      // Force bounded automatic negotiation onto the legacy initialize era,
      // whose Streamable HTTP transport owns an explicit session id.
      response.statusCode = 404;
      response.end('Modern discovery unsupported');
      return;
    }
    if (message.method === 'notifications/initialized') {
      response.statusCode = 202;
      response.end();
      return;
    }
    if (message.method !== 'initialize') {
      response.statusCode = 400;
      response.end('Unexpected method');
      return;
    }
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.setHeader('mcp-session-id', 'hanging-delete-session');
    response.end(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        serverInfo: { name: 'hanging-delete', version: '2.0.0' },
      },
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${address.port}/mcp`, server, deleteSeen };
}

async function closeHttpFixture(fixture: HangingDeleteFixture): Promise<void> {
  fixture.server.closeAllConnections();
  await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
}

try {
  await check('stdio startup stderr is continuously drained, bounded, and redacted', async () => {
    const secret = 'stdio-secret-that-must-not-leak';
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...values: unknown[]) => { warnings.push(values.map(String).join(' ')); };
    let connection: Awaited<ReturnType<typeof createAndConnectMcpClient>> | undefined;
    try {
      const config = normalizeMcpConfig(
        'stdio',
        {
          command: process.execPath,
          args: [hardeningFixture],
          env: { HARDENING_SECRET: secret, HARDENING_FLOOD: 'true' },
        },
        { localExecutionApproved: true },
      );
      connection = await createAndConnectMcpClient(
        { transport: 'stdio', config, serverId: 'hardening-fixture' },
        { userId: 'hardening-test' },
      );
      assert.equal(connection.info.protocolEra, 'modern');
      assert.ok(warnings.length <= 10, `stderr logging was not bounded (${warnings.length} lines)`);
      assert.equal(warnings.some((line) => line.includes(secret)), false, 'configured secret leaked through stderr');
      assert.equal(warnings.some((line) => line.includes('[REDACTED]')), true, 'secret was not visibly redacted');
    } finally {
      try {
        await connection?.close();
      } finally {
        console.warn = originalWarn;
      }
    }
  });

  await check('list_changed atomically refreshes schemas and removed tools fail closed', async () => {
    const config = normalizeMcpConfig(
      'stdio',
      { command: process.execPath, args: [hardeningFixture] },
      { localExecutionApproved: true },
    );
    const connection = await createAndConnectMcpClient(
      { transport: 'stdio', config, serverId: 'mutable-catalog-fixture' },
      { userId: 'hardening-test' },
    );
    try {
      const listed = await listMcpTools(connection.client, 'mutable');
      assert.equal(listed.some((tool) => tool.mcpToolName === 'mutable-target'), true);
      await callMcpToolDetailed(connection.client, 'mutable-target', { value: 'before' });

      await callMcpToolDetailed(connection.client, 'catalog-control', { action: 'change' });
      await waitForStale(connection.client);
      await assert.rejects(
        () => callMcpToolDetailed(connection.client, 'mutable-target', { value: 'stale-input' }),
        /Invalid arguments/,
      );
      const renewed = await callMcpToolDetailed(connection.client, 'mutable-target', { count: 4 });
      assert.deepEqual(renewed.structuredContent, { doubled: 8 });
      const invalidOutput = await callMcpToolDetailed(connection.client, 'mutable-target', { count: 13 });
      assert.equal(invalidOutput.isError, true, 'renewed output schema did not fail closed');
      assert.match(invalidOutput.output, /output|schema|structured/i);

      await callMcpToolDetailed(connection.client, 'catalog-control', { action: 'remove' });
      await waitForStale(connection.client);
      await assert.rejects(
        () => callMcpToolDetailed(connection.client, 'mutable-target', { count: 5 }),
        (error: unknown) => error instanceof McpToolCatalogChangedError,
      );
      const stats = await callMcpToolDetailed(connection.client, 'catalog-control', { action: 'stats' });
      assert.deepEqual(stats.structuredContent, { targetCalls: 3, action: 'stats' });
    } finally {
      await connection.close();
    }
  });

  await check('hanging HTTP session termination is bounded and still closes the client', async () => {
    const fixture = await startHangingDeleteFixture();
    let connection: Awaited<ReturnType<typeof createAndConnectMcpClient>> | undefined;
    try {
      const config = normalizeMcpConfig('url', {
        url: fixture.url,
        allowPrivateNetwork: true,
        allowInsecureHttp: true,
      });
      connection = await within('HTTP fixture connect', createAndConnectMcpClient(
          { transport: 'url', config, serverId: 'hanging-delete-fixture' },
          { userId: 'hardening-test' },
        ));
      const startedAt = Date.now();
      await within('bounded MCP connection close', connection.close());
      connection = undefined;
      const elapsed = Date.now() - startedAt;
      await fixture.deleteSeen;
      assert.ok(elapsed >= 1_200, `termination timeout was not exercised (${elapsed}ms)`);
      assert.ok(elapsed < 4_000, `close remained pinned by DELETE (${elapsed}ms)`);
    } finally {
      await connection?.close();
      await within('HTTP fixture cleanup', closeHttpFixture(fixture));
    }
  });
} finally {
  if (previousBackendStdio === undefined) delete process.env.MCP_ALLOW_BACKEND_STDIO;
  else process.env.MCP_ALLOW_BACKEND_STDIO = previousBackendStdio;
  db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${testDbPath}${suffix}`, { force: true });
}

console.log(`MCP client hardening: ${checks} checks passed`);
