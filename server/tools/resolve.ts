/**
 * Resolve which tools an agent can use and return them in OpenRouter/OpenAI format.
 * Only returns tools that are properly configured and ready to run.
 * Includes tools from the tools table (builtin, http) and from MCP servers linked to the agent.
 */

import db from '../db.js';
import { getSettingValue } from '../routes/settings.js';
import { getBuiltinDefinition, getBuiltinExecutor } from './registry.js';
import { isRunCommandUsable } from './execCommand.js';
import {
  createAndConnectMcpClient,
  listMcpTools,
  type McpConnection,
} from '../mcp/index.js';
import type { McpServerConfig } from '../mcp/types.js';

export interface ResolvedToolMcpConfig {
  mcp_server_id: string;
  mcp_tool_name: string;
  annotations?: Record<string, unknown>;
}

export interface McpToolCatalogEntry {
  serverId: string;
  serverName: string;
  name: string;
  mcpToolName: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface ResolvedToolMcpMetaConfig {
  kind: 'mcp_search' | 'mcp_details' | 'mcp_call';
}

export interface ResolvedTool {
  id: string;
  name: string;
  type: 'builtin' | 'http' | 'mcp';
  config: unknown;
  mcpCatalog?: McpToolCatalogEntry[];
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
    if (t.name === 'run_command') return isRunCommandUsable(userId);
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

export interface ResolveToolsResult {
  resolvedTools: ResolvedTool[];
  mcpClients: Map<string, McpConnection>;
}

const PROGRESSIVE_MCP_TOOL_THRESHOLD = Number.parseInt(process.env.MCP_PROGRESSIVE_TOOL_THRESHOLD || '20', 10);

function shouldUseProgressiveDiscovery(mcpToolCount: number): boolean {
  return mcpToolCount >= Math.max(1, PROGRESSIVE_MCP_TOOL_THRESHOLD);
}

function buildMcpMetaTools(catalog: McpToolCatalogEntry[]): ResolvedTool[] {
  const commonCatalog = catalog;
  return [
    {
      id: 'mcp_meta_search_tools',
      name: 'search_mcp_tools',
      type: 'mcp',
      config: { kind: 'mcp_search' } as ResolvedToolMcpMetaConfig,
      mcpCatalog: commonCatalog,
      openAIDef: {
        type: 'function',
        function: {
          name: 'search_mcp_tools',
          description: 'Search available MCP tools by natural-language query. Returns concise matches; call get_mcp_tool_details before executing a tool.',
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
      id: 'mcp_meta_get_tool_details',
      name: 'get_mcp_tool_details',
      type: 'mcp',
      config: { kind: 'mcp_details' } as ResolvedToolMcpMetaConfig,
      mcpCatalog: commonCatalog,
      openAIDef: {
        type: 'function',
        function: {
          name: 'get_mcp_tool_details',
          description: 'Fetch the full input schema and safety annotations for one MCP tool found by search_mcp_tools.',
          parameters: {
            type: 'object',
            properties: { name: { type: 'string', description: 'Exact exposed MCP tool name.' } },
            required: ['name'],
          },
        },
      },
    },
    {
      id: 'mcp_meta_call_tool',
      name: 'call_mcp_tool',
      type: 'mcp',
      config: { kind: 'mcp_call' } as ResolvedToolMcpMetaConfig,
      mcpCatalog: commonCatalog,
      openAIDef: {
        type: 'function',
        function: {
          name: 'call_mcp_tool',
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

  // 1. Tools from tools table (builtin, http)
  const rows = db.prepare(`
    SELECT t.id, t.name, t.description, t.parameters_schema, t.type, t.config
    FROM tools t
    INNER JOIN agent_tools at ON at.tool_id = t.id
    WHERE at.agent_id = ?
  `).all(agentId) as ToolRow[];

  for (const row of rows) {
    if (!isUsable(row, userId)) continue;

    let parameters: Record<string, unknown>;
    try {
      parameters = JSON.parse(row.parameters_schema);
    } catch {
      continue;
    }

    if (row.type === 'builtin') {
      const def = getBuiltinDefinition(row.name);
      if (!def) continue;
      resolved.push({
        id: row.id,
        name: row.name,
        type: 'builtin',
        config: row.config ? tryParse(row.config) : undefined,
        openAIDef: {
          type: 'function',
          function: {
            name: def.function.name,
            description: def.function.description,
            parameters: def.function.parameters,
          },
        },
      });
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

  // 2. MCP servers linked to this agent
  const mcpLinks = db.prepare(`
    SELECT mcp_server_id FROM agent_mcp_servers WHERE agent_id = ?
  `).all(agentId) as { mcp_server_id: string }[];

  for (const { mcp_server_id } of mcpLinks) {
    const serverRow = db.prepare('SELECT id, name, transport, config FROM mcp_servers WHERE id = ?').get(mcp_server_id) as
      | { id: string; name: string; transport: string; config: string }
      | undefined;
    if (!serverRow) continue;

    let config: McpServerConfig;
    try {
      config = JSON.parse(serverRow.config) as McpServerConfig;
    } catch {
      console.error(`[resolve] Invalid MCP server config for ${mcp_server_id}`);
      continue;
    }

    const transport = serverRow.transport as 'url' | 'stdio';
    if (transport !== 'url' && transport !== 'stdio') {
      console.error(`[resolve] Unknown MCP transport for ${mcp_server_id}: ${transport}`);
      continue;
    }

    // Connect with one retry on transient failures
    let connection: McpConnection | null = null;
    for (let attempt = 0; attempt <= 1; attempt++) {
      try {
        connection = await createAndConnectMcpClient({ transport, config }, { userId });
        break;
      } catch (err) {
        if (attempt < 1) {
          console.warn(`[resolve] MCP connect attempt ${attempt + 1} failed for ${serverRow.name}, retrying in 2s...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
          console.error(`[resolve] Failed to connect to MCP server ${serverRow.name} (${mcp_server_id}) after 2 attempts:`, err);
        }
      }
    }
    if (!connection) continue;

    try {
      const slug = slugFromServerName(serverRow.name, mcp_server_id);
      const namePrefix = `mcp_${slug}`;
      const mcpTools = await listMcpTools(connection.client, namePrefix);

      for (const mt of mcpTools) {
        mcpCatalog.push({
          serverId: mcp_server_id,
          serverName: serverRow.name,
          name: mt.name,
          mcpToolName: mt.mcpToolName,
          title: mt.title,
          description: mt.description,
          inputSchema: mt.inputSchema,
          annotations: mt.annotations,
        });
        resolved.push({
          id: `mcp_${mcp_server_id}_${mt.mcpToolName}`,
          name: mt.name,
          type: 'mcp',
          config: { mcp_server_id, mcp_tool_name: mt.mcpToolName, annotations: mt.annotations } as ResolvedToolMcpConfig,
          openAIDef: mt.openAIDef,
        });
      }
      mcpClients.set(mcp_server_id, connection);
    } catch (err) {
      await connection.close();
      console.error(`[resolve] Failed to list tools from MCP server ${serverRow.name} (${mcp_server_id}):`, err);
      // Do not fail the whole request; skip this MCP server
    }
  }

  const mcpToolCount = mcpCatalog.length;
  if (shouldUseProgressiveDiscovery(mcpToolCount)) {
    const nonMcpTools = resolved.filter((tool) => tool.type !== 'mcp');
    return { resolvedTools: [...nonMcpTools, ...buildMcpMetaTools(mcpCatalog)], mcpClients };
  }

  return { resolvedTools: resolved, mcpClients };
}

export interface ResolveToolsFromIdsOptions {
  /** When true, resolve tools by id only (no user_id filter). Use for council merge when council belongs to current user. */
  byIdOnly?: boolean;
}

/**
 * Resolve tools and MCP servers by explicit IDs (for general chat or council merge).
 * By default only resolves tools that belong to the user (user_id filter).
 * MCP clients are connected and must be closed by the caller when done.
 */
export async function resolveToolsFromIds(
  toolIds: string[],
  mcpServerIds: string[],
  userId: string,
  options?: ResolveToolsFromIdsOptions
): Promise<ResolveToolsResult> {
  const resolved: ResolvedTool[] = [];
  const mcpClients = new Map<string, McpConnection>();
  const mcpCatalog: McpToolCatalogEntry[] = [];
  const byIdOnly = options?.byIdOnly === true;

  // 1. Tools from tools table by id; optionally scoped to user
  if (toolIds.length > 0) {
    const placeholders = toolIds.map(() => '?').join(',');
    const rows = byIdOnly
      ? (db.prepare(`
          SELECT id, name, description, parameters_schema, type, config
          FROM tools
          WHERE id IN (${placeholders})
        `).all(...toolIds) as ToolRow[])
      : (db.prepare(`
          SELECT id, name, description, parameters_schema, type, config
          FROM tools
          WHERE id IN (${placeholders}) AND user_id = ?
        `).all(...toolIds, userId) as ToolRow[]);

    for (const row of rows) {
      if (!isUsable(row, userId)) continue;

      let parameters: Record<string, unknown>;
      try {
        parameters = JSON.parse(row.parameters_schema);
      } catch {
        continue;
      }

      if (row.type === 'builtin') {
        const def = getBuiltinDefinition(row.name);
        if (!def) continue;
        resolved.push({
          id: row.id,
          name: row.name,
          type: 'builtin',
          config: row.config ? tryParse(row.config) : undefined,
          openAIDef: {
            type: 'function',
            function: {
              name: def.function.name,
              description: def.function.description,
              parameters: def.function.parameters,
            },
          },
        });
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

  // 2. MCP servers by id; optionally scoped to user
  for (const mcp_server_id of mcpServerIds) {
    const serverRow = (byIdOnly
      ? db.prepare('SELECT id, name, transport, config FROM mcp_servers WHERE id = ?').get(mcp_server_id)
      : db.prepare('SELECT id, name, transport, config FROM mcp_servers WHERE id = ? AND user_id = ?').get(mcp_server_id, userId)) as
      | { id: string; name: string; transport: string; config: string }
      | undefined;
    if (!serverRow) continue;

    let config: McpServerConfig;
    try {
      config = JSON.parse(serverRow.config) as McpServerConfig;
    } catch {
      console.error(`[resolve] Invalid MCP server config for ${mcp_server_id}`);
      continue;
    }

    const transport = serverRow.transport as 'url' | 'stdio';
    if (transport !== 'url' && transport !== 'stdio') {
      console.error(`[resolve] Unknown MCP transport for ${mcp_server_id}: ${transport}`);
      continue;
    }

    let connection: McpConnection | null = null;
    for (let attempt = 0; attempt <= 1; attempt++) {
      try {
        connection = await createAndConnectMcpClient({ transport, config }, { userId });
        break;
      } catch (err) {
        if (attempt < 1) {
          console.warn(`[resolve] MCP connect attempt ${attempt + 1} failed for ${serverRow.name}, retrying in 2s...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
          console.error(`[resolve] Failed to connect to MCP server ${serverRow.name} (${mcp_server_id}) after 2 attempts:`, err);
        }
      }
    }
    if (!connection) continue;

    try {
      const slug = slugFromServerName(serverRow.name, mcp_server_id);
      const namePrefix = `mcp_${slug}`;
      const mcpTools = await listMcpTools(connection.client, namePrefix);

      for (const mt of mcpTools) {
        mcpCatalog.push({
          serverId: mcp_server_id,
          serverName: serverRow.name,
          name: mt.name,
          mcpToolName: mt.mcpToolName,
          title: mt.title,
          description: mt.description,
          inputSchema: mt.inputSchema,
          annotations: mt.annotations,
        });
        resolved.push({
          id: `mcp_${mcp_server_id}_${mt.mcpToolName}`,
          name: mt.name,
          type: 'mcp',
          config: { mcp_server_id, mcp_tool_name: mt.mcpToolName, annotations: mt.annotations } as ResolvedToolMcpConfig,
          openAIDef: mt.openAIDef,
        });
      }
      mcpClients.set(mcp_server_id, connection);
    } catch (err) {
      await connection.close();
      console.error(`[resolve] Failed to list tools from MCP server ${serverRow.name} (${mcp_server_id}):`, err);
    }
  }

  const mcpToolCount = mcpCatalog.length;
  if (shouldUseProgressiveDiscovery(mcpToolCount)) {
    const nonMcpTools = resolved.filter((tool) => tool.type !== 'mcp');
    return { resolvedTools: [...nonMcpTools, ...buildMcpMetaTools(mcpCatalog)], mcpClients };
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
export function getConversationToolOverride(conversationId: string): ConversationToolOverride {
  const row = db.prepare('SELECT tools_overridden FROM conversations WHERE id = ?').get(conversationId) as
    | { tools_overridden: number }
    | undefined;
  const tools_overridden = !!row?.tools_overridden;
  const toolLinks = db.prepare('SELECT tool_id FROM conversation_tools WHERE conversation_id = ?').all(conversationId) as { tool_id: string }[];
  const mcpLinks = db.prepare('SELECT mcp_server_id FROM conversation_mcp_servers WHERE conversation_id = ?').all(conversationId) as { mcp_server_id: string }[];
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
  const hasMeta = resolvedTools.some((t) => t.name === 'search_mcp_tools' || t.name === 'call_mcp_tool');
  const extra = hasMeta
    ? ' When many MCP tools are available, first use search_mcp_tools, then get_mcp_tool_details, and execute through call_mcp_tool with the exact tool name.'
    : '';
  return (
    systemPrompt +
    '\n\nWhen calling tools, always use the exact tool name from the tools list. MCP tools have names starting with mcp_; do not omit this prefix.' +
    extra
  );
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
