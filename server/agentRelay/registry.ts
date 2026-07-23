import type { AgentToBackendMessage, BackendToAgentMessage } from './protocol.js';

export interface AgentConnection {
  isConnected(): boolean;
  send(msg: BackendToAgentMessage): void;
  onMessage(cb: (msg: AgentToBackendMessage) => void): void;
  close(reason?: string): void;
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
  resolve: (result: CommandResult) => void;
  reject: (error: { error: string }) => void;
  onOutputChunk: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void;
};

const connections = new Map<string, AgentConnection>();
const pendingRequests = new Map<string, PendingRequest>();

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
}

export function getAgentConnection(userId: string): AgentConnection | undefined {
  const connection = connections.get(userId);
  return connection?.isConnected() ? connection : undefined;
}

export function isAgentConnected(userId: string): boolean {
  return getAgentConnection(userId) !== undefined;
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

export function cancelCommandRequest(userId: string, requestId: string): void {
  const pending = pendingRequests.get(requestId);
  if (!pending || pending.userId !== userId || !pending.connection.isConnected()) return;
  pending.connection.send({ type: 'command_cancel', requestId });
}
