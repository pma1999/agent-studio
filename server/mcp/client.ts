/**
 * Production MCP client helpers.
 *
 * The SDK v2 client negotiates the 2026-07-28 stateless protocol first and
 * deliberately falls back to the 2025 initialize era when a server is old.
 * This module owns host policy around transport safety, tenant-scoped caches,
 * schema validation, timeouts/cancellation, result bounds, and cleanup.
 */

import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import { lookup as dnsLookupPromise } from 'node:dns/promises';
import net from 'node:net';
import type { LookupFunction } from 'node:net';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import {
  Agent as UndiciAgent,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
} from 'undici';
import {
  Client,
  ClientCredentialsProvider,
  InMemoryResponseCacheStore,
  SSEClientTransport,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  type AuthProvider,
  type FetchLike,
  type GetPromptResult,
  type JsonSchemaType,
  type ListPromptsResult,
  type ListResourcesResult,
  type ListResourceTemplatesResult,
  type Progress,
  type ReadResourceResult,
  type RequestOptions,
  type ServerCapabilities,
  type Tool,
} from '@modelcontextprotocol/client';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { McpConfigStdio, McpConfigUrl, McpServerConfig, McpTransport } from './types.js';
import { isMcpConfigUrl, isMcpConfigStdio } from './types.js';
import { getOrCreateRelaySession } from './relaySessions.js';
import { hasValidExecutionApproval, mcpUrlLogLabel } from './config.js';
import { scanCommand } from '../../shared/commandSafety.js';
import { logToolExecution } from '../tools/execAudit.js';

const MCP_CLIENT_NAME = 'agent-studio';
const MCP_CLIENT_VERSION = '2.0.0';
const CONNECT_TIMEOUT_MS = 15_000;
const TOOL_CALL_TIMEOUT_MS = 60_000;
const TOOL_CALL_MAX_TOTAL_TIMEOUT_MS = 5 * 60_000;
const LIST_TIMEOUT_MS = 30_000;
const HTTP_SESSION_TERMINATION_TIMEOUT_MS = 1_500;
const MAX_TEXT_RESULT_CHARS = 64_000;
const MAX_CONTENT_BLOCKS = 128;
const MAX_BINARY_BASE64_CHARS = 4 * 1024 * 1024;
const MAX_HTTP_RESPONSE_BYTES = (() => {
  const parsed = Number.parseInt(process.env.MCP_HTTP_RESPONSE_MAX_BYTES || '', 10);
  return Number.isFinite(parsed) && parsed >= 1_048_576
    ? Math.min(parsed, 64 * 1024 * 1024)
    : 16 * 1024 * 1024;
})();
const MAX_STDIO_BUFFER_BYTES = 10 * 1024 * 1024;
const MAX_STDIO_STDERR_LOG_LINES = 8;
const MAX_STDIO_STDERR_LOG_CHARS = 8_192;
const MAX_STDIO_STDERR_LINE_CHARS = 1_000;
const MAX_STDIO_STDERR_PENDING_CHARS = 4_096;
const MAX_SHARED_CACHE_STORES = 256;
const MCP_STDIO_AUDIT_TOOL_NAME = 'mcp_stdio_connect';
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

const schemaValidator = new AjvJsonSchemaValidator();
const sharedCacheStores = new Map<string, InMemoryResponseCacheStore>();
const clientCacheStores = new WeakMap<Client, InMemoryResponseCacheStore>();
const credentialProviders = new Map<string, ClientCredentialsProvider>();

interface ToolRuntimeInfo {
  definition: Tool;
  validateInput?: (input: unknown) =>
    | { valid: true; data: Record<string, unknown>; errorMessage: undefined }
    | { valid: false; data: undefined; errorMessage: string };
  inputSchemaError?: string;
}

interface ToolCatalogEntry {
  definition: Tool;
  parameters: Record<string, unknown>;
  runtime: ToolRuntimeInfo;
}

interface ToolCatalogSnapshot {
  entries: ToolCatalogEntry[];
  runtime: Map<string, ToolRuntimeInfo>;
}

interface ToolCatalogState {
  /** Monotonic invalidation epoch. A refresh may only commit to its own epoch. */
  revision: number;
  stale: boolean;
  snapshot?: ToolCatalogSnapshot;
  refresh?: Promise<void>;
}

const toolCatalogByClient = new WeakMap<Client, ToolCatalogState>();

export interface McpConnectionInfo {
  protocolEra: 'modern' | 'legacy';
  protocolVersion?: string;
  serverInfo?: { name: string; version: string; [key: string]: unknown };
  capabilities?: ServerCapabilities;
  instructions?: string;
  transport: 'streamable-http' | 'sse' | 'stdio' | 'relay';
}

export interface McpConnection {
  client: Client;
  info: McpConnectionInfo;
  close(): Promise<void>;
}

export interface McpRequestControl {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxTotalTimeoutMs?: number;
  onProgress?: (progress: Progress) => void;
}

interface McpStdioAuditContext {
  userId: string;
  conversationId?: string;
}

/**
 * Build the intentionally small environment inherited by backend-hosted MCP
 * children. Explicit server variables win, but unrelated backend secrets are
 * never inherited.
 */
export function buildSafeEnv(configEnv?: Record<string, string>): Record<string, string> {
  const safeEnv: Record<string, string> = {};
  for (const key of SAFE_STDIO_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) safeEnv[key] = value;
  }
  return { ...safeEnv, ...(configEnv ?? {}) };
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
    // Only the executable is logged. argv/env can contain credentials.
    command: details.command,
    cwd: details.cwd ?? null,
    durationMs: details.durationMs,
    blockedPattern: details.blockedPattern,
    isError: details.isError,
  });
}

function stableHash(value: unknown, length = 16): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length);
}

function touchBoundedMap<K, V>(map: Map<K, V>, key: K, value: V, max: number): V {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    const evicted = map.get(oldest);
    map.delete(oldest);
    if (evicted instanceof InMemoryResponseCacheStore) evicted.clear();
  }
  return value;
}

