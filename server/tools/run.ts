/**
 * Execute a single tool by name with the given arguments.
 * Used by the chat route when the model returns tool_calls.
 */

import { getBuiltinExecutor } from './registry.js';
import { runHttpTool } from './httpTool.js';
import { callMcpToolDetailed } from '../mcp/index.js';
import { runSkillTool } from '../skills/activation.js';
import type { McpToolCatalogEntry, ResolvedTool, ResolvedToolMcpConfig, ResolvedToolMcpMetaConfig } from './resolve.js';
import type {
  McpConnection,
  McpRequestControl,
  McpToolAuthorizationRequest,
  McpToolCallResult,
} from '../mcp/index.js';

export type ToolExecutionSource = 'builtin' | 'http' | 'mcp' | 'skill' | 'unknown';

export interface RunToolResult {
  output: string;
  isError: boolean;
  source: ToolExecutionSource;
  metadata?: Record<string, unknown>;
}

export interface RunToolOptions {
  mcpControl?: McpRequestControl;
  /** Required for every MCP tools/call. Absence is intentionally fail-closed. */
  authorizeMcpCall?: (request: McpToolAuthorizationRequest) => Promise<boolean>;
  /** Conservative provenance hint: prior tool output may have influenced args. */
  possibleCrossToolData?: boolean;
}

const MAX_META_TOOL_OUTPUT_CHARS = (() => {
  const parsed = Number.parseInt(process.env.MCP_META_TOOL_OUTPUT_MAX_CHARS || '', 10);
  return Number.isFinite(parsed) && parsed >= 4_096 ? Math.min(parsed, 256_000) : 64_000;
})();

function jsonResult(value: unknown, source: ToolExecutionSource = 'mcp'): RunToolResult {
  let output: string;
  try {
    output = JSON.stringify(value, null, 2);
  } catch {
    return { output: JSON.stringify({ error: 'Result could not be serialized safely' }), isError: true, source };
  }
  if (output.length > MAX_META_TOOL_OUTPUT_CHARS) {
    return {
      output: JSON.stringify({
        error: `Result exceeds the safe ${MAX_META_TOOL_OUTPUT_CHARS}-character limit`,
        actual_characters: output.length,
      }),
      isError: true,
      source,
    };
  }
  return { output, isError: false, source };
}

function boundedMetadataValue(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || serialized.length <= MAX_META_TOOL_OUTPUT_CHARS) return value;
    return { omitted: true, reason: 'Value exceeded the safe metadata limit', actual_characters: serialized.length };
  } catch {
    return { omitted: true, reason: 'Value could not be serialized safely' };
  }
}

function mcpResultMetadata(result: McpToolCallResult, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    content: boundedMetadataValue(result.content),
    ...extra,
  };
  if (Object.prototype.hasOwnProperty.call(result, 'structuredContent')) {
    metadata.structuredContent = boundedMetadataValue(result.structuredContent);
  }
  return metadata;
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

async function requireMcpAuthorization(
  request: Omit<McpToolAuthorizationRequest, 'possibleCrossToolData'>,
  options: RunToolOptions,
): Promise<RunToolResult | null> {
  if (!options.authorizeMcpCall) {
    return {
      output: JSON.stringify({ error: 'MCP tool call blocked: explicit human approval is required on this surface' }),
      isError: true,
      source: 'mcp',
    };
  }
  try {
    const approved = await options.authorizeMcpCall({
      ...request,
      possibleCrossToolData: options.possibleCrossToolData === true,
    });
    if (approved) return null;
  } catch {
    // Authorization failures never become execution grants.
  }
  return {
    output: JSON.stringify({ error: 'MCP tool call was not approved by the user' }),
    isError: true,
    source: 'mcp',
  };
}

function scoreCatalogEntry(entry: McpToolCatalogEntry, query: string): number {
  const terms = query.toLowerCase().slice(0, 1_000).split(/\s+/).filter(Boolean).slice(0, 32);
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
  // Only provider-facing names are accepted. Raw MCP names are not globally
  // unique across servers and accepting them would make dispatch ambiguous.
  return catalog.find((entry) => entry.name === name);
}

