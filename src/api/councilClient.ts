import type {
  CouncilChatRequest,
  CouncilStreamEvent,
  CouncilMember,
  CouncilRun,
  CouncilRunDetail,
  CouncilConfig,
} from '../types';

/** Same as main API client: use VITE_API_URL in production so requests hit the backend, not the SPA. */
const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '') + '/api';

export interface CouncilStreamHandlers {
  onMemberStart?: (event: { member_index: number; model_id: string; total_members: number }) => void;
  onMemberComplete?: (event: {
    member_index: number;
    model_id: string;
    status: 'success' | 'error' | 'timeout';
    tokens_used?: number;
    cost?: number;
    response_time_ms?: number;
    error_message?: string;
  }) => void;
  onSynthesisStart?: (event: { synthesizer_model: string; successful_members: number; failed_members: number }) => void;
  onSynthesisChunk?: (content: string) => void;
  onSynthesisReasoning?: (content: string) => void;
  onComplete?: (event: {
    council_run_id: string;
    message_id: string;
    total_cost: number;
    total_tokens: number;
    synthesis_tokens: number;
    synthesis_cost: number;
  }) => void;
  onError?: (error: string) => void;
}

export async function streamCouncilChat(
  request: CouncilChatRequest,
  handlers: CouncilStreamHandlers,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetch(`${API_BASE}/chat/council`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Council request failed: ${errorText}`);
  }

  if (!response.body) {
    throw new Error('No response body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (data === '[DONE]') return;

        try {
          const event = JSON.parse(data) as CouncilStreamEvent;

          switch (event.type) {
            case 'council_member_start':
              handlers.onMemberStart?.(event);
              break;
            case 'council_member_complete':
              handlers.onMemberComplete?.(event);
              break;
            case 'council_synthesis_start':
              handlers.onSynthesisStart?.(event);
              break;
            case 'council_synthesis_chunk':
              handlers.onSynthesisChunk?.(event.content);
              break;
            case 'council_synthesis_reasoning':
              handlers.onSynthesisReasoning?.(event.content);
              break;
            case 'council_complete':
              handlers.onComplete?.(event);
              return;
            case 'council_error':
              handlers.onError?.(event.error);
              return;
          }
        } catch {
          // Skip malformed events
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// Council runs
export async function getCouncilRuns(conversationId: string): Promise<
  Array<{
    id: string;
    status: string;
    member_count: number;
    synthesizer_model: string;
    total_cost: number;
    total_tokens: number;
    failed_members: number;
    started_at: string;
    completed_at: string | null;
    successful_members: number;
    message_preview: string | null;
  }>
> {
  const response = await fetch(`${API_BASE}/council/runs?conversation_id=${encodeURIComponent(conversationId)}`);
  if (!response.ok) {
    throw new Error('Failed to fetch council runs');
  }
  return response.json();
}

export async function getCouncilRun(id: string): Promise<CouncilRunDetail> {
  const response = await fetch(`${API_BASE}/council/runs/${encodeURIComponent(id)}`);
  if (!response.ok) {
    throw new Error('Failed to fetch council run');
  }
  return response.json();
}

// Council members (configurations)
export async function getCouncilMembers(): Promise<CouncilMember[]> {
  const response = await fetch(`${API_BASE}/council/members`);
  if (!response.ok) {
    throw new Error('Failed to fetch council members');
  }
  return response.json();
}

export async function createCouncilMember(member: Omit<CouncilMember, 'id' | 'user_id' | 'created_at' | 'updated_at'>): Promise<CouncilMember> {
  const response = await fetch(`${API_BASE}/council/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(member),
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create council: ${error}`);
  }
  return response.json();
}

export async function updateCouncilMember(
  id: string,
  updates: Partial<Omit<CouncilMember, 'id' | 'user_id' | 'created_at' | 'updated_at'>>
): Promise<CouncilMember> {
  const response = await fetch(`${API_BASE}/council/members/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to update council: ${error}`);
  }
  return response.json();
}

export async function deleteCouncilMember(id: string): Promise<void> {
  const response = await fetch(`${API_BASE}/council/members/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error('Failed to delete council');
  }
}