function responseCacheFor(cacheKey: string): InMemoryResponseCacheStore {
  const existing = sharedCacheStores.get(cacheKey);
  if (existing) return touchBoundedMap(sharedCacheStores, cacheKey, existing, MAX_SHARED_CACHE_STORES);
  return touchBoundedMap(
    sharedCacheStores,
    cacheKey,
    new InMemoryResponseCacheStore({ maxEntries: 256 }),
    MAX_SHARED_CACHE_STORES
  );
}

function toolCatalogStateFor(client: Client): ToolCatalogState {
  const existing = toolCatalogByClient.get(client);
  if (existing) return existing;
  const created: ToolCatalogState = { revision: 0, stale: true };
  toolCatalogByClient.set(client, created);
  return created;
}

function markMcpToolCatalogStale(client: Client): void {
  const state = toolCatalogStateFor(client);
  state.revision += 1;
  state.stale = true;
  state.snapshot = undefined;
  // The SDK also performs this eviction before dispatching list_changed. Keep
  // this explicit for manual invalidation and tolerate asynchronous stores.
  void Promise.resolve(clientCacheStores.get(client)?.evict('tools/list')).catch(() => undefined);
}

/**
 * Construct the single SDK client policy used by HTTP, stdio, and relay.
 * Exported for the custom relay transport so all transports advertise and
 * negotiate identically.
 */
