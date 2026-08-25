import type {
  Agent,
  AgentFormData,
  Conversation,
  Message,
  OpenRouterModel,
  OpenRouterEndpoint,
  UsageStats,
  OpenRouterCredits,
  Annotation,
  ReasoningConfig,
  Tool,
  McpServer,
  McpTransport,
  McpServerConfig,
  ChatAttachmentInput,
  PDFEngine,
  ToolSource,
  CouncilMember,
  CouncilRun,
  CouncilRunDetail,
  CouncilConfig,
  ProviderRoutingConfig,
  Skill,
} from '../types';
// Type-only import of the frozen snapshot wire contract (plan.md D6); erased at build time,
// so vite never bundles from shared/. Nothing here exists yet anywhere else — single source.
import type { ShareSnapshot, SharedMessage } from '../../shared/shareTypes';

/** In production (Vercel), set VITE_API_URL to your Railway API URL (e.g. https://your-app.railway.app). No trailing slash. */
const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '') + '/api';

const AUTH_TOKEN_KEY = 'auth_token';

export function setAuthToken(token: string): void {
  sessionStorage.setItem(AUTH_TOKEN_KEY, token);
}

export function clearAuthToken(): void {
  sessionStorage.removeItem(AUTH_TOKEN_KEY);
}

export function getAuthToken(): string | null {
  return sessionStorage.getItem(AUTH_TOKEN_KEY);
}

/** Returns Authorization header when a token is stored (cross-origin cookie fallback). */
export function getAuthHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

let onUnauthorized: (() => void) | null = null;
export function setOnUnauthorized(fn: (() => void) | null) {
  onUnauthorized = fn;
}

/** Delay helper for retry back-off. */
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Maximum retries for 503 (server restarting) responses. */
const MAX_503_RETRIES = 3;
const RETRY_DELAYS = [2_000, 4_000, 8_000];

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_503_RETRIES; attempt++) {
    const res = await fetch(`${API_BASE}${url}`, {
      ...options,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders(),
        ...(options?.headers as Record<string, string> | undefined),
      },
    });
    if (res.status === 401 && onUnauthorized) {
      onUnauthorized();
    }
    // Retry on 503 (server restarting during deploy)
    if (res.status === 503 && attempt < MAX_503_RETRIES) {
      await delay(RETRY_DELAYS[attempt]);
      continue;
    }
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  throw lastError ?? new Error('Request failed after retries');
}

// Auth
export interface AuthUser {
  id: string;
  email: string;
  created_at?: string;
}

export const authApi = {
  config: () => request<{ authRequired: boolean }>('/auth/config'),
  register: (email: string, password: string) =>
    request<{ token: string; user: AuthUser }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  login: (email: string, password: string) =>
    request<{ token: string; user: AuthUser }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  logout: async () => {
    try {
      return await request<{ success: boolean }>('/auth/logout', { method: 'POST' });
    } finally {
      clearAuthToken();
    }
  },
  me: () => request<AuthUser>('/auth/me'),
};

