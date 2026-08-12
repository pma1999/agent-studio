/**
 * Resolve which tools an agent can use and return them in OpenRouter/OpenAI format.
 * Only returns tools that are properly configured and ready to run.
 * Includes tools from the tools table (builtin, http) and from MCP servers linked to the agent.
 */

import db from '../db.js';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import { getSettingValue } from '../routes/settings.js';
import { isAgentConnected } from '../agentRelay/registry.js';
import { getBuiltinDefinition, getBuiltinExecutor } from './registry.js';
import { buildRunCommandDisclosure, isRunCommandUsable } from './execCommand.js';
import {
  createAndConnectMcpClient,
  listMcpTools,
  parseStoredMcpConfig,
  type McpConnection,
  type McpToolDef,
} from '../mcp/index.js';
import type { McpTransport } from '../mcp/types.js';
import type { ResolvedSkill } from '../skills/resolve.js';

export interface ResolvedToolMcpConfig {
  mcp_server_id: string;
  mcp_server_name?: string;
  mcp_tool_name: string;
  annotations?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  execution?: Record<string, unknown>;
}

export interface McpToolCatalogEntry {
  serverId: string;
  serverName: string;
  name: string;
  mcpToolName: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  execution?: Record<string, unknown>;
}

export interface ResolvedToolMcpMetaConfig {
  kind: 'mcp_search' | 'mcp_details' | 'mcp_call';
}

export interface ResolvedTool {
  id: string;
  name: string;
  type: 'builtin' | 'http' | 'mcp' | 'skill';
  config: unknown;
  mcpCatalog?: McpToolCatalogEntry[];
  skillCatalog?: ResolvedSkill[];
  openAIDef: {
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  };
}

export interface ToolRow {
  id: string;
  name: string;
  description: string;
  parameters_schema: string;
  type: string;
  config: string | null;
}

/**
 * Build a safe prefix slug from MCP server name and id for tool names.
 * Ensures uniqueness when multiple servers have the same name.
 */
export function slugFromServerName(serverName: string, serverId: string): string {
  const slug = (serverName || 'mcp')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .toLowerCase()
    .slice(0, 24) || 'mcp';
  const shortId = serverId.replace(/[^a-z0-9]/gi, '').slice(0, 6);
  return shortId ? `${slug}_${shortId}` : slug;
}

function isUsable(t: ToolRow, userId: string): boolean {
  if (t.type === 'builtin') {
    const def = getBuiltinDefinition(t.name);
    const executor = getBuiltinExecutor(t.name);
    if (!def || !executor) return false;
    if (t.name === 'web_search') {
      const key = userId ? getSettingValue(userId, 'search_api_key') : '';
      return !!key?.trim();
    }
    if (t.name === 'run_command') return isAgentConnected(userId) || isRunCommandUsable(userId);
    if (['read_file', 'write_file', 'edit_file', 'delete_file', 'list_directory', 'send_file'].includes(t.name)) {
      return isAgentConnected(userId);
    }
    if (t.name === 'web_fetch') return true;
    return true;
  }
  if (t.type === 'http') {
    let config: { url?: string } = {};
    try {
      config = t.config ? JSON.parse(t.config) : {};
    } catch {
      return false;
    }
    return !!config.url?.trim();
  }
  return false;
}

export function buildResolvedBuiltinTool(row: ToolRow, userId: string): ResolvedTool | null {
  const def = getBuiltinDefinition(row.name);
  if (!def) return null;
  const disclosure = row.name === 'run_command' ? buildRunCommandDisclosure(userId) : '';
  const description = disclosure
    ? `${def.function.description}\n\n${disclosure}`
    : def.function.description;
  return {
    id: row.id,
    name: row.name,
    type: 'builtin',
    config: row.config ? tryParse(row.config) : undefined,
    openAIDef: {
      type: 'function',
      function: {
        name: def.function.name,
        description,
        parameters: def.function.parameters,
      },
    },
  };
}

export interface ResolveToolsResult {
  resolvedTools: ResolvedTool[];
  mcpClients: Map<string, McpConnection>;
}

interface McpServerRowForConnect {
  id: string;
  name: string;
  transport: string;
  config: string;
}

interface ConnectedMcpServer {
  serverRow: McpServerRowForConnect;
  connection: McpConnection;
  tools: McpToolDef[];
}

const TRANSIENT_NODE_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
]);

