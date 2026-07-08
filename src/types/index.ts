export type Provider = 'openrouter' | 'deepseek';

export type ProviderRoutingConfig =
  | { mode: 'auto' }
  | { mode: 'provider'; provider_slug: string; allow_fallbacks: boolean };

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
  provider_routing?: ProviderRoutingConfig | null;
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
  headers?: Record<string, string>;
}

export interface McpConfigStdio {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
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

export interface ConversationToolConfigOverride {
  tools_overridden: boolean;
  tool_ids: string[];
  mcp_server_ids: string[];
}

export interface Conversation {
  id: string;
  agent_id: string | null;
  title: string;
  model?: string;
  provider_routing?: ProviderRoutingConfig | null;
  agent_name?: string;
  agent_emoji?: string;
  is_general?: boolean;
  tools_overridden?: boolean;
  tool_ids?: string[];
  mcp_server_ids?: string[];
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
  model?: string;
  provider_routing?: ProviderRoutingConfig | null;
  processed_by_agent_id?: string | null;
  processed_by_agent_name?: string | null;
  council_run_id?: string | null;
  is_council_synthesis?: boolean;
  created_at: string;
}

export type PDFEngine = 'pdf-text' | 'mistral-ocr' | 'native';

export interface ChatAttachmentInput {
  filename: string;
  file_data?: string;
  url?: string;
}

export type View = 'agents' | 'chat' | 'tools' | 'mcp' | 'settings' | 'councils';

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

/** Tool result for council member responses (id = tool_call_id). */
export interface ToolResultRecord {
  id: string;
  content: string;
}

export type ToolSource = 'builtin' | 'http' | 'mcp' | 'unknown';

export type ToolExecutionStatus = 'running' | 'done' | 'error';

export interface ToolExecution {
  id: string;
  name: string;
  arguments: string;
  status: ToolExecutionStatus;
  result?: string;
  ok?: boolean;
  duration_ms?: number;
  source?: ToolSource;
}

export interface StreamingReasoningEvent {
  id: string;
  type: 'reasoning';
  content: string;
}

export interface StreamingContentEvent {
  id: string;
  type: 'content';
  content: string;
}

export interface StreamingToolEvent {
  id: string;
  type: 'tool';
  tool: ToolExecution;
}

export type StreamingActivityEvent =
  | StreamingReasoningEvent
  | StreamingContentEvent
  | StreamingToolEvent;

export interface AgentFormData {
  name: string;
  description: string;
  emoji: string;
  system_prompt: string;
  provider: Provider;
  provider_routing?: ProviderRoutingConfig | null;
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

export interface GeneralChatSettings {
  model: string;
  provider_routing?: ProviderRoutingConfig | null;
  system_prompt: string;
  emoji?: string;
  tool_ids?: string[];
  mcp_server_ids?: string[];
  tool_choice?: 'auto' | 'none';
  parallel_tool_calls?: number;
  reasoning_enabled?: boolean;
  reasoning_effort?: ReasoningEffort | null;
  reasoning_max_tokens?: number | null;
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

export interface OpenRouterEndpoint {
  tag: string;
  name: string;
  provider_name: string;
  context_length: number;
  max_completion_tokens: number | null;
  pricing: { prompt: string; completion: string };
  quantization: string | null;
  supported_parameters: string[];
  status: number | null;
}

// ===== Model Council Types =====

export interface CouncilMember {
  id: string;
  user_id: string;
  name: string;
  description?: string;
  member_models: string[];
  member_provider_routing?: Record<string, ProviderRoutingConfig>;
  synthesizer_model: string;
  synthesizer_provider_routing?: ProviderRoutingConfig | null;
  synthesis_prompt_template?: string;
  auto_expand_responses: boolean;
  show_member_responses: boolean;
  tool_ids: string[];
  mcp_server_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface CouncilRun {
  id: string;
  user_id: string;
  conversation_id: string;
  message_id?: string;
  user_message_id: string;
  synthesizer_model: string;
  synthesizer_provider_routing?: ProviderRoutingConfig | null;
  member_provider_routing?: Record<string, ProviderRoutingConfig>;
  member_count: number;
  system_prompt?: string;
  status: 'running' | 'completed' | 'partial_failure' | 'failed';
  started_at: string;
  completed_at?: string;
  total_cost: number;
  total_tokens: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  failed_members: number;
  error_log?: string;
  show_member_responses?: boolean;
  created_at: string;
}

export interface CouncilResponse {
  id: string;
  council_run_id: string;
  model_id: string;
  provider_routing?: ProviderRoutingConfig | null;
  content: string;
  reasoning_content?: string;
  tokens_used: number;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  cost: number;
  response_time_ms: number;
  status: 'success' | 'error' | 'timeout' | 'cancelled';
  error_message?: string;
  display_order: number;
  tool_calls?: ToolCallSpec[];
  tool_results?: ToolResultRecord[];
  created_at: string;
}

/** Structured comparison data: agreements, disagreements, unique findings per model. */
export interface CouncilComparison {
  question_type?: 'yes_no' | 'open' | 'comparison';
  agreements?: Array<{
    finding: string;
    model_ids: string[];
    evidence?: string;
  }>;
  disagreements?: Array<{
    topic: string;
    stances: Array<{ model_id: string; stance: string }>;
    why_they_differ: string;
  }>;
  unique_findings?: Array<{
    model_id: string;
    finding: string;
    why_it_matters?: string;
  }>;
}

export interface CouncilRunDetail extends CouncilRun {
  responses: CouncilResponse[];
  comparison?: CouncilComparison;
  synthesis_message?: Message;
}

export interface CouncilConfig {
  member_models: string[];
  member_provider_routing?: Record<string, ProviderRoutingConfig>;
  synthesizer_model: string;
  synthesizer_provider_routing?: ProviderRoutingConfig | null;
  synthesis_prompt_template?: string;
  show_member_responses?: boolean;
  tool_ids?: string[];
  mcp_server_ids?: string[];
}

export interface CouncilExecutionOptions {
  conversationId: string;
  userId: string;
  content: string;
  memberModels: string[];
  synthesizerModel: string;
  memberProviderRouting?: Record<string, ProviderRoutingConfig>;
  synthesizerProviderRouting?: ProviderRoutingConfig | null;
  systemPrompt: string;
  messageHistory: Array<{ role: string; content: string }>;
  attachments?: ChatAttachmentInput[];
  pdfEngine?: PDFEngine;
  tools?: Array<{ id: string; name: string; description: string; parameters_schema: Record<string, unknown> }>;
  mcpClients?: Map<string, unknown>;
  onMemberStart: (index: number, modelId: string) => void;
  onMemberComplete: (index: number, result: MemberResult) => void;
  onSynthesisStart: (modelId: string, memberResults: MemberResult[]) => void;
  onSynthesisChunk: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface MemberResult {
  modelId: string;
  providerRouting?: ProviderRoutingConfig;
  content: string;
  reasoningContent?: string;
  tokensUsed: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cost: number;
  responseTimeMs: number;
  status: 'success' | 'error' | 'timeout';
  errorMessage?: string;
  toolCalls?: ToolCallSpec[];
}

export interface SynthesisResult {
  content: string;
  providerRouting?: ProviderRoutingConfig;
  reasoningContent?: string;
  tokensUsed: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  responseTimeMs: number;
}

export interface CouncilResult {
  memberResults: MemberResult[];
  synthesis: SynthesisResult;
  totalCost: number;
  totalTokens: number;
}

// Council Streaming Events
export type CouncilMemberStartEvent = {
  type: 'council_member_start';
  member_index: number;
  model_id: string;
  total_members: number;
};

export type CouncilMemberCompleteEvent = {
  type: 'council_member_complete';
  member_index: number;
  model_id: string;
  status: 'success' | 'error' | 'timeout';
  tokens_used?: number;
  cost?: number;
  response_time_ms?: number;
  error_message?: string;
};

export type CouncilSynthesisStartEvent = {
  type: 'council_synthesis_start';
  synthesizer_model: string;
  successful_members: number;
  failed_members: number;
};

export type CouncilSynthesisChunkEvent = {
  type: 'council_synthesis_chunk';
  content: string;
};

export type CouncilSynthesisReasoningEvent = {
  type: 'council_synthesis_reasoning';
  content: string;
};

export type CouncilCompleteEvent = {
  type: 'council_complete';
  council_run_id: string;
  message_id: string;
  total_cost: number;
  total_tokens: number;
  synthesis_tokens: number;
  synthesis_cost: number;
};

export type CouncilErrorEvent = {
  type: 'council_error';
  error: string;
  phase: 'execution' | 'synthesis' | 'storage';
};

export type ConversationTitleEvent = {
  type: 'conversation_title';
  conversation_id: string;
  title: string;
};

export type CouncilStreamEvent =
  | CouncilMemberStartEvent
  | CouncilMemberCompleteEvent
  | CouncilSynthesisStartEvent
  | CouncilSynthesisChunkEvent
  | CouncilSynthesisReasoningEvent
  | CouncilCompleteEvent
  | ConversationTitleEvent
  | CouncilErrorEvent;

// Council Chat Request
export interface CouncilChatRequest {
  conversation_id: string;
  content: string;
  council_member_id?: string;
  council_config?: CouncilConfig;
  attachments?: ChatAttachmentInput[];
  pdf_engine?: PDFEngine;
  timezone?: string;
  invoke_agent_id?: string;
}

// Council UI State
export interface CouncilUIState {
  isEnabled: boolean;
  selectedCouncilId: string | null;
  councilConfig: CouncilConfig | null;
  isExecuting: boolean;
  memberProgress: Map<number, { status: 'pending' | 'running' | 'complete' | 'error'; modelId: string; progress?: number }>;
  synthesisPhase: boolean;
  streamingContent: string;
}