async function runMcpMetaTool(
  tool: ResolvedTool,
  args: Record<string, unknown>,
  mcpClients?: Map<string, McpConnection>,
  options: RunToolOptions = {}
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
    return jsonResult({ matches });
  }

  if (config.kind === 'mcp_details') {
    const name = typeof args.name === 'string' ? args.name : '';
    const entry = findCatalogEntry(catalog, name);
    if (!entry) {
      return { output: JSON.stringify({ error: `Unknown MCP tool: ${name}` }), isError: true, source: 'mcp' };
    }
    return jsonResult({
      name: entry.name,
      mcp_tool_name: entry.mcpToolName,
      server_id: entry.serverId,
      server_name: entry.serverName,
      title: entry.title,
      description: entry.description,
      input_schema: entry.inputSchema,
      output_schema: entry.outputSchema,
      annotations: entry.annotations,
      execution: entry.execution,
    });
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
    if (!isRecord(args.arguments)) {
      return {
        output: JSON.stringify({ error: 'arguments must be a JSON object matching the inspected MCP tool schema' }),
        isError: true,
        source: 'mcp',
      };
    }
    const callArgs = args.arguments;
    const authorizationError = await requireMcpAuthorization({
      serverId: entry.serverId,
      serverName: entry.serverName,
      exposedName: entry.name,
      toolName: entry.mcpToolName,
      arguments: callArgs,
      annotations: entry.annotations,
      execution: entry.execution,
    }, options);
    if (authorizationError) return authorizationError;
    const result = await callMcpToolDetailed(connection.client, entry.mcpToolName, callArgs, options.mcpControl);
    return {
      output: result.output,
      isError: result.isError,
      source: 'mcp',
      metadata: mcpResultMetadata(result, {
        annotations: entry.annotations,
        outputSchema: entry.outputSchema,
        execution: entry.execution,
      }),
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
  options: RunToolOptions = {},
): Promise<RunToolResult> {
  const exactMatches = resolvedTools.filter((candidate) => candidate.name === toolName);
  if (exactMatches.length === 0) {
    return { output: JSON.stringify({ error: `Unknown or disabled tool: ${toolName}` }), isError: true, source: 'unknown' };
  }
  if (exactMatches.length > 1) {
    return { output: JSON.stringify({ error: `Ambiguous tool name: ${toolName}` }), isError: true, source: 'unknown' };
  }
  const tool = exactMatches[0];

  let parsedArgs: Record<string, unknown>;
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args) as unknown;
      if (!isRecord(parsed)) throw new Error('not an object');
      parsedArgs = parsed;
    } catch {
      return { output: JSON.stringify({ error: 'Invalid tool arguments (expected JSON object)' }), isError: true, source: tool.type };
    }
  } else if (isRecord(args)) {
    parsedArgs = args;
  } else {
    return { output: JSON.stringify({ error: 'Invalid tool arguments (expected JSON object)' }), isError: true, source: tool.type };
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
      const mcpOptions: RunToolOptions = {
        ...options,
        possibleCrossToolData: options.possibleCrossToolData === true
          || currentMessages?.some((message) => message.role === 'tool') === true,
      };
      if (isMetaConfig(tool.config)) return runMcpMetaTool(tool, parsedArgs, mcpClients, mcpOptions);
      const config = tool.config as ResolvedToolMcpConfig;
      const connection = mcpClients?.get(config.mcp_server_id);
      if (!connection) return { output: JSON.stringify({ error: `MCP client not available for server ${config.mcp_server_id}` }), isError: true, source: 'mcp' };
      const authorizationError = await requireMcpAuthorization({
        serverId: config.mcp_server_id,
        serverName: config.mcp_server_name,
        exposedName: tool.name,
        toolName: config.mcp_tool_name,
        arguments: parsedArgs,
        annotations: config.annotations,
        execution: config.execution,
      }, mcpOptions);
      if (authorizationError) return authorizationError;
      const result = await callMcpToolDetailed(connection.client, config.mcp_tool_name, parsedArgs, mcpOptions.mcpControl);
      return {
        output: result.output,
        isError: result.isError,
        source: 'mcp',
        metadata: mcpResultMetadata(result, {
          annotations: config.annotations,
          outputSchema: config.outputSchema,
          execution: config.execution,
        }),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
