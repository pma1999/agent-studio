/**
 * MCP server config and DB row types.
 */

export interface McpConfigUrl {
  url: string;
  headers?: Record<string, string>;
  /** Explicit opt-in for loopback/private/link-local destinations. */
  allowPrivateNetwork?: boolean;
  /** Explicit opt-in for clear-text HTTP. HTTPS remains the default. */
  allowInsecureHttp?: boolean;
  auth?: McpUrlAuth;
}

export type McpUrlAuth =
  | {
      type: 'bearer';
      token: string;
    }
  | {
      type: 'client_credentials';
      clientId: string;
      clientSecret: string;
      scope?: string;
      /** Authorization-server issuer used to bind the credential. */
      expectedIssuer: string;
    };

export interface McpExecutionApproval {
  /** SHA-256 fingerprint of command + argv + cwd approved by the user. */
  fingerprint: string;
  approvedAt: string;
}

export interface McpConfigStdio {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Stored proof that the exact executable invocation was confirmed. */
  executionApproval?: McpExecutionApproval;
}

export type McpServerConfig = McpConfigUrl | McpConfigStdio;

export type McpTransport = 'url' | 'stdio' | 'relay';

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
