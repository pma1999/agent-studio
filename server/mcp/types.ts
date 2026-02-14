/**
 * MCP server config and DB row types.
 */

export interface McpConfigUrl {
  url: string;
}

export interface McpConfigStdio {
  command: string;
  args?: string[];
}

export type McpServerConfig = McpConfigUrl | McpConfigStdio;

export type McpTransport = 'url' | 'stdio';

export interface McpServerRow {
  id: string;
  name: string;
  transport: McpTransport;
  config: string;
  created_at: string;
  updated_at: string;
}

export interface McpServerParsed {
  id: string;
  name: string;
  transport: McpTransport;
  config: McpServerConfig;
  created_at: string;
  updated_at: string;
}

export function isMcpConfigUrl(config: McpServerConfig): config is McpConfigUrl {
  return 'url' in config && typeof (config as McpConfigUrl).url === 'string';
}

export function isMcpConfigStdio(config: McpServerConfig): config is McpConfigStdio {
  return 'command' in config && typeof (config as McpConfigStdio).command === 'string';
}
