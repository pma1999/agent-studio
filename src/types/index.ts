export type Provider = 'openrouter';

export type ReasoningEffort = 'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'none';

export interface ReasoningConfig {
  enabled: boolean;
  effort?: ReasoningEffort;
  max_tokens?: number;
  exclude?: boolean;
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  emoji: string;
  system_prompt: string;
  provider: Provider;
  base_url: string;
  model: string;
  temperature: number;
  max_tokens: number;
  web_search_enabled?: boolean;
  reasoning_enabled?: boolean;
  reasoning_effort?: ReasoningEffort | null;
  reasoning_max_tokens?: number | null;
  tool_ids?: string[];
  tools?: Tool[];
  mcp_server_ids?: string[];
  mcp_servers?: McpServer[];
  tool_choice?: 'auto' | 'none';
  parallel_tool_calls?: boolean;
  structured_output_enabled?: boolean;
  structured_output_schema?: string | null;
  response_healing_enabled?: boolean;
  created_at: string;
  updated_at: string;
}

export type McpTransport = 'url' | 'stdio';

export interface McpConfigUrl {
  url: string;
}

export interface McpConfigStdio {
  command: string;
  args?: string[];
}

export type McpServerConfig = McpConfigUrl | McpConfigStdio;

export interface McpServer {
  id: string;
  name: string;
  transport: McpTransport;
  config: McpServerConfig | null;
  created_at: string;
  updated_at: string;
}

export interface Conversation {
  id: string;
  agent_id: string;
  title: string;
  agent_name?: string;
  agent_emoji?: string;
  created_at: string;
  updated_at: string;
}

export interface Annotation {
  type: string;
  url?: string;
  title?: string;
  start_index?: number;
  end_index?: number;
  file?: { hash: string; name?: string; content?: unknown[] };
}

export interface MessageAttachment {
  filename: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tokens_used?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  annotations?: Annotation[];
  attachments?: MessageAttachment[];
  reasoning_content?: string;
  reasoning_tokens?: number;
  cached_tokens?: number;
  tool_call_id?: string;
  tool_calls?: ToolCallSpec[];
  created_at: string;
}

export type PDFEngine = 'pdf-text' | 'mistral-ocr' | 'native';

export interface ChatAttachmentInput {
  filename: string;
  file_data?: string;
  url?: string;
}

export type View = 'agents' | 'chat' | 'tools' | 'mcp' | 'settings';

export type ToolType = 'builtin' | 'http';

export interface Tool {
  id: string;
  name: string;
  description: string;
  parameters_schema: Record<string, unknown>;
  type: ToolType;
  config?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface ToolCallSpec {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface AgentFormData {
  name: string;
  description: string;
  emoji: string;
  system_prompt: string;
  provider: Provider;
  base_url: string;
  model: string;
  temperature: number;
  max_tokens: number;
  web_search_enabled?: boolean;
  reasoning_enabled?: boolean;
  reasoning_effort?: ReasoningEffort | null;
  reasoning_max_tokens?: number | null;
  tool_ids?: string[];
  mcp_server_ids?: string[];
  tool_choice?: 'auto' | 'none';
  parallel_tool_calls?: boolean;
  structured_output_enabled?: boolean;
  structured_output_schema?: string | null;
  response_healing_enabled?: boolean;
}

export interface UsageStats {
  total_cost: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_cached_tokens: number;
  total_messages: number;
}

export interface OpenRouterCredits {
  limit: number | null;
  limit_remaining: number | null;
  usage: number;
  usage_daily: number;
  usage_monthly: number;
  is_free_tier: boolean;
}

export interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  context_length: number;
  pricing: { prompt: string; completion: string };
}