const TRANSIENT_SDK_ERROR_CODES = new Set<SdkErrorCode>([
  SdkErrorCode.RequestTimeout,
  SdkErrorCode.ConnectionClosed,
  SdkErrorCode.SendFailed,
]);

/** True only for failures where opening a fresh connection can reasonably recover. */
export function isTransientMcpConnectionError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return false;
  if (SdkError.isInstance(error)) return TRANSIENT_SDK_ERROR_CODES.has(error.code);
  if (!error || typeof error !== 'object') return false;

  const candidate = error as { code?: unknown; status?: unknown; cause?: unknown };
  if (typeof candidate.code === 'string' && TRANSIENT_NODE_ERROR_CODES.has(candidate.code)) return true;
  if (typeof candidate.status === 'number') {
    return candidate.status === 408 || candidate.status === 425 || candidate.status === 429 || candidate.status >= 500;
  }
  return candidate.cause !== undefined && candidate.cause !== error
    ? isTransientMcpConnectionError(candidate.cause)
    : false;
}

function positiveIntegerEnv(name: string, fallback: number, maximum: number): number {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

const MCP_CONNECT_CONCURRENCY = positiveIntegerEnv('MCP_CONNECT_CONCURRENCY', 4, 8);
const MCP_CONNECT_RETRY_DELAY_MS = positiveIntegerEnv('MCP_CONNECT_RETRY_DELAY_MS', 300, 5_000);
const PROGRESSIVE_MCP_TOOL_THRESHOLD = positiveIntegerEnv('MCP_PROGRESSIVE_TOOL_THRESHOLD', 20, 10_000);
const PROGRESSIVE_MCP_SCHEMA_TOKEN_THRESHOLD = positiveIntegerEnv('MCP_PROGRESSIVE_SCHEMA_TOKEN_THRESHOLD', 3_000, 1_000_000);
const MAX_EXPLICIT_TOOL_IDS = 200;
const MAX_EXPLICIT_MCP_SERVER_IDS = 50;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeErrorSummary(error: unknown): string {
  const candidate = error && typeof error === 'object'
    ? error as { name?: unknown; message?: unknown; code?: unknown; status?: unknown }
    : null;
  const name = typeof candidate?.name === 'string' ? candidate.name : 'Error';
  const code = typeof candidate?.code === 'string' ? ` code=${candidate.code}` : '';
  const status = typeof candidate?.status === 'number' ? ` status=${candidate.status}` : '';
  const rawMessage = typeof candidate?.message === 'string' ? candidate.message : String(error);
  const message = rawMessage
    .replace(/([?&](?:access_token|api_key|key|secret|token)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(authorization|client_secret|password)\s*[:=]\s*[^,;\s]+/gi, '$1=[redacted]')
    .slice(0, 1_000);
  return `${name}${code}${status}: ${message}`;
}

/**
 * Load the mcp_servers row, decrypt/parse the config, connect an MCP client,
 * and compute the tool name prefix. One retry is allowed only for a failure
 * classified as transient.
 * Returns null when the server is skipped (bad config, unknown transport,
 * offline local agent, or connection failure) — callers then just continue.
 */
async function connectMcpServer(
  serverRow: McpServerRowForConnect,
  userId: string
): Promise<{ connection: McpConnection; slug: string; namePrefix: string } | null> {
  const config = parseStoredMcpConfig(serverRow.config);
  if (!config) {
    console.error(`[resolve] Invalid MCP server config for ${serverRow.id}`);
    return null;
  }

  const transport = serverRow.transport as McpTransport;
  if (transport !== 'url' && transport !== 'stdio' && transport !== 'relay') {
    console.error(`[resolve] Unknown MCP transport for ${serverRow.id}: ${transport}`);
    return null;
  }

  // Relay-hosted servers run on the user's own PC: hide their tools while the
  // local agent is offline.
  if (transport === 'relay' && !isAgentConnected(userId)) {
    console.log(`[resolve] Skipping relay MCP server ${serverRow.name} (${serverRow.id}): local agent is not connected`);
    return null;
  }

  // A fresh connection is retried once only for timeout/closed/network failures.
  let connection: McpConnection | null = null;
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      connection = await createAndConnectMcpClient({ transport, config, serverId: serverRow.id }, { userId });
      break;
    } catch (err) {
      if (attempt < 1 && isTransientMcpConnectionError(err)) {
        console.warn(`[resolve] Transient MCP connection failure for ${serverRow.name}; retrying once`);
        await delay(MCP_CONNECT_RETRY_DELAY_MS);
      } else {
        console.error(`[resolve] Failed to connect to MCP server ${serverRow.name} (${serverRow.id}): ${safeErrorSummary(err)}`);
        break;
      }
    }
  }
  if (!connection) return null;

  const slug = slugFromServerName(serverRow.name, serverRow.id);
  const namePrefix = `mcp_${slug}`;
  return { connection, slug, namePrefix };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

async function connectAndListMcpServers(
  serverRows: readonly McpServerRowForConnect[],
  userId: string
): Promise<ConnectedMcpServer[]> {
  const outcomes = await mapWithConcurrency(serverRows, MCP_CONNECT_CONCURRENCY, async (serverRow) => {
    const connected = await connectMcpServer(serverRow, userId);
    if (!connected) return null;
    try {
      const tools = await listMcpTools(connected.connection.client, connected.namePrefix);
      return { serverRow, connection: connected.connection, tools } satisfies ConnectedMcpServer;
    } catch (error) {
      await connected.connection.close().catch((closeError) => {
        console.error(`[resolve] Failed to close MCP server ${serverRow.name} after list failure: ${safeErrorSummary(closeError)}`);
      });
      console.error(`[resolve] Failed to list tools from MCP server ${serverRow.name} (${serverRow.id}): ${safeErrorSummary(error)}`);
      return null;
    }
  });
  return outcomes.filter((outcome): outcome is ConnectedMcpServer => outcome !== null);
}

function allocateProviderFacingName(baseName: string, serverId: string, occupied: Set<string>): string {
  if (!occupied.has(baseName)) {
    occupied.add(baseName);
    return baseName;
  }
  const stableSuffix = serverId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 8) || 'server';
  let sequence = 1;
  while (true) {
    const suffix = `__${stableSuffix}${sequence === 1 ? '' : `_${sequence}`}`;
    const candidate = `${baseName.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
    if (!occupied.has(candidate)) {
      occupied.add(candidate);
      return candidate;
    }
    sequence++;
  }
}

async function appendConnectedMcpServers(
  connectedServers: readonly ConnectedMcpServer[],
  resolved: ResolvedTool[],
  catalog: McpToolCatalogEntry[],
  clients: Map<string, McpConnection>
): Promise<void> {
  const occupiedNames = new Set(resolved.map((tool) => tool.name));
  for (const connected of connectedServers) {
    const { serverRow, connection, tools } = connected;
    const existing = clients.get(serverRow.id);
    if (existing) {
      await connection.close().catch((error) => console.error(`[resolve] Duplicate MCP connection close failed: ${safeErrorSummary(error)}`));
      continue;
    }

    for (const tool of tools) {
      const exposedName = allocateProviderFacingName(tool.name, serverRow.id, occupiedNames);
      const openAIDef = exposedName === tool.name
        ? tool.openAIDef
        : {
            ...tool.openAIDef,
            function: {
              ...tool.openAIDef.function,
              name: exposedName,
              description: `${tool.description} Call it only by its exact exposed name: ${exposedName}.`,
            },
          };
      catalog.push({
        serverId: serverRow.id,
        serverName: serverRow.name,
        name: exposedName,
        mcpToolName: tool.mcpToolName,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
        execution: tool.execution,
      });
      resolved.push({
        id: `mcp_${serverRow.id}_${tool.mcpToolName}`,
        name: exposedName,
        type: 'mcp',
        config: {
          mcp_server_id: serverRow.id,
          mcp_server_name: serverRow.name,
          mcp_tool_name: tool.mcpToolName,
          annotations: tool.annotations,
          outputSchema: tool.outputSchema,
          execution: tool.execution,
        } satisfies ResolvedToolMcpConfig,
        openAIDef,
      });
    }
    clients.set(serverRow.id, connection);
  }
}

/** Conservative four-characters-per-token estimate for catalog definitions. */
export function estimateMcpCatalogTokens(catalog: readonly McpToolCatalogEntry[]): number {
  try {
    return Math.ceil(JSON.stringify(catalog.map((entry) => ({
      name: entry.name,
      description: entry.description,
      inputSchema: entry.inputSchema,
      outputSchema: entry.outputSchema,
      annotations: entry.annotations,
      execution: entry.execution,
    }))).length / 4);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function shouldUseProgressiveMcpDiscovery(catalog: readonly McpToolCatalogEntry[]): boolean {
  return catalog.length >= PROGRESSIVE_MCP_TOOL_THRESHOLD
    || estimateMcpCatalogTokens(catalog) >= PROGRESSIVE_MCP_SCHEMA_TOKEN_THRESHOLD;
}

function allocateUniqueToolName(baseName: string, occupied: Set<string>): string {
  let candidate = baseName;
  let suffix = 2;
  while (occupied.has(candidate)) candidate = `${baseName}_${suffix++}`;
  occupied.add(candidate);
  return candidate;
}

function buildMcpMetaTools(catalog: McpToolCatalogEntry[], occupiedNames: Iterable<string>): ResolvedTool[] {
  const commonCatalog = catalog;
  const occupied = new Set(occupiedNames);
  const searchName = allocateUniqueToolName('search_mcp_tools', occupied);
  const detailsName = allocateUniqueToolName('get_mcp_tool_details', occupied);
  const callName = allocateUniqueToolName('call_mcp_tool', occupied);
  return [
    {
      id: `mcp_meta_search_tools_${searchName}`,
      name: searchName,
      type: 'mcp',
      config: { kind: 'mcp_search' } as ResolvedToolMcpMetaConfig,
      mcpCatalog: commonCatalog,
      openAIDef: {
        type: 'function',
        function: {
          name: searchName,
          description: `Search available MCP tools by natural-language query. Returns concise matches; call ${detailsName} before executing a tool.`,
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Capability or task to search for.' },
              server_id: { type: 'string', description: 'Optional MCP server id to limit the search.' },
              limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum matches to return.' },
            },
            required: ['query'],
          },
        },
      },
    },
    {
      id: `mcp_meta_get_tool_details_${detailsName}`,
      name: detailsName,
      type: 'mcp',
      config: { kind: 'mcp_details' } as ResolvedToolMcpMetaConfig,
      mcpCatalog: commonCatalog,
      openAIDef: {
        type: 'function',
        function: {
          name: detailsName,
          description: `Fetch the full schemas and safety metadata for one MCP tool found by ${searchName}.`,
          parameters: {
            type: 'object',
            properties: { name: { type: 'string', description: 'Exact exposed MCP tool name.' } },
            required: ['name'],
          },
        },
      },
    },
    {
      id: `mcp_meta_call_tool_${callName}`,
      name: callName,
      type: 'mcp',
      config: { kind: 'mcp_call' } as ResolvedToolMcpMetaConfig,
      mcpCatalog: commonCatalog,
      openAIDef: {
        type: 'function',
        function: {
          name: callName,
          description: 'Execute an MCP tool by exact exposed name after inspecting it. Use this stable broker tool for MCP calls.',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Exact exposed MCP tool name.' },
              arguments: { type: 'object', description: 'Arguments matching the inspected MCP tool input schema.', additionalProperties: true },
            },
            required: ['name', 'arguments'],
          },
        },
      },
    },
  ];
}

/**
 * Load all tools assigned to the agent (builtin, http, and from linked MCP servers)
 * and return only those that are usable, in OpenRouter format.
 * MCP clients are connected and must be closed by the caller when done.
 */
export async function resolveToolsForAgent(agentId: string, userId: string): Promise<ResolveToolsResult> {
  const resolved: ResolvedTool[] = [];
  const mcpClients = new Map<string, McpConnection>();
  const mcpCatalog: McpToolCatalogEntry[] = [];

  // The agent and every assigned capability must belong to the same tenant.
  const rows = db.prepare(`
    SELECT DISTINCT t.id, t.name, t.description, t.parameters_schema, t.type, t.config
    FROM tools t
    INNER JOIN agent_tools at ON at.tool_id = t.id
    INNER JOIN agents a ON a.id = at.agent_id
    WHERE at.agent_id = ? AND a.user_id = ? AND t.user_id = ?
  `).all(agentId, userId, userId) as ToolRow[];

  for (const row of rows) {
    if (!isUsable(row, userId)) continue;

    let parameters: Record<string, unknown>;
    try {
      parameters = JSON.parse(row.parameters_schema);
    } catch {
      continue;
    }

    if (row.type === 'builtin') {
      const builtin = buildResolvedBuiltinTool(row, userId);
      if (!builtin) continue;
      resolved.push(builtin);
    } else {
      resolved.push({
        id: row.id,
        name: row.name,
        type: 'http',
        config: row.config ? tryParse(row.config) : undefined,
        openAIDef: {
          type: 'function',
          function: {
            name: row.name,
            description: row.description,
            parameters: { type: 'object', properties: parameters?.properties || {}, required: parameters?.required || [] },
          },
        },
      });
    }
  }

  const serverRows = db.prepare(`
    SELECT DISTINCT ms.id, ms.name, ms.transport, ms.config
    FROM mcp_servers ms
    INNER JOIN agent_mcp_servers ams ON ams.mcp_server_id = ms.id
    INNER JOIN agents a ON a.id = ams.agent_id
    WHERE ams.agent_id = ? AND a.user_id = ? AND ms.user_id = ?
    ORDER BY ms.id
  `).all(agentId, userId, userId) as McpServerRowForConnect[];
  const connectedServers = await connectAndListMcpServers(serverRows, userId);
  await appendConnectedMcpServers(connectedServers, resolved, mcpCatalog, mcpClients);

  if (shouldUseProgressiveMcpDiscovery(mcpCatalog)) {
    const nonMcpTools = resolved.filter((tool) => tool.type !== 'mcp');
    const occupied = nonMcpTools.map((tool) => tool.name);
    return { resolvedTools: [...nonMcpTools, ...buildMcpMetaTools(mcpCatalog, occupied)], mcpClients };
  }

  return { resolvedTools: resolved, mcpClients };
}

export interface ResolveToolsFromIdsOptions {
  /** Reserved for backwards-compatible call sites. Tenant scoping can never be disabled. */
  readonly tenantScopeCannotBeDisabled?: true;
}

/**
 * Resolve tools and MCP servers by explicit IDs (for general chat or council merge).
 * Always resolves only records owned by the authenticated user.
 * MCP clients are connected and must be closed by the caller when done.
 */
export async function resolveToolsFromIds(
  toolIds: string[],
  mcpServerIds: string[],
  userId: string,
  _options?: ResolveToolsFromIdsOptions
): Promise<ResolveToolsResult> {
  const resolved: ResolvedTool[] = [];
  const mcpClients = new Map<string, McpConnection>();
  const mcpCatalog: McpToolCatalogEntry[] = [];
  const ownedToolIds = [...new Set(toolIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    .slice(0, MAX_EXPLICIT_TOOL_IDS);
  const ownedMcpServerIds = [...new Set(mcpServerIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    .slice(0, MAX_EXPLICIT_MCP_SERVER_IDS);

  if (ownedToolIds.length > 0) {
    const placeholders = ownedToolIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT id, name, description, parameters_schema, type, config
      FROM tools
      WHERE id IN (${placeholders}) AND user_id = ?
      ORDER BY id
    `).all(...ownedToolIds, userId) as ToolRow[];

    for (const row of rows) {
      if (!isUsable(row, userId)) continue;

      let parameters: Record<string, unknown>;
      try {
        parameters = JSON.parse(row.parameters_schema);
      } catch {
        continue;
      }

      if (row.type === 'builtin') {
        const builtin = buildResolvedBuiltinTool(row, userId);
        if (!builtin) continue;
        resolved.push(builtin);
      } else {
        resolved.push({
          id: row.id,
          name: row.name,
          type: 'http',
          config: row.config ? tryParse(row.config) : undefined,
          openAIDef: {
            type: 'function',
            function: {
              name: row.name,
              description: row.description,
              parameters: { type: 'object', properties: parameters?.properties || {}, required: parameters?.required || [] },
            },
          },
        });
      }
    }
  }

  const serverRows = ownedMcpServerIds.length > 0
    ? db.prepare(`
        SELECT id, name, transport, config
        FROM mcp_servers
        WHERE id IN (${ownedMcpServerIds.map(() => '?').join(',')}) AND user_id = ?
        ORDER BY id
      `).all(...ownedMcpServerIds, userId) as McpServerRowForConnect[]
    : [];
  const connectedServers = await connectAndListMcpServers(serverRows, userId);
  await appendConnectedMcpServers(connectedServers, resolved, mcpCatalog, mcpClients);

  if (shouldUseProgressiveMcpDiscovery(mcpCatalog)) {
    const nonMcpTools = resolved.filter((tool) => tool.type !== 'mcp');
    const occupied = nonMcpTools.map((tool) => tool.name);
    return { resolvedTools: [...nonMcpTools, ...buildMcpMetaTools(mcpCatalog, occupied)], mcpClients };
  }

  return { resolvedTools: resolved, mcpClients };
}

