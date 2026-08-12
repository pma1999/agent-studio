import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-config-security-'));
process.env.DATABASE_PATH = path.join(testDirectory, 'test.db');
process.env.ENCRYPTION_KEY = `test-only-${crypto.randomBytes(48).toString('hex')}`;
process.env.MCP_ALLOW_BACKEND_STDIO = 'true';

const { default: db, migrate } = await import('../server/db.js');
const mcpServersRouter = (await import('../server/routes/mcpServers.js')).default;
const { exportRouter, importRouter } = await import('../server/routes/exportImport.js');
const {
  MCP_SECRET_PLACEHOLDER,
  hasValidExecutionApproval,
  isEncryptedMcpConfig,
  parseStoredMcpConfig,
  pendingMcpToolApprovalCount,
  requestMcpToolApproval,
  resolveMcpToolApproval,
} = await import('../server/mcp/index.js');
type McpServerConfig = import('../server/mcp/types.js').McpServerConfig;

migrate();

const suffix = crypto.randomUUID();
const userA = `mcp-security-a-${suffix}`;
const userB = `mcp-security-b-${suffix}`;
const userC = `mcp-security-c-${suffix}`;
for (const userId of [userA, userB, userC]) {
  db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)')
    .run(userId, `${userId}@example.test`, 'test');
}

// Per-call authorization nonces are one-shot, tenant-bound and fail closed.
let emittedApprovalId = '';
const approvalPromise = requestMcpToolApproval({
  userId: userA,
  conversationId: 'approval-conversation',
  request: {
    serverId: 'approval-server',
    exposedName: 'mcp_approval_server__write',
    toolName: 'write',
    arguments: { record: 'abc', value: 42 },
    annotations: { readOnlyHint: true },
    possibleCrossToolData: true,
  },
  emit: (event: { id: string; arguments_sha256: string }) => {
    emittedApprovalId = event.id;
    assert.match(event.arguments_sha256, /^[a-f0-9]{64}$/);
  },
});
assert.equal(pendingMcpToolApprovalCount(), 1);
assert.ok(emittedApprovalId.length >= 32);
assert.equal(resolveMcpToolApproval(emittedApprovalId, userB, true), 'not_found');
assert.equal(pendingMcpToolApprovalCount(), 1);
assert.equal(resolveMcpToolApproval(emittedApprovalId, userA, true), 'approved');
assert.equal(await approvalPromise, true);
assert.equal(resolveMcpToolApproval(emittedApprovalId, userA, true), 'not_found');
assert.equal(pendingMcpToolApprovalCount(), 0);

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((req: Request, _res: Response, next: NextFunction) => {
  (req as Request & { userId?: string }).userId = req.header('x-test-user') || undefined;
  next();
});
app.use('/api/mcp-servers', mcpServersRouter);
app.use('/api/export', exportRouter);
app.use('/api/import', importRouter);

