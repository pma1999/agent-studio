import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-runtime-integration-'));
process.env.DATABASE_PATH = path.join(testDirectory, 'test.db');
process.env.INITIAL_ADMIN_PASSWORD = 'mcp-runtime-test-only';
process.env.MCP_PROGRESSIVE_TOOL_THRESHOLD = '20';
process.env.MCP_PROGRESSIVE_SCHEMA_TOKEN_THRESHOLD = '3000';

const { SdkError, SdkErrorCode } = await import('@modelcontextprotocol/client');
const { default: db, migrate } = await import('../server/db.js');
const {
  estimateMcpCatalogTokens,
  getConversationToolOverride,
  isTransientMcpConnectionError,
  resolveToolsForAgent,
  resolveToolsFromIds,
  shouldUseProgressiveMcpDiscovery,
} = await import('../server/tools/resolve.js');
const { runTool } = await import('../server/tools/run.js');

type Client = import('@modelcontextprotocol/client').Client;
type McpConnection = import('../server/mcp/client.js').McpConnection;
type McpToolCatalogEntry = import('../server/tools/resolve.js').McpToolCatalogEntry;
type ResolvedTool = import('../server/tools/resolve.js').ResolvedTool;

migrate();

const userA = 'runtime-user-a';
const userB = 'runtime-user-b';
const toolA = 'runtime-tool-a';
const toolB = 'runtime-tool-b';
const serverB = 'runtime-server-b';
const agentA = 'runtime-agent-a';
const conversationA = 'runtime-conversation-a';

db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(userA, 'runtime-a@example.test', 'test');
db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(userB, 'runtime-b@example.test', 'test');
const insertTool = db.prepare(`
  INSERT INTO tools (id, user_id, name, description, parameters_schema, type)
  VALUES (?, ?, 'web_fetch', 'Fetch a URL', '{"type":"object"}', 'builtin')
`);
insertTool.run(toolA, userA);
insertTool.run(toolB, userB);
db.prepare(`
  INSERT INTO mcp_servers (id, user_id, name, transport, config)
  VALUES (?, ?, 'Foreign MCP', 'url', ?)
`).run(serverB, userB, JSON.stringify({ url: 'https://foreign.example.test/mcp' }));
db.prepare(`
  INSERT INTO agents (id, name, description, emoji, system_prompt, base_url, model, temperature, max_tokens, provider, user_id)
  VALUES (?, 'Runtime agent', '', 'R', 'sys', 'https://openrouter.ai/api/v1', 'openrouter/auto', 0.7, 4096, 'openrouter', ?)
`).run(agentA, userA);
db.prepare('INSERT INTO agent_tools (agent_id, tool_id) VALUES (?, ?)').run(agentA, toolA);
db.prepare('INSERT INTO agent_tools (agent_id, tool_id) VALUES (?, ?)').run(agentA, toolB);
db.prepare('INSERT INTO agent_mcp_servers (agent_id, mcp_server_id) VALUES (?, ?)').run(agentA, serverB);
db.prepare('INSERT INTO conversations (id, user_id, agent_id, title, tools_overridden) VALUES (?, ?, ?, ?, 1)')
  .run(conversationA, userA, agentA, 'Runtime');
db.prepare('INSERT INTO conversation_tools (conversation_id, tool_id) VALUES (?, ?)').run(conversationA, toolA);
db.prepare('INSERT INTO conversation_tools (conversation_id, tool_id) VALUES (?, ?)').run(conversationA, toolB);
db.prepare('INSERT INTO conversation_mcp_servers (conversation_id, mcp_server_id) VALUES (?, ?)').run(conversationA, serverB);