export interface ConversationToolOverride {
  tools_overridden: boolean;
  tool_ids: string[];
  mcp_server_ids: string[];
}

/**
 * Reads conversations.tools_overridden + conversation_tools + conversation_mcp_servers for one conversation.
 * Always returns a value (never null) — { tools_overridden: false, tool_ids: [], mcp_server_ids: [] } when no
 * override row/flag is set, so callers never need a null-check.
 */
export function getConversationToolOverride(conversationId: string, userId: string): ConversationToolOverride {
  const row = db.prepare('SELECT tools_overridden FROM conversations WHERE id = ? AND user_id = ?').get(conversationId, userId) as
    | { tools_overridden: number }
    | undefined;
  if (!row) return { tools_overridden: false, tool_ids: [], mcp_server_ids: [] };
  const tools_overridden = !!row?.tools_overridden;
  const toolLinks = db.prepare(`
    SELECT DISTINCT ct.tool_id
    FROM conversation_tools ct
    INNER JOIN tools t ON t.id = ct.tool_id
    WHERE ct.conversation_id = ? AND t.user_id = ?
  `).all(conversationId, userId) as { tool_id: string }[];
  const mcpLinks = db.prepare(`
    SELECT DISTINCT cms.mcp_server_id
    FROM conversation_mcp_servers cms
    INNER JOIN mcp_servers ms ON ms.id = cms.mcp_server_id
    WHERE cms.conversation_id = ? AND ms.user_id = ?
  `).all(conversationId, userId) as { mcp_server_id: string }[];
  return {
    tools_overridden,
    tool_ids: toolLinks.map((l) => l.tool_id),
    mcp_server_ids: mcpLinks.map((l) => l.mcp_server_id),
  };
}

