import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tenant-isolation-'));
process.env.DATABASE_PATH = path.join(testDirectory, 'test.db');

const { default: db, migrate } = await import('../server/db.js');
const agentsRouter = (await import('../server/routes/agents.js')).default;
const conversationsRouter = (await import('../server/routes/conversations.js')).default;
const councilMembersRouter = (await import('../server/routes/councilMembers.js')).default;

migrate();

const suffix = crypto.randomUUID();
const userA = `tenant-a-${suffix}`;
const userB = `tenant-b-${suffix}`;
const toolA = `tool-a-${suffix}`;
const toolB = `tool-b-${suffix}`;
const mcpA = `mcp-a-${suffix}`;
const mcpB = `mcp-b-${suffix}`;

db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(userA, `${userA}@example.test`, 'test');
db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(userB, `${userB}@example.test`, 'test');
const insertTool = db.prepare(`
  INSERT INTO tools (id, user_id, name, description, parameters_schema, type)
  VALUES (?, ?, ?, ?, ?, 'builtin')
`);
insertTool.run(toolA, userA, `owned-tool-${suffix}`, 'Owned tool', '{}');
insertTool.run(toolB, userB, `foreign-tool-${suffix}`, 'Foreign tool', '{}');
const insertMcpServer = db.prepare(`
  INSERT INTO mcp_servers (id, user_id, name, transport, config)
  VALUES (?, ?, ?, 'url', ?)
`);
insertMcpServer.run(mcpA, userA, `owned-mcp-${suffix}`, JSON.stringify({ url: 'https://owned.example.test/mcp' }));
insertMcpServer.run(mcpB, userB, `foreign-mcp-${suffix}`, JSON.stringify({ url: 'https://foreign.example.test/mcp' }));

const app = express();
app.use(express.json());
app.use((req: Request, _res: Response, next: NextFunction) => {
  (req as Request & { userId?: string }).userId = req.header('x-test-user') || undefined;
  next();
});
app.use('/api/agents', agentsRouter);
app.use('/api/conversations', conversationsRouter);
app.use('/api/council', councilMembersRouter);

const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve, reject) => {
  server.once('listening', resolve);
  server.once('error', reject);
});
const address = server.address();
assert.ok(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;

async function api(
  pathname: string,
  method: 'GET' | 'POST' | 'PUT',
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> | Record<string, unknown>[] }> {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-test-user': userA,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown> | Record<string, unknown>[],
  };
}

function assertOwnershipError(result: Awaited<ReturnType<typeof api>>, field: 'tool_ids' | 'mcp_server_ids'): void {
  assert.equal(result.status, 400);
  assert.ok(!Array.isArray(result.body));
  assert.match(String(result.body.error), new RegExp(`${field}.*not owned by this user`));
}

function countRows(sql: string, value: string): number {
  return (db.prepare(sql).get(value) as { count: number }).count;
}