try {
  const explicitForeign = await resolveToolsFromIds([toolB], [serverB], userA);
  assert.deepEqual(explicitForeign.resolvedTools, []);
  assert.equal(explicitForeign.mcpClients.size, 0);

  const agentResolved = await resolveToolsForAgent(agentA, userA);
  assert.deepEqual(agentResolved.resolvedTools.map((tool) => tool.id), [toolA]);
  assert.equal(agentResolved.mcpClients.size, 0);

  assert.deepEqual(getConversationToolOverride(conversationA, userA), {
    tools_overridden: true,
    tool_ids: [toolA],
    mcp_server_ids: [],
  });
  assert.deepEqual(getConversationToolOverride(conversationA, userB), {
    tools_overridden: false,
    tool_ids: [],
    mcp_server_ids: [],
  });

  assert.equal(isTransientMcpConnectionError(new SdkError(SdkErrorCode.RequestTimeout, 'timeout')), true);
  assert.equal(isTransientMcpConnectionError(new SdkError(SdkErrorCode.InvalidResult, 'bad result')), false);
  assert.equal(isTransientMcpConnectionError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), true);
  assert.equal(isTransientMcpConnectionError(Object.assign(new Error('abort'), { name: 'AbortError' })), false);

  const catalogEntry = (overrides: Partial<McpToolCatalogEntry> = {}): McpToolCatalogEntry => ({
    serverId: 'server-1',
    serverName: 'Server One',
    name: 'mcp_server_1__echo',
    mcpToolName: 'echo',
    title: 'Echo',
    description: 'Echo text',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { echoed: { type: 'string' } } },
    annotations: { readOnlyHint: true },
    execution: { taskSupport: 'optional' },
    ...overrides,
  });
  assert.ok(estimateMcpCatalogTokens([catalogEntry()]) > 0);
  assert.equal(shouldUseProgressiveMcpDiscovery([catalogEntry()]), false);
  assert.equal(shouldUseProgressiveMcpDiscovery(Array.from({ length: 20 }, (_, index) => catalogEntry({ name: `tool_${index}` }))), true);
  assert.equal(shouldUseProgressiveMcpDiscovery([catalogEntry({ description: 'x'.repeat(13_000) })]), true);

  let observedRequest: unknown;
  let observedOptions: Record<string, unknown> | undefined;
  let progressObserved = false;
  const fakeClient = {
    listTools: async () => ({
      tools: [{
        name: 'echo',
        description: 'Echo text',
        inputSchema: catalogEntry().inputSchema,
        outputSchema: catalogEntry().outputSchema,
      }],
    }),
    callTool: async (request: unknown, options: Record<string, unknown>) => {
      observedRequest = request;
      observedOptions = options;
      const onprogress = options.onprogress as ((value: { progress: number; total: number; message: string }) => void) | undefined;
      onprogress?.({ progress: 1, total: 2, message: 'halfway' });
      return {
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: null,
      };
    },
  } as unknown as Client;
  const connection: McpConnection = {
    client: fakeClient,
    info: { protocolEra: 'modern', protocolVersion: '2026-07-28', transport: 'streamable-http' },
    close: async () => {},
  };
  const clients = new Map([['server-1', connection]]);
  const directTool: ResolvedTool = {
    id: 'direct-echo',
    name: 'mcp_server_1__echo',
    type: 'mcp',
    config: {
      mcp_server_id: 'server-1',
      mcp_tool_name: 'echo',
      outputSchema: catalogEntry().outputSchema,
      annotations: catalogEntry().annotations,
      execution: catalogEntry().execution,
    },
    openAIDef: {
      type: 'function',
      function: { name: 'mcp_server_1__echo', description: 'Echo', parameters: { type: 'object' } },
    },
  };
  const abortController = new AbortController();
  const blockedWithoutApproval = await runTool(
    [directTool],
    directTool.name,
    { text: 'blocked' },
    clients,
    userA,
    conversationA,
    [],
  );
  assert.equal(blockedWithoutApproval.isError, true);
  assert.match(blockedWithoutApproval.output, /explicit human approval/);
  assert.equal(observedRequest, undefined);

  const deniedByUser = await runTool(
    [directTool],
    directTool.name,
    { text: 'denied' },
    clients,
    userA,
    conversationA,
    [],
    { authorizeMcpCall: async () => false },
  );
  assert.equal(deniedByUser.isError, true);
  assert.match(deniedByUser.output, /not approved/);
  assert.equal(observedRequest, undefined);

  let authorizationRequest: Record<string, unknown> | undefined;
  const directResult = await runTool(
    [directTool],
    directTool.name,
    { text: 'hello' },
    clients,
    userA,
    conversationA,
    [],
    {
      authorizeMcpCall: async (request) => {
        authorizationRequest = request as unknown as Record<string, unknown>;
        return true;
      },
      mcpControl: {
        signal: abortController.signal,
        timeoutMs: 1_234,
        maxTotalTimeoutMs: 5_678,
        onProgress: () => { progressObserved = true; },
      },
    },
  );
  assert.equal(directResult.isError, false);
  assert.equal(authorizationRequest?.serverId, 'server-1');
  assert.equal(authorizationRequest?.toolName, 'echo');
  assert.deepEqual(authorizationRequest?.arguments, { text: 'hello' });
  assert.deepEqual(observedRequest, { name: 'echo', arguments: { text: 'hello' } });
  assert.equal(observedOptions?.signal, abortController.signal);
  assert.equal(observedOptions?.timeout, 1_234);
  assert.equal(observedOptions?.maxTotalTimeout, 5_678);
  assert.equal(progressObserved, true);
  assert.equal(directResult.metadata?.structuredContent, null);
  assert.deepEqual(directResult.metadata?.outputSchema, catalogEntry().outputSchema);

  const rawNameResult = await runTool([directTool], 'echo', {}, clients);
  assert.equal(rawNameResult.isError, true);
  assert.match(rawNameResult.output, /Unknown or disabled tool/);

  const duplicateNameResult = await runTool([directTool, { ...directTool, id: 'duplicate' }], directTool.name, {}, clients);
  assert.equal(duplicateNameResult.isError, true);
  assert.match(duplicateNameResult.output, /Ambiguous tool name/);

  const detailsTool: ResolvedTool = {
    id: 'meta-details',
    name: 'get_mcp_tool_details',
    type: 'mcp',
    config: { kind: 'mcp_details' },
    mcpCatalog: [catalogEntry()],
    openAIDef: {
      type: 'function',
      function: { name: 'get_mcp_tool_details', description: 'Details', parameters: { type: 'object' } },
    },
  };
  const detailsResult = await runTool([detailsTool], detailsTool.name, { name: catalogEntry().name }, clients);
  assert.equal(detailsResult.isError, false);
  const details = JSON.parse(detailsResult.output) as Record<string, unknown>;
  assert.deepEqual(details.output_schema, catalogEntry().outputSchema);
  assert.deepEqual(details.annotations, catalogEntry().annotations);
  assert.deepEqual(details.execution, catalogEntry().execution);

  const rawDetailsResult = await runTool([detailsTool], detailsTool.name, { name: 'echo' }, clients);
  assert.equal(rawDetailsResult.isError, true);

  const callMetaTool: ResolvedTool = {
    ...detailsTool,
    id: 'meta-call',
    name: 'call_mcp_tool',
    config: { kind: 'mcp_call' },
    openAIDef: {
      type: 'function',
      function: { name: 'call_mcp_tool', description: 'Call', parameters: { type: 'object' } },
    },
  };
  const rawMetaCall = await runTool([callMetaTool], callMetaTool.name, { name: 'echo', arguments: {} }, clients);
  assert.equal(rawMetaCall.isError, true);
  const invalidMetaArguments = await runTool(
    [callMetaTool],
    callMetaTool.name,
    { name: catalogEntry().name, arguments: [] },
    clients,
  );
  assert.equal(invalidMetaArguments.isError, true);
  const exactMetaCall = await runTool(
    [callMetaTool],
    callMetaTool.name,
    { name: catalogEntry().name, arguments: { text: 'from-meta' } },
    clients,
    userA,
    conversationA,
    [{ role: 'tool', content: 'untrusted upstream data' }],
    {
      authorizeMcpCall: async (request) => {
        assert.equal(request.possibleCrossToolData, true);
        assert.equal(request.toolName, 'echo');
        return true;
      },
    },
  );
  assert.equal(exactMetaCall.isError, false);
  assert.deepEqual(observedRequest, { name: 'echo', arguments: { text: 'from-meta' } });

  const oversizedDetailsTool = { ...detailsTool, mcpCatalog: [catalogEntry({ description: 'x'.repeat(70_000) })] };
  const oversizedResult = await runTool([oversizedDetailsTool], oversizedDetailsTool.name, { name: catalogEntry().name }, clients);
  assert.equal(oversizedResult.isError, true);
  assert.match(oversizedResult.output, /safe .*character limit/);

  console.log('PASS MCP runtime integration');
} finally {
  db.close();
  fs.rmSync(testDirectory, { recursive: true, force: true });
}
