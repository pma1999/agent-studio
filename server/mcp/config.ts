import { createHash } from 'node:crypto';
import { decrypt, encrypt, hasEncryptionKey } from '../crypto.js';
import type {
  McpConfigStdio,
  McpConfigUrl,
  McpServerConfig,
  McpTransport,
  McpUrlAuth,
} from './types.js';

const ENCRYPTED_CONFIG_PREFIX = 'mcp:v1:';
export const MCP_SECRET_PLACEHOLDER = '__AGENT_STUDIO_SECRET__';

const MAX_URL_LENGTH = 4_096;
const MAX_COMMAND_LENGTH = 4_096;
const MAX_ARGUMENTS = 256;
const MAX_ARGUMENT_LENGTH = 16_384;
const MAX_ENV_ENTRIES = 256;
const MAX_SECRET_LENGTH = 65_536;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const ENV_NAME = /^[^=\0]+$/;
const MANAGED_OR_HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'mcp-method',
  'mcp-name',
  'mcp-protocol-version',
  'mcp-session-id',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unsupported field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
  }
}

function normalizeStringRecord(
  value: unknown,
  label: string,
  options: { maxEntries: number; validateKey?: (key: string) => void }
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${label} must be an object of string key-value pairs`);
  const entries = Object.entries(value);
  if (entries.length > options.maxEntries) throw new Error(`${label} has too many entries`);
  const normalized: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (typeof raw !== 'string') throw new Error(`${label}.${key} must be a string`);
    if (raw.length > MAX_SECRET_LENGTH) throw new Error(`${label}.${key} is too long`);
    if (raw.includes('\0') || /[\r\n]/.test(raw)) throw new Error(`${label}.${key} contains forbidden control characters`);
    options.validateKey?.(key);
    normalized[key] = raw;
  }
  return normalized;
}

function normalizeHeaders(value: unknown): Record<string, string> | undefined {
  return normalizeStringRecord(value, 'config.headers', {
    maxEntries: 128,
    validateKey: (key) => {
      if (!HEADER_NAME.test(key)) throw new Error(`Invalid HTTP header name: ${key}`);
      if (MANAGED_OR_HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
        throw new Error(`HTTP header ${key} is managed by the MCP client and cannot be overridden`);
      }
    },
  });
}

function normalizeEnv(value: unknown): Record<string, string> | undefined {
  return normalizeStringRecord(value, 'config.env', {
    maxEntries: MAX_ENV_ENTRIES,
    validateKey: (key) => {
      if (!ENV_NAME.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
    },
  });
}

function secretFromIncoming(incoming: unknown, previous: string | undefined, label: string): string {
  if (incoming === MCP_SECRET_PLACEHOLDER) {
    if (previous === undefined) throw new Error(`${label} cannot use the secret placeholder on a new configuration`);
    return previous;
  }
  if (typeof incoming !== 'string' || incoming.length === 0) throw new Error(`${label} is required`);
  if (incoming.length > MAX_SECRET_LENGTH) throw new Error(`${label} is too long`);
  if (incoming.includes('\0') || /[\r\n]/.test(incoming)) throw new Error(`${label} contains forbidden control characters`);
  return incoming;
}

function restoreSecretRecord(
  incoming: Record<string, string> | undefined,
  previous: Record<string, string> | undefined,
  label: string
): Record<string, string> | undefined {
  if (!incoming) return incoming;
  const restored: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    restored[key] = value === MCP_SECRET_PLACEHOLDER
      ? secretFromIncoming(value, previous?.[key], `${label}.${key}`)
      : value;
  }
  return restored;
}

function normalizeAuth(value: unknown, previous?: McpUrlAuth): McpUrlAuth | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('config.auth must be an object');
  if (value.type === 'bearer') {
    assertAllowedKeys(value, ['type', 'token'], 'config.auth');
    return {
      type: 'bearer',
      token: secretFromIncoming(value.token, previous?.type === 'bearer' ? previous.token : undefined, 'config.auth.token'),
    };
  }
  if (value.type === 'client_credentials') {
    assertAllowedKeys(value, ['type', 'clientId', 'clientSecret', 'scope', 'expectedIssuer'], 'config.auth');
    if (typeof value.clientId !== 'string' || !value.clientId.trim()) throw new Error('config.auth.clientId is required');
    if (typeof value.expectedIssuer !== 'string' || !value.expectedIssuer.trim()) {
      throw new Error('config.auth.expectedIssuer is required to bind client credentials to an authorization server');
    }
    let issuer: URL;
    try {
      issuer = new URL(value.expectedIssuer.trim());
    } catch {
      throw new Error('config.auth.expectedIssuer must be a valid URL');
    }
    if (issuer.protocol !== 'https:' || issuer.username || issuer.password) {
      throw new Error('config.auth.expectedIssuer must be an HTTPS URL without embedded credentials');
    }
    if (value.scope !== undefined && typeof value.scope !== 'string') throw new Error('config.auth.scope must be a string');
    return {
      type: 'client_credentials',
      clientId: value.clientId.trim(),
      clientSecret: secretFromIncoming(
        value.clientSecret,
        previous?.type === 'client_credentials' ? previous.clientSecret : undefined,
        'config.auth.clientSecret'
      ),
      expectedIssuer: issuer.href,
      ...(typeof value.scope === 'string' && value.scope.trim() ? { scope: value.scope.trim() } : {}),
    };
  }
  throw new Error('config.auth.type must be "bearer" or "client_credentials"');
}

export function executionFingerprint(config: Pick<McpConfigStdio, 'command' | 'args' | 'env' | 'cwd'>): string {
  const env = Object.fromEntries(Object.entries(config.env ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify({
    command: config.command,
    args: config.args ?? [],
    env,
    cwd: config.cwd ?? null,
  })).digest('hex');
}

export function hasValidExecutionApproval(config: McpConfigStdio): boolean {
  return Boolean(
    config.executionApproval
    && config.executionApproval.fingerprint === executionFingerprint(config)
    && !Number.isNaN(Date.parse(config.executionApproval.approvedAt))
  );
}

export interface NormalizeMcpConfigOptions {
  previous?: McpServerConfig | null;
  localExecutionApproved?: boolean;
  /** Imports intentionally set this false so approval is always renewed locally. */
  requireExecutionApproval?: boolean;
}

export function normalizeMcpConfig(
  transport: McpTransport,
  input: unknown,
  options: NormalizeMcpConfigOptions = {}
): McpServerConfig {
  if (!isRecord(input)) throw new Error('config must be an object');

  if (transport === 'url') {
    assertAllowedKeys(input, ['url', 'headers', 'allowPrivateNetwork', 'allowInsecureHttp', 'auth'], 'config');
    if (typeof input.url !== 'string' || !input.url.trim()) throw new Error('config.url is required for URL transport');
    if (input.url.length > MAX_URL_LENGTH) throw new Error('config.url is too long');
    const previous = options.previous && 'url' in options.previous ? options.previous : undefined;
    const maskedPrevious = previous ? maskMcpConfig(previous) : undefined;
    const publicPreviousUrl = maskedPrevious && 'url' in maskedPrevious ? maskedPrevious.url : undefined;
    const incomingUrl = publicPreviousUrl !== undefined && input.url.trim() === publicPreviousUrl
      ? previous!.url
      : input.url.trim();
    let url: URL;
    try {
      url = new URL(incomingUrl);
    } catch {
      throw new Error('config.url must be a valid absolute URL');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('MCP URL must use https:// or http://');
    if (url.username || url.password) throw new Error('MCP URL must not contain embedded credentials');
    const allowPrivateNetwork = input.allowPrivateNetwork === true;
    const allowInsecureHttp = input.allowInsecureHttp === true;
    if (input.allowPrivateNetwork !== undefined && typeof input.allowPrivateNetwork !== 'boolean') {
      throw new Error('config.allowPrivateNetwork must be a boolean');
    }
    if (input.allowInsecureHttp !== undefined && typeof input.allowInsecureHttp !== 'boolean') {
      throw new Error('config.allowInsecureHttp must be a boolean');
    }
    if (url.protocol === 'http:' && !allowInsecureHttp) {
      throw new Error('Clear-text HTTP is disabled; explicitly enable allowInsecureHttp only for a trusted development server');
    }

    const headers = restoreSecretRecord(normalizeHeaders(input.headers), previous?.headers, 'config.headers');
    const auth = normalizeAuth(input.auth, previous?.auth);
    if (auth && Object.keys(headers ?? {}).some((key) => key.toLowerCase() === 'authorization')) {
      throw new Error('Configure either config.auth or an Authorization header, not both');
    }
    const normalized: McpConfigUrl = {
      url: url.href,
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
      ...(allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
      ...(allowInsecureHttp ? { allowInsecureHttp: true } : {}),
      ...(auth ? { auth } : {}),
    };
    return normalized;
  }

  assertAllowedKeys(input, ['command', 'args', 'env', 'cwd', 'executionApproval'], 'config');
  if (typeof input.command !== 'string' || !input.command.trim()) throw new Error('config.command is required');
  const command = input.command.trim();
  if (command.length > MAX_COMMAND_LENGTH || /[\r\n\0]/.test(command)) throw new Error('config.command is invalid or too long');
  let args: string[] | undefined;
  if (input.args !== undefined) {
    if (!Array.isArray(input.args) || !input.args.every((arg) => typeof arg === 'string')) {
      throw new Error('config.args must be an array of strings');
    }
    if (input.args.length > MAX_ARGUMENTS) throw new Error('config.args has too many entries');
    if (input.args.some((arg) => arg.length > MAX_ARGUMENT_LENGTH || arg.includes('\0'))) {
      throw new Error('config.args contains an invalid or oversized argument');
    }
    args = [...input.args];
  }
  const incomingEnv = normalizeEnv(input.env);
  const previous = options.previous && 'command' in options.previous ? options.previous : undefined;
  const env = restoreSecretRecord(incomingEnv, previous?.env, 'config.env');
  if (input.cwd !== undefined && (typeof input.cwd !== 'string' || /[\r\n\0]/.test(input.cwd))) {
    throw new Error('config.cwd must be a valid string');
  }
  const normalized: McpConfigStdio = {
    command,
    ...(args && args.length > 0 ? { args } : {}),
    ...(env && Object.keys(env).length > 0 ? { env } : {}),
    ...(typeof input.cwd === 'string' && input.cwd.trim() ? { cwd: input.cwd.trim() } : {}),
  };
  const fingerprint = executionFingerprint(normalized);
  const approvalStillMatches = previous?.executionApproval?.fingerprint === fingerprint
    && hasValidExecutionApproval(previous);
  if (options.localExecutionApproved === true) {
    normalized.executionApproval = { fingerprint, approvedAt: new Date().toISOString() };
  } else if (approvalStillMatches && previous?.executionApproval) {
    normalized.executionApproval = previous.executionApproval;
  } else if (options.requireExecutionApproval !== false) {
    throw new Error('Explicit approval is required for this exact local command, arguments, environment, and working directory');
  }
  return normalized;
}

export function serializeMcpConfig(config: McpServerConfig): string {
  if (!hasEncryptionKey()) {
    throw new Error('ENCRYPTION_KEY must be configured before MCP server credentials can be stored');
  }
  return `${ENCRYPTED_CONFIG_PREFIX}${encrypt(JSON.stringify(config))}`;
}

export function parseStoredMcpConfig(stored: string | null | undefined): McpServerConfig | null {
  if (!stored) return null;
  try {
    const json = stored.startsWith(ENCRYPTED_CONFIG_PREFIX)
      ? decrypt(stored.slice(ENCRYPTED_CONFIG_PREFIX.length))
      : stored;
    const parsed = JSON.parse(json) as unknown;
    return isRecord(parsed) ? parsed as unknown as McpServerConfig : null;
  } catch {
    return null;
  }
}

export function isEncryptedMcpConfig(stored: string | null | undefined): boolean {
  return typeof stored === 'string' && stored.startsWith(ENCRYPTED_CONFIG_PREFIX);
}

export function maskMcpConfig(config: McpServerConfig): McpServerConfig {
  if ('url' in config) {
    const headers = config.headers
      ? Object.fromEntries(Object.keys(config.headers).map((key) => [key, MCP_SECRET_PLACEHOLDER]))
      : undefined;
    const auth = config.auth?.type === 'bearer'
      ? { type: 'bearer' as const, token: MCP_SECRET_PLACEHOLDER }
      : config.auth?.type === 'client_credentials'
        ? { ...config.auth, clientSecret: MCP_SECRET_PLACEHOLDER }
        : undefined;
    let publicUrl = config.url;
    try {
      const url = new URL(config.url);
      if (url.search) url.search = `?${MCP_SECRET_PLACEHOLDER}`;
      if (url.hash) url.hash = `#${MCP_SECRET_PLACEHOLDER}`;
      publicUrl = url.href;
    } catch {
      publicUrl = '[invalid MCP URL]';
    }
    return {
      ...config,
      url: publicUrl,
      ...(headers ? { headers } : {}),
      ...(auth ? { auth } : {}),
    };
  }
  const env = config.env
    ? Object.fromEntries(Object.keys(config.env).map((key) => [key, MCP_SECRET_PLACEHOLDER]))
    : undefined;
  return {
    ...config,
    ...(env ? { env } : {}),
    ...(config.executionApproval
      ? { executionApproval: { fingerprint: 'approved', approvedAt: config.executionApproval.approvedAt } }
      : {}),
  };
}

/** URL safe for logs: credentials are rejected and the query/fragment are never emitted. */
export function mcpUrlLogLabel(url: URL): string {
  return `${url.origin}${url.pathname}${url.search ? '?[redacted]' : ''}`;
}
