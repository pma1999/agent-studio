/**
 * Execute a single tool by name with the given arguments.
 * Used by the chat route when the model returns tool_calls.
 */

import { getBuiltinExecutor } from './registry.js';
import { runHttpTool } from './httpTool.js';
import { callMcpTool } from '../mcp/index.js';
import type { ResolvedTool, ResolvedToolMcpConfig } from './resolve.js';
import type { McpConnection } from '../mcp/index.js';

export async function runTool(
  resolvedTools: ResolvedTool[],
  toolName: string,
  args: Record<string, unknown>,
  mcpClients?: Map<string, McpConnection>,
  userId?: string
): Promise<string> {
  const tool = resolvedTools.find((t) => t.name === toolName);
  if (!tool) {
    return JSON.stringify({ error: `Unknown or disabled tool: ${toolName}` });
  }

  let parsedArgs = args;
  if (typeof args === 'string') {
    try {
      parsedArgs = JSON.parse(args) as Record<string, unknown>;
    } catch {
      return JSON.stringify({ error: 'Invalid tool arguments (expected JSON object)' });
    }
  }

  try {
    if (tool.type === 'builtin') {
      const executor = getBuiltinExecutor(tool.name);
      if (!executor) {
        return JSON.stringify({ error: `Builtin tool not implemented: ${tool.name}` });
      }
      return await executor(parsedArgs, tool.config, userId);
    }

    if (tool.type === 'http') {
      const config = tool.config as { url?: string; method?: string; headers?: Record<string, string> };
      if (!config?.url) {
        return JSON.stringify({ error: 'HTTP tool has no URL configured' });
      }
      return await runHttpTool(
        {
          url: config.url,
          method: (config.method as 'GET' | 'POST') || 'GET',
          headers: config.headers,
        },
        parsedArgs
      );
    }

    if (tool.type === 'mcp') {
      const config = tool.config as ResolvedToolMcpConfig;
      const connection = mcpClients?.get(config.mcp_server_id);
      if (!connection) {
        return JSON.stringify({ error: `MCP client not available for server ${config.mcp_server_id}` });
      }
      return await callMcpTool(connection.client, config.mcp_tool_name, parsedArgs);
    }

    return JSON.stringify({ error: `Unsupported tool type: ${(tool as ResolvedTool).type}` });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return JSON.stringify({ error: msg });
  }
}
