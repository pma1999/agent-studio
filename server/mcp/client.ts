/**
 * MCP client helpers: connect, list tools, call tool, and cleanup.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServerConfig, McpTransport } from './types.js';
import { isMcpConfigUrl, isMcpConfigStdio } from './types.js';
import { scanCommand } from '../../shared/commandSafety.js';
import { logToolExecution } from '../tools/execAudit.js';

const MCP_CLIENT_NAME = 'agent-studio';
const MCP_CLIENT_VERSION = '1.0.0';
const CONNECT_TIMEOUT_MS = 15_000;
const TOOL_CALL_TIMEOUT_MS = 60_000;
const MAX_TEXT_RESULT_CHARS = 64_000;
const TOOL_CACHE_TTL_MS = 30_000;
const SAFE_STDIO_ENV_KEYS = [
  'PATH',
  'SystemRoot',
  'windir',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'LANG',
  'TMPDIR',
] as const;

const MCP_STDIO_AUDIT_TOOL_NAME = 'mcp_stdio_connect';

export interface McpConnection {
  client: Client;
  close(): Promise<void>;
}

/**
 * Build the intentionally small environment inherited by MCP stdio servers.
 * Caller-provided values are applied last so server configuration wins over
 * the host baseline for the same key.
 */
export function buildSafeEnv(configEnv?: Record<string, string>): Record<string, string> {
  const safeEnv: Record<string, string> = {};
  for (const key of SAFE_STDIO_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) safeEnv[key] = value;
  }
  return { ...safeEnv, ...(configEnv ?? {}) };
}

interface McpStdioAuditContext {
  userId: string;
  conversationId?: string;
}

function auditMcpStdioConnection(
  auditContext: McpStdioAuditContext | undefined,
  details: {
    command: string;
    cwd?: string;
    blockedPattern?: string;
    durationMs?: number;
    isError?: boolean;
  }
): void {
  if (!auditContext) return;
  logToolExecution({
    userId: auditContext.userId,
    conversationId: auditContext.conversationId,
    toolName: MCP_STDIO_AUDIT_TOOL_NAME,
    backend: 'mcp-stdio',
    command: details.command,
    cwd: details.cwd ?? null,
    durationMs: details.durationMs,
    blockedPattern: details.blockedPattern,
    isError: details.isError,
  });
}

async function closeQuietly(close: () => Promise<void>, label: string): Promise<void> {
  try {
    await close();
  } catch (e) {
    console.error(`[mcp] Error closing ${label}:`, e);
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: () => Promise<void> | void
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      void Promise.resolve(onTimeout?.()).finally(() => reject(new Error(message)));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
    // Avoid unhandled rejections if the underlying operation finishes after the timeout.
    if (timedOut) promise.catch(() => undefined);
  }
}

/**
 * Try connecting via StreamableHTTP first, fall back to SSE for legacy servers.
 * Returns the connected client and a close function for the transport that succeeded.
 */

