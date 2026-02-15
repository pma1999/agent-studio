/**
 * Resolve which tools an agent can use and return them in OpenRouter/OpenAI format.
 * Only returns tools that are properly configured and ready to run.
 * Includes tools from the tools table (builtin, http) and from MCP servers linked to the agent.
 */

import db from '../db.js';
import { getSettingValue } from '../routes/settings.js';
import { getBuiltinDefinition, getBuiltinExecutor } from './registry.js';
import {
  createAndConnectMcpClient,
  listMcpTools,
  type McpConnection,
} from '../mcp/index.js';
import type { McpServerConfig } from '../mcp/types.js';

export interface ResolvedToolMcpConfig {
  mcp_server_id: string;
  mcp_tool_name: string;
}

export interface ResolvedTool {
  id: string;
  name: string;
  type: 'builtin' | 'http' | 'mcp';
  config: unknown;
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

function isUsable(t: ToolRow, userId: string): boolean {
  if (t.type === 'builtin') {
    const def = getBuiltinDefinition(t.name);
    const executor = getBuiltinExecutor(t.name);
    if (!def || !executor) return false;
    if (t.name === 'web_search') {
      const key = userId ? getSettingValue(userId, 'search_api_key') : '';
      return !!key?.trim();
    }
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

/**
 * Load all tools assigned to the agent (builtin, http, and from linked MCP servers)
 * and return only those that are usable, in OpenRouter format.
 * MCP clients are connected and must be closed by the caller when done.
 */
export async function resolveToolsForAgent(agentId: string, userId: string): Promise<ResolveToolsResult> {
  const resolved: ResolvedTool[] = [];
  const mcpClients = new Map<string, McpConnection>();

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
        connection = await createAndConnectMcpClient({ transport, config });
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
      mcpClients.set(mcp_server_id, connection);

      const namePrefix = `mcp_${mcp_server_id.slice(0, 8)}`;
      const mcpTools = await listMcpTools(connection.client, namePrefix);

      for (const mt of mcpTools) {
        resolved.push({
          id: `mcp_${mcp_server_id}_${mt.mcpToolName}`,
          name: mt.name,
          type: 'mcp',
          config: { mcp_server_id, mcp_tool_name: mt.mcpToolName } as ResolvedToolMcpConfig,
          openAIDef: mt.openAIDef,
        });
      }
    } catch (err) {
      console.error(`[resolve] Failed to list tools from MCP server ${serverRow.name} (${mcp_server_id}):`, err);
      // Do not fail the whole request; skip this MCP server
    }
  }

  return { resolvedTools: resolved, mcpClients };
}

/**
 * Resolve tools and MCP servers by explicit IDs (for general chat).
 * Only resolves tools and MCP servers that belong to the user (user_id filter).
 * MCP clients are connected and must be closed by the caller when done.
 */
export async function resolveToolsFromIds(
  toolIds: string[],
  mcpServerIds: string[],
  userId: string
): Promise<ResolveToolsResult> {
  const resolved: ResolvedTool[] = [];
  const mcpClients = new Map<string, McpConnection>();

  // 1. Tools from tools table by id, scoped to user
  if (toolIds.length > 0) {
    const placeholders = toolIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT id, name, description, parameters_schema, type, config
      FROM tools
      WHERE id IN (${placeholders}) AND user_id = ?
    `).all(...toolIds, userId) as ToolRow[];

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

  // 2. MCP servers by id, scoped to user
  for (const mcp_server_id of mcpServerIds) {
    const serverRow = db.prepare('SELECT id, name, transport, config FROM mcp_servers WHERE id = ? AND user_id = ?').get(mcp_server_id, userId) as
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
        connection = await createAndConnectMcpClient({ transport, config });
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
      mcpClients.set(mcp_server_id, connection);

      const namePrefix = `mcp_${mcp_server_id.slice(0, 8)}`;
      const mcpTools = await listMcpTools(connection.client, namePrefix);

      for (const mt of mcpTools) {
        resolved.push({
          id: `mcp_${mcp_server_id}_${mt.mcpToolName}`,
          name: mt.name,
          type: 'mcp',
          config: { mcp_server_id, mcp_tool_name: mt.mcpToolName } as ResolvedToolMcpConfig,
          openAIDef: mt.openAIDef,
        });
      }
    } catch (err) {
      console.error(`[resolve] Failed to list tools from MCP server ${serverRow.name} (${mcp_server_id}):`, err);
    }
  }

  return { resolvedTools: resolved, mcpClients };
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

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
