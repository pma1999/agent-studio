import crypto from 'crypto';

const APPROVAL_TIMEOUT_MS = 60_000;
const MAX_REVIEW_JSON_CHARS = 16_000;
const MAX_PENDING_APPROVALS = 1_000;

export interface McpToolAuthorizationRequest {
  serverId: string;
  serverName?: string;
  exposedName: string;
  toolName: string;
  arguments: Record<string, unknown>;
  /** Server-provided hints only. They are never trusted for authorization. */
  annotations?: Record<string, unknown>;
  /** Server-provided execution metadata only. */
  execution?: Record<string, unknown>;
  possibleCrossToolData: boolean;
}

export interface McpApprovalEvent {
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

interface PendingApproval {
  userId: string;
  conversationId: string;
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abortListener?: () => void;
}

const pendingApprovals = new Map<string, PendingApproval>();

function stableReviewJson(value: unknown): string | null {
  try {
    const json = JSON.stringify(value);
    if (json === undefined || json.length > MAX_REVIEW_JSON_CHARS) return null;
    return json;
  } catch {
    return null;
  }
}

function boundedHint(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const json = stableReviewJson(value);
  if (!json) return { omitted: true };
  return value;
}

function settle(id: string, approved: boolean): boolean {
  const pending = pendingApprovals.get(id);
  if (!pending) return false;
  pendingApprovals.delete(id);
  clearTimeout(pending.timer);
  if (pending.signal && pending.abortListener) {
    pending.signal.removeEventListener('abort', pending.abortListener);
  }
  pending.resolve(approved);
  return true;
}

export type ApprovalResolution = 'approved' | 'denied' | 'not_found';

/** Resolve a one-shot approval. A different tenant deliberately sees not_found. */
export function resolveMcpToolApproval(id: string, userId: string, approved: boolean): ApprovalResolution {
  const pending = pendingApprovals.get(id);
  if (!pending || pending.userId !== userId) return 'not_found';
  settle(id, approved);
  return approved ? 'approved' : 'denied';
}

export function cancelMcpToolApprovalsForConversation(userId: string, conversationId: string): void {
  for (const [id, pending] of pendingApprovals) {
    if (pending.userId === userId && pending.conversationId === conversationId) settle(id, false);
  }
}

/**
 * Ask the authenticated browser to approve one exact MCP invocation. The
 * request is one-shot, tenant-bound, conversation-bound, abortable and
 * time-limited. Oversized/unserializable arguments are denied because a human
 * could not review the complete value safely.
 */
export async function requestMcpToolApproval(input: {
  userId: string;
  conversationId: string;
  request: McpToolAuthorizationRequest;
  emit: (event: McpApprovalEvent) => void;
  signal?: AbortSignal;
}): Promise<boolean> {
  if (input.signal?.aborted || pendingApprovals.size >= MAX_PENDING_APPROVALS) return false;
  const argumentsJson = stableReviewJson(input.request.arguments);
  if (!argumentsJson) return false;

  const id = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString();
  const digest = crypto.createHash('sha256').update(argumentsJson).digest('hex');

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => settle(id, false), APPROVAL_TIMEOUT_MS);
    timer.unref?.();
    const abortListener = () => settle(id, false);
    const pending: PendingApproval = {
      userId: input.userId,
      conversationId: input.conversationId,
      resolve,
      timer,
      ...(input.signal ? { signal: input.signal, abortListener } : {}),
    };
    pendingApprovals.set(id, pending);
    input.signal?.addEventListener('abort', abortListener, { once: true });

    try {
      input.emit({
        id,
        server_id: input.request.serverId,
        ...(input.request.serverName ? { server_name: input.request.serverName.slice(0, 200) } : {}),
        exposed_name: input.request.exposedName,
        tool_name: input.request.toolName,
        arguments: input.request.arguments,
        arguments_sha256: digest,
        possible_cross_tool_data: input.request.possibleCrossToolData,
        ...(boundedHint(input.request.annotations) ? { annotations: boundedHint(input.request.annotations) } : {}),
        ...(boundedHint(input.request.execution) ? { execution: boundedHint(input.request.execution) } : {}),
        expires_at: expiresAt,
      });
    } catch {
      settle(id, false);
    }
  });
}

/** Test-only observability without exposing pending payloads. */
export function pendingMcpToolApprovalCount(): number {
  return pendingApprovals.size;
}