function createMcpClient(label: string): Client {
  const client = new Client(
    { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
    {
      listChanged: {
        tools: {
          onChanged: (error: Error | null) => {
            invalidateMcpToolCache(client);
            if (error) {
              console.warn(`[mcp] Failed to refresh changed tool list for ${label}:`, error.message);
            } else {
              console.log(`[mcp] Tool list changed for ${label}; cache invalidated`);
            }
          },
        },
      },
    }
  );
  return client;
}

async function connectUrlTransport(
  url: URL,
  headers?: Record<string, string>
): Promise<{ client: Client; close: () => Promise<void> }> {
  const requestInit = headers && Object.keys(headers).length > 0 ? { headers } : undefined;

  let streamableTransport: StreamableHTTPClientTransport | null = null;
  try {
    streamableTransport = new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : undefined);
    const client = createMcpClient(url.href);
    const transport = streamableTransport;
    await withTimeout(
      client.connect(transport),
      CONNECT_TIMEOUT_MS,
      `MCP StreamableHTTP connection to ${url.href} timed out after ${CONNECT_TIMEOUT_MS}ms`,
      () => transport.close()
    );
    console.log(`[mcp] Connected via StreamableHTTP to ${url.href}`);
    return {
      client,
      async close() {
        await closeQuietly(() => transport.close(), 'StreamableHTTP transport');
      },
    };
  } catch (streamableErr) {
    if (streamableTransport) {
      await closeQuietly(() => streamableTransport!.close(), 'failed StreamableHTTP transport');
    }
    console.warn(
      `[mcp] StreamableHTTP failed for ${url.href}, trying SSE fallback:`,
      streamableErr instanceof Error ? streamableErr.message : streamableErr
    );
  }

  const sseTransport = new SSEClientTransport(url, requestInit ? { requestInit } : undefined);
  const sseClient = createMcpClient(url.href);
  await withTimeout(
    sseClient.connect(sseTransport),
    CONNECT_TIMEOUT_MS,
    `MCP SSE connection to ${url.href} timed out after ${CONNECT_TIMEOUT_MS}ms`,
    () => sseTransport.close()
  );
  console.log(`[mcp] Connected via SSE (legacy) to ${url.href}`);
  return {
    client: sseClient,
    async close() {
      await closeQuietly(() => sseTransport.close(), 'SSE transport');
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
}, auditContext?: McpStdioAuditContext): Promise<McpConnection> {
  if (server.transport === 'url') {
    if (!isMcpConfigUrl(server.config)) throw new Error('URL transport requires config.url');
    const urlStr = server.config.url?.trim();
    if (!urlStr) throw new Error('config.url is required for URL transport');
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      throw new Error(`Invalid MCP URL: ${urlStr}`);
    }
    const result = await connectUrlTransport(url, server.config.headers);
    return { client: result.client, close: result.close };
  }

  if (server.transport === 'stdio') {
    if (!isMcpConfigStdio(server.config)) throw new Error('stdio transport requires config.command');
    const command = server.config.command?.trim();
    if (!command) throw new Error('config.command is required for stdio transport');

    const verdict = scanCommand(command, null, false);
    if (verdict.tier === 1) {
      auditMcpStdioConnection(auditContext, {
        command,
        cwd: server.config.cwd,
        blockedPattern: verdict.label,
        isError: true,
      });
      throw new Error(`Refused: command matches a blocked pattern (${verdict.label ?? 'tier-1'})`);
    }

    const transport = new StdioClientTransport({
      command,
      args: Array.isArray(server.config.args) ? server.config.args : [],
      env: buildSafeEnv(server.config.env),
      cwd: server.config.cwd || undefined,
    });
    const client = createMcpClient(command);
    const startedAt = Date.now();

    try {
      await withTimeout(
        client.connect(transport),
        CONNECT_TIMEOUT_MS,
        `MCP stdio connection timed out after ${CONNECT_TIMEOUT_MS}ms`,
        () => transport.close()
      );
      auditMcpStdioConnection(auditContext, {
        command,
        cwd: server.config.cwd,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      auditMcpStdioConnection(auditContext, {
        command,
        cwd: server.config.cwd,
        durationMs: Date.now() - startedAt,
        isError: true,
      });
      throw err;
    }

    return {
      client,
      async close() {
        await closeQuietly(() => transport.close(), 'stdio transport');
      },
    };
  }

  throw new Error(`Unsupported MCP transport: ${server.transport}`);
}

function normalizeToolName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, '_')
    .replace(/-/g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .toLowerCase() || 'tool';
}

export function prefixToolName(prefix: string, name: string): string {
  const normalized = normalizeToolName(name);
  const prefixed = prefix ? `${prefix.replace(/[^a-z0-9_]/gi, '_')}_${normalized}` : normalized;
  return prefixed || 'tool';
}

export function unprefixToolName(prefix: string, prefixedName: string): string {
  if (!prefix) return prefixedName;
  const p = prefix.replace(/[^a-z0-9_]/gi, '_');
  if (!p || !prefixedName.startsWith(p + '_')) return prefixedName;
  return prefixedName.slice(p.length + 1);
}

function inputSchemaToOpenAIParameters(inputSchema: Record<string, unknown>): Record<string, unknown> {
  const schema = inputSchema && typeof inputSchema === 'object' ? { ...inputSchema } : {} as Record<string, unknown>;
  if (schema.type !== 'object') schema.type = 'object';
  if (!schema.properties || typeof schema.properties !== 'object') schema.properties = {};
  if (!Array.isArray(schema.required)) schema.required = [];
  return schema;
}

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
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  openAIDef: {
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  };
}

const toolCache = new WeakMap<Client, { fetchedAt: number; namePrefix: string; tools: McpToolDef[] }>();

function uniqueToolName(baseName: string, used: Map<string, number>): string {
  const count = used.get(baseName) || 0;
  used.set(baseName, count + 1);
  return count === 0 ? baseName : `${baseName}_${count + 1}`;
}

export function invalidateMcpToolCache(client: Client): void {
  toolCache.delete(client);
}