// Agents
export const agentsApi = {
  list: () => request<Agent[]>('/agents'),
  get: (id: string) => request<Agent>(`/agents/${id}`),
  create: (data: AgentFormData) => request<Agent>('/agents', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
  update: (id: string, data: Partial<AgentFormData>) => request<Agent>(`/agents/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  }),
  delete: (id: string) => request<{ success: boolean }>(`/agents/${id}`, {
    method: 'DELETE',
  }),
  search: (query: string) => request<{ agents: { id: string; name: string; emoji: string; description: string }[] }>(
    `/agents/search?q=${encodeURIComponent(query)}`
  ),
};

// Conversations
export const conversationsApi = {
  list: (agentId?: string) => request<Conversation[]>(
    agentId ? `/conversations?agent_id=${agentId}` : '/conversations'
  ),
  create: (agentId: string | null, title?: string) => request<Conversation>('/conversations', {
    method: 'POST',
    body: JSON.stringify({ agent_id: agentId, title }),
  }),
  createGeneral: (title?: string) => request<Conversation>('/conversations', {
    method: 'POST',
    body: JSON.stringify({ agent_id: null, title: title || 'General Chat' }),
  }),
  update: (id: string, title: string) => request<Conversation>(`/conversations/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ title }),
  }),
  updateModel: (id: string, model: string | null) => request<Conversation>(`/conversations/${id}/model`, {
    method: 'PUT',
    body: JSON.stringify({ model }),
  }),
  updateProviderRouting: (id: string, provider_routing: ProviderRoutingConfig | null) => request<Conversation>(`/conversations/${id}/provider-routing`, {
    method: 'PUT',
    body: JSON.stringify({ provider_routing }),
  }),
  updateToolConfig: (id: string, toolIds: string[], mcpServerIds: string[]) => request<Conversation>(`/conversations/${id}/tool-config`, {
    method: 'PUT',
    body: JSON.stringify({ tool_ids: toolIds, mcp_server_ids: mcpServerIds }),
  }),
  resetToolConfig: (id: string) => request<Conversation>(`/conversations/${id}/tool-config`, {
    method: 'DELETE',
  }),
  updateSkillConfig: (id: string, skillIds: string[]) => request<Conversation>(`/conversations/${id}/skill-config`, {
    method: 'PUT',
    body: JSON.stringify({ skill_ids: skillIds }),
  }),
  resetSkillConfig: (id: string) => request<Conversation>(`/conversations/${id}/skill-config`, {
    method: 'DELETE',
  }),
  delete: (id: string) => request<{ success: boolean }>(`/conversations/${id}`, {
    method: 'DELETE',
  }),
  /** Moves the visible thread cursor of a conversation to a specific message. */
  setActiveLeaf: (id: string, messageId: string) => request<{ success: boolean }>(`/conversations/${id}/active-leaf`, {
    method: 'PUT',
    body: JSON.stringify({ message_id: messageId }),
  }),
};

// Messages
/** Response of GET /conversations/:id/messages (new contract: also returns the active leaf id). */
export interface MessagesListResponse {
  messages: Message[];
  active_leaf_id: string | null;
  /** Additive, optional (plan.md S6): id of the live generation turn, present/null
   *  when idle — clients poll for reopen reconciliation while it is set. */
  active_turn_id?: string | null;
}

export const messagesApi = {
  list: (conversationId: string) => request<MessagesListResponse>(`/conversations/${conversationId}/messages`),
};

// Tools
export interface ToolCreatePayload {
  name: string;
  description: string;
  parameters_schema: Record<string, unknown>;
  type: 'builtin' | 'http';
  config?: Record<string, unknown> | null;
}

