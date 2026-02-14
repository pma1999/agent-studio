/**
 * MCP client helpers: connect, list tools, call tool, and cleanup.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServerConfig, McpTransport } from './types.js';
import { isMcpConfigUrl, isMcpConfigStdio } from './types.js';

const MCP_CLIENT_NAME = 'agent-studio';
const MCP_CLIENT_VERSION = '1.0.0';
const CONNECT_TIMEOUT_MS = 15_000;
const TOOL_CALL_TIMEOUT_MS = 60_000;

export interface McpConnection {
  client: Client;
  close(): Promise<void>;
}

/**
 * Try connecting via StreamableHTTP first, fall back to SSE for legacy servers.
 * Returns the connected client and a close function for the transport that succeeded.
 */
async function connectUrlTransport(
  url: URL,
  headers?: Record<string, string>
): Promise<{ client: Client; close: () => Promise<void> }> {
  const requestInit = headers && Object.keys(headers).length > 0 ? { headers } : undefined;

  // Try StreamableHTTP first (modern MCP servers)
  let streamableTransport: StreamableHTTPClientTransport | null = null;
  try {
    streamableTransport = new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : undefined);
    const client = new Client({ name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION });
    await client.connect(streamableTransport);
    console.log(`[mcp] Connected via StreamableHTTP to ${url.href}`);
    const transport = streamableTransport;
    return {
      client,
      async close() {
        try { await transport.close(); } catch (e) { console.error('[mcp] Error closing transport:', e); }
      },
    };
  } catch (streamableErr) {
    // Clean up failed transport
    if (streamableTransport) {
      try { await streamableTransport.close(); } catch { /* ignore */ }
    }
    console.warn(
      `[mcp] StreamableHTTP failed for ${url.href}, trying SSE fallback:`,
      streamableErr instanceof Error ? streamableErr.message : streamableErr
    );
  }

  // Fallback to SSE (legacy MCP servers)
  const sseTransport = new SSEClientTransport(url, requestInit ? { requestInit } : undefined);
  const sseClient = new Client({ name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION });
  await sseClient.connect(sseTransport);
  console.log(`[mcp] Connected via SSE (legacy) to ${url.href}`);
  return {
    client: sseClient,
    async close() {
      try { await sseTransport.close(); } catch (e) { console.error('[mcp] Error closing transport:', e); }
    },
  };
}

/**
 * Create and connect an MCP client for the given server config.
 * For URL transport, tries StreamableHTTP first with automatic SSE fallback.
 * Returns { client, close } so the caller can use the client and must call close() when done.
 */
