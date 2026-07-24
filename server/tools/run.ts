/**
 * Execute a single tool by name with the given arguments.
 * Used by the chat route when the model returns tool_calls.
 */

import { getBuiltinExecutor } from './registry.js';
import { runHttpTool } from './httpTool.js';
import { callMcpToolDetailed } from '../mcp/index.js';
import { runSkillTool } from '../skills/activation.js';
import type { McpToolCatalogEntry, ResolvedTool, ResolvedToolMcpConfig, ResolvedToolMcpMetaConfig } from './resolve.js';
import type { McpConnection } from '../mcp/index.js';

export type ToolExecutionSource = 'builtin' | 'http' | 'mcp' | 'skill' | 'unknown';

export interface RunToolResult {
  output: string;
  isError: boolean;
  source: ToolExecutionSource;
  metadata?: Record<string, unknown>;
}

function inferIsErrorOutput(output: string): boolean {
  const trimmed = output.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('[Tool execution error]')) return true;
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown };
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      const err = parsed.error;
      return err !== undefined && err !== null && String(err).trim().length > 0;
    }
  } catch {
    // Non-JSON tool outputs are valid and usually not errors.
  }
  return false;
}

function isMetaConfig(config: unknown): config is ResolvedToolMcpMetaConfig {
  return !!config && typeof config === 'object' && 'kind' in config;
}

function scoreCatalogEntry(entry: McpToolCatalogEntry, query: string): number {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;
  const haystack = [entry.name, entry.mcpToolName, entry.title || '', entry.description, entry.serverName]
    .join(' ')
    .toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (entry.name.toLowerCase() === term || entry.mcpToolName.toLowerCase() === term) score += 8;
    if (haystack.includes(term)) score += 2;
    if (entry.name.toLowerCase().includes(term) || entry.mcpToolName.toLowerCase().includes(term)) score += 3;
  }
  return score;
}

function findCatalogEntry(catalog: McpToolCatalogEntry[], name: string): McpToolCatalogEntry | undefined {
  return catalog.find((entry) => entry.name === name || entry.mcpToolName === name);
}

async function runMcpMetaTool(
  tool: ResolvedTool,
  args: Record<string, unknown>,
  mcpClients?: Map<string, McpConnection>
): Promise<RunToolResult> {
  const config = tool.config as ResolvedToolMcpMetaConfig;
  const catalog = tool.mcpCatalog || [];

  if (config.kind === 'mcp_search') {
    const query = typeof args.query === 'string' ? args.query : '';
    const serverId = typeof args.server_id === 'string' ? args.server_id : undefined;
    const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 20);
    const matches = catalog
      .filter((entry) => !serverId || entry.serverId === serverId)
      .map((entry) => ({ entry, score: scoreCatalogEntry(entry, query) }))
      .filter(({ score }) => score > 0 || !query.trim())
      .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
      .slice(0, limit)
      .map(({ entry }) => ({
        name: entry.name,
        server_id: entry.serverId,
        server_name: entry.serverName,
        description: entry.description,
        annotations: entry.annotations,
      }));
    return { output: JSON.stringify({ matches }, null, 2), isError: false, source: 'mcp' };
  }

  if (config.kind === 'mcp_details') {
    const name = typeof args.name === 'string' ? args.name : '';
    const entry = findCatalogEntry(catalog, name);
    if (!entry) {
      return { output: JSON.stringify({ error: `Unknown MCP tool: ${name}` }), isError: true, source: 'mcp' };
    }
    return {
      output: JSON.stringify({
        name: entry.name,
        mcp_tool_name: entry.mcpToolName,
        server_id: entry.serverId,
        server_name: entry.serverName,
        title: entry.title,
        description: entry.description,
        input_schema: entry.inputSchema,
        annotations: entry.annotations,
      }, null, 2),
      isError: false,
      source: 'mcp',
    };
  }

  if (config.kind === 'mcp_call') {
    const name = typeof args.name === 'string' ? args.name : '';
    const entry = findCatalogEntry(catalog, name);
    if (!entry) {
      return { output: JSON.stringify({ error: `Unknown MCP tool: ${name}` }), isError: true, source: 'mcp' };
    }
    const connection = mcpClients?.get(entry.serverId);
    if (!connection) {
      return { output: JSON.stringify({ error: `MCP client not available for server ${entry.serverId}` }), isError: true, source: 'mcp' };
    }
    const callArgs = args.arguments && typeof args.arguments === 'object' ? args.arguments as Record<string, unknown> : {};
    const result = await callMcpToolDetailed(connection.client, entry.mcpToolName, callArgs);
    return {
      output: result.output,
      isError: result.isError,
      source: 'mcp',
      metadata: { content: result.content, structuredContent: result.structuredContent },
    };
  }

  return { output: JSON.stringify({ error: `Unsupported MCP meta-tool: ${config.kind}` }), isError: true, source: 'mcp' };
}

