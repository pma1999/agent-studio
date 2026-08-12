import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpHandler, McpServer, type McpHttpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';

const testDbPath = path.join(process.cwd(), `.mcp-client-v2-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = testDbPath;
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'mcp-client-test-key-material-32-bytes-minimum';
const previousBackendStdio = process.env.MCP_ALLOW_BACKEND_STDIO;
process.env.MCP_ALLOW_BACKEND_STDIO = 'true';

const { default: db, migrate } = await import('../server/db.js');
migrate();

const {
  assertSafeMcpUrl,
  callMcpToolDetailed,
  createAndConnectMcpClient,
  getMcpPrompt,
  listMcpPrompts,
  listMcpResources,
  listMcpTools,
  prefixToolName,
  readMcpResource,
} = await import('../server/mcp/client.js');
const {
  MCP_SECRET_PLACEHOLDER,
  hasValidExecutionApproval,
  maskMcpConfig,
  normalizeMcpConfig,
  parseStoredMcpConfig,
  serializeMcpConfig,
} = await import('../server/mcp/config.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const modernFixture = path.join(here, 'fixtures', 'mcp-modern-server.mjs');
const legacyFixture = path.join(here, 'fixtures', 'mcp-echo-server.cjs');
let checks = 0;

interface ModernHttpFixture {
  url: string;
  handler: McpHttpHandler;
  server: HttpServer;
  requestCount: number;
  toolCallCount: number;
}

async function readRequestBody(request: IncomingMessage): Promise<Uint8Array | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return undefined;
  return new Uint8Array(Buffer.concat(chunks));
}

async function writeResponse(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status;
  response.headers.forEach((value, name) => target.setHeader(name, value));
  target.end(Buffer.from(await response.arrayBuffer()));
}

async function startModernHttpFixture(): Promise<ModernHttpFixture> {
  let requestCount = 0;
  let toolCallCount = 0;
  const handler = createMcpHandler(
    () => {
      const mcp = new McpServer({ name: 'test-modern-http', version: '2.0.0' });
      mcp.registerTool(
        'http-echo',
        {
          description: 'Returns a structured value over modern Streamable HTTP.',
          inputSchema: z.object({ value: z.string().min(1) }),
          outputSchema: z.object({ echoed: z.string() }),
        },
        async ({ value }) => {
          toolCallCount += 1;
          return {
            content: [{ type: 'text', text: `http:${value}` }],
            structuredContent: { echoed: value },
          };
        },
      );
      return mcp;
    },
    { legacy: 'reject', keepAliveMs: 0 },
  );

  const server = createServer(async (request, response) => {
    requestCount += 1;
    try {
      const address = server.address() as AddressInfo | null;
      if (!address || request.url !== '/mcp') {
        response.statusCode = 404;
        response.end('Not found');
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
        else if (value !== undefined) headers.set(name, value);
      }
      const body = request.method === 'GET' || request.method === 'HEAD'
        ? undefined
        : await readRequestBody(request);
      const webRequest = new Request(`http://127.0.0.1:${address.port}${request.url}`, {
        method: request.method,
        headers,
        ...(body ? { body } : {}),
      });
      await writeResponse(await handler.fetch(webRequest), response);
    } catch (error) {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    handler,
    server,
    get requestCount() { return requestCount; },
    get toolCallCount() { return toolCallCount; },
  };
}

function connectionCount(server: HttpServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.getConnections((error, count) => error ? reject(error) : resolve(count));
  });
}

async function closeHttpFixture(fixture: ModernHttpFixture): Promise<void> {
  await fixture.handler.close();
  fixture.server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    fixture.server.close((error) => error ? reject(error) : resolve());
  });
}

async function check(name: string, test: () => Promise<void> | void): Promise<void> {
  await test();
  checks += 1;
  console.log(`ok - ${name}`);
}

