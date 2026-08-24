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
  onProxyChunk?: (text: string) => void;
  cancelOnTimeout?: BackendToAgentMessage;
};

const connections = new Map<string, AgentConnection>();
const pendingRequests = new Map<string, PendingRequest>();
const messageHooks = new Set<(userId: string, message: AgentToBackendMessage) => void>();
const disconnectHooks = new Set<(userId: string) => void>();
/** Capabilities declared by each connection's most recent `hello` (§2). */
const helloCapabilities = new Map<AgentConnection, string[]>();

export function registerMessageHook(cb: (userId: string, message: AgentToBackendMessage) => void): () => void {
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
      pending.connection.send(pending.cancelOnTimeout ?? { type: 'command_cancel', requestId });
    }
  }, pending.timeoutMs);
}

function handleMessage(userId: string, connection: AgentConnection, message: AgentToBackendMessage): void {
  if (message.type === 'hello') {
    // The WS route answers hello separately (hello_ack); here we only record
    // the declared capability list for `getAgentCapabilities`. A hello
    // without the field clears any earlier declaration.
    if (message.capabilities) helloCapabilities.set(connection, [...message.capabilities]);
    else helloCapabilities.delete(connection);
  }

  for (const hook of messageHooks) {
    try {
      hook(userId, message);
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

  if (message.type === 'http_proxy_chunk') {
    pending.onProxyChunk?.(message.text);
    return;
  }

  if (message.type === 'http_proxy_response') {
    clearTimeout(pending.timer);
    pendingRequests.delete(message.requestId);
    const { type: _type, requestId: _requestId, ...result } = message;
    pending.resolve(result);
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
    || message.type === 'llamacpp_scan_response'
    || message.type === 'llamacpp_spawn_response'
    || message.type === 'llamacpp_stop_response'
    || message.type === 'llamacpp_status_response'
    || message.type === 'llamacpp_logs_response'
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
  connection.onMessage((message) => handleMessage(userId, connection, message));
}

export function unregisterAgentConnection(
  userId: string,
  connection: AgentConnection,
  _reason = 'disconnected',
): void {
  if (connections.get(userId) === connection) {
    connections.delete(userId);
  }
  helloCapabilities.delete(connection);
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

/**
 * Capabilities the connected agent declared in its most recent `hello`
 * (global-constraints.md §2 capability gate). `undefined` when the agent is
 * not connected or its hello carried no `capabilities` field — callers treat
 * that as "capability not supported".
 */
export function getAgentCapabilities(userId: string): string[] | undefined {
  const connection = getAgentConnection(userId);
  if (!connection) return undefined;
  const capabilities = helloCapabilities.get(connection);
  return capabilities ? [...capabilities] : undefined;
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

export type HttpProxyResult = {
  ok: boolean;
  status: number;
  contentType?: string;
  totalBytes?: number;
  error?: string;
};

export function sendHttpProxyRequest(
  userId: string,
  requestId: string,
  req: { url: string; method: 'GET' | 'POST'; headers: Record<string, string>; body: string | null; timeoutMs: number },
  onResponseChunk: (text: string) => void,
): Promise<HttpProxyResult> {
  const connection = getAgentConnection(userId);
  if (!connection) {
    return Promise.reject({ error: 'local agent is not connected' });
  }
  if (pendingRequests.has(requestId)) {
    return Promise.reject({ error: 'duplicate local agent request id' });
  }

  return new Promise<HttpProxyResult>((resolve, reject) => {
    const pending: PendingRequest = {
      userId,
      connection,
      timeoutMs: req.timeoutMs,
      timer: undefined as unknown as NodeJS.Timeout,
      resolve,
      reject,
      onOutputChunk: () => {},
      onProxyChunk: onResponseChunk,
      cancelOnTimeout: { type: 'http_proxy_cancel', requestId },
    };
    pending.timer = startTimeout(requestId, pending);
    pendingRequests.set(requestId, pending);
    try {
      connection.send({
        type: 'http_proxy_request',
        requestId,
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: req.body,
        timeoutMs: req.timeoutMs,
      });
    } catch {
      clearTimeout(pending.timer);
      pendingRequests.delete(requestId);
      reject({ error: 'local agent disconnected mid-command' });
    }
  });
}

export function cancelHttpProxyRequest(userId: string, requestId: string): void {
  const pending = pendingRequests.get(requestId);
  if (!pending || pending.userId !== userId || !pending.connection.isConnected()) return;
  pending.connection.send({ type: 'http_proxy_cancel', requestId });
}

export type LlamacppExitEvent = Extract<AgentToBackendMessage, { type: 'llamacpp_exited' }>;

/**
 * Subscribes to unsolicited `llamacpp_exited` pushes (one tracked llama-server
 * child per agent). Implemented over the shared messageHooks mechanism, so the
 * callback fires with the tenant userId plus the event frame. Returns an
 * unsubscribe function.
 */
export function registerLlamacppExitHook(cb: (userId: string, e: LlamacppExitEvent) => void): () => void {
  return registerMessageHook((userId, message) => {
    if (message.type === 'llamacpp_exited') cb(userId, message);
  });
}

/**
 * Generic request/response sender for the llamacpp_* frames — modeled on
 * `sendFileOpRequest` with identical timeout+cancel semantics (a lost response
 * rejects with 'local agent command timed out' and sends the same
 * `command_cancel` best-effort cancel other senders use; there is no
 * llamacpp-specific cancel frame in the §2 contract).
 */
export function sendLlamacppRequest<T extends Record<string, unknown>>(
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