try {
  // Agent creation rejects foreign resources before the agent row is written.
  const invalidAgentTool = await api('/api/agents', 'POST', {
    name: `invalid-tool-agent-${suffix}`,
    system_prompt: 'test',
    tool_ids: [toolB],
    mcp_server_ids: [mcpA],
  });
  assertOwnershipError(invalidAgentTool, 'tool_ids');
  assert.equal(countRows('SELECT COUNT(*) AS count FROM agents WHERE name = ?', `invalid-tool-agent-${suffix}`), 0);

  const invalidAgentMcp = await api('/api/agents', 'POST', {
    name: `invalid-mcp-agent-${suffix}`,
    system_prompt: 'test',
    tool_ids: [toolA],
    mcp_server_ids: [mcpB],
  });
  assertOwnershipError(invalidAgentMcp, 'mcp_server_ids');
  assert.equal(countRows('SELECT COUNT(*) AS count FROM agents WHERE name = ?', `invalid-mcp-agent-${suffix}`), 0);

  const createdAgent = await api('/api/agents', 'POST', {
    name: `owned-agent-${suffix}`,
    system_prompt: 'test',
    tool_ids: [toolA, toolA],
    mcp_server_ids: [mcpA, mcpA],
  });
  assert.equal(createdAgent.status, 201);
  assert.ok(!Array.isArray(createdAgent.body));
  const agentId = String(createdAgent.body.id);
  assert.deepEqual(createdAgent.body.tool_ids, [toolA]);
  assert.deepEqual(createdAgent.body.mcp_server_ids, [mcpA]);

  const invalidAgentUpdate = await api(`/api/agents/${agentId}`, 'PUT', {
    name: `mutated-agent-${suffix}`,
    tool_ids: [toolA],
    mcp_server_ids: [mcpB],
  });
  assertOwnershipError(invalidAgentUpdate, 'mcp_server_ids');
  const unchangedAgent = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string };
  assert.equal(unchangedAgent.name, `owned-agent-${suffix}`);
  assert.deepEqual(
    (db.prepare('SELECT mcp_server_id FROM agent_mcp_servers WHERE agent_id = ?').all(agentId) as Array<{ mcp_server_id: string }>).map((row) => row.mcp_server_id),
    [mcpA],
  );

  // Legacy/corrupt cross-tenant links are filtered from both agent read forms.
  db.prepare('INSERT INTO agent_mcp_servers (agent_id, mcp_server_id) VALUES (?, ?)').run(agentId, mcpB);
  const fetchedAgent = await api(`/api/agents/${agentId}`, 'GET');
  assert.equal(fetchedAgent.status, 200);
  assert.ok(!Array.isArray(fetchedAgent.body));
  assert.deepEqual(fetchedAgent.body.mcp_server_ids, [mcpA]);
  assert.deepEqual((fetchedAgent.body.mcp_servers as Array<{ id: string }>).map((serverRow) => serverRow.id), [mcpA]);
  const listedAgents = await api('/api/agents', 'GET');
  assert.equal(listedAgents.status, 200);
  assert.ok(Array.isArray(listedAgents.body));
  const listedAgent = listedAgents.body.find((row) => row.id === agentId);
  assert.deepEqual(listedAgent?.mcp_server_ids, [mcpA]);

  // Conversation overrides validate both collections before replacing links.
  const conversationId = `conversation-${suffix}`;
  db.prepare('INSERT INTO conversations (id, user_id, agent_id, title) VALUES (?, ?, ?, ?)')
    .run(conversationId, userA, agentId, 'Tenant isolation');

  const invalidConversationTool = await api(`/api/conversations/${conversationId}/tool-config`, 'PUT', {
    tool_ids: [toolB],
    mcp_server_ids: [mcpA],
  });
  assertOwnershipError(invalidConversationTool, 'tool_ids');
  const untouchedConversation = db.prepare('SELECT tools_overridden FROM conversations WHERE id = ?').get(conversationId) as { tools_overridden: number };
  assert.equal(untouchedConversation.tools_overridden, 0);
  assert.equal(countRows('SELECT COUNT(*) AS count FROM conversation_tools WHERE conversation_id = ?', conversationId), 0);

  const invalidConversationMcp = await api(`/api/conversations/${conversationId}/tool-config`, 'PUT', {
    tool_ids: [toolA],
    mcp_server_ids: [mcpB],
  });
  assertOwnershipError(invalidConversationMcp, 'mcp_server_ids');
  assert.equal(countRows('SELECT COUNT(*) AS count FROM conversation_tools WHERE conversation_id = ?', conversationId), 0);

  const validConversation = await api(`/api/conversations/${conversationId}/tool-config`, 'PUT', {
    tool_ids: [toolA, toolA],
    mcp_server_ids: [mcpA, mcpA],
  });
  assert.equal(validConversation.status, 200);
  assert.ok(!Array.isArray(validConversation.body));
  assert.deepEqual(validConversation.body.tool_ids, [toolA]);
  assert.deepEqual(validConversation.body.mcp_server_ids, [mcpA]);

  const rejectedReplacement = await api(`/api/conversations/${conversationId}/tool-config`, 'PUT', {
    tool_ids: [],
    mcp_server_ids: [mcpB],
  });
  assertOwnershipError(rejectedReplacement, 'mcp_server_ids');
  assert.deepEqual(
    (db.prepare('SELECT tool_id FROM conversation_tools WHERE conversation_id = ?').all(conversationId) as Array<{ tool_id: string }>).map((row) => row.tool_id),
    [toolA],
  );
  assert.deepEqual(
    (db.prepare('SELECT mcp_server_id FROM conversation_mcp_servers WHERE conversation_id = ?').all(conversationId) as Array<{ mcp_server_id: string }>).map((row) => row.mcp_server_id),
    [mcpA],
  );

  // Council JSON fields receive the same ownership gate and stable de-duplication.
  const invalidCouncilTool = await api('/api/council/members', 'POST', {
    name: `invalid-tool-council-${suffix}`,
    member_models: ['openrouter/auto', 'anthropic/claude-sonnet-4'],
    tool_ids: [toolB],
    mcp_server_ids: [mcpA],
  });
  assertOwnershipError(invalidCouncilTool, 'tool_ids');
  assert.equal(countRows('SELECT COUNT(*) AS count FROM council_members WHERE name = ?', `invalid-tool-council-${suffix}`), 0);

  const invalidCouncilMcp = await api('/api/council/members', 'POST', {
    name: `invalid-mcp-council-${suffix}`,
    member_models: ['openrouter/auto', 'anthropic/claude-sonnet-4'],
    tool_ids: [toolA],
    mcp_server_ids: [mcpB],
  });
  assertOwnershipError(invalidCouncilMcp, 'mcp_server_ids');
  assert.equal(countRows('SELECT COUNT(*) AS count FROM council_members WHERE name = ?', `invalid-mcp-council-${suffix}`), 0);

  const createdCouncil = await api('/api/council/members', 'POST', {
    name: `owned-council-${suffix}`,
    member_models: ['openrouter/auto', 'anthropic/claude-sonnet-4'],
    tool_ids: [toolA, toolA],
    mcp_server_ids: [mcpA, mcpA],
  });
  assert.equal(createdCouncil.status, 201);
  assert.ok(!Array.isArray(createdCouncil.body));
  const councilId = String(createdCouncil.body.id);
  assert.deepEqual(createdCouncil.body.tool_ids, [toolA]);
  assert.deepEqual(createdCouncil.body.mcp_server_ids, [mcpA]);

  const invalidCouncilUpdate = await api(`/api/council/members/${councilId}`, 'PUT', {
    name: `mutated-council-${suffix}`,
    tool_ids: [toolA],
    mcp_server_ids: [mcpB],
  });
  assertOwnershipError(invalidCouncilUpdate, 'mcp_server_ids');
  const unchangedCouncil = db.prepare('SELECT name, tool_ids, mcp_server_ids FROM council_members WHERE id = ?').get(councilId) as {
    name: string;
    tool_ids: string;
    mcp_server_ids: string;
  };
  assert.equal(unchangedCouncil.name, `owned-council-${suffix}`);
  assert.deepEqual(JSON.parse(unchangedCouncil.tool_ids), [toolA]);
  assert.deepEqual(JSON.parse(unchangedCouncil.mcp_server_ids), [mcpA]);

  console.log('MCP tenant isolation regression tests passed');
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  fs.rmSync(testDirectory, { recursive: true, force: true });
}
