/**
 * Chat-turn bridge: translates the app's conversation semantics onto the
 * `codex app-server` thread/turn protocol.
 *
 * - One Codex thread is persisted per conversation (`conversations.codex_thread_id`).
 * - The app's system prompt becomes the thread's developer instructions.
 * - The app's own tools (builtin/http/MCP/skills) are registered as dynamic
 *   tools; each `item/tool/call` server request is executed with the app's
 *   existing tool executors and the result is returned as content items — the
 *   same safeguards (audit, e2b sandbox) apply.
 * - `item/agentMessage/delta` / reasoning deltas map 1:1 to the SSE events the
 *   chat UI already consumes.
 */

import { runTool } from '../tools/index.js';
import { runCommandTool } from '../tools/execCommand.js';
import type { ResolvedTool, RunToolResult } from '../tools/index.js';
import type { McpConnection } from '../mcp/index.js';
import { CodexRpc } from './rpc.js';
import { getConnectedInstance, CodexUnavailableError, type CodexInstance } from './instanceManager.js';

export interface CodexTurnEvent {
  [key: string]: unknown;
}

export interface CodexTurnInput {
  userId: string;
  /** Conversation id, for tool-execution context (audit trail). */
  conversationId: string | null;
  /** Existing Codex thread id for this conversation, or null to create one. */
  threadId: string | null;
  /** App system prompt (thread developer instructions). */
  systemPrompt: string;
  /**
   * Full reconstructed message history, the last entry being the current user
   * message. Used to seed a fresh thread; for existing threads only the last
   * message becomes the turn input.
   */
  messages: Array<{
    role: string;
    content?: string | unknown[] | null;
    tool_call_id?: string | null;
    tool_calls?: unknown[] | null;
  }>;
  /** Bare (non-namespaced) Codex model id; omit to use the thread default. */
  model?: string | null;
  reasoningEffort?: string | null;
  outputSchema?: Record<string, unknown> | null;
  /** App tools to expose to the model (registered as dynamic tools). */
  tools: ResolvedTool[];
  toolChoice?: 'auto' | 'none';
  mcpClients?: Map<string, McpConnection>;
  signal?: AbortSignal;
  /** SSE relay: receives {content|reasoning|tool_call|tool_result|tool_output_chunk} events. */
  emit?: (evt: CodexTurnEvent) => void;
  /** Persists a tool-result message row (chat.ts owns the DB writes). */
  persistToolResult?: (callId: string, name: string, result: RunToolResult, durationMs: number) => void;
  turnTimeoutMs?: number;
}

export interface CodexTurnResult {
  threadId: string;
  content: string;
  reasoning: string;
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  cost: number;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
}

interface TurnUsage {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

const ACTIVE_TURN_WAIT_MS = 60_000;
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,128}$/;

function lastTextMessage(messages: CodexTurnInput['messages']): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && typeof m.content === 'string') return m.content;
  }
  return '';
}

/** Items used to seed a fresh thread with the pre-existing conversation. */
function historyItems(messages: CodexTurnInput['messages']): unknown[] {
  const items: unknown[] = [];
  for (let i = 0; i < messages.length - 1; i++) {
    const m = messages[i];
    if (m.role === 'tool') continue; // tool rows reference app-side call ids; not replayable
    const text = typeof m.content === 'string' ? m.content : '';
    if (!text.trim()) continue;
    if (m.role === 'user') {
      items.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
    } else if (m.role === 'assistant') {
      items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
    }
  }
  return items;
}

function buildDynamicTools(tools: ResolvedTool[]): unknown[] {
  const out: unknown[] = [];
  for (const tool of tools) {
    const name = tool.name;
    if (!TOOL_NAME_RE.test(name)) {
      console.warn(`[codex] Tool '${name}' skipped: name must match ^[a-zA-Z0-9_-]{1,128}$`);
      continue;
    }
    out.push({
      type: 'function',
      name,
      description: tool.openAIDef.function.description || '',
      inputSchema: tool.openAIDef.function.parameters ?? { type: 'object', properties: {} },
    });
  }
  return out;
}

