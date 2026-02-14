/**
 * MCP client helpers: connect, list tools, call tool, and cleanup.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServerConfig, McpTransport } from './types.js';
import { isMcpConfigUrl, isMcpConfigStdio } from './types.js';

const MCP_CLIENT_NAME = 'agent-studio';
const MCP_CLIENT_VERSION = '1.0.0';
const CONNECT_TIMEOUT_MS = 15_000;

export interface McpConnection {
  client: Client;
  close(): Promise<void>;
}

/**
 * Create and connect an MCP client for the given server config.
 * Returns { client, close } so the caller can use the client and must call close() when done.
 */
export async function createAndConnectMcpClient(server: {
  transport: McpTransport;
  config: McpServerConfig;
}): Promise<McpConnection> {
  let transport: StreamableHTTPClientTransport | StdioClientTransport;

  if (server.transport === 'url') {
    if (!isMcpConfigUrl(server.config)) {
      throw new Error('URL transport requires config.url');
    }
    const urlStr = server.config.url?.trim();
    if (!urlStr) {
      throw new Error('config.url is required for URL transport');
    }
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      throw new Error(`Invalid MCP URL: ${urlStr}`);
    }
    transport = new StreamableHTTPClientTransport(url);
  } else if (server.transport === 'stdio') {
    if (!isMcpConfigStdio(server.config)) {
      throw new Error('stdio transport requires config.command');
    }
    const command = server.config.command?.trim();
    if (!command) {
      throw new Error('config.command is required for stdio transport');
    }
    transport = new StdioClientTransport({
      command,
      args: Array.isArray(server.config.args) ? server.config.args : [],
    });
  } else {
    throw new Error(`Unsupported MCP transport: ${server.transport}`);
  }

  const client = new Client(
    { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION }
  );

  const connectPromise = client.connect(transport);
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('MCP connection timeout')), CONNECT_TIMEOUT_MS);
  });

  await Promise.race([connectPromise, timeoutPromise]);

  return {
    client,
    async close() {
      try {
        await transport.close();
      } catch (e) {
        console.error('[mcp] Error closing transport:', e);
      }
    },
  };
}

/**
 * Normalize tool name for OpenAI/OpenRouter: snake_case, no spaces.
 */
function normalizeToolName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, '_')
    .replace(/-/g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .toLowerCase() || 'tool';
}

/**
 * Ensure unique name with optional prefix (e.g. mcp_abc123_read_file).
 */
export function prefixToolName(prefix: string, name: string): string {
  const normalized = normalizeToolName(name);
  const prefixed = prefix ? `${prefix.replace(/[^a-z0-9_]/gi, '_')}_${normalized}` : normalized;
  return prefixed || 'tool';
}

/**
 * Extract the original MCP tool name from a prefixed name (prefix_tool_name -> tool_name).
 */
export function unprefixToolName(prefix: string, prefixedName: string): string {
  if (!prefix) return prefixedName;
  const p = prefix.replace(/[^a-z0-9_]/gi, '_');
  if (!p || !prefixedName.startsWith(p + '_')) {
    return prefixedName;
  }
  return prefixedName.slice(p.length + 1);
}

/**
 * Map MCP inputSchema (JSON Schema) to OpenAI/OpenRouter function parameters.
 * Spec: inputSchema MUST be valid JSON Schema object; for no params use
 * { type: "object", additionalProperties: false } or { type: "object" }.
 */
function inputSchemaToOpenAIParameters(inputSchema: {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}): { type: 'object'; properties: Record<string, unknown>; required: string[] } {
  const schema = inputSchema && typeof inputSchema === 'object' ? inputSchema : null;
  const properties =
    schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required =
    schema && Array.isArray(schema.required) ? (schema.required as string[]) : [];
  return {
    type: 'object',
    properties,
    required,
  };
}

export interface McpToolDef {
  name: string;
  mcpToolName: string;
  openAIDef: {
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  };
}

/**
 * List tools from an MCP client and convert to OpenAI/OpenRouter format.
 * namePrefix is used to avoid collisions when multiple MCPs are attached (e.g. mcp_abc_).
 * Exposes name, title (if present), description, and full inputSchema so the model sees all tool metadata.
 */
export async function listMcpTools(
  client: Client,
  namePrefix: string
): Promise<McpToolDef[]> {
  const { tools } = await client.listTools();
  const result: McpToolDef[] = [];

  for (const tool of tools) {
    const mcpName = tool.name || 'unnamed';
    const displayName = prefixToolName(namePrefix, mcpName);
    const schema =
      tool.inputSchema && typeof tool.inputSchema === 'object'
        ? tool.inputSchema
        : { type: 'object' as const, properties: {}, required: [] as string[] };
    const parameters = inputSchemaToOpenAIParameters(schema);

    const desc = typeof tool.description === 'string' ? tool.description : (tool.description ?? '');
    const title = typeof (tool as { title?: string }).title === 'string' ? (tool as { title: string }).title : '';
    const description =
      title && desc ? `${title}. ${desc}` : title ? title : desc || 'MCP tool';

    result.push({
      name: displayName,
      mcpToolName: mcpName,
      openAIDef: {
        type: 'function',
        function: {
          name: displayName,
          description,
          parameters,
        },
      },
    });
  }

  return result;
}

/**
 * Call an MCP tool and return the result as a string (for the tool message content).
 * Handles text, isError (per spec: tool execution errors should be given to the model for self-correction),
 * structuredContent, and resource_link so the model sees everything the server returns.
 */
export async function callMcpTool(
  client: Client,
  toolName: string,
  args: Record<string, unknown>
): Promise<string> {
  const result = await client.callTool({
    name: toolName,
    arguments: args,
  });

  const content = result?.content;
  const isError = (result as { isError?: boolean })?.isError === true;
  const structuredContent = (result as { structuredContent?: Record<string, unknown> })?.structuredContent;

  const parts: string[] = [];
  if (isError) {
    parts.push('[Tool execution error]');
  }

  if (content && Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== 'object' || !('type' in item)) continue;
      const t = (item as { type: string }).type;
      if (t === 'text' && 'text' in item) {
        parts.push(String((item as { text: string }).text));
      } else if (t === 'resource_link' && 'uri' in item && 'name' in item) {
        const r = item as { uri: string; name: string; description?: string };
        const line = r.description
          ? `Resource: ${r.name} (${r.uri}) — ${r.description}`
          : `Resource: ${r.name} (${r.uri})`;
        parts.push(line);
      }
    }
  }

  if (structuredContent && typeof structuredContent === 'object' && Object.keys(structuredContent).length > 0) {
    try {
      parts.push(JSON.stringify(structuredContent));
    } catch {
      // ignore
    }
  }

  if (parts.length === 0) {
    return JSON.stringify(result ?? {});
  }
  return parts.join('\n\n');
}
