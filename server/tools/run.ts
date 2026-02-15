/**
 * Execute a single tool by name with the given arguments.
 * Used by the chat route when the model returns tool_calls.
 */

import { getBuiltinExecutor } from './registry.js';
import { runHttpTool } from './httpTool.js';
import { callMcpTool } from '../mcp/index.js';
import type { ResolvedTool, ResolvedToolMcpConfig } from './resolve.js';
import type { McpConnection } from '../mcp/index.js';

export type ToolExecutionSource = 'builtin' | 'http' | 'mcp' | 'unknown';

export interface RunToolResult {
  output: string;
  isError: boolean;
  source: ToolExecutionSource;
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

export async function runTool(
  resolvedTools: ResolvedTool[],
  toolName: string,
  args: Record<string, unknown>,
  mcpClients?: Map<string, McpConnection>,
  userId?: string
): Promise<RunToolResult> {
  let tool = resolvedTools.find((t) => t.name === toolName);

  // Fallback: if model called MCP tool by short name (e.g. search_legislation), resolve when unique
  if (!tool) {
    const mcpMatches = resolvedTools.filter(
      (t): t is ResolvedTool & { type: 'mcp'; config: ResolvedToolMcpConfig } =>
        t.type === 'mcp' && (t.config as ResolvedToolMcpConfig).mcp_tool_name === toolName
    );
    if (mcpMatches.length === 1) {
      tool = mcpMatches[0];
    } else if (mcpMatches.length > 1) {
      const fullNames = mcpMatches.map((t) => t.name).join(', ');
      return {
        output: JSON.stringify({
          error: `Multiple MCP tools named '${toolName}'. Use the full tool name: ${fullNames}`,
        }),
        isError: true,
        source: 'mcp',
      };
    }
  }

  if (!tool) {
    return {
      output: JSON.stringify({ error: `Unknown or disabled tool: ${toolName}` }),
      isError: true,
      source: 'unknown',
    };
  }

  let parsedArgs = args;
  if (typeof args === 'string') {
    try {
      parsedArgs = JSON.parse(args) as Record<string, unknown>;
    } catch {
      return {
        output: JSON.stringify({ error: 'Invalid tool arguments (expected JSON object)' }),
        isError: true,
        source: tool.type,
      };
    }
  }

  try {
    if (tool.type === 'builtin') {
      const executor = getBuiltinExecutor(tool.name);
      if (!executor) {
        return {
          output: JSON.stringify({ error: `Builtin tool not implemented: ${tool.name}` }),
          isError: true,
          source: 'builtin',
        };
      }
      const output = await executor(parsedArgs, tool.config, userId);
      return { output, isError: inferIsErrorOutput(output), source: 'builtin' };
    }

    if (tool.type === 'http') {
      const config = tool.config as { url?: string; method?: string; headers?: Record<string, string> };
      if (!config?.url) {
        return {
          output: JSON.stringify({ error: 'HTTP tool has no URL configured' }),
          isError: true,
          source: 'http',
        };
      }
      const output = await runHttpTool(
        {
          url: config.url,
          method: (config.method as 'GET' | 'POST') || 'GET',
          headers: config.headers,
        },
        parsedArgs
      );
      return { output, isError: inferIsErrorOutput(output), source: 'http' };
    }

    if (tool.type === 'mcp') {
      const config = tool.config as ResolvedToolMcpConfig;
      const connection = mcpClients?.get(config.mcp_server_id);
      if (!connection) {
        return {
          output: JSON.stringify({ error: `MCP client not available for server ${config.mcp_server_id}` }),
          isError: true,
          source: 'mcp',
        };
      }
      const output = await callMcpTool(connection.client, config.mcp_tool_name, parsedArgs);
      return { output, isError: inferIsErrorOutput(output), source: 'mcp' };
    }

    return {
      output: JSON.stringify({ error: `Unsupported tool type: ${(tool as ResolvedTool).type}` }),
      isError: true,
      source: 'unknown',
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      output: JSON.stringify({ error: msg }),
      isError: true,
      source: tool.type,
    };
  }
}