export function createConfiguredMcpClient(label: string, cacheKey: string, cachePartition: string): Client {
  const store = responseCacheFor(cacheKey);
  let client: Client;
  client = new Client(
    { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
    {
      capabilities: {},
      enforceStrictCapabilities: true,
      versionNegotiation: {
        mode: 'auto',
        probe: { timeoutMs: Math.min(CONNECT_TIMEOUT_MS, 5_000), maxRetries: 0 },
      },
      inputRequired: { autoFulfill: false, maxRounds: 4 },
      listMaxPages: 64,
      defaultCacheTtlMs: 0,
      responseCacheStore: store,
      cachePartition,
      listChanged: {
        tools: {
          autoRefresh: false,
          // Tool safety cannot tolerate a debounce window in which an old
          // schema remains callable after list_changed has been received.
          debounceMs: 0,
          onChanged: (error) => {
            markMcpToolCatalogStale(client);
            if (error) console.warn(`[mcp] Tool catalog notification failed for ${label}: ${error.message}`);
          },
        },
        prompts: {
          autoRefresh: false,
          debounceMs: 250,
          onChanged: (error) => {
            if (error) console.warn(`[mcp] Prompt catalog notification failed for ${label}: ${error.message}`);
          },
        },
        resources: {
          autoRefresh: false,
          debounceMs: 250,
          onChanged: (error) => {
            if (error) console.warn(`[mcp] Resource catalog notification failed for ${label}: ${error.message}`);
          },
        },
      },
    }
  );
  clientCacheStores.set(client, store);
  toolCatalogStateFor(client);
  return client;
}

export function invalidateMcpToolCache(client: Client): void {
  markMcpToolCatalogStale(client);
}

function connectionInfo(client: Client, transport: McpConnectionInfo['transport']): McpConnectionInfo {
  const era = client.getProtocolEra();
  if (era !== 'modern' && era !== 'legacy') throw new Error('MCP connection completed without a negotiated protocol era');
  const serverInfo = client.getServerVersion();
  return {
    protocolEra: era,
    protocolVersion: client.getNegotiatedProtocolVersion(),
    ...(serverInfo ? { serverInfo } : {}),
    capabilities: client.getServerCapabilities(),
    instructions: client.getInstructions(),
    transport,
  };
}

function makeConnection(
  client: Client,
  transport: McpConnectionInfo['transport'],
  terminateHttpSession?: () => Promise<void>,
  closeNetworkDispatcher?: () => Promise<void>
): McpConnection {
  let closed = false;
  return {
    client,
    info: connectionInfo(client, transport),
    async close() {
      if (closed) return;
      closed = true;
      if (terminateHttpSession) {
        const outcome = await settleWithin(terminateHttpSession, HTTP_SESSION_TERMINATION_TIMEOUT_MS);
        if (outcome.kind === 'error'
          && !(outcome.error instanceof SdkError && outcome.error.code === SdkErrorCode.NotConnected)) {
          console.warn('[mcp] Failed to terminate HTTP session cleanly:', outcome.error instanceof Error ? outcome.error.message : outcome.error);
        } else if (outcome.kind === 'timeout') {
          console.warn(`[mcp] HTTP session termination exceeded ${HTTP_SESSION_TERMINATION_TIMEOUT_MS}ms; closing transport`);
        }
      }
      try {
        // Always close the client immediately after the bounded, best-effort
        // DELETE attempt. A stuck remote endpoint must not pin local sockets.
        const outcome = await settleWithin(() => client.close(), HTTP_SESSION_TERMINATION_TIMEOUT_MS);
        if (outcome.kind === 'timeout') {
          console.warn(`[mcp] Client transport close exceeded ${HTTP_SESSION_TERMINATION_TIMEOUT_MS}ms; force-closing network dispatcher`);
        } else if (outcome.kind === 'error') {
          throw outcome.error;
        }
      } finally {
        toolCatalogByClient.delete(client);
        if (closeNetworkDispatcher) {
          const dispatcherOutcome = await settleWithin(closeNetworkDispatcher, HTTP_SESSION_TERMINATION_TIMEOUT_MS);
          if (dispatcherOutcome.kind === 'timeout') {
            console.warn(`[mcp] Network dispatcher close exceeded ${HTTP_SESSION_TERMINATION_TIMEOUT_MS}ms`);
          } else if (dispatcherOutcome.kind === 'error') {
            console.warn('[mcp] Network dispatcher close failed:', dispatcherOutcome.error instanceof Error ? dispatcherOutcome.error.message : dispatcherOutcome.error);
          }
        }
      }
    },
  };
}

type BoundedOutcome = { kind: 'ok' } | { kind: 'error'; error: unknown } | { kind: 'timeout' };

async function settleWithin(operation: () => Promise<void>, timeoutMs: number): Promise<BoundedOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operationOutcome = Promise.resolve()
    .then(operation)
    .then<BoundedOutcome, BoundedOutcome>(() => ({ kind: 'ok' }), (error: unknown) => ({ kind: 'error', error }));
  const timeoutOutcome = new Promise<BoundedOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([operationOutcome, timeoutOutcome]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closeFailedClient(client: Client | null): Promise<void> {
  if (!client) return;
  try {
    await client.close();
  } catch {
    // Preserve the original connection error.
  }
}

type AddressClass = 'public' | 'private' | 'forbidden';

function classifyIpv4(address: string): AddressClass {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return 'forbidden';
  const [a, b, c] = octets;
  if (a === 0 || a >= 224) return 'forbidden';
  if (a === 10 || a === 127) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'private';
  // Link-local ranges include cloud metadata endpoints and remain blocked even
  // when ordinary private-network access is explicitly enabled.
  if (a === 169 && b === 254) return 'forbidden';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && (b === 0 || b === 168)) return 'private';
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return 'private';
  if (a === 203 && b === 0 && c === 113) return 'private';
  return 'public';
}

function ipv6Words(address: string): number[] | null {
  let value = address;
  const dottedTail = value.match(/(^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dottedTail) {
    const octets = dottedTail[2].split('.').map(Number);
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    value = `${value.slice(0, value.length - dottedTail[2].length)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const raw = halves.length === 2 ? [...left, ...Array(missing).fill('0'), ...right] : left;
  if (raw.length !== 8 || raw.some((word) => !/^[0-9a-f]{1,4}$/i.test(word))) return null;
  return raw.map((word) => Number.parseInt(word, 16));
}

function embeddedIpv4(words: number[], offset: number): string {
  return [words[offset] >> 8, words[offset] & 0xff, words[offset + 1] >> 8, words[offset + 1] & 0xff].join('.');
}

function classifyIp(address: string): AddressClass {
  const clean = address.toLowerCase().split('%')[0];
  if (net.isIP(clean) === 4) return classifyIpv4(clean);
  if (net.isIP(clean) !== 6) return 'forbidden';
  const words = ipv6Words(clean);
  if (!words) return 'forbidden';
  if (words.every((word) => word === 0) || words[0] === 0xff00) return 'forbidden';
  if ((words[0] & 0xff00) === 0xff00) return 'forbidden'; // multicast
  if ((words[0] & 0xffc0) === 0xfe80) return 'forbidden'; // link-local
  if ((words[0] & 0xfe00) === 0xfc00) return 'private'; // unique-local
  if ((words[0] & 0xffc0) === 0xfec0) return 'private'; // deprecated site-local
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return 'private'; // loopback
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return classifyIpv4(embeddedIpv4(words, 6));
  }
  if (words.slice(0, 6).every((word) => word === 0)) {
    return classifyIpv4(embeddedIpv4(words, 6));
  }
  if (words[0] === 0x0064 && words[1] === 0xff9b && words.slice(2, 6).every((word) => word === 0)) {
    return classifyIpv4(embeddedIpv4(words, 6)); // well-known NAT64 prefix
  }
  if (words[0] === 0x2002) return classifyIpv4(embeddedIpv4(words, 1)); // 6to4
  if (words[0] === 0x2001 && words[1] === 0x0000) return 'private'; // Teredo transition range
  if (words[0] === 0x2001 && words[1] === 0x0db8) return 'private'; // documentation
  return words[0] >= 0x2000 && words[0] <= 0x3fff ? 'public' : 'forbidden';
}

/** Resolve and enforce the network boundary before every HTTP request. */
export async function assertSafeMcpUrl(url: URL, config: Pick<McpConfigUrl, 'allowPrivateNetwork' | 'allowInsecureHttp'>): Promise<void> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('MCP URL must use https:// or http://');
  if (url.username || url.password) throw new Error('MCP URL must not contain embedded credentials');
  if (url.protocol === 'http:' && config.allowInsecureHttp !== true) {
    throw new Error('Clear-text MCP HTTP is disabled for this server');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  let addresses: string[];
  if (net.isIP(hostname)) {
    addresses = [hostname];
  } else {
    const resolved = await dnsLookupPromise(hostname, { all: true, verbatim: true });
    addresses = resolved.map((entry) => entry.address);
  }
  assertAllowedAddresses(hostname, addresses, config);
}

function assertAllowedAddresses(
  hostname: string,
  addresses: string[],
  config: Pick<McpConfigUrl, 'allowPrivateNetwork'>
): void {
  if (addresses.length === 0) throw new Error(`MCP host ${hostname} did not resolve to an address`);
  for (const address of addresses) {
    const classification = classifyIp(address);
    if (classification === 'forbidden') throw new Error(`MCP host ${hostname} resolved to a forbidden address`);
    if (classification === 'private' && config.allowPrivateNetwork !== true) {
      throw new Error(`MCP host ${hostname} resolves to a private or local address; explicit private-network approval is required`);
    }
  }
}

interface GuardedFetchHandle {
  fetch: FetchLike;
  close(): Promise<void>;
}

function boundedHttpResponse(response: Response): Response {
  const declared = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (Number.isFinite(declared) && declared > MAX_HTTP_RESPONSE_BYTES) {
    void response.body?.cancel('MCP response exceeded configured size limit').catch(() => undefined);
    throw new Error(`MCP HTTP response exceeds the ${MAX_HTTP_RESPONSE_BYTES}-byte safety limit`);
  }
  if (!response.body) return response;
  let received = 0;
  const bounded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > MAX_HTTP_RESPONSE_BYTES) {
        controller.error(new Error(`MCP HTTP response exceeds the ${MAX_HTTP_RESPONSE_BYTES}-byte safety limit`));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
  return new Response(bounded, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Validate DNS at the socket boundary, not only before fetch. This closes the
 * classic DNS-rebinding gap between a policy lookup and the actual connect().
 */
function guardedFetchFor(config: McpConfigUrl): GuardedFetchHandle {
  const guardedLookup: LookupFunction = (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true, verbatim: true }, (error, addresses) => {
      if (error) {
        callback(error, '');
        return;
      }
      try {
        assertAllowedAddresses(hostname, addresses.map((entry) => entry.address), config);
      } catch (policyError) {
        const denied = policyError instanceof Error ? policyError : new Error(String(policyError));
        (denied as NodeJS.ErrnoException).code = 'EACCES';
        callback(denied, '');
        return;
      }
      if (options.all) {
        callback(null, addresses);
      } else {
        const selected = addresses[0];
        callback(null, selected.address, selected.family);
      }
    });
  };
  const dispatcher = new UndiciAgent({
    connect: { lookup: guardedLookup },
    connectTimeout: CONNECT_TIMEOUT_MS,
    headersTimeout: TOOL_CALL_MAX_TOTAL_TIMEOUT_MS,
    bodyTimeout: TOOL_CALL_MAX_TOTAL_TIMEOUT_MS,
    maxOrigins: 8,
  });
  const guardedFetch: FetchLike = async (input, init) => {
    const target = input instanceof URL ? input : new URL(input);
    await assertSafeMcpUrl(target, config);
    // Redirects are rejected rather than followed, preventing credentials from
    // crossing origins and forcing every configured endpoint to be explicit.
    const requestInit = {
      ...(init ?? {}),
      redirect: 'error',
      dispatcher,
    } as unknown as UndiciRequestInit;
    const response = await undiciFetch(target, requestInit) as unknown as Response;
    return boundedHttpResponse(response);
  };
  return {
    fetch: guardedFetch,
    async close() {
      const graceful = await settleWithin(() => dispatcher.close(), HTTP_SESSION_TERMINATION_TIMEOUT_MS);
      if (graceful.kind === 'ok') return;
      // Graceful close waits for in-flight requests by design. A timed-out
      // session DELETE is precisely such a request, so abort it explicitly.
      const forced = await settleWithin(() => dispatcher.destroy(), HTTP_SESSION_TERMINATION_TIMEOUT_MS);
      if (forced.kind !== 'ok') {
        console.warn('[mcp] Network dispatcher required forced shutdown and did not settle promptly');
      }
    },
  };
}

function authProviderFor(config: McpConfigUrl, cacheKey: string): AuthProvider | ClientCredentialsProvider | undefined {
  if (!config.auth) return undefined;
  if (config.auth.type === 'bearer') {
    const token = config.auth.token;
    return { token: async () => token };
  }
  const key = `${cacheKey}:${stableHash(config.auth)}`;
  const existing = credentialProviders.get(key);
  if (existing) return touchBoundedMap(credentialProviders, key, existing, MAX_SHARED_CACHE_STORES);
  return touchBoundedMap(
    credentialProviders,
    key,
    new ClientCredentialsProvider({
      clientId: config.auth.clientId,
      clientSecret: config.auth.clientSecret,
      clientName: MCP_CLIENT_NAME,
      expectedIssuer: config.auth.expectedIssuer,
      scope: config.auth.scope,
    }),
    MAX_SHARED_CACHE_STORES
  );
}

function shouldFallBackToSse(error: unknown): boolean {
  if (error instanceof SdkHttpError) {
    if (error.status === 401 || error.status === 403 || error.status === 408 || error.status === 429 || error.status >= 500) return false;
    return [400, 404, 405, 406, 409, 410, 415, 426, 501].includes(error.status);
  }
  if (error instanceof SdkError) {
    return error.code === SdkErrorCode.ClientHttpNotImplemented
      || error.code === SdkErrorCode.ClientHttpUnexpectedContent;
  }
  return false;
}

async function connectUrlTransport(
  config: McpConfigUrl,
  cacheKey: string,
  cachePartition: string
): Promise<McpConnection> {
  const url = new URL(config.url);
  await assertSafeMcpUrl(url, config);
  const label = mcpUrlLogLabel(url);
  const guarded = guardedFetchFor(config);
  const guardedFetch = guarded.fetch;
  const authProvider = authProviderFor(config, cacheKey);
  const requestInit = config.headers && Object.keys(config.headers).length > 0
    ? { headers: config.headers }
    : undefined;

  let streamableClient: Client | null = createConfiguredMcpClient(label, cacheKey, cachePartition);
  try {
    const transport = new StreamableHTTPClientTransport(url, {
      ...(requestInit ? { requestInit } : {}),
      ...(authProvider ? { authProvider } : {}),
      fetch: guardedFetch,
      onInsufficientScope: 'throw',
      maxStepUpRetries: 0,
    });
    await streamableClient.connect(transport, {
      timeout: CONNECT_TIMEOUT_MS,
      maxTotalTimeout: CONNECT_TIMEOUT_MS,
    });
    const connected = makeConnection(
      streamableClient,
      'streamable-http',
      () => transport.terminateSession(),
      guarded.close,
    );
    streamableClient = null;
    console.log(`[mcp] Connected via Streamable HTTP (${connected.info.protocolEra}) to ${label}`);
    return connected;
  } catch (streamableError) {
    await closeFailedClient(streamableClient);
    if (!shouldFallBackToSse(streamableError)) {
      await guarded.close();
      throw streamableError;
    }
    console.warn(`[mcp] Streamable HTTP is unsupported at ${label}; trying deprecated SSE compatibility`);
  }

  let sseClient: Client | null = createConfiguredMcpClient(`${label} (SSE)`, `${cacheKey}:sse`, cachePartition);
  try {
    const transport = new SSEClientTransport(url, {
      ...(requestInit ? { requestInit, eventSourceInit: { fetch: guardedFetch } } : { eventSourceInit: { fetch: guardedFetch } }),
      ...(authProvider ? { authProvider } : {}),
      fetch: guardedFetch,
    });
    await sseClient.connect(transport, {
      timeout: CONNECT_TIMEOUT_MS,
      maxTotalTimeout: CONNECT_TIMEOUT_MS,
    });
    const connected = makeConnection(sseClient, 'sse', undefined, guarded.close);
    sseClient = null;
    console.log(`[mcp] Connected via deprecated SSE compatibility to ${label}`);
    return connected;
  } catch (error) {
    await closeFailedClient(sseClient);
    await guarded.close();
    throw error;
  }
}

function assertApprovedInvocation(config: McpConfigStdio): void {
  if (!hasValidExecutionApproval(config)) {
    throw new Error('This exact local MCP command has not been explicitly approved. Review and save the server configuration again.');
  }
}

function scanInvocation(config: McpConfigStdio): ReturnType<typeof scanCommand> {
  const invocation = [config.command, ...(config.args ?? [])].join(' ');
  return scanCommand(invocation, config.cwd ?? null, false);
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function explicitStdioSecrets(config: McpConfigStdio): string[] {
  const secrets = new Set<string>();
  for (const value of Object.values(config.env ?? {})) {
    if (value.length >= 4) secrets.add(value);
  }
  const args = config.args ?? [];
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    const inline = current.match(/^(?:--?)?(?:api[-_]?key|token|secret|password|passwd|credential|authorization)=(.+)$/i);
    if (inline?.[1] && inline[1].length >= 4) secrets.add(inline[1]);
    if (/^(?:--?)?(?:api[-_]?key|token|secret|password|passwd|credential|authorization)$/i.test(current)) {
      const next = args[index + 1];
      if (next && next.length >= 4) secrets.add(next);
    }
  }
  return [...secrets].sort((left, right) => right.length - left.length);
}

function redactStdioDiagnostic(line: string, explicitSecrets: string[]): string {
  let safe = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  for (const secret of explicitSecrets) {
    safe = safe.replace(new RegExp(regexEscape(secret), 'g'), '[REDACTED]');
  }
  return safe
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [REDACTED]')
    .replace(/((?:api[-_]?key|token|secret|password|passwd|credential|authorization)["'\s:=]+)[^\s,;"']+/gi, '$1[REDACTED]')
    .replace(/([?&](?:api[-_]?key|access_token|token|secret|password|credential)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//[REDACTED]@')
    .replace(/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]')
    .replace(/\b(?:[A-Fa-f0-9]{48,}|[A-Za-z0-9+/=_-]{80,})\b/g, '[REDACTED_TOKEN]');
}

interface StdioStderrDrain {
  close(): Promise<void>;
}

/**
 * Put a piped child stderr stream in flowing mode before spawn/connect. Only a
 * small, aggressively redacted diagnostic prefix is emitted; all later bytes
 * remain drained but are suppressed so a noisy or hostile server cannot block
 * on its pipe or flood logs.
 */
function attachStdioStderrDrain(transport: StdioClientTransport, config: McpConfigStdio): StdioStderrDrain {
  const stream = transport.stderr as Readable | null;
  if (!stream) return { close: async () => undefined };

  const decoder = new StringDecoder('utf8');
  const secrets = explicitStdioSecrets(config);
  const label = config.command;
  let pending = '';
  let loggedLines = 0;
  let loggedChars = 0;
  let suppressed = false;
  let detached = false;

  const suppress = () => {
    if (suppressed) return;
    suppressed = true;
    pending = '';
    console.warn(`[mcp] Further stderr from ${label} is suppressed while the stream continues to be drained`);
  };
  const emit = (rawLine: string) => {
    if (suppressed || rawLine.length === 0) return;
    const safe = redactStdioDiagnostic(rawLine, secrets).slice(0, MAX_STDIO_STDERR_LINE_CHARS);
    if (loggedLines >= MAX_STDIO_STDERR_LOG_LINES
      || loggedChars + safe.length > MAX_STDIO_STDERR_LOG_CHARS) {
      suppress();
      return;
    }
    loggedLines += 1;
    loggedChars += safe.length;
    console.warn(`[mcp] stderr from ${label}: ${safe}`);
  };
  const consumePending = (flush: boolean) => {
    if (suppressed) {
      pending = '';
      return;
    }
    let newline = pending.search(/\r?\n/);
    while (newline >= 0) {
      emit(pending.slice(0, newline));
      pending = pending.slice(newline + (pending[newline] === '\r' ? 2 : 1));
      if (suppressed) return;
      newline = pending.search(/\r?\n/);
    }
    while (pending.length > MAX_STDIO_STDERR_PENDING_CHARS && !suppressed) {
      emit(pending.slice(0, MAX_STDIO_STDERR_LINE_CHARS));
      pending = pending.slice(MAX_STDIO_STDERR_LINE_CHARS);
    }
    if (flush && pending.length > 0) {
      emit(pending);
      pending = '';
    }
  };
  const onData = (chunk: Buffer | string) => {
    if (suppressed) return;
    pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    consumePending(false);
  };
  const onEnd = () => {
    if (!suppressed) pending += decoder.end();
    consumePending(true);
  };
  stream.on('data', onData);
  stream.once('end', onEnd);

  return {
    async close() {
      if (detached) return;
      detached = true;
      onEnd();
      stream.off('data', onData);
      stream.off('end', onEnd);
    },
  };
}

/**
 * Create and connect a client for URL, backend stdio, or paired-PC relay.
 * Callers own the returned connection and must await close().
 */
export async function createAndConnectMcpClient(server: {
  transport: McpTransport;
  config: McpServerConfig;
  serverId?: string;
}, auditContext?: McpStdioAuditContext): Promise<McpConnection> {
  const principal = auditContext?.userId ?? 'single-user';
  const configIdentity = stableHash(server.config);
  // Configuration identity is part of the partition so an endpoint/command
  // mutation can never reuse definitions or resource responses from the old
  // server behind the same database id.
  const cacheKey = `mcp:${principal}:${server.serverId ?? 'anonymous'}:${configIdentity}`;

  if (server.transport === 'url') {
    if (!isMcpConfigUrl(server.config)) throw new Error('URL transport requires config.url');
    return connectUrlTransport(server.config, cacheKey, principal);
  }

  if (server.transport === 'stdio') {
    if (!isMcpConfigStdio(server.config)) throw new Error('stdio transport requires config.command');
    const config = server.config;
    const verdict = scanInvocation(config);
    if (verdict.tier === 1) {
      auditMcpStdioConnection(auditContext, {
        command: config.command,
        cwd: config.cwd,
        blockedPattern: verdict.label,
        isError: true,
      });
      throw new Error(`Refused: command or arguments match a blocked pattern (${verdict.label ?? 'tier-1'})`);
    }
    assertApprovedInvocation(config);
    if (process.env.MCP_ALLOW_BACKEND_STDIO !== 'true') {
      auditMcpStdioConnection(auditContext, { command: config.command, cwd: config.cwd, isError: true });
      throw new Error('Backend-hosted MCP stdio is disabled. Use the paired-PC relay, or explicitly set MCP_ALLOW_BACKEND_STDIO=true on a trusted single-user deployment.');
    }

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: buildSafeEnv(config.env),
      cwd: config.cwd,
      stderr: 'pipe',
      maxBufferSize: MAX_STDIO_BUFFER_BYTES,
    });
    // The SDK exposes this PassThrough immediately. Attach before connect so
    // even startup floods are consumed and cannot deadlock version discovery.
    const stderrDrain = attachStdioStderrDrain(transport, config);
    let client: Client | null = createConfiguredMcpClient(config.command, cacheKey, principal);
    const startedAt = Date.now();
    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS, maxTotalTimeout: CONNECT_TIMEOUT_MS });
      auditMcpStdioConnection(auditContext, {
        command: config.command,
        cwd: config.cwd,
        durationMs: Date.now() - startedAt,
      });
      const connected = makeConnection(client, 'stdio', undefined, stderrDrain.close);
      client = null;
      return connected;
    } catch (error) {
      auditMcpStdioConnection(auditContext, {
        command: config.command,
        cwd: config.cwd,
        durationMs: Date.now() - startedAt,
        isError: true,
      });
      await closeFailedClient(client);
      await stderrDrain.close();
      throw error;
    }
  }

  if (server.transport === 'relay') {
    if (!server.serverId) throw new Error('relay transport requires serverId');
    if (!auditContext?.userId) throw new Error('relay transport requires a userId');
    if (!isMcpConfigStdio(server.config)) throw new Error('relay transport requires config.command');
    const verdict = scanInvocation(server.config);
    if (verdict.tier === 1) {
      auditMcpStdioConnection(auditContext, {
        command: server.config.command,
        cwd: server.config.cwd,
        blockedPattern: verdict.label,
        isError: true,
      });
      throw new Error(`Refused: command or arguments match a blocked pattern (${verdict.label ?? 'tier-1'})`);
    }
    assertApprovedInvocation(server.config);
    const startedAt = Date.now();
    try {
      const connection = await getOrCreateRelaySession(auditContext.userId, server.serverId, server.config);
      auditMcpStdioConnection(auditContext, {
        command: server.config.command,
        cwd: server.config.cwd,
        durationMs: Date.now() - startedAt,
      });
      return connection;
    } catch (error) {
      auditMcpStdioConnection(auditContext, {
        command: server.config.command,
        cwd: server.config.cwd,
        durationMs: Date.now() - startedAt,
        isError: true,
      });
      throw error;
    }
  }

  throw new Error(`Unsupported MCP transport: ${server.transport}`);
}

function providerSafeSegment(raw: string, maxLength: number): string {
  const trimmed = raw.trim() || 'tool';
  let safe = trimmed.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_');
  const changed = safe !== trimmed;
  if (!safe) safe = 'tool';
  const hash = stableHash(trimmed, 8);
  if (changed) safe = `${safe.slice(0, Math.max(1, maxLength - 10))}__${hash}`;
  if (safe.length > maxLength) safe = `${safe.slice(0, Math.max(1, maxLength - 10))}__${hash}`;
  return safe;
}

/** Stable provider-facing name; the exact MCP name remains in mcpToolName. */
export function prefixToolName(prefix: string, name: string): string {
  const safePrefix = prefix ? providerSafeSegment(prefix, 28) : '';
  const maxToolLength = Math.max(8, 64 - (safePrefix ? safePrefix.length + 2 : 0));
  const safeTool = providerSafeSegment(name, maxToolLength);
  const combined = safePrefix ? `${safePrefix}__${safeTool}` : safeTool;
  if (combined.length <= 64) return combined;
  const hash = stableHash({ prefix, name }, 8);
  return `${combined.slice(0, 54)}__${hash}`;
}

/** Best-effort helper retained for compatibility; hashed names are not reversible. */
export function unprefixToolName(prefix: string, prefixedName: string): string {
  if (!prefix) return prefixedName;
  const safePrefix = providerSafeSegment(prefix, 28);
  return prefixedName.startsWith(`${safePrefix}__`)
    ? prefixedName.slice(safePrefix.length + 2)
    : prefixedName;
}

function inputSchemaToProviderParameters(inputSchema: Record<string, unknown>): Record<string, unknown> {
  const schema = { ...inputSchema };
  if (schema.type === undefined) schema.type = 'object';
  if (schema.type !== 'object') throw new Error('MCP tool inputSchema must have an object root');
  if (schema.properties !== undefined && (typeof schema.properties !== 'object' || schema.properties === null || Array.isArray(schema.properties))) {
    throw new Error('MCP tool inputSchema.properties must be an object');
  }
  if (schema.properties === undefined) schema.properties = {};
  if (schema.required !== undefined && !Array.isArray(schema.required)) {
    throw new Error('MCP tool inputSchema.required must be an array');
  }
  return schema;
}

function buildAnnotationHints(annotations: Record<string, unknown> | undefined): string {
  if (!annotations) return '';
  const hints: string[] = [];
  if (annotations.readOnlyHint === true) hints.push('read-only');
  if (annotations.destructiveHint === true) hints.push('destructive');
  if (annotations.idempotentHint === true) hints.push('idempotent');
  if (annotations.openWorldHint === true) hints.push('external interaction');
  return hints.length > 0 ? ` [Untrusted server-provided hints: ${hints.join(', ')}.]` : '';
}

export interface McpToolDef {
  name: string;
  mcpToolName: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  execution?: Record<string, unknown>;
  rawDefinition: Tool;
  openAIDef: {
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  };
}

export class McpToolCatalogChangedError extends Error {
  readonly code = 'MCP_TOOL_CATALOG_CHANGED';
  readonly toolName: string;

  constructor(toolName: string, detail = 'is no longer advertised with a usable definition') {
    super(`MCP tool "${toolName}" ${detail}; rebuild the exposed tool catalog before retrying`);
    this.name = 'McpToolCatalogChangedError';
    this.toolName = toolName;
  }
}

/** Minimal observable state for runtimes that want to proactively rebuild. */
export function getMcpToolCatalogStatus(client: Client): { revision: number; stale: boolean } {
  const state = toolCatalogStateFor(client);
  return { revision: state.revision, stale: state.stale };
}

function compileToolCatalog(tools: readonly Tool[]): ToolCatalogSnapshot {
  const entries: ToolCatalogEntry[] = [];
  const runtime = new Map<string, ToolRuntimeInfo>();
  const seenExactNames = new Set<string>();

  for (const tool of tools) {
    if (!tool.name || seenExactNames.has(tool.name)) {
      console.warn(`[mcp] Ignoring invalid or duplicate tool name: ${tool.name || '(empty)'}`);
      continue;
    }
    seenExactNames.add(tool.name);

    let parameters: Record<string, unknown>;
    try {
      parameters = inputSchemaToProviderParameters(tool.inputSchema as Record<string, unknown>);
    } catch (error) {
      console.warn(`[mcp] Ignoring tool ${tool.name}: ${error instanceof Error ? error.message : error}`);
      continue;
    }
    const runtimeInfo: ToolRuntimeInfo = { definition: tool };
    try {
      runtimeInfo.validateInput = schemaValidator.getValidator<Record<string, unknown>>(parameters as JsonSchemaType);
    } catch (error) {
      runtimeInfo.inputSchemaError = error instanceof Error ? error.message : String(error);
    }
    runtime.set(tool.name, runtimeInfo);
    entries.push({ definition: tool, parameters, runtime: runtimeInfo });
  }

  return { entries, runtime };
}

async function loadCurrentToolCatalog(
  client: Client,
  control: McpRequestControl,
  requestEvenWhenFresh: boolean,
): Promise<ToolCatalogSnapshot> {
  const state = toolCatalogStateFor(client);
  let mustRequest = requestEvenWhenFresh;

  while (true) {
    if (state.refresh) {
      await state.refresh;
      // An in-flight list satisfies this caller's explicit refresh request.
      mustRequest = false;
      if (!state.stale && state.snapshot) return state.snapshot;
      continue;
    }
    if (!mustRequest && !state.stale && state.snapshot) return state.snapshot;

    const revision = state.revision;
    const cacheMode = state.stale || !state.snapshot ? 'refresh' as const : 'use' as const;
    let refresh!: Promise<void>;
    refresh = (async () => {
      const response = await client.listTools(undefined, {
        signal: control.signal,
        timeout: control.timeoutMs ?? LIST_TIMEOUT_MS,
        maxTotalTimeout: control.maxTotalTimeoutMs ?? LIST_TIMEOUT_MS,
        cacheMode,
      });
      const snapshot = compileToolCatalog(response.tools);
      // A notification that arrived while tools/list was in flight wins. Its
      // epoch cannot be cleared by the older response; the loop relists.
      if (state.revision !== revision) return;
      state.snapshot = snapshot;
      state.stale = false;
    })();
    state.refresh = refresh;
    mustRequest = false;
    try {
      await refresh;
    } finally {
      if (state.refresh === refresh) state.refresh = undefined;
    }
    if (!state.stale && state.snapshot) return state.snapshot;
  }
}

export async function listMcpTools(
  client: Client,
  namePrefix: string,
  control: McpRequestControl = {}
): Promise<McpToolDef[]> {
  const snapshot = await loadCurrentToolCatalog(client, control, true);
  const result: McpToolDef[] = [];
  const seenProviderNames = new Set<string>();

  for (const { definition: tool, parameters } of snapshot.entries) {
    const exposedName = prefixToolName(namePrefix, tool.name);
    if (seenProviderNames.has(exposedName)) {
      console.warn(`[mcp] Ignoring tool ${tool.name}: stable provider-name collision at ${exposedName}`);
      continue;
    }
    seenProviderNames.add(exposedName);

    const annotations = tool.annotations as Record<string, unknown> | undefined;
    const title = typeof tool.title === 'string' ? tool.title : undefined;
    const baseDescription = title && tool.description
      ? `${title}. ${tool.description}`
      : title ?? tool.description ?? 'MCP tool';
    const description = `${baseDescription}${buildAnnotationHints(annotations)}`;
    const outputSchema = tool.outputSchema && typeof tool.outputSchema === 'object'
      ? tool.outputSchema as Record<string, unknown>
      : undefined;
    const execution = tool.execution && typeof tool.execution === 'object'
      ? tool.execution as Record<string, unknown>
      : undefined;
    result.push({
      name: exposedName,
      mcpToolName: tool.name,
      title,
      description,
      inputSchema: parameters,
      outputSchema,
      annotations,
      execution,
      rawDefinition: tool,
      openAIDef: {
        type: 'function',
        function: {
          name: exposedName,
          description: namePrefix
            ? `${description} Call it only by its exact exposed name: ${exposedName}.`
            : description,
          parameters,
        },
      },
    });
  }

  return result;
}

export interface McpToolCallResult {
  output: string;
  isError: boolean;
  content: unknown[];
  structuredContent?: unknown;
}

function truncateText(text: string): string {
  if (text.length <= MAX_TEXT_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TEXT_RESULT_CHARS)}\n\n[Output truncated to ${MAX_TEXT_RESULT_CHARS} characters]`;
}

function base64DecodedBytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function sanitizeContentBlock(item: unknown): unknown {
  if (!item || typeof item !== 'object') return item;
  const block = item as Record<string, unknown>;
  if ((block.type === 'image' || block.type === 'audio') && typeof block.data === 'string' && block.data.length > MAX_BINARY_BASE64_CHARS) {
    return {
      ...block,
      data: '',
      truncated: true,
      originalBytes: base64DecodedBytes(block.data),
    };
  }
  if (block.type === 'text' && typeof block.text === 'string') return { ...block, text: truncateText(block.text) };
  return block;
}

function requestOptions(control: McpRequestControl, defaultTimeout: number): RequestOptions {
  const timeout = control.timeoutMs ?? defaultTimeout;
  return {
    signal: control.signal,
    timeout,
    resetTimeoutOnProgress: true,
    maxTotalTimeout: control.maxTotalTimeoutMs ?? Math.max(timeout, TOOL_CALL_MAX_TOTAL_TIMEOUT_MS),
    onprogress: control.onProgress,
  };
}

export async function callMcpToolDetailed(
  client: Client,
  toolName: string,
  args: Record<string, unknown>,
  timeoutOrControl: number | McpRequestControl = TOOL_CALL_TIMEOUT_MS
): Promise<McpToolCallResult> {
  const control = typeof timeoutOrControl === 'number'
    ? { timeoutMs: timeoutOrControl }
    : timeoutOrControl;
  let result: Awaited<ReturnType<Client['callTool']>> | undefined;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const snapshot = await loadCurrentToolCatalog(client, control, false);
    const state = toolCatalogStateFor(client);
    // A notification can run between promise settlement and this continuation.
    // Never validate or send using the detached pre-notification snapshot.
    if (state.stale || state.snapshot !== snapshot) continue;

    const runtime = snapshot.runtime.get(toolName);
    if (!runtime) throw new McpToolCatalogChangedError(toolName);
    if (runtime.inputSchemaError) {
      throw new McpToolCatalogChangedError(toolName, `has an unusable input schema (${runtime.inputSchemaError})`);
    }
    if (runtime.validateInput) {
      const validation = runtime.validateInput(args);
      if (!validation.valid) throw new Error(`Invalid arguments for MCP tool "${toolName}": ${validation.errorMessage}`);
    }
    // There is deliberately no await between this final epoch check and the
    // callTool invocation, so list_changed cannot interleave in that gap.
    if (state.stale || state.snapshot !== snapshot) continue;
    result = await client.callTool(
      { name: toolName, arguments: args },
      {
        ...requestOptions(control, TOOL_CALL_TIMEOUT_MS),
        toolDefinition: runtime.definition,
      }
    );
    break;
  }
  if (!result) {
    throw new McpToolCatalogChangedError(toolName, 'kept changing while the call was being prepared');
  }
  const rawContent = Array.isArray(result.content) ? result.content : [];
  const boundedContent = rawContent.slice(0, MAX_CONTENT_BLOCKS).map(sanitizeContentBlock);
  const isError = result.isError === true;
  const hasStructuredContent = Object.prototype.hasOwnProperty.call(result, 'structuredContent')
    && result.structuredContent !== undefined;
  const structuredContent = result.structuredContent;
  const parts: string[] = [];
  if (isError) parts.push('[Tool execution error]');

  for (const raw of rawContent.slice(0, MAX_CONTENT_BLOCKS)) {
    if (!raw || typeof raw !== 'object' || !('type' in raw)) continue;
    const item = raw as Record<string, unknown>;
    const type = typeof item.type === 'string' ? item.type : 'unknown';
    if (type === 'text' && typeof item.text === 'string') {
      parts.push(item.text);
    } else if ((type === 'image' || type === 'audio') && typeof item.data === 'string') {
      const label = type === 'image' ? 'Image' : 'Audio';
      parts.push(`[${label}: ${typeof item.mimeType === 'string' ? item.mimeType : 'application/octet-stream'}, ${base64DecodedBytes(item.data)} bytes]`);
    } else if (type === 'resource' && item.resource && typeof item.resource === 'object') {
      const resource = item.resource as Record<string, unknown>;
      if (typeof resource.text === 'string') parts.push(resource.text);
      else if (typeof resource.blob === 'string') {
        parts.push(`[Embedded resource: ${String(resource.uri ?? 'unknown')}, ${base64DecodedBytes(resource.blob)} bytes]`);
      } else {
        parts.push(`[Embedded resource: ${String(resource.uri ?? 'unknown')}]`);
      }
    } else if (type === 'resource_link' && typeof item.uri === 'string') {
      const name = typeof item.name === 'string' ? item.name : item.uri;
      const description = typeof item.description === 'string' ? ` — ${item.description}` : '';
      parts.push(`Resource: ${name} (${item.uri})${description}`);
    } else {
      parts.push(`[Unsupported MCP content block: ${type}]`);
    }
  }
  if (rawContent.length > MAX_CONTENT_BLOCKS) parts.push(`[${rawContent.length - MAX_CONTENT_BLOCKS} additional content blocks omitted]`);
  if (hasStructuredContent) {
    try {
      const serialized = JSON.stringify(structuredContent);
      if (serialized !== undefined) parts.push(serialized);
    } catch {
      parts.push('[Structured MCP output could not be serialized]');
    }
  }

  let output: string;
  if (parts.length > 0) {
    output = truncateText(parts.join('\n\n'));
  } else {
    try {
      output = truncateText(JSON.stringify(result));
    } catch {
      output = '[Empty MCP result]';
    }
  }
  return {
    output,
    isError,
    content: boundedContent,
    ...(hasStructuredContent ? { structuredContent } : {}),
  };
}

export async function callMcpTool(
  client: Client,
  toolName: string,
  args: Record<string, unknown>,
  timeoutOrControl: number | McpRequestControl = TOOL_CALL_TIMEOUT_MS
): Promise<string> {
  return (await callMcpToolDetailed(client, toolName, args, timeoutOrControl)).output;
}

export async function listMcpResources(client: Client, control: McpRequestControl = {}): Promise<ListResourcesResult> {
  return client.listResources(undefined, { ...requestOptions(control, LIST_TIMEOUT_MS), cacheMode: 'use' });
}

export async function listMcpResourceTemplates(client: Client, control: McpRequestControl = {}): Promise<ListResourceTemplatesResult> {
  return client.listResourceTemplates(undefined, { ...requestOptions(control, LIST_TIMEOUT_MS), cacheMode: 'use' });
}

export async function readMcpResource(client: Client, uri: string, control: McpRequestControl = {}): Promise<ReadResourceResult> {
  if (!uri.trim()) throw new Error('Resource URI is required');
  return client.readResource({ uri }, { ...requestOptions(control, TOOL_CALL_TIMEOUT_MS), cacheMode: 'use' });
}

export async function listMcpPrompts(client: Client, control: McpRequestControl = {}): Promise<ListPromptsResult> {
  return client.listPrompts(undefined, { ...requestOptions(control, LIST_TIMEOUT_MS), cacheMode: 'use' });
}

export async function getMcpPrompt(
  client: Client,
  name: string,
  args?: Record<string, string>,
  control: McpRequestControl = {}
): Promise<GetPromptResult> {
  if (!name.trim()) throw new Error('Prompt name is required');
  return client.getPrompt({ name, arguments: args }, requestOptions(control, TOOL_CALL_TIMEOUT_MS));
}