const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve, reject) => {
  server.once('listening', resolve);
  server.once('error', reject);
});
const address = server.address();
assert.ok(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;

interface ApiResult {
  status: number;
  headers: Headers;
  body: Record<string, any>;
  text: string;
}

async function api(
  pathname: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    userId?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<ApiResult> {
  const response = await fetch(`${origin}${pathname}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      'x-test-user': options.userId ?? userA,
      ...(options.headers ?? {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) as Record<string, any> : {},
    text,
  };
}

function storedRow(id: string, userId = userA): { config: string } {
  return db.prepare('SELECT config FROM mcp_servers WHERE id = ? AND user_id = ?').get(id, userId) as { config: string };
}

function parsedStored(id: string, userId = userA): McpServerConfig {
  const parsed = parseStoredMcpConfig(storedRow(id, userId).config);
  assert.ok(parsed);
  return parsed;
}

try {
  const remoteSecrets = {
    header: `header-${crypto.randomUUID()}`,
    bearer: `bearer-${crypto.randomUUID()}`,
    query: `query-${crypto.randomUUID()}`,
    fragment: `fragment-${crypto.randomUUID()}`,
  };
  const createdRemote = await api('/api/mcp-servers', {
    method: 'POST',
    body: {
      name: 'Secure remote',
      transport: 'url',
      config: {
        url: `https://mcp.example.test/rpc?api_key=${remoteSecrets.query}#${remoteSecrets.fragment}`,
        headers: { 'X-API-Key': remoteSecrets.header },
        auth: { type: 'bearer', token: remoteSecrets.bearer },
      },
    },
  });
  assert.equal(createdRemote.status, 201, createdRemote.text);
  assert.match(createdRemote.headers.get('cache-control') ?? '', /no-store/);
  const remoteId = String(createdRemote.body.id);
  assert.equal(createdRemote.body.config.headers['X-API-Key'], MCP_SECRET_PLACEHOLDER);
  assert.equal(createdRemote.body.config.auth.token, MCP_SECRET_PLACEHOLDER);
  assert.match(createdRemote.body.config.url, new RegExp(MCP_SECRET_PLACEHOLDER));
  for (const secret of Object.values(remoteSecrets)) assert.doesNotMatch(createdRemote.text, new RegExp(secret));

  const remoteStored = storedRow(remoteId).config;
  assert.equal(isEncryptedMcpConfig(remoteStored), true);
  for (const secret of Object.values(remoteSecrets)) assert.doesNotMatch(remoteStored, new RegExp(secret));
  const remoteParsed = parsedStored(remoteId);
  assert.ok('url' in remoteParsed);
  assert.equal(remoteParsed.headers?.['X-API-Key'], remoteSecrets.header);
  assert.equal(remoteParsed.auth?.type, 'bearer');
  if (remoteParsed.auth?.type === 'bearer') assert.equal(remoteParsed.auth.token, remoteSecrets.bearer);
  assert.match(remoteParsed.url, new RegExp(remoteSecrets.query));

  // Echoing the masked representation preserves every secret, including URL
  // query/fragment values, without sending them back to the browser.
  const updatedRemote = await api(`/api/mcp-servers/${remoteId}`, {
    method: 'PUT',
    body: { name: 'Secure remote renamed', config: createdRemote.body.config },
  });
  assert.equal(updatedRemote.status, 200, updatedRemote.text);
  const updatedParsed = parsedStored(remoteId);
  assert.ok('url' in updatedParsed);
  assert.equal(updatedParsed.headers?.['X-API-Key'], remoteSecrets.header);
  assert.match(updatedParsed.url, new RegExp(remoteSecrets.query));

  // Plaintext legacy rows are masked on read and opportunistically encrypted.
  const legacyId = `legacy-${suffix}`;
  const legacySecret = `legacy-${crypto.randomUUID()}`;
  db.prepare('INSERT INTO mcp_servers (id, user_id, name, transport, config) VALUES (?, ?, ?, ?, ?)')
    .run(legacyId, userA, 'Legacy plaintext', 'url', JSON.stringify({
      url: 'https://legacy.example.test/mcp',
      headers: { 'X-Legacy-Key': legacySecret },
    }));
  const legacyRead = await api(`/api/mcp-servers/${legacyId}`);
  assert.equal(legacyRead.status, 200);
  assert.doesNotMatch(legacyRead.text, new RegExp(legacySecret));
  assert.equal(legacyRead.body.config.headers['X-Legacy-Key'], MCP_SECRET_PLACEHOLDER);
  assert.equal(isEncryptedMcpConfig(storedRow(legacyId).config), true);

  const fixturePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'fixtures',
    'mcp-echo-server.cjs',
  );
  const localEnvSecret = `local-env-${crypto.randomUUID()}`;
  const localConfig = {
    command: process.execPath,
    args: [fixturePath],
    env: { MCP_TEST_TOKEN: localEnvSecret },
  };
  const refusedLocal = await api('/api/mcp-servers', {
    method: 'POST',
    body: { name: 'Local echo refused', transport: 'stdio', config: localConfig },
  });
  assert.equal(refusedLocal.status, 400);
  assert.match(String(refusedLocal.body.error), /Explicit approval is required/);

  const createdLocal = await api('/api/mcp-servers', {
    method: 'POST',
    body: {
      name: 'Local echo',
      transport: 'stdio',
      config: localConfig,
      local_execution_approved: true,
    },
  });
  assert.equal(createdLocal.status, 201, createdLocal.text);
  const localId = String(createdLocal.body.id);
  const localParsed = parsedStored(localId);
  assert.ok('command' in localParsed);
  assert.equal(hasValidExecutionApproval(localParsed), true);
  assert.equal(createdLocal.body.config.executionApproval.fingerprint, 'approved');

  const unchangedLocal = await api(`/api/mcp-servers/${localId}`, {
    method: 'PUT',
    body: { name: 'Local echo renamed', config: createdLocal.body.config },
  });
  assert.equal(unchangedLocal.status, 200, unchangedLocal.text);
  const unchangedParsed = parsedStored(localId);
  assert.ok('command' in unchangedParsed);
  assert.equal(hasValidExecutionApproval(unchangedParsed), true);

  const changedConfig = { ...createdLocal.body.config, args: [...createdLocal.body.config.args, '--changed'] };
  const changedWithoutApproval = await api(`/api/mcp-servers/${localId}`, {
    method: 'PUT',
    body: { config: changedConfig },
  });
  assert.equal(changedWithoutApproval.status, 400);
  assert.match(String(changedWithoutApproval.body.error), /Explicit approval is required/);

  // The route uses the exact server id, reports negotiated legacy/modern state,
  // and only queries surfaces that the fixture advertised (tools, not prompts/resources).
  const connectionTest = await api(`/api/mcp-servers/${localId}/test`, { method: 'POST' });
  assert.equal(connectionTest.status, 200);
  assert.equal(connectionTest.body.ok, true, connectionTest.text);
  assert.equal(connectionTest.body.transport, 'stdio');
  assert.ok(connectionTest.body.protocolEra === 'legacy' || connectionTest.body.protocolEra === 'modern');
  assert.equal(typeof connectionTest.body.protocolVersion, 'string');
  assert.equal(connectionTest.body.counts.tools, 1);
  assert.ok(connectionTest.body.tools.some((tool: { name: string }) => tool.name === 'echo'));
  assert.equal('resources' in connectionTest.body, false);
  assert.equal('resourceTemplates' in connectionTest.body, false);
  assert.equal('prompts' in connectionTest.body, false);

  const maskedExport = await api('/api/export/mcp-servers');
  assert.equal(maskedExport.status, 200);
  assert.match(maskedExport.headers.get('cache-control') ?? '', /no-store/);
  for (const secret of Object.values(remoteSecrets)) assert.doesNotMatch(maskedExport.text, new RegExp(secret));
  assert.doesNotMatch(maskedExport.text, new RegExp(localEnvSecret));
  const exportedRemote = maskedExport.body.mcp_servers.find((entry: { id: string }) => entry.id === remoteId);
  assert.equal(exportedRemote.portability.state, 'redacted');
  assert.ok(exportedRemote.portability.redacted_fields.includes('config.url.query'));
  assert.ok(exportedRemote.portability.redacted_fields.includes('config.url.fragment'));
  assert.ok(exportedRemote.portability.redacted_fields.includes('config.headers.X-API-Key'));
  assert.ok(exportedRemote.portability.redacted_fields.includes('config.auth.token'));
  const exportedLocal = maskedExport.body.mcp_servers.find((entry: { id: string }) => entry.id === localId);
  assert.equal('executionApproval' in exportedLocal.config, false);
  assert.equal(exportedLocal.portability.state, 'redacted');
  assert.ok(exportedLocal.portability.redacted_fields.includes('config.env.MCP_TEST_TOKEN'));
  assert.ok(exportedLocal.portability.redacted_fields.includes('config.args.0'));
  assert.equal(exportedLocal.config.env.MCP_TEST_TOKEN, MCP_SECRET_PLACEHOLDER);
  assert.equal(exportedLocal.config.args[0], MCP_SECRET_PLACEHOLDER);

  const unconfirmedSecretExport = await api('/api/export/mcp-servers?include_secrets=true');
  assert.equal(unconfirmedSecretExport.status, 400);
  assert.match(String(unconfirmedSecretExport.body.error), /x-confirm-secret-export/);

  const secretExport = await api('/api/export/mcp-servers?include_secrets=true', {
    headers: { 'x-confirm-secret-export': 'include-secrets' },
  });
  assert.equal(secretExport.status, 200);
  assert.match(secretExport.text, new RegExp(remoteSecrets.header));
  assert.match(secretExport.text, new RegExp(remoteSecrets.bearer));
  assert.match(secretExport.text, new RegExp(remoteSecrets.query));
  assert.match(secretExport.text, new RegExp(localEnvSecret));
  const secretExportedLocal = secretExport.body.mcp_servers.find((entry: { id: string }) => entry.id === localId);
  assert.equal('executionApproval' in secretExportedLocal.config, false);
  assert.equal(secretExportedLocal.portability.state, 'local_approval_required');

  // Import encrypts every config and deliberately drops executable approval.
  const imported = await api('/api/import', {
    method: 'POST',
    userId: userB,
    body: secretExport.body,
  });
  assert.equal(imported.status, 200, imported.text);
  assert.equal(imported.body.created.mcp_servers, secretExport.body.mcp_servers.length);
  const importedRows = db.prepare('SELECT name, config FROM mcp_servers WHERE user_id = ? ORDER BY name').all(userB) as Array<{ name: string; config: string }>;
  assert.ok(importedRows.length > 0);
  assert.ok(importedRows.every((row) => isEncryptedMcpConfig(row.config)));
  const importedRemote = parseStoredMcpConfig(importedRows.find((row) => row.name === 'Secure remote renamed')?.config);
  assert.ok(importedRemote && 'url' in importedRemote);
  assert.equal(importedRemote.headers?.['X-API-Key'], remoteSecrets.header);
  assert.equal(importedRemote.auth?.type, 'bearer');
  const importedLocal = parseStoredMcpConfig(importedRows.find((row) => row.name === 'Local echo renamed')?.config);
  assert.ok(importedLocal && 'command' in importedLocal);
  assert.equal(importedLocal.env?.MCP_TEST_TOKEN, localEnvSecret);
  assert.equal(importedLocal.executionApproval, undefined);
  assert.ok(imported.body.requires_configuration.some((entry: { name: string; reason: string }) => (
    entry.name === 'Local echo renamed' && entry.reason === 'local_approval_required'
  )));

  // A default export is a portable, explicitly redacted draft. Import accepts
  // it without ever treating presentation placeholders as credentials. Remote
  // drafts are pinned to a blocked loopback URL; local drafts have no argv,
  // environment, working directory, or machine-bound execution approval.
  const importedMasked = await api('/api/import', {
    method: 'POST',
    userId: userC,
    body: maskedExport.body,
  });
  assert.equal(importedMasked.status, 200, importedMasked.text);
  assert.equal(importedMasked.body.created.mcp_servers, maskedExport.body.mcp_servers.length);
  assert.doesNotMatch(importedMasked.text, new RegExp(remoteSecrets.header));
  assert.doesNotMatch(importedMasked.text, new RegExp(remoteSecrets.bearer));
  assert.doesNotMatch(importedMasked.text, new RegExp(remoteSecrets.query));
  assert.doesNotMatch(importedMasked.text, new RegExp(localEnvSecret));
  assert.ok(importedMasked.body.requires_configuration.length >= 2);

  const maskedImportRows = db.prepare('SELECT name, config FROM mcp_servers WHERE user_id = ? ORDER BY name')
    .all(userC) as Array<{ name: string; config: string }>;
  assert.equal(maskedImportRows.length, maskedExport.body.mcp_servers.length);
  assert.ok(maskedImportRows.every((row) => isEncryptedMcpConfig(row.config)));
  const draftRemote = parseStoredMcpConfig(maskedImportRows.find((row) => row.name === '[Setup required] Secure remote renamed')?.config);
  assert.ok(draftRemote && 'url' in draftRemote);
  assert.equal(draftRemote.url, 'https://127.0.0.1/__agent_studio_mcp_import_requires_setup__');
  assert.equal(draftRemote.headers, undefined);
  assert.equal(draftRemote.auth, undefined);
  assert.equal(draftRemote.allowPrivateNetwork, undefined);
  assert.equal(draftRemote.allowInsecureHttp, undefined);

  const draftLocal = parseStoredMcpConfig(maskedImportRows.find((row) => row.name === '[Setup required] Local echo renamed')?.config);
  assert.ok(draftLocal && 'command' in draftLocal);
  assert.equal(draftLocal.command, process.execPath);
  assert.equal(draftLocal.args, undefined);
  assert.equal(draftLocal.env, undefined);
  assert.equal(draftLocal.cwd, undefined);
  assert.equal(draftLocal.executionApproval, undefined);
  assert.equal(hasValidExecutionApproval(draftLocal), false);
  for (const row of maskedImportRows) {
    const parsed = parseStoredMcpConfig(row.config);
    assert.ok(parsed);
    assert.doesNotMatch(JSON.stringify(parsed), new RegExp(MCP_SECRET_PLACEHOLDER));
    for (const secret of [...Object.values(remoteSecrets), localEnvSecret]) {
      assert.doesNotMatch(JSON.stringify(parsed), new RegExp(secret));
    }
  }

  // Legacy/forged payloads cannot relabel a presentation sentinel as a ready
  // credential, including when it is embedded in an opaque URL component.
  const forgedReadyPlaceholder = await api('/api/import', {
    method: 'POST',
    userId: userC,
    body: {
      version: 1,
      kind: 'mcp_servers',
      exported_at: new Date().toISOString(),
      mcp_servers: [{
        id: 'forged-ready-placeholder',
        name: 'Must not import',
        transport: 'url',
        config: { url: `https://mcp.example.test/rpc?token=${MCP_SECRET_PLACEHOLDER}` },
        portability: { state: 'ready', redacted_fields: [] },
      }],
    },
  });
  assert.equal(forgedReadyPlaceholder.status, 400);
  assert.match(String(forgedReadyPlaceholder.body.error), /explicitly redacted portability state/);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM mcp_servers WHERE user_id = ? AND name = ?')
    .get(userC, 'Must not import') as { count: number }).count, 0);

  // New writes fail closed when encryption becomes unavailable.
  const encryptionKey = process.env.ENCRYPTION_KEY;
  delete process.env.ENCRYPTION_KEY;
  const missingKey = await api('/api/mcp-servers', {
    method: 'POST',
    body: { name: 'Must not persist', transport: 'url', config: { url: 'https://no-key.example.test/mcp' } },
  });
  process.env.ENCRYPTION_KEY = encryptionKey;
  assert.equal(missingKey.status, 503);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM mcp_servers WHERE name = ?').get('Must not persist') as { count: number }).count, 0);

  const deleted = await api(`/api/mcp-servers/${localId}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.success, true);

  console.log('MCP configuration security and export/import tests passed');
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  fs.rmSync(testDirectory, { recursive: true, force: true });
}