export async function listMcpTools(client: Client, namePrefix: string): Promise<McpToolDef[]> {
  const now = Date.now();
  const cached = toolCache.get(client);
  if (cached && cached.namePrefix === namePrefix && now - cached.fetchedAt < TOOL_CACHE_TTL_MS) {
    return cached.tools;
  }

  const allTools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown>; [key: string]: unknown }> = [];
  let cursor: string | undefined;
  do {
    const response = await client.listTools(cursor ? { cursor } : undefined);
    allTools.push(...(response.tools as typeof allTools));
    cursor = (response as { nextCursor?: string }).nextCursor;
  } while (cursor);

  const result: McpToolDef[] = [];
  const usedNames = new Map<string, number>();

  for (const tool of allTools) {
    const mcpName = tool.name || 'unnamed';
    const baseDisplayName = prefixToolName(namePrefix, mcpName);
    const displayName = uniqueToolName(baseDisplayName, usedNames);
    if (displayName !== baseDisplayName) {
      console.warn(`[mcp] Tool name collision for ${baseDisplayName}; exposed as ${displayName}`);
    }

    const schema = tool.inputSchema && typeof tool.inputSchema === 'object'
      ? tool.inputSchema
      : { type: 'object' as const, properties: {}, required: [] as string[] };
    const parameters = inputSchemaToOpenAIParameters(schema as Record<string, unknown>);
    const desc = typeof tool.description === 'string' ? tool.description : (tool.description ?? '');
    const rawTitle = (tool as Record<string, unknown>).title;
    const title = typeof rawTitle === 'string' ? rawTitle : '';
    const rawAnnotations = (tool as Record<string, unknown>).annotations;
    const annotations = rawAnnotations && typeof rawAnnotations === 'object'
      ? rawAnnotations as Record<string, unknown>
      : undefined;
    const baseDescription = title && desc ? `${title}. ${desc}` : title ? title : desc || 'MCP tool';
    const description = baseDescription + buildAnnotationHints(annotations);
    const openAIDescription = description + (namePrefix ? ` You must call this tool using its exact name: ${displayName}.` : '');

    result.push({
      name: displayName,
      mcpToolName: mcpName,
      title: title || undefined,
      description,
      inputSchema: schema as Record<string, unknown>,
      annotations,
      openAIDef: {
        type: 'function',
        function: { name: displayName, description: openAIDescription, parameters },
      },
    });
  }

  toolCache.set(client, { fetchedAt: now, namePrefix, tools: result });
  return result;
}

export interface McpToolCallResult {
  output: string;
  isError: boolean;
  content: unknown[];
  structuredContent?: Record<string, unknown>;
}

function truncateText(text: string): string {
  if (text.length <= MAX_TEXT_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TEXT_RESULT_CHARS)}\n\n[Output truncated to ${MAX_TEXT_RESULT_CHARS} characters]`;
}

export async function callMcpToolDetailed(
  client: Client,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number = TOOL_CALL_TIMEOUT_MS
): Promise<McpToolCallResult> {
  const result = await withTimeout(
    client.callTool({ name: toolName, arguments: args }),
    timeoutMs,
    `MCP tool call "${toolName}" timed out after ${timeoutMs}ms`
  );

  const content = Array.isArray(result?.content) ? result.content : [];
  const isError = (result as { isError?: boolean })?.isError === true;
  const structuredContent = (result as { structuredContent?: Record<string, unknown> })?.structuredContent;

  const parts: string[] = [];
  if (isError) parts.push('[Tool execution error]');

  for (const item of content) {
    if (!item || typeof item !== 'object' || !('type' in item)) continue;
    const t = (item as { type: string }).type;
    if (t === 'text' && 'text' in item) {
      parts.push(String((item as { text: string }).text));
    } else if (t === 'image' && 'data' in item) {
      const img = item as { data: string; mimeType?: string };
      parts.push(`[Image: ${img.mimeType || 'image/png'}, ${img.data ? img.data.length : 0} bytes of base64 data]`);
    } else if (t === 'audio' && 'data' in item) {
      const audio = item as { data: string; mimeType?: string };
      parts.push(`[Audio: ${audio.mimeType || 'audio/wav'}, ${audio.data ? audio.data.length : 0} bytes of base64 data]`);
    } else if (t === 'resource' && 'resource' in item) {
      const res = (item as { resource: { uri?: string; mimeType?: string; text?: string } }).resource;
      parts.push(res.text ? res.text : `[Embedded resource: ${res.uri || 'unknown'} (${res.mimeType || 'unknown type'})]`);
    } else if (t === 'resource_link' && 'uri' in item && 'name' in item) {
      const r = item as { uri: string; name: string; description?: string };
      parts.push(r.description ? `Resource: ${r.name} (${r.uri}) — ${r.description}` : `Resource: ${r.name} (${r.uri})`);
    } else {
      parts.push(`[Unsupported MCP content block: ${t}]`);
    }
  }

  if (structuredContent && Object.keys(structuredContent).length > 0) {
    try { parts.push(JSON.stringify(structuredContent)); } catch { /* ignore */ }
  }

  const output = parts.length === 0 ? JSON.stringify(result ?? {}) : truncateText(parts.join('\n\n'));
  return { output, isError, content, structuredContent };
}

export async function callMcpTool(
  client: Client,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number = TOOL_CALL_TIMEOUT_MS
): Promise<string> {
  return (await callMcpToolDetailed(client, toolName, args, timeoutMs)).output;
}