export async function runTool(
  resolvedTools: ResolvedTool[],
  toolName: string,
  args: Record<string, unknown>,
  mcpClients?: Map<string, McpConnection>,
  userId?: string,
  conversationId?: string,
  currentMessages?: Array<{ role: string; content?: unknown }>,
): Promise<RunToolResult> {
  let tool = resolvedTools.find((t) => t.name === toolName);

  if (!tool) {
    const mcpMatches = resolvedTools.filter(
      (t): t is ResolvedTool & { type: 'mcp'; config: ResolvedToolMcpConfig } =>
        t.type === 'mcp' && !isMetaConfig(t.config) && (t.config as ResolvedToolMcpConfig).mcp_tool_name === toolName
    );
    if (mcpMatches.length === 1) {
      tool = mcpMatches[0];
    } else if (mcpMatches.length > 1) {
      const fullNames = mcpMatches.map((t) => t.name).join(', ');
      return { output: JSON.stringify({ error: `Multiple MCP tools named '${toolName}'. Use the full tool name: ${fullNames}` }), isError: true, source: 'mcp' };
    }
  }

  if (!tool) return { output: JSON.stringify({ error: `Unknown or disabled tool: ${toolName}` }), isError: true, source: 'unknown' };

  let parsedArgs = args;
  if (typeof args === 'string') {
    try {
      parsedArgs = JSON.parse(args) as Record<string, unknown>;
    } catch {
      return { output: JSON.stringify({ error: 'Invalid tool arguments (expected JSON object)' }), isError: true, source: tool.type };
    }
  }

  try {
    if (tool.type === 'builtin') {
      const executor = getBuiltinExecutor(tool.name);
      if (!executor) return { output: JSON.stringify({ error: `Builtin tool not implemented: ${tool.name}` }), isError: true, source: 'builtin' };
      const output = await executor(parsedArgs, tool.config, userId, conversationId);
      return { output, isError: inferIsErrorOutput(output), source: 'builtin' };
    }

    if (tool.type === 'http') {
      const config = tool.config as { url?: string; method?: string; headers?: Record<string, string> };
      if (!config?.url) return { output: JSON.stringify({ error: 'HTTP tool has no URL configured' }), isError: true, source: 'http' };
      const output = await runHttpTool({ url: config.url, method: (config.method as 'GET' | 'POST') || 'GET', headers: config.headers }, parsedArgs);
      return { output, isError: inferIsErrorOutput(output), source: 'http' };
    }

    if (tool.type === 'mcp') {
      if (isMetaConfig(tool.config)) return runMcpMetaTool(tool, parsedArgs, mcpClients);
      const config = tool.config as ResolvedToolMcpConfig;
      const connection = mcpClients?.get(config.mcp_server_id);
      if (!connection) return { output: JSON.stringify({ error: `MCP client not available for server ${config.mcp_server_id}` }), isError: true, source: 'mcp' };
      const result = await callMcpToolDetailed(connection.client, config.mcp_tool_name, parsedArgs);
      return {
        output: result.output,
        isError: result.isError,
        source: 'mcp',
        metadata: { content: result.content, structuredContent: result.structuredContent, annotations: config.annotations },
      };
    }

    if (tool.type === 'skill') {
      if (!userId) {
        return { output: JSON.stringify({ error: 'Skill tools require an authenticated user context' }), isError: true, source: 'skill' };
      }
      return runSkillTool(tool, parsedArgs, { userId, currentMessages: currentMessages || [], conversationId });
    }

    return { output: JSON.stringify({ error: `Unsupported tool type: ${(tool as ResolvedTool).type}` }), isError: true, source: 'unknown' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { output: JSON.stringify({ error: msg }), isError: true, source: tool.type };
  }
}
