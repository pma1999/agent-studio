import type { Agent, AgentFormData, Conversation, Message, OpenRouterModel, UsageStats, OpenRouterCredits, Annotation, ReasoningConfig, Tool, McpServer, McpTransport, McpServerConfig, ChatAttachmentInput, PDFEngine } from '../types';

/** In production (Vercel), set VITE_API_URL to your Railway API URL (e.g. https://your-app.railway.app). No trailing slash. */
const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '') + '/api';

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
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ...options,
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
  logout: () =>
    request<{ success: boolean }>('/auth/logout', { method: 'POST' }),
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
};

// Conversations
export const conversationsApi = {
  list: (agentId?: string) => request<Conversation[]>(
    agentId ? `/conversations?agent_id=${agentId}` : '/conversations'
  ),
  create: (agentId: string, title?: string) => request<Conversation>('/conversations', {
    method: 'POST',
    body: JSON.stringify({ agent_id: agentId, title }),
  }),
  update: (id: string, title: string) => request<Conversation>(`/conversations/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ title }),
  }),
  delete: (id: string) => request<{ success: boolean }>(`/conversations/${id}`, {
    method: 'DELETE',
  }),
};

// Messages
export const messagesApi = {
  list: (conversationId: string) => request<Message[]>(`/conversations/${conversationId}/messages`),
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
}

export interface McpServerTestResult {
  ok: boolean;
  tools?: { name: string; description: string }[];
  error?: string;
}

export const mcpServersApi = {
  list: () => request<McpServer[]>('/mcp-servers'),
  get: (id: string) => request<McpServer>(`/mcp-servers/${id}`),
  create: (data: McpServerCreatePayload) => request<McpServer>('/mcp-servers', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
  update: (id: string, data: Partial<Pick<McpServer, 'name' | 'transport' | 'config'>>) =>
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
}
export interface StreamToolResultData {
  id: string;
  name: string;
  ok: boolean;
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
): Promise<void> {
  try {
    const body: Record<string, unknown> = { conversation_id: conversationId, content };

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

    // Retry loop for 503 (server restarting during deploy)
    let res: Response | null = null;
    for (let attempt = 0; attempt <= MAX_503_RETRIES; attempt++) {
      res = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
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

// Models
export const modelsApi = {
  openrouter: () => request<{ data: OpenRouterModel[] }>('/models/openrouter'),
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