async function waitForActiveTurnClear(inst: CodexInstance, threadId: string, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + ACTIVE_TURN_WAIT_MS;
  while (inst.activeTurns.has(threadId)) {
    if (signal?.aborted) throw new AbortError('Turn cancelled');
    if (Date.now() > deadline) {
      throw new CodexUnavailableError('Another response is still generating in this conversation. Please wait.');
    }
    await sleep(500);
  }
}

class AbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AbortError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs one app turn through the user's Codex app-server.
 * Returns the accumulated text/reasoning/token usage and the thread id.
 */
export async function runCodexTurn(input: CodexTurnInput): Promise<CodexTurnResult> {
  const inst = await getConnectedInstance(input.userId);
  const rpc = inst.rpc;
  const threadId = await ensureThread(inst, input);
  await waitForActiveTurnClear(inst, threadId, input.signal);
  inst.activeTurns.add(threadId);

  const emit = (evt: CodexTurnEvent) => {
    if (!input.emit || input.signal?.aborted) return;
    try {
      input.emit(evt);
    } catch {
      // relay errors are non-fatal
    }
  };

  const turnTimeoutMs = input.turnTimeoutMs ?? Number(process.env.CODEX_TURN_TIMEOUT_MS ?? 300_000);
  const listeners: Array<() => void> = [];

  return new Promise<CodexTurnResult>((resolve, reject) => {
    let settled = false;
    let interrupted = false;
    let content = '';
    let reasoning = '';
    let failMessage: string | null = null;
    let turnId: string | null = null;
    let usage: TurnUsage = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

    const finish = (err: Error | null, result?: Partial<CodexTurnResult>) => {
      if (settled) return;
      settled = true;
      cleanup();
      inst.activeTurns.delete(threadId);
      inst.lastUsedAt = Date.now();
      if (err) reject(err);
      else
        resolve({
          threadId,
          content,
          reasoning,
          totalTokens: usage.totalTokens,
          inputTokens: usage.inputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          outputTokens: usage.outputTokens,
          reasoningOutputTokens: usage.reasoningOutputTokens,
          cost: 0,
          toolCalls,
          ...result,
        });
    };

    const cleanup = () => {
      for (const off of listeners) off();
      listeners.length = 0;
    };

    const handleToolCall = async (id: number, params: unknown): Promise<void> => {
      const p = params as { threadId?: string; turnId?: string; callId?: string; namespace?: string | null; tool?: string; arguments?: unknown };
      if (p.threadId !== threadId) return;
      const name = p.tool || '';
      const callId = p.callId || `call_${Date.now()}`;
      let args: Record<string, unknown> = {};
      if (p.arguments && typeof p.arguments === 'object') {
        try {
          args = JSON.parse(JSON.stringify(p.arguments));
        } catch {
          args = {};
        }
      }
      const resolvedTool = input.tools.find((t) => t.name === name);
      const source = resolvedTool?.type || 'unknown';
      emit({ tool_call: { id: callId, name, arguments: JSON.stringify(args), source } });

      const startedAt = Date.now();
      let result: RunToolResult;
      try {
        let outputSeq = 0;
        if (name === 'run_command') {
          result = await runCommandTool(args, input.userId, {
            signal: input.signal ?? new AbortController().signal,
            onOutputChunk: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => {
              emit({ tool_output_chunk: { id: callId, stream: chunk.stream, text: chunk.text, seq: outputSeq++ } });
            },
          });
        } else {
          result = await runTool(
            input.tools,
            name,
            args,
            input.mcpClients,
            input.userId,
            input.conversationId ?? undefined,
            input.messages as Array<{ role: string; content?: unknown }>
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result = { output: `[Tool execution error] ${msg}`, isError: true, source };
      }
      const durationMs = Date.now() - startedAt;

      rpc.respond(id, {
        contentItems: [{ type: 'inputText', text: result.output }],
        success: !result.isError,
      });

      emit({
        tool_result: {
          id: callId,
          name,
          ok: !result.isError,
          result: result.output,
          duration_ms: durationMs,
          source: result.source,
          ...(name === 'run_command' && result.metadata ? { metadata: result.metadata } : {}),
        },
      });
      toolCalls.push({ id: callId, name, arguments: JSON.stringify(args) });
      input.persistToolResult?.(callId, name, result, durationMs);
    };

    const handleServerRequest = (method: string, id: number, params: unknown): void => {
      if (method === 'item/tool/call') {
        handleToolCall(id, params).catch((err) => {
          console.error('[codex] dynamic tool call failed:', err);
          rpc.respond(id, {
            contentItems: [{ type: 'inputText', text: `[Tool execution error] ${err instanceof Error ? err.message : String(err)}` }],
            success: false,
          });
        });
        return;
      }
      // Defense in depth: sandbox is read-only and approval policy is "never",
      // but if the model still asks for approvals, decline everything.
      const p = (params ?? {}) as { threadId?: string };
      if (p.threadId === threadId) {
        if (method === 'item/commandExecution/requestApproval') {
          rpc.respond(id, { decision: 'decline' });
        } else if (method === 'item/fileChange/requestApproval') {
          rpc.respond(id, { decision: 'decline' });
        } else if (method === 'item/permissions/requestApproval') {
          rpc.respond(id, { permissions: {} });
        } else if (method === 'item/tool/requestUserInput') {
          rpc.respond(id, { answers: [] });
        } else if (method === 'mcpServer/elicitation/request') {
          rpc.respond(id, { action: 'decline', content: null });
        }
      }
    };

    const handleNotification = (method: string, params: unknown): void => {
      const p = (params ?? {}) as {
        threadId?: string;
        turnId?: string | null;
        itemId?: string;
        delta?: string;
        error?: { message?: string } | null;
        turn?: { id?: string; status?: string; error?: { message?: string } | null };
        tokenUsage?: { total?: TurnUsage; last?: TurnUsage };
      };
      if (p.threadId !== threadId) return;

      if (method === 'item/agentMessage/delta' && typeof p.delta === 'string') {
        content += p.delta;
        emit({ content: p.delta });
        return;
      }
      if ((method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') && typeof p.delta === 'string') {
        reasoning += p.delta;
        emit({ reasoning: p.delta });
        return;
      }
      if (method === 'thread/tokenUsage/updated' && p.tokenUsage?.last) {
        const last = p.tokenUsage.last;
        usage = {
          totalTokens: last.totalTokens ?? usage.totalTokens,
          inputTokens: last.inputTokens ?? usage.inputTokens,
          cachedInputTokens: last.cachedInputTokens ?? usage.cachedInputTokens,
          outputTokens: last.outputTokens ?? usage.outputTokens,
          reasoningOutputTokens: last.reasoningOutputTokens ?? usage.reasoningOutputTokens,
        };
        return;
      }
      if (method === 'turn/completed' && p.turn) {
        const status = p.turn.status;
        if (status === 'failed' || status === 'interrupted') {
          const message = p.turn.error?.message || (status === 'interrupted' ? 'Turn interrupted' : 'Codex turn failed');
          failMessage = message;
          if (status === 'interrupted' && interrupted) {
            finish(new AbortError('Turn cancelled'));
          } else {
            finish(new CodexUnavailableError(message));
          }
          return;
        }
        finish(null);
        return;
      }
      if (method === 'error') {
        failMessage = p.error?.message ?? 'Codex error';
      }
    };

    listeners.push(
      rpc.onNotification(handleNotification),
      rpc.onServerRequest(handleServerRequest)
    );

    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      console.warn('[codex] turn timed out, interrupting');
      interrupted = true;
      rpc.request('turn/interrupt', { threadId, turnId: turnId ?? undefined }, 15_000).catch(() => {});
      // The turn/completed(interrupted) notification resolves the promise.
      setTimeout(() => finish(new CodexUnavailableError(`Codex turn timed out after ${turnTimeoutMs}ms`)), 20_000);
    }, turnTimeoutMs);

    const abortHandler = () => {
      if (settled) return;
      interrupted = true;
      rpc.request('turn/interrupt', { threadId, turnId: turnId ?? undefined }, 15_000).catch(() => {});
      // fallback if the interrupt never completes the turn
      setTimeout(() => finish(new AbortError('Turn cancelled')), 15_000);
    };
    if (input.signal) {
      if (input.signal.aborted) {
        abortHandler();
      } else {
        input.signal.addEventListener('abort', abortHandler, { once: true });
        listeners.push(() => input.signal!.removeEventListener('abort', abortHandler));
      }
    }

    (async () => {
      const turnParams: Record<string, unknown> = {
        threadId,
        input: [{ type: 'text', text: lastTextMessage(input.messages), text_elements: [] }],
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly' },
      };
      if (input.model) turnParams.model = input.model;
      if (input.reasoningEffort && input.reasoningEffort !== 'none') {
        turnParams.effort = input.reasoningEffort;
      }
      if (input.outputSchema && typeof input.outputSchema === 'object') {
        turnParams.outputSchema = input.outputSchema;
      }

      try {
        const res = await rpc.request<{ turn?: { id?: string; status?: string } }>('turn/start', turnParams, 60_000);
        turnId = res?.turn?.id ?? null;
      } catch (err) {
        // Active-turn collision on the thread: interrupt and retry once.
        if (err instanceof Error && /active turn|already.*turn|in progress/i.test(err.message)) {
          try {
            await rpc.request('turn/interrupt', { threadId }, 15_000);
            await sleep(1_000);
            const retry = await rpc.request<{ turn?: { id?: string } }>('turn/start', turnParams, 60_000);
            turnId = retry?.turn?.id ?? null;
          } catch (retryErr) {
            clearTimeout(timeoutTimer);
            finish(
              new CodexUnavailableError(
                retryErr instanceof Error ? retryErr.message : 'Failed to start Codex turn'
              )
            );
            return;
          }
        } else {
          clearTimeout(timeoutTimer);
          finish(
            new CodexUnavailableError(err instanceof Error ? err.message : 'Failed to start Codex turn')
          );
          return;
        }
      }
    })();
  });
}

/** Resolves the conversation's Codex thread, creating + seeding it if needed. */
async function ensureThread(inst: CodexInstance, input: CodexTurnInput): Promise<string> {
  const rpc = inst.rpc;
  let threadId = input.threadId;
  if (threadId) {
    try {
      await rpc.request('thread/resume', { threadId }, 30_000);
      return threadId;
    } catch {
      // Stale thread (reset/archived/deleted) — start a fresh one.
      threadId = null;
    }
  }

  const dynamicTools = buildDynamicTools(input.toolChoice === 'none' ? [] : input.tools);
  const startParams: Record<string, unknown> = {
    developerInstructions: input.systemPrompt || null,
    sandbox: 'read-only',
    approvalPolicy: 'never',
    serviceName: 'agent_studio',
  };
  if (input.model) startParams.model = input.model;
  if (dynamicTools.length > 0) {
    startParams.dynamicTools = dynamicTools;
  }

  const res = await rpc.request<{ thread?: { id?: string } }>('thread/start', startParams, 30_000);
  const newThreadId = res?.thread?.id;
  if (!newThreadId) {
    throw new CodexUnavailableError('Codex did not return a thread id');
  }

  const history = historyItems(input.messages);
  if (history.length > 0) {
    try {
      await rpc.request('thread/inject_items', { threadId: newThreadId, items: history }, 30_000);
    } catch (err) {
      console.warn('[codex] thread/inject_items failed (continuing without seeded history):', err);
    }
  }
  return newThreadId;
}