export type ToolResolutionSource =
  | { kind: 'conversation-override'; tool_ids: string[]; mcp_server_ids: string[] }
  | { kind: 'general-settings'; tool_ids: string[]; mcp_server_ids: string[] }
  | { kind: 'agent-default' };

/**
 * Pure decision function — no DB access. Conversation override wins outright; otherwise general-chat
 * settings win for agent-less conversations; otherwise fall through to the agent's own defaults.
 */
export function selectToolResolutionSource(params: {
  conversationOverride: ConversationToolOverride;
  isGeneralChat: boolean;
  generalSettings: { tool_ids: string[]; mcp_server_ids: string[] } | null;
}): ToolResolutionSource {
  const { conversationOverride, isGeneralChat, generalSettings } = params;
  if (conversationOverride.tools_overridden === true) {
    return {
      kind: 'conversation-override',
      tool_ids: conversationOverride.tool_ids,
      mcp_server_ids: conversationOverride.mcp_server_ids,
    };
  }
  if (isGeneralChat && generalSettings !== null) {
    return {
      kind: 'general-settings',
      tool_ids: generalSettings.tool_ids,
      mcp_server_ids: generalSettings.mcp_server_ids,
    };
  }
  return { kind: 'agent-default' };
}

/**
 * Build the `tools` array for OpenRouter request body (only definitions).
 */
