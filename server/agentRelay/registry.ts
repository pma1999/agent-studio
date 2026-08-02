import type { AgentToBackendMessage, BackendToAgentMessage } from './protocol.js';

export interface AgentConnection {
  isConnected(): boolean;
  send(msg: BackendToAgentMessage): void;
  onMessage(cb: (msg: AgentToBackendMessage) => void): void;
  close(reason?: string): void;
  getIdentity?(): { platform?: string; shell?: { kind: string; execPath: string } } | undefined;
}

type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  blockedPattern?: string;
  confirmation?: 'approved' | 'declined' | 'timeout';
};

type PendingRequest = {
  userId: string;
  connection: AgentConnection;
  timeoutMs: number;
  timer: NodeJS.Timeout;
  resolve: (result: any) => void;
  reject: (error: { error: string }) => void;
  onOutputChunk: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void;
};

const connections = new Map<string, AgentConnection>();
const pendingRequests = new Map<string, PendingRequest>();
const messageHooks = new Set<(message: AgentToBackendMessage) => void>();
const disconnectHooks = new Set<(userId: string) => void>();

export function registerMessageHook(cb: (message: AgentToBackendMessage) => void): () => void {
  messageHooks.add(cb);
  return () => {
    messageHooks.delete(cb);
  };
}

export function registerDisconnectHook(cb: (userId: string) => void): () => void {
  disconnectHooks.add(cb);
  return () => {
    disconnectHooks.delete(cb);
  };
}

function rejectPendingForConnection(connection: AgentConnection): void {
  for (const [requestId, pending] of pendingRequests) {
    if (pending.connection !== connection) continue;
    clearTimeout(pending.timer);
    pendingRequests.delete(requestId);
    pending.reject({ error: 'local agent disconnected mid-command' });
  }
}

function startTimeout(requestId: string, pending: PendingRequest): NodeJS.Timeout {
  return setTimeout(() => {
    if (pendingRequests.get(requestId) !== pending) return;
    pendingRequests.delete(requestId);
    pending.reject({ error: 'local agent command timed out' });
    if (pending.connection.isConnected()) {
      pending.connection.send({ type: 'command_cancel', requestId });
    }
  }, pending.timeoutMs);
}

function handleMessage(connection: AgentConnection, message: AgentToBackendMessage): void {
  for (const hook of messageHooks) {
    try {
      hook(message);
    } catch (e) {
      console.error('[agentRelay] message hook error:', e);
    }
  }

  if (!('requestId' in message)) return;
  const pending = pendingRequests.get(message.requestId);
  if (!pending || pending.connection !== connection) return;

  if (message.type === 'command_awaiting_confirmation') {
    clearTimeout(pending.timer);
    pending.timer = startTimeout(message.requestId, pending);
    return;
  }

  if (message.type === 'command_output_chunk') {
    pending.onOutputChunk({ stream: message.stream, text: message.text });
    return;
  }

  if (message.type === 'command_response') {
    clearTimeout(pending.timer);
    pendingRequests.delete(message.requestId);
    const { type: _type, requestId: _requestId, ...result } = message;
    pending.resolve(result);
  }

  if (
    message.type === 'read_file_response'
    || message.type === 'write_file_response'
    || message.type === 'edit_file_response'
    || message.type === 'delete_file_response'
    || message.type === 'list_directory_response'
    || message.type === 'send_file_response'
    || message.type === 'receive_file_response'
    || message.type === 'mcp_start_response'
    || message.type === 'mcp_stop_response'
  ) {
    clearTimeout(pending.timer);
    pendingRequests.delete(message.requestId);
    const { type: _type, requestId: _requestId, ...result } = message;
    pending.resolve(result);
  }
}

export function registerAgentConnection(userId: string, connection: AgentConnection): void {
  const previous = connections.get(userId);
  if (previous && previous !== connection) {
    unregisterAgentConnection(userId, previous, 'replaced by a newer connection');
    previous.close('replaced by a newer connection');
  }
  connections.set(userId, connection);
  connection.onMessage((message) => handleMessage(connection, message));
}

export function unregisterAgentConnection(
  userId: string,
  connection: AgentConnection,
  _reason = 'disconnected',
): void {
  if (connections.get(userId) === connection) {
    connections.delete(userId);
  }
  rejectPendingForConnection(connection);
  for (const hook of disconnectHooks) {
    try {
      hook(userId);
    } catch (e) {
      console.error('[agentRelay] disconnect hook error:', e);
    }
  }
}

export function getAgentConnection(userId: string): AgentConnection | undefined {
  const connection = connections.get(userId);
  return connection?.isConnected() ? connection : undefined;
}

export function isAgentConnected(userId: string): boolean {
  return getAgentConnection(userId) !== undefined;
}

export function getAgentShellInfo(userId: string): {
  platform?: string;
  shell?: { kind: string; execPath: string };
} | undefined {
  return getAgentConnection(userId)?.getIdentity?.();
}

export function sendCommandRequest(
  userId: string,
  requestId: string,
  command: string,
  cwd: string | undefined,
  timeoutMs: number,
  onOutputChunk: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void,
): Promise<CommandResult> {
  const connection = getAgentConnection(userId);
  if (!connection) {
    return Promise.reject({ error: 'local agent is not connected' });
  }
  if (pendingRequests.has(requestId)) {
    return Promise.reject({ error: 'duplicate local agent request id' });
  }

  return new Promise<CommandResult>((resolve, reject) => {
    const pending = {
      userId,
      connection,
      timeoutMs,
      timer: undefined as unknown as NodeJS.Timeout,
      resolve,
      reject,
      onOutputChunk,
    };
    pending.timer = startTimeout(requestId, pending);
    pendingRequests.set(requestId, pending);
    try {
      connection.send({ type: 'command_request', requestId, command, cwd, timeoutMs });
    } catch {
      clearTimeout(pending.timer);
      pendingRequests.delete(requestId);
      reject({ error: 'local agent disconnected mid-command' });
    }
  });
}

export function sendFileOpRequest<T extends Record<string, unknown>>(
  userId: string,
  request: BackendToAgentMessage & { requestId: string },
  timeoutMs: number,
): Promise<T> {
  const connection = getAgentConnection(userId);
  if (!connection) {
    return Promise.reject({ error: 'local agent is not connected' });
  }
  if (pendingRequests.has(request.requestId)) {
    return Promise.reject({ error: 'duplicate local agent request id' });
  }

  return new Promise<T>((resolve, reject) => {
    const pending = {
      userId,
      connection,
      timeoutMs,
      timer: undefined as unknown as NodeJS.Timeout,
      resolve,
      reject,
      onOutputChunk: () => {},
    };
    pending.timer = startTimeout(request.requestId, pending);
    pendingRequests.set(request.requestId, pending);
    try {
      connection.send(request);
    } catch {
      clearTimeout(pending.timer);
      pendingRequests.delete(request.requestId);
      reject({ error: 'local agent disconnected mid-command' });
    }
  });
}

export function cancelCommandRequest(userId: string, requestId: string): void {
  const pending = pendingRequests.get(requestId);
  if (!pending || pending.userId !== userId || !pending.connection.isConnected()) return;
  pending.connection.send({ type: 'command_cancel', requestId });
}