export const toolsApi = {
  list: () => request<Tool[]>('/tools'),
  get: (id: string) => request<Tool>(`/tools/${id}`),
  create: (data: ToolCreatePayload) => request<Tool>('/tools', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
  update: (id: string, data: Partial<Pick<Tool, 'description' | 'parameters_schema' | 'config'>>) =>
    request<Tool>(`/tools/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (id: string) => request<{ success: boolean }>(`/tools/${id}`, {
    method: 'DELETE',
  }),
};

// MCP Servers
export interface McpServerCreatePayload {
  name: string;
  transport: McpTransport;
  config: McpServerConfig;
  /** One-shot consent for the exact local invocation in `config`. The server
   * stores a fingerprint, never this blanket boolean. */
  local_execution_approved?: boolean;
}

export interface McpServerUpdatePayload {
  name?: string;
  transport?: McpTransport;
  config?: McpServerConfig | null;
  local_execution_approved?: boolean;
}

export interface McpServerTestResult {
  ok: boolean;
  tools?: { name: string; description: string; parameters?: Record<string, unknown> }[];
  transport?: McpTransport | string;
  protocolEra?: string;
  protocolVersion?: string;
  serverInfo?: { name?: string; version?: string; [key: string]: unknown };
  capabilities?: {
    resources?: boolean | Record<string, unknown>;
    prompts?: boolean | Record<string, unknown>;
    tools?: boolean | Record<string, unknown>;
    [key: string]: unknown;
  };
  counts?: {
    tools?: number;
    resources?: number;
    resourceTemplates?: number;
    prompts?: number;
  };
  error?: string;
}

export interface McpApprovalRequiredData {
  id: string;
  server_id: string;
  server_name?: string;
  exposed_name: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  arguments_sha256: string;
  possible_cross_tool_data: boolean;
  annotations?: Record<string, unknown>;
  execution?: Record<string, unknown>;
  expires_at: string;
}

export const mcpServersApi = {
  list: () => request<McpServer[]>('/mcp-servers'),
  get: (id: string) => request<McpServer>(`/mcp-servers/${id}`),
  create: (data: McpServerCreatePayload) => request<McpServer>('/mcp-servers', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
  update: (id: string, data: McpServerUpdatePayload) =>
    request<McpServer>(`/mcp-servers/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (id: string) => request<{ success: boolean }>(`/mcp-servers/${id}`, {
    method: 'DELETE',
  }),
  test: (id: string) => request<McpServerTestResult>(`/mcp-servers/${id}/test`, {
    method: 'POST',
  }),
  resolveApproval: (id: string, approved: boolean) => request<{ resolved: true; approved: boolean }>(
    `/mcp-servers/approvals/${encodeURIComponent(id)}`,
    { method: 'POST', body: JSON.stringify({ approved }) },
  ),
  /** Owner-scoped snapshot of the pending MCP tool approvals for one conversation
   *  (plan.md S7): same payload shape as the live `{mcp_approval_required}` SSE event. */
  listPendingApprovals: (conversationId: string) => request<{ approvals: McpApprovalRequiredData[] }>(
    `/mcp-servers/pending-approvals?conversation_id=${encodeURIComponent(conversationId)}`,
  ),
};

// Skills
export type SkillCreatePayload =
  | { raw_skill_md: string }
  | {
      name: string;
      description: string;
      body: string;
      license?: string;
      compatibility?: string;
      metadata?: Record<string, string>;
      allowed_tools?: string;
      disable_model_invocation?: boolean;
    };

export interface SkillResourceEntry {
  path: string;
  size_bytes: number;
}

export interface SkillParsePreviewResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  catalog_entry?: { name: string; description: string };
}

export interface SkillImportResult {
  skill: Skill;
  warnings: string[];
  resources: SkillResourceEntry[];
}

/** UTF-8-safe base64 encoding of a relative path, mirroring how `agentFiles.ts`'s
 *  server side decodes `X-File-Name-B64` (`Buffer.from(header, 'base64').toString('utf8')`).
 *  Bare `btoa(path)` mangles non-Latin1 characters, so encode the UTF-8 byte sequence first. */
function base64EncodeUtf8(value: string): string {
  return btoa(unescape(encodeURIComponent(value)));
}

export const skillsApi = {
  list: () => request<Skill[]>('/skills'),
  get: (id: string) => request<Skill & { resources: SkillResourceEntry[] }>(`/skills/${id}`),
  create: (data: SkillCreatePayload) => request<SkillImportResult>('/skills', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
  update: (id: string, data: SkillCreatePayload) => request<Skill>(`/skills/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  }),
  delete: (id: string) => request<{ success: boolean }>(`/skills/${id}`, {
    method: 'DELETE',
  }),
  parsePreview: (data: SkillCreatePayload) => request<SkillParsePreviewResult>('/skills/parse-preview', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
  importZip: async (zipBytes: ArrayBuffer): Promise<SkillImportResult> => {
    const res = await fetch(`${API_BASE}/skills/import-zip`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/zip',
        ...getAuthHeaders(),
      },
      body: zipBytes,
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || `HTTP ${res.status}`);
    }
    return res.json();
  },
  listResources: (id: string) => request<SkillResourceEntry[]>(`/skills/${id}/resources`),
  getResourceContent: (id: string, path: string) => request<{ path: string; content: string | null; size_bytes: number; truncated: boolean; binary?: boolean }>(
    `/skills/${id}/resources/content?path=${encodeURIComponent(path)}`
  ),
  addResource: async (id: string, path: string, bytes: ArrayBuffer): Promise<SkillResourceEntry> => {
    const res = await fetch(`${API_BASE}/skills/${id}/resources`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Resource-Path-B64': base64EncodeUtf8(path),
        ...getAuthHeaders(),
      },
      body: bytes,
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || `HTTP ${res.status}`);
    }
    return res.json();
  },
  deleteResource: (id: string, path: string) => request<{ success: boolean }>(
    `/skills/${id}/resources?path=${encodeURIComponent(path)}`,
    { method: 'DELETE' }
  ),
};

// Done event data shape from the backend
export interface StreamDoneData {
  done: true;
  tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  reasoning_tokens?: number;
  cached_tokens?: number;
  annotations?: Annotation[];
}

// Tool call/result events from SSE
export interface StreamToolCallData {
  id: string;
  name: string;
  arguments: string;
  source?: ToolSource;
}
export interface StreamToolResultData {
  id: string;
  name: string;
  ok: boolean;
  result?: string;
  duration_ms?: number;
  source?: ToolSource;
  /** Additive, `run_command`-only. Same value as the tool's own JSON output's
   *  `backend`/`exit_code` for a successful/failed execution, but also present for
   *  refusals (blocked/declined/timeout), where the JSON output has no `backend` field. */
  metadata?: { backend: 'local' | 'e2b'; exit_code: number | null };
}

// Local-agent `run_command` live output chunk (local backend only; never emitted for E2B).
export interface StreamToolOutputChunkData {
  id: string;
  stream: 'stdout' | 'stderr';
  text: string;
  seq: number;
}

export interface StreamConversationTitleData {
  conversation_id: string;
  title: string;
}

// Chat (streaming) with AbortSignal support, reasoning callback, tool callbacks, PDF attachments, and rich done data
export async function streamChat(
  conversationId: string,
  content: string,
  onChunk: (text: string) => void,
  onDone: (data: StreamDoneData) => void,
  onError: (error: string) => void,
  onReasoning?: (text: string) => void,
  signal?: AbortSignal,
  reasoning?: ReasoningConfig | null,
  onToolCall?: (data: StreamToolCallData) => void,
  onToolResult?: (data: StreamToolResultData) => void,
  attachments?: ChatAttachmentInput[],
  pdf_engine?: PDFEngine,
  model?: string,
  providerRouting?: ProviderRoutingConfig | null,
  invokeAgentId?: string,
  onConversationTitle?: (data: StreamConversationTitleData) => void,
  // Appended last (not inserted earlier): every existing call site uses positional
  // arguments and would silently break if this shifted the position of any prior one.
  onToolOutputChunk?: (data: StreamToolOutputChunkData) => void,
  // Same rule as onToolOutputChunk above: appended last, not inserted earlier.
  invokeSkillNames?: string[],
  // Same rule as onToolOutputChunk above: appended last, not inserted earlier.
  /** When set, the request creates a new variant of the target user message's turn (edit/relaunch). */
  editMessageId?: string,
  /** Appended last to preserve every positional call site. Must explicitly
   * approve or deny each exact MCP invocation. */
  onMcpApprovalRequired?: (data: McpApprovalRequiredData) => void,
): Promise<void> {
  try {
    const body: Record<string, unknown> = { conversation_id: conversationId, content };

    // Send user's timezone so the model can use local date/time for time-sensitive answers
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) body.timezone = tz;
    } catch {
      // ignore
    }

    // Include invoke_agent_id for @agent mentions
    if (invokeAgentId) {
      body.invoke_agent_id = invokeAgentId;
    }
    if (invokeSkillNames?.length) {
      body.invoke_skill_names = invokeSkillNames;
    }

    // Include per-message reasoning override if provided
    if (reasoning) {
      body.reasoning = {
        enabled: reasoning.enabled,
        ...(reasoning.effort && { effort: reasoning.effort }),
        ...(reasoning.max_tokens && { max_tokens: reasoning.max_tokens }),
      };
    }

    if (attachments?.length) {
      body.attachments = attachments;
    }
    if (pdf_engine) {
      body.pdf_engine = pdf_engine;
    }
    if (model) {
      body.model = model;
    }
    if (providerRouting) {
      body.provider_routing = providerRouting;
    }
    if (editMessageId) {
      body.edit_message_id = editMessageId;
    }

    // Retry loop for 503 (server restarting during deploy)
    let res: Response | null = null;
    for (let attempt = 0; attempt <= MAX_503_RETRIES; attempt++) {
      res = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(),
        },
        body: JSON.stringify(body),
        signal,
      });

      if (res.status === 503 && attempt < MAX_503_RETRIES) {
        await delay(RETRY_DELAYS[attempt]);
        continue;
      }
      break;
    }

    if (!res!.ok) {
      const error = await res!.json().catch(() => ({ error: 'Chat request failed' }));
      onError(error.error || `HTTP ${res!.status}`);
      return;
    }

    if (!res!.body) {
      onError('No response body');
      return;
    }

    const reader = res!.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(': ') || !trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (data === '[DONE]') return;

        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            onError(parsed.error);
            return;
          }
          // Conversation title updates
          if (
            parsed.type === 'conversation_title' &&
            typeof parsed.conversation_id === 'string' &&
            typeof parsed.title === 'string' &&
            onConversationTitle
          ) {
            onConversationTitle({
              conversation_id: parsed.conversation_id,
              title: parsed.title,
            });
          }
          // Reasoning content
          if (parsed.reasoning && onReasoning) {
            onReasoning(parsed.reasoning);
          }
          // Regular content
          if (parsed.content) {
            onChunk(parsed.content);
          }
          // Tool call (model requested a tool)
          if (parsed.tool_call && onToolCall) {
            onToolCall(parsed.tool_call as StreamToolCallData);
          }
          // Tool result (tool execution finished)
          if (parsed.tool_result && onToolResult) {
            onToolResult(parsed.tool_result as StreamToolResultData);
          }
          // Live output chunk (run_command, local backend only)
          if (parsed.tool_output_chunk && onToolOutputChunk) {
            onToolOutputChunk(parsed.tool_output_chunk as StreamToolOutputChunkData);
          }
          if (parsed.mcp_approval_required) {
            const approval = parsed.mcp_approval_required as McpApprovalRequiredData;
            if (onMcpApprovalRequired) {
              onMcpApprovalRequired(approval);
            } else if (typeof approval.id === 'string') {
              // A surface without approval UI must never leave a call pending
              // or implicitly approve it.
              void mcpServersApi.resolveApproval(approval.id, false).catch(() => {});
            }
          }
          // Done event with rich metadata
          if (parsed.done) {
            onDone(parsed as StreamDoneData);
            return;
          }
        } catch {
          // Skip unparseable chunks
        }
      }
    }

    // Stream ended without explicit done (e.g. cancelled)
    onDone({ done: true });
  } catch (err) {
    // AbortError is expected when user cancels
    if (err instanceof Error && err.name === 'AbortError') {
      onDone({ done: true });
      return;
    }
    onError(err instanceof Error ? err.message : 'Connection failed');
  }
}

/**
 * Stop the active generation turn in a conversation (plan.md S5; frozen REST
 * contract in Cross-task interfaces §2). Appended after `streamChat` — never
 * inserted between its positional parameters. Throws on non-OK (e.g. 404 when
 * no live turn exists for this conversation).
 */
export async function stopTurn(conversationId: string): Promise<void> {
  await request<{ stopped: boolean }>('/chat/stop', {
    method: 'POST',
    body: JSON.stringify({ conversation_id: conversationId }),
  });
}

// Models
export const modelsApi = {
  openrouter: () => request<{ data: OpenRouterModel[] }>('/models/openrouter'),
  openrouterEndpoints: (model: string) => request<{ data: OpenRouterEndpoint[] }>(
    `/models/openrouter/endpoints?model=${encodeURIComponent(model)}`
  ),
  deepseek: () => request<{ data: OpenRouterModel[] }>('/models/deepseek'),
  codex: () => request<{ data: OpenRouterModel[] }>('/models/codex'),
  llamacpp: () => request<{ data: LlamaCppModel[] }>('/models/llamacpp'),
  /** NEVER-THROWS §5 status payload. */
  llamacppStatus: () => request<LlamaCppStatus>('/models/llamacpp/status'),
};

// ChatGPT (Codex app-server) provider
export interface ChatgptPendingLogin {
  loginId: string;
  verificationUrl: string;
  userCode: string;
  startedAt: number;
}

export interface ChatgptRateLimitBucket {
  limitId: string;
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number | null;
}

export interface ChatgptStatus {
  allowed: boolean;
  connected: boolean;
  email: string | null;
  planType: string | null;
  pendingLogin: ChatgptPendingLogin | null;
  rateLimits: {
    usedPercent?: number;
    windowDurationMins?: number;
    resetsAt?: number | null;
    byLimitId?: ChatgptRateLimitBucket[];
  } | null;
}

export const chatgptApi = {
  status: () => request<ChatgptStatus>('/chatgpt/status'),
  login: () => request<ChatgptPendingLogin>('/chatgpt/login', { method: 'POST' }),
  cancel: () => request<{ ok: true }>('/chatgpt/cancel', { method: 'POST' }),
  logout: () => request<{ ok: true }>('/chatgpt/logout', { method: 'POST' }),
};

// DeepSeek (direct provider)
export interface DeepSeekValidateResult {
  ok: boolean;
  is_available?: boolean;
  balance?: string;
  currency?: string;
  error?: string;
}

export const deepseekApi = {
  validate: () => request<DeepSeekValidateResult>('/models/deepseek/validate'),
};

// llama.cpp (local provider via the paired local agent) — response types
// pinned field-for-field to plans/llamacpp-local-provider/global-constraints.md
// §5. Do not invent fields; consumers must tolerate their absence.
import type { LlamaCppKnobOverrides } from '../utils/llamacppKnobs';

export interface LlamaCppModel extends OpenRouterModel {
  /** Absolute path of the representative (first-shard) .gguf file. */
  path: string;
  size_bytes?: number;
  /** Number of shard files collapsed into this logical model. */
  shards: number;
  mtp_capable: boolean;
  loaded?: boolean;
}

/** NEVER-THROWS §5 status payload (GET /api/models/llamacpp/status). */
export interface LlamaCppStatus {
  agentConnected: boolean;
  capabilitySupported: boolean;
  running: boolean;
  pid: number | null;
  modelPath: string | null;
  modelKey: string | null;
  port: number | null;
  transport: 'direct' | 'relay' | null;
  healthy: boolean | null;
  startedAt: number | null;
  lastExitCode: number | null;
  argv: string[] | null;
  mtpActive: boolean;
  /** §5 Increment 2: running child's argv differs from what persisted settings would spawn now. */
  pendingRestart: boolean;
}

/** §5 start envelope — resolves only after the /health wait (≥120 s budget). */
export interface LlamaCppStartResult {
  ok: true;
  pid: number;
  port: number;
  argv: string[];
  waitedMs: number;
}

/** §5 FROZEN stop envelope; 'not-running' is SUCCESS (fail-soft idempotency). */
export interface LlamaCppStopResult {
  ok: true;
  status: 'stopped' | 'not-running';
}

/** §3 Increment 2 preset ids (order drives the Settings card order). */
export type LlamaCppPresetId = 'rapido' | 'equilibrado' | 'profundo';

/** §3 Increment 2 sampling row — request-body extras; never touches argv. */
export interface LlamaCppSampling {
  temp: number;
  top_p: number;
  top_k: number;
  min_p: number;
  repeat_penalty: number;
  /** §10 Increment 2d — OPTIONAL; absent = omitted from the request body. */
  presence_penalty?: number;
}

/** One `llamacpp_model_sampling` entry: any subset of the sampling row. */
export type LlamaCppSamplingOverride = Partial<LlamaCppSampling>;

/** Persisted `llamacpp_presets` row — one partial knob-bag slot per preset id. */
export type LlamaCppPresetsRow = Record<LlamaCppPresetId, LlamaCppKnobOverrides>;

export interface LlamaCppConfigPayload {
  defaults?: object;
  overrides?: Record<string, object>;
  /** §5 Increment 2 sections: each provided section is validated independently
   * with KEY-LEVEL 400 detail (e.g. `sampling.top_p: …`); at least one section
   * is required server-side. */
  presets?: Partial<LlamaCppPresetsRow>;
  activePreset?: LlamaCppPresetId;
  sampling?: Partial<LlamaCppSampling>;
  /** §10 Increment 2d: Record<modelKey, Partial<samplingRow>>, persisted
   * verbatim after validation (`modelSampling.<key>.temp: …` on 400). */
  modelSampling?: Record<string, LlamaCppSamplingOverride>;
}

/** §5 logs envelope — text never exceeds maxBytes. */
export interface LlamaCppLogsResult {
  ok: true;
  text: string;
  truncated: boolean;
}

export const llamacppApi = {
  start: (model: string, overrides?: object) =>
    request<LlamaCppStartResult>('/models/llamacpp/start', {
      method: 'POST',
      body: JSON.stringify({ model, ...(overrides !== undefined ? { overrides } : {}) }),
    }),
  stop: () =>
    request<LlamaCppStopResult>('/models/llamacpp/stop', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  config: (payload: LlamaCppConfigPayload) =>
    request<{ ok: true }>('/models/llamacpp/config', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  logs: (maxBytes = 8192) =>
    request<LlamaCppLogsResult>(`/models/llamacpp/logs?maxBytes=${maxBytes}`),
};

// Settings
export const settingsApi = {
  get: (key: string) => request<{ key: string; value: string | null }>(`/settings/${key}`),
  getAll: () => request<Record<string, string>>('/settings'),
  set: (key: string, value: string) => request<{ key: string; value: string }>(`/settings/${key}`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  }),
};

// Local Agent pairing (named `agentPairingApi`, not `agentsApi` — that name is already
// taken by the unrelated AI-agent CRUD API above)
export interface PairingCodeResponse {
  code: string;
  expires_at: string;
}

export interface PairedDevice {
  id: string;
  device_name: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  connected: boolean;
}

export const agentPairingApi = {
  createPairingCode: () => request<PairingCodeResponse>('/agent/pairing-codes', {
    method: 'POST',
  }),
  listPairings: () => request<PairedDevice[]>('/agent/pairings'),
  unpair: (id: string) => request<{ ok: true }>(`/agent/pairings/${id}`, {
    method: 'DELETE',
  }),
};

// Agent-delivered files (send_file tool) — URL-builder only, no network call needed:
// the download is a plain `<a href>` navigation, not a fetch.
export const agentFilesApi = {
  downloadUrl: (fileId: string) => `${API_BASE}/agent/files/${encodeURIComponent(fileId)}/download`,
};

// "Send to my computer" — delivers a user-picked file to the connected local agent's
// workspace via the chat composer (distinct from the agent-initiated send_file tool above).
export const agentUploadsApi = {
  send: (conversationId: string, file: File) => request<{ message: Message }>(
    `/conversations/${encodeURIComponent(conversationId)}/agent-uploads`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name-B64': base64EncodeUtf8(file.name),
      },
      body: file,
    }
  ),
};

// Credits (OpenRouter)
export const creditsApi = {
  get: () => request<{ data: OpenRouterCredits }>('/credits'),
};

// Usage stats
export const usageApi = {
  stats: () => request<UsageStats>('/usage/stats'),
};

// Export / Import (agents, tools, mcp_servers, or all)
export type ExportKind = 'agents' | 'tools' | 'mcp_servers' | 'all';

export interface ExportPayload {
  version: number;
  kind: ExportKind;
  exported_at: string;
  agents?: Record<string, unknown>[];
  tools?: Record<string, unknown>[];
  mcp_servers?: Record<string, unknown>[];
}

export interface ImportResult {
  success: boolean;
  created: { agents: number; tools: number; mcp_servers: number };
  requires_configuration?: Array<{
    id: string;
    source_id: string;
    name: string;
    transport: McpTransport;
    reason: 'redacted' | 'local_approval_required';
    redacted_fields: string[];
  }>;
}

export const exportApi = {
  agents: (agentIds?: string[]) => {
    const q = agentIds?.length ? `?ids=${agentIds.join(',')}` : '';
    return request<ExportPayload>(`/export/agents${q}`);
  },
  tools: () => request<ExportPayload>('/export/tools'),
  mcpServers: () => request<ExportPayload>('/export/mcp-servers'),
  all: () => request<ExportPayload>('/export/all'),
};

export const importApi = {
  import: (payload: ExportPayload) =>
    request<ImportResult>('/import', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
};

// Council APIs
export const councilsApi = {
  list: () => request<CouncilMember[]>('/council/members'),
  create: (data: {
    name: string;
    description?: string;
    member_models: string[];
    member_provider_routing?: Record<string, ProviderRoutingConfig>;
    synthesizer_model: string;
    synthesizer_provider_routing?: ProviderRoutingConfig | null;
    synthesis_prompt_template?: string;
    auto_expand_responses?: boolean;
    show_member_responses?: boolean;
    tool_ids?: string[];
    mcp_server_ids?: string[];
  }) => request<CouncilMember>('/council/members', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
  update: (id: string, data: Partial<{
    name: string;
    description?: string;
    member_models: string[];
    member_provider_routing?: Record<string, ProviderRoutingConfig>;
    synthesizer_model: string;
    synthesizer_provider_routing?: ProviderRoutingConfig | null;
    synthesis_prompt_template?: string;
    auto_expand_responses?: boolean;
    show_member_responses?: boolean;
    tool_ids?: string[];
    mcp_server_ids?: string[];
  }>) => request<CouncilMember>(`/council/members/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  }),
  delete: (id: string) => request<{ success: boolean }>(`/council/members/${id}`, {
    method: 'DELETE',
  }),
  listRuns: (conversationId: string) => request<Array<{
    id: string;
    status: string;
    member_count: number;
    synthesizer_model: string;
    total_cost: number;
    total_tokens: number;
    failed_members: number;
    started_at: string;
    completed_at: string | null;
    message_preview: string | null;
    successful_members: number;
  }>>(`/council/runs?conversation_id=${conversationId}`),
  getRun: (id: string) => request<CouncilRunDetail>(`/council/runs/${id}`),
};

// Shares (per-conversation read-only sharing; frozen REST contract in GC3)
/** Snapshot payload types — single source of truth shared with the server (plan.md D6). */
export type { ShareSnapshot, SharedMessage };

/**
 * GET /conversations/:id/share — owner-scoped status. Never includes the raw token (GC3/GC6).
 */
export type ShareStatusResponse =
  | { status: 'none' }
  | { status: 'active'; share: { id: string; created_at: string } };

/** POST /conversations/:id/share — raw token returned exactly once (GC6); rotates any previous share. */
export interface CreateShareResponse {
  id: string;
  token: string;
  created_at: string;
}

export const sharesApi = {
  getStatus: (conversationId: string) => request<ShareStatusResponse>(`/conversations/${conversationId}/share`),
  create: (conversationId: string) => request<CreateShareResponse>(`/conversations/${conversationId}/share`, { method: 'POST' }),
  revoke: (conversationId: string) => request<{ success: boolean }>(`/conversations/${conversationId}/share`, { method: 'DELETE' }),
  resolvePublic: (token: string) => request<ShareSnapshot>(`/shares/${encodeURIComponent(token)}`),
};

/** Trigger download of JSON as a file (e.g. export data). */
export function downloadExport(data: ExportPayload, kind: ExportKind): void {
  const filename = `agent-studio-export-${kind}-${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