export function toOpenRouterTools(resolved: ResolvedTool[]): { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }[] {
  return resolved.map((r) => ({
    type: 'function' as const,
    function: {
      name: r.openAIDef.function.name,
      description: r.openAIDef.function.description,
      parameters: r.openAIDef.function.parameters,
    },
  }));
}

/**
 * If resolvedTools includes any MCP tool, append an instruction so the model uses exact tool names.
 */
export function appendToolInstructionsIfNeeded(systemPrompt: string, resolvedTools: ResolvedTool[]): string {
  const hasMcp = resolvedTools.some((t) => t.type === 'mcp');
  if (!hasMcp) return systemPrompt;
  const searchTool = resolvedTools.find((tool) => isMcpMetaTool(tool, 'mcp_search'));
  const detailsTool = resolvedTools.find((tool) => isMcpMetaTool(tool, 'mcp_details'));
  const callTool = resolvedTools.find((tool) => isMcpMetaTool(tool, 'mcp_call'));
  const extra = searchTool && detailsTool && callTool
    ? ` When many MCP tools are available, first use ${searchTool.name}, then ${detailsTool.name}, and execute through ${callTool.name} with the exact exposed tool name.`
    : '';
  return (
    systemPrompt +
    '\n\nWhen calling tools, always use the exact tool name from the tools list. MCP tools have names starting with mcp_; do not omit this prefix.' +
    extra
  );
}

function isMcpMetaTool(tool: ResolvedTool, kind: ResolvedToolMcpMetaConfig['kind']): boolean {
  return tool.type === 'mcp'
    && !!tool.config
    && typeof tool.config === 'object'
    && (tool.config as Partial<ResolvedToolMcpMetaConfig>).kind === kind;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