try {
  await check('configuration is encrypted, masked, and can preserve masked secrets on update', () => {
    const original = normalizeMcpConfig('url', {
      url: 'https://mcp.example.test/service?tenant=private',
      headers: { 'X-Workspace-Key': 'header-secret' },
      auth: { type: 'bearer', token: 'bearer-secret' },
    });
    const stored = serializeMcpConfig(original);
    assert.match(stored, /^mcp:v1:/);
    assert.equal(stored.includes('header-secret'), false);
    assert.equal(stored.includes('bearer-secret'), false);
    const parsed = parseStoredMcpConfig(stored);
    assert.deepEqual(parsed, original);
    const masked = maskMcpConfig(original);
    assert.deepEqual(masked, {
      ...original,
      url: `https://mcp.example.test/service?${MCP_SECRET_PLACEHOLDER}`,
      headers: { 'X-Workspace-Key': MCP_SECRET_PLACEHOLDER },
      auth: { type: 'bearer', token: MCP_SECRET_PLACEHOLDER },
    });
    const updated = normalizeMcpConfig('url', masked, { previous: original });
    assert.deepEqual(updated, original);
  });

  await check('local execution approval is bound to the exact invocation', () => {
    const approved = normalizeMcpConfig(
      'stdio',
      { command: process.execPath, args: [modernFixture], env: { FIXTURE_TOKEN: 'secret' } },
      { localExecutionApproved: true },
    );
    assert.equal(hasValidExecutionApproval(approved), true);
    const changed = normalizeMcpConfig(
      'stdio',
      { command: process.execPath, args: [modernFixture, '--changed'], env: { FIXTURE_TOKEN: 'secret' } },
      { previous: approved, requireExecutionApproval: false },
    );
    assert.equal(hasValidExecutionApproval(changed), false);
  });

  await check('private and clear-text destinations require explicit opt-in', async () => {
    await assert.rejects(
      () => assertSafeMcpUrl(new URL('http://127.0.0.1:3000/mcp'), {}),
      /Clear-text MCP HTTP is disabled/,
    );
    await assert.rejects(
      () => assertSafeMcpUrl(new URL('https://127.0.0.1/mcp'), {}),
      /explicit private-network approval is required/,
    );
    await assert.doesNotReject(
      () => assertSafeMcpUrl(new URL('http://127.0.0.1:3000/mcp'), {
        allowPrivateNetwork: true,
        allowInsecureHttp: true,
      }),
    );
    await assert.rejects(
      () => assertSafeMcpUrl(new URL('https://[::ffff:127.0.0.1]/mcp'), {}),
      /explicit private-network approval is required/,
    );
    await assert.rejects(
      () => assertSafeMcpUrl(new URL('https://[64:ff9b::7f00:1]/mcp'), {}),
      /explicit private-network approval is required/,
    );
    await assert.rejects(
      () => assertSafeMcpUrl(new URL('https://169.254.169.254/latest/meta-data'), {
        allowPrivateNetwork: true,
      }),
      /forbidden address/,
    );
    await assert.rejects(
      () => assertSafeMcpUrl(new URL('https://[fe80::1]/mcp'), {
        allowPrivateNetwork: true,
      }),
      /forbidden address/,
    );
  });

  await check('provider tool names are stable, bounded, and collision-resistant', () => {
    const first = prefixToolName('server/name', 'tool with spaces/and:punctuation');
    const second = prefixToolName('server/name', 'tool-with-spaces/and:punctuation');
    assert.equal(first, prefixToolName('server/name', 'tool with spaces/and:punctuation'));
    assert.notEqual(first, second);
    assert.ok(first.length <= 64);
    assert.match(first, /^[A-Za-z0-9_-]+$/);
  });

  await check('real v2 stdio server negotiates the modern era and exposes all advertised surfaces', async () => {
    const config = normalizeMcpConfig(
      'stdio',
      { command: process.execPath, args: [modernFixture] },
      { localExecutionApproved: true },
    );
    const connection = await createAndConnectMcpClient(
      { transport: 'stdio', config, serverId: 'modern-fixture' },
      { userId: 'mcp-client-v2-test' },
    );
    try {
      assert.equal(connection.info.protocolEra, 'modern');
      assert.equal(connection.info.protocolVersion, '2026-07-28');
      assert.deepEqual(connection.info.serverInfo, { name: 'test-modern', version: '2.0.0' });
      assert.ok(connection.info.capabilities?.tools);
      assert.ok(connection.info.capabilities?.resources);
      assert.ok(connection.info.capabilities?.prompts);

      const tools = await listMcpTools(connection.client, 'fixture');
      assert.equal(tools.length, 1);
      assert.equal(tools[0].mcpToolName, 'echo-value');
      assert.ok(tools[0].outputSchema);
      assert.equal(tools[0].annotations?.readOnlyHint, true);
      await assert.rejects(
        () => callMcpToolDetailed(connection.client, 'echo-value', { value: 42 }),
        /Invalid arguments/,
      );
      const result = await callMcpToolDetailed(connection.client, 'echo-value', { value: 'hello' });
      assert.equal(result.isError, false);
      assert.deepEqual(result.structuredContent, { echoed: 'hello' });
      assert.match(result.output, /echo:hello/);

      const resources = await listMcpResources(connection.client);
      assert.equal(resources.resources[0]?.uri, 'fixture://readme');
      const resource = await readMcpResource(connection.client, 'fixture://readme');
      assert.equal(resource.contents[0]?.text, 'modern-resource');

      const prompts = await listMcpPrompts(connection.client);
      assert.equal(prompts.prompts[0]?.name, 'summarize-topic');
      const prompt = await getMcpPrompt(connection.client, 'summarize-topic', { topic: 'MCP' });
      assert.equal(prompt.messages[0]?.content.type, 'text');
      assert.match(prompt.messages[0]?.content.type === 'text' ? prompt.messages[0].content.text : '', /MCP/);
    } finally {
      await connection.close();
      await connection.close();
    }
  });

  await check('real v2 Streamable HTTP server negotiates modern MCP, calls tools, and closes cleanly', async () => {
    const fixture = await startModernHttpFixture();
    let connection: Awaited<ReturnType<typeof createAndConnectMcpClient>> | undefined;
    try {
      const config = normalizeMcpConfig('url', {
        url: fixture.url,
        allowPrivateNetwork: true,
        allowInsecureHttp: true,
      });
      connection = await createAndConnectMcpClient(
        { transport: 'url', config, serverId: 'modern-http-fixture' },
        { userId: 'mcp-client-v2-http-test' },
      );

      assert.equal(connection.info.transport, 'streamable-http');
      assert.equal(connection.info.protocolEra, 'modern');
      assert.equal(connection.info.protocolVersion, '2026-07-28');
      assert.deepEqual(connection.info.serverInfo, { name: 'test-modern-http', version: '2.0.0' });
      assert.ok(connection.info.capabilities?.tools);

      const tools = await listMcpTools(connection.client, 'http-fixture');
      assert.equal(tools.length, 1);
      assert.equal(tools[0]?.mcpToolName, 'http-echo');
      const result = await callMcpToolDetailed(connection.client, 'http-echo', { value: 'round-trip' });
      assert.equal(result.isError, false);
      assert.deepEqual(result.structuredContent, { echoed: 'round-trip' });
      assert.match(result.output, /http:round-trip/);
      assert.equal(fixture.toolCallCount, 1);
      assert.ok(fixture.requestCount >= 3, 'discover, tools/list, and tools/call must cross real HTTP');

      await connection.close();
      await connection.close();
      connection = undefined;
      assert.equal(await connectionCount(fixture.server), 0, 'HTTP dispatcher must release its socket');
    } finally {
      await connection?.close();
      await closeHttpFixture(fixture);
    }
  });

  await check('real v1 fixture remains available through bounded automatic legacy negotiation', async () => {
    const config = normalizeMcpConfig(
      'stdio',
      { command: process.execPath, args: [legacyFixture] },
      { localExecutionApproved: true },
    );
    const connection = await createAndConnectMcpClient(
      { transport: 'stdio', config, serverId: 'legacy-fixture' },
      { userId: 'mcp-client-v2-test' },
    );
    try {
      assert.equal(connection.info.protocolEra, 'legacy');
      const tools = await listMcpTools(connection.client, 'legacy');
      assert.equal(tools[0]?.mcpToolName, 'echo');
      const result = await callMcpToolDetailed(connection.client, 'echo', { text: 'compat' });
      assert.match(result.output, /echo:compat/);
    } finally {
      await connection.close();
    }
  });
} finally {
  if (previousBackendStdio === undefined) delete process.env.MCP_ALLOW_BACKEND_STDIO;
  else process.env.MCP_ALLOW_BACKEND_STDIO = previousBackendStdio;
  db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${testDbPath}${suffix}`, { force: true });
}

console.log(`MCP v2 client: ${checks} checks passed`);
