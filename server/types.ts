// Server-side type definitions for Council feature
// These mirror the client types but are defined here to avoid cross-rootDir imports

export interface Tool {
  id: string;
  name: string;
  description: string;
  parameters_schema: Record<string, unknown>;
  type: 'builtin' | 'http';
  config?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface ToolCallSpec {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface CouncilConfig {
  member_models: string[];
  synthesizer_model: string;
  synthesis_prompt_template?: string;
  show_member_responses?: boolean;
  tool_ids?: string[];
  mcp_server_ids?: string[];
}

/** Tool result stored per council member response (id = tool_call_id). */
export interface ToolResultRecord {
  id: string;
  content: string;
}

export interface MemberResult {
  modelId: string;
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
  /** Results for each tool call (same order as toolCalls, keyed by id). */
  toolResults?: ToolResultRecord[];
}

export interface SynthesisResult {
  content: string;
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

export interface ResolvedTool {
  id: string;
  name: string;
  type: 'builtin' | 'http' | 'mcp';
  config: unknown;
  openAIDef: {
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  };
}

export interface CouncilExecutionOptions {
  conversationId: string;
  userId: string;
  content: string;
  memberModels: string[];
  synthesizerModel: string;
  systemPrompt: string;
  messageHistory: Array<{ role: string; content: string }>;
  attachments?: Array<{ filename: string; file_data?: string; url?: string }>;
  pdfEngine?: string;
  tools?: ResolvedTool[];
  mcpClients?: Map<string, unknown>;
  onMemberStart: (index: number, modelId: string) => void;
  onMemberComplete: (index: number, result: MemberResult) => void;
  onSynthesisStart: (modelId: string, memberResults: MemberResult[]) => void;
  onSynthesisChunk: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface CouncilMember {
  id: string;
  user_id: string;
  name: string;
  description?: string;
  member_models: string[];
  synthesizer_model: string;
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

export interface CouncilRunDetail extends CouncilRun {
  responses: CouncilResponse[];
  synthesis_message?: {
    id: string;
    conversation_id: string;
    role: string;
    content: string;
    reasoning_content?: string;
    tokens_used: number;
    cost: number;
    model: string;
    council_run_id: string;
    created_at: string;
  };
}

export interface CouncilResponse {
  id: string;
  council_run_id: string;
  model_id: string;
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
  /** Parsed from DB JSON; maps tool_call_id to result content. */
  tool_results?: ToolResultRecord[];
  created_at: string;
}