export async function createAndConnectMcpClient(server: {
  transport: McpTransport;
  config: McpServerConfig;
}): Promise<McpConnection> {
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

    const headers = server.config.headers;

    const connectPromise = connectUrlTransport(url, headers);
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('MCP connection timeout')), CONNECT_TIMEOUT_MS);
    });

    const result = await Promise.race([connectPromise, timeoutPromise]);
    return { client: result.client, close: result.close };
  }

  if (server.transport === 'stdio') {
    if (!isMcpConfigStdio(server.config)) {
      throw new Error('stdio transport requires config.command');
    }
    const command = server.config.command?.trim();
    if (!command) {
      throw new Error('config.command is required for stdio transport');
    }

    const transport = new StdioClientTransport({
      command,
      args: Array.isArray(server.config.args) ? server.config.args : [],
      env: server.config.env
        ? { ...process.env as Record<string, string>, ...server.config.env }
        : undefined,
      cwd: server.config.cwd || undefined,
    });

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

  throw new Error(`Unsupported MCP transport: ${server.transport}`);
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
 * Passes through the full schema faithfully (including additionalProperties, enum, oneOf, etc.)
 * while ensuring the required minimum structure for OpenAI compatibility.
 */
function inputSchemaToOpenAIParameters(inputSchema: Record<string, unknown>): Record<string, unknown> {
  const schema = inputSchema && typeof inputSchema === 'object' ? { ...inputSchema } : {} as Record<string, unknown>;
  // Ensure type is 'object' (required by OpenAI function calling)
  if (schema.type !== 'object') {
    schema.type = 'object';
  }
  // Ensure properties exists
  if (!schema.properties || typeof schema.properties !== 'object') {
    schema.properties = {};
  }
  // Ensure required is an array
  if (!Array.isArray(schema.required)) {
    schema.required = [];
  }
  return schema;
}

/**
 * Build annotation hints from MCP tool annotations for the LLM description.
 */
function buildAnnotationHints(annotations: Record<string, unknown> | undefined): string {
  if (!annotations || typeof annotations !== 'object') return '';
  const hints: string[] = [];
  if (annotations.readOnlyHint === true) hints.push('read-only');
  if (annotations.destructiveHint === true) hints.push('destructive, use with caution');
  if (annotations.idempotentHint === true) hints.push('idempotent');
  if (annotations.openWorldHint === true) hints.push('interacts with external services');
  return hints.length > 0 ? ` (${hints.join('; ')})` : '';
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
 * Handles pagination (follows nextCursor) for servers with many tools.
 * Exposes name, title (if present), description, annotations, and full inputSchema.
 */
export async function listMcpTools(
  client: Client,
  namePrefix: string
): Promise<McpToolDef[]> {
  // Fetch all tools with pagination
  const allTools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown>; [key: string]: unknown }> = [];
  let cursor: string | undefined;
  do {
    const response = await client.listTools(cursor ? { cursor } : undefined);
    allTools.push(...(response.tools as typeof allTools));
    cursor = (response as { nextCursor?: string }).nextCursor;
  } while (cursor);

  const result: McpToolDef[] = [];

  for (const tool of allTools) {
    const mcpName = tool.name || 'unnamed';
    const displayName = prefixToolName(namePrefix, mcpName);
    const schema =
      tool.inputSchema && typeof tool.inputSchema === 'object'
        ? tool.inputSchema
        : { type: 'object' as const, properties: {}, required: [] as string[] };
    const parameters = inputSchemaToOpenAIParameters(schema as Record<string, unknown>);

    const desc = typeof tool.description === 'string' ? tool.description : (tool.description ?? '');
    const title = typeof (tool as unknown as { title?: string }).title === 'string' ? (tool as unknown as { title: string }).title : '';
    const baseDescription =
      title && desc ? `${title}. ${desc}` : title ? title : desc || 'MCP tool';

    // Append annotation hints (read-only, destructive, etc.)
    const annotationHints = buildAnnotationHints(
      (tool as { annotations?: Record<string, unknown> }).annotations
    );
    const description = baseDescription + annotationHints;

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
 * Handles text, image, audio, embedded resource, resource_link, isError, and structuredContent.
 * Per spec: tool execution errors should be given to the model for self-correction.
 * Includes a configurable timeout to prevent hung tool calls from blocking indefinitely.
 */
export async function callMcpTool(
  client: Client,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number = TOOL_CALL_TIMEOUT_MS
): Promise<string> {
  const callPromise = client.callTool({
    name: toolName,
    arguments: args,
  });
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`MCP tool call "${toolName}" timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  const result = await Promise.race([callPromise, timeoutPromise]);

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
      } else if (t === 'image' && 'data' in item) {
        const img = item as { data: string; mimeType?: string };
        const mimeType = img.mimeType || 'image/png';
        const dataLen = img.data ? img.data.length : 0;
        parts.push(`[Image: ${mimeType}, ${dataLen} bytes of base64 data]`);
      } else if (t === 'audio' && 'data' in item) {
        const audio = item as { data: string; mimeType?: string };
        const mimeType = audio.mimeType || 'audio/wav';
        const dataLen = audio.data ? audio.data.length : 0;
        parts.push(`[Audio: ${mimeType}, ${dataLen} bytes of base64 data]`);
      } else if (t === 'resource' && 'resource' in item) {
        const res = (item as { resource: { uri?: string; mimeType?: string; text?: string } }).resource;
        if (res.text) {
          parts.push(res.text);
        } else {
          parts.push(`[Embedded resource: ${res.uri || 'unknown'} (${res.mimeType || 'unknown type'})]`);
        }
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
