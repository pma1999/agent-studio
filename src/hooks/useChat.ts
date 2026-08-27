import { useCallback, useRef } from 'react';
import { useStore } from '../stores/store';
import { streamChat, stopTurn, artifactsApi } from '../api/client';
import { conversationsApi, mcpServersApi, type McpApprovalRequiredData } from '../api/client';
import { streamCouncilChat } from '../api/councilClient';
import { buildThread, getTurnVariants } from '../utils/threads';
import type { Message, ChatAttachmentInput, PDFEngine, CouncilConfig, ProviderRoutingConfig, ChatArtifact } from '../types';

export interface SendMessageOptions {
  attachments?: ChatAttachmentInput[];
  pdf_engine?: PDFEngine;
  model?: string;
  providerRouting?: ProviderRoutingConfig | null;
  invokeAgentId?: string;
  invokeSkillNames?: string[];
  councilConfig?: CouncilConfig;
  /** When set, server loads full council config (including tool_ids) from DB instead of using councilConfig inline */
  councilMemberId?: string;
  /** When set, the message is sent as a NEW VARIANT of the target user message's turn (edit/relaunch). */
  editMessageId?: string;
}

/**
 * The exact MCP approval dialog used by the live streaming path (regular sends).
 * Extracted so the reopen-poll reconciliation flow can surface recovered
 * approvals through the SAME window.confirm + resolveApproval semantics.
 */
export function confirmMcpApproval(approval: McpApprovalRequiredData): boolean {
  let argumentsText = '{}';
  try {
    argumentsText = JSON.stringify(approval.arguments, null, 2);
  } catch {
    // The server already rejects values that cannot be reviewed fully.
  }
  const flowWarning = approval.possible_cross_tool_data
    ? '\n\nWarning: these arguments may contain data returned by another tool or server.'
    : '';
  return window.confirm(
    `Allow this exact MCP tool call?\n\n`
    + `Server: ${approval.server_name || approval.server_id}\n`
    + `Tool: ${approval.tool_name}\n`
    + `Arguments (SHA-256 ${approval.arguments_sha256.slice(0, 12)}…):\n${argumentsText}`
    + flowWarning
    + '\n\nServer annotations are untrusted hints and were not used to approve this action.',
  );
}

/** stopTurn capped at ~3s so a hanging backend never freezes the Stop click. */
const STOP_TURN_TIMEOUT_MS = 3_000;

function stopTurnWithTimeout(conversationId: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stop request timed out')), timeoutMs);
    stopTurn(conversationId)
      .then(() => {
        clearTimeout(timer);
        resolve();
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function hydrateArtifactsFor(conversationId: string): void {
  void artifactsApi.listByConversation(conversationId).then(
    (res) => useStore.getState().hydrateConversationArtifacts(conversationId, res.artifacts),
    (err: unknown) => console.warn('[artifacts] hydrate failed', err),
  );
}

export function useChat() {
  const {
    activeConversationId,
    streamsByConversation,
    beginStream,
    endStream,
    appendStreamContent,
    appendStreamContentEvent,
    setStreamAbortController,
    reasoningOverride,
    addMessage,
    loadMessages,
    loadConversations,
    updateConversationTitle,
    selectedAgentId,
    appendStreamReasoning,
    appendStreamReasoningEvent,
    upsertStreamToolCall,
    completeStreamToolCall,
    appendStreamToolOutputChunk,
    // Council state
    councilEnabled,
    setCouncilIsExecuting,
    setCouncilMemberProgress,
    setCouncilSynthesisPhase,
    setCouncilStreamingContent,
    appendCouncilStreamingContent,
    resetCouncilState,
  } = useStore();

  // Track whether we already auto-opened the artifact panel this turn (per sendRegularMessage closure, reset on next send).
  const turnOpenedArtifactPanelRef = useRef(false);
  const artifactPanelOpenRef = useRef(useStore.getState().artifactPanelOpen);
  // Keep artifactPanelOpenRef fresh without adding to callback deps (avoids stale closure).
  artifactPanelOpenRef.current = useStore.getState().artifactPanelOpen;

  const sendMessage = useCallback(async (content: string, options?: SendMessageOptions) => {
    // Check if council mode is enabled or council config is provided
    const useCouncil = councilEnabled || options?.councilConfig;

    if (useCouncil) {
      return sendCouncilMessage(content, options);
    }

    return sendRegularMessage(content, options);
  }, [councilEnabled, activeConversationId, streamsByConversation, beginStream, endStream, appendStreamContent, appendStreamContentEvent, setStreamAbortController, reasoningOverride, appendStreamReasoning, appendStreamReasoningEvent, upsertStreamToolCall, completeStreamToolCall, appendStreamToolOutputChunk, addMessage, loadMessages, loadConversations, updateConversationTitle, selectedAgentId]);

  const sendCouncilMessage = useCallback(async (content: string, options?: SendMessageOptions) => {
    const conversationId = activeConversationId;
    // Send guard is per conversation: a stream running in ANOTHER conversation
    // must not block this one (the server 409 claim remains the same-conversation guard).
    if (!conversationId || streamsByConversation[conversationId] || !content.trim()) return;

    const attachments = options?.attachments;
    const pdf_engine = options?.pdf_engine;
    const invokeAgentId = options?.invokeAgentId;
    const councilConfig = options?.councilConfig;
    const councilMemberId = options?.councilMemberId;

    if (!councilMemberId && !councilConfig) {
      console.error('Council config or councilMemberId required for council mode');
      return;
    }

    // Add user message to local state immediately
    const userMsg: Message = {
      id: `temp-user-${Date.now()}`,
      conversation_id: conversationId,
      role: 'user',
      content: content.trim(),
      created_at: new Date().toISOString(),
      ...(attachments?.length && { attachments: attachments.map((a) => ({ filename: a.filename })) }),
    };
    addMessage(userMsg);

    // Add placeholder assistant message for synthesis
    const assistantMsg: Message = {
      id: `temp-council-${Date.now()}`,
      conversation_id: conversationId,
      role: 'assistant',
      content: '',
      created_at: new Date().toISOString(),
    };
    addMessage(assistantMsg);

    // Register the per-conversation stream (busy state + abort controller +
    // activity events live on the entry; council CONTENT fields stay separate).
    const controller = new AbortController();
    beginStream(conversationId);
    setStreamAbortController(conversationId, controller);

    setCouncilIsExecuting(true);
    setCouncilStreamingContent('');
    setCouncilMemberProgress(new Map());
    setCouncilSynthesisPhase(false);

    try {
      await streamCouncilChat(
        {
          conversation_id: conversationId,
          content: content.trim(),
          ...(councilMemberId
            ? { council_member_id: councilMemberId }
            : { council_config: councilConfig }),
          attachments,
          pdf_engine,
          invoke_agent_id: invokeAgentId,
        },
        {
          onMemberStart: (event) => {
            setCouncilMemberProgress((prev) => {
              const next = new Map(prev);
              next.set(event.member_index, {
                status: 'running',
                modelId: event.model_id,
                progress: 0,
              });
              return next;
            });
          },
          onMemberComplete: (event) => {
            setCouncilMemberProgress((prev) => {
              const next = new Map(prev);
              next.set(event.member_index, {
                status: event.status === 'success' ? 'complete' : 'error',
                modelId: event.model_id,
              });
              return next;
            });
          },
          onSynthesisStart: () => {
            setCouncilSynthesisPhase(true);
          },
          onSynthesisChunk: (chunk) => {
            setCouncilStreamingContent((prev) => prev + chunk);
            appendCouncilStreamingContent(chunk);
            appendStreamContentEvent(conversationId, chunk);
          },
          onConversationTitle: (event) => {
            updateConversationTitle(event.conversation_id, event.title);
          },
          onMcpApprovalRequired: (approval) => {
            let argumentsText = '{}';
            try { argumentsText = JSON.stringify(approval.arguments, null, 2); } catch { /* fail closed below */ }
            const flowWarning = approval.possible_cross_tool_data
              ? '\n\nWarning: these arguments may contain data returned by another tool or server.'
              : '';
            const approved = window.confirm(
              `Allow this exact MCP tool call from the council?\n\n`
              + `Server: ${approval.server_name || approval.server_id}\n`
              + `Tool: ${approval.tool_name}\n`
              + `Arguments (SHA-256 ${approval.arguments_sha256.slice(0, 12)}…):\n${argumentsText}`
              + flowWarning
              + '\n\nServer annotations are untrusted hints and were not used to approve this action.',
            );
            void mcpServersApi.resolveApproval(approval.id, approved).catch(() => {});
          },
          onComplete: async () => {
            endStream(conversationId);
            setCouncilIsExecuting(false);
            setCouncilStreamingContent('');
            setCouncilMemberProgress(new Map());
            setCouncilSynthesisPhase(false);
            await loadMessages(conversationId, { silent: true });
            await loadConversations(selectedAgentId || undefined);
          },
          onError: async (error) => {
            endStream(conversationId);
            setCouncilIsExecuting(false);
            setCouncilStreamingContent('');
            setCouncilMemberProgress(new Map());
            setCouncilSynthesisPhase(false);
            console.error('Council error:', error);
            await loadMessages(conversationId, { silent: true });
            await loadConversations(selectedAgentId || undefined);
          },
        },
        controller.signal
      );
    } catch (err) {
      console.error('Council message error:', err);
      endStream(conversationId);
      setCouncilIsExecuting(false);
      await loadMessages(conversationId, { silent: true });
    }
  }, [activeConversationId, streamsByConversation, beginStream, endStream, setStreamAbortController, addMessage, setCouncilIsExecuting, setCouncilMemberProgress, setCouncilSynthesisPhase, setCouncilStreamingContent, appendCouncilStreamingContent, appendStreamContentEvent, loadMessages, loadConversations, updateConversationTitle, selectedAgentId]);

  const sendRegularMessage = useCallback(async (content: string, options?: SendMessageOptions) => {
    const conversationId = activeConversationId;
    // Send guard is per conversation: a stream in ANOTHER conversation must not
    // block this send (the server's turn claim remains the same-conversation guard).
    if (!conversationId || streamsByConversation[conversationId] || !content.trim()) return;

    const attachments = options?.attachments;
    const pdf_engine = options?.pdf_engine;
    const model = options?.model;
    const providerRouting = options?.providerRouting;
    const invokeAgentId = options?.invokeAgentId;
    const invokeSkillNames = options?.invokeSkillNames;
    const editMessageId = options?.editMessageId;

    const now = new Date().toISOString();
    const trimmed = content.trim();

    // Edit / relaunch flow: create a NEW VARIANT of the target message's turn
    // optimistically (same parent, same turn_id, next variant_seq), switch the
    // visible leaf to it, and stream with edit_message_id so the server does the
    // same. loadMessages(silent) in onDone reconciles with the server.
    let userMsg: Message;
    let assistantMsg: Message;
    if (editMessageId) {
      const store = useStore.getState();
      const target = store.messages.find((message) => message.id === editMessageId);
      if (!target) {
        console.error(`Cannot relaunch: message ${editMessageId} not found in store`);
        return;
      }
      const variants = getTurnVariants(store.messages, target.id);
      const maxSeq = variants.reduce((max, message) => Math.max(max, message.variant_seq ?? 1), 0);
      userMsg = {
        id: `temp-edit-${Date.now()}`,
        conversation_id: conversationId,
        role: 'user',
        content: trimmed,
        parent_id: target.parent_id ?? null,
        turn_id: target.turn_id ?? null,
        variant_seq: maxSeq + 1,
        created_at: now,
        ...(attachments?.length && { attachments: attachments.map((a) => ({ filename: a.filename })) }),
      };
      assistantMsg = {
        id: `temp-assistant-${Date.now()}`,
        conversation_id: conversationId,
        role: 'assistant',
        content: '',
        parent_id: userMsg.id,
        turn_id: userMsg.turn_id,
        created_at: now,
      };
      addMessage(userMsg);
      addMessage(assistantMsg);
      // The active thread hangs from the leaf: point it at the LAST optimistic
      // message (the temp assistant) so buildThread walks the new variant chain
      // (…target.parent → temp-user → temp-assistant) and the streaming
      // placeholder renders. Pointing at the temp USER would leave the temp
      // assistant out of the chain — no streaming until loadMessages.
      store.setActiveLeaf(assistantMsg.id);
    } else {
      // Add user message to local state immediately. Anchor it to the current
      // leaf and set the leaf to the temp assistant so the optimistic chain
      // (…old leaf → temp-user → temp-assistant) is the visible thread.
      const store = useStore.getState();
      userMsg = {
        id: `temp-user-${Date.now()}`,
        conversation_id: conversationId,
        role: 'user',
        content: trimmed,
        parent_id: store.activeLeafId,
        created_at: now,
        ...(attachments?.length && { attachments: attachments.map((a) => ({ filename: a.filename })) }),
      };
      // Add placeholder assistant message
      assistantMsg = {
        id: `temp-assistant-${Date.now()}`,
        conversation_id: conversationId,
        role: 'assistant',
        content: '',
        parent_id: userMsg.id,
        created_at: now,
      };
      addMessage(userMsg);
      addMessage(assistantMsg);
      store.setActiveLeaf(assistantMsg.id);
    }

    // Register the per-conversation stream entry (fresh content/reasoning/
    // activityEvents + startTime), then hang the abort controller on it.
    const controller = new AbortController();
    beginStream(conversationId);
    setStreamAbortController(conversationId, controller);
    // Reset per-turn auto-open flag for the upcoming stream.
    turnOpenedArtifactPanelRef.current = false;

    await streamChat(
      conversationId,
      trimmed,
      (chunk) => {
        appendStreamContent(conversationId, chunk);
        appendStreamContentEvent(conversationId, chunk);
      },
      async () => {
        endStream(conversationId);
        await loadMessages(conversationId, { silent: true });
        await loadConversations(selectedAgentId || undefined);
        // Fire-and-forget REST hydrate: authority for any artifact frames missed (incl. disconnects).
        void hydrateArtifactsFor(conversationId);
      },
      async (error) => {
        endStream(conversationId);
        await loadMessages(conversationId, { silent: true });
        void hydrateArtifactsFor(conversationId);
        // Join the error message to the visible chain (the server may or may
        // not have persisted the new variant) and make it the active leaf so
        // it renders; `temp-` prefix keeps setActiveLeaf from PUTting it.
        const leaf = useStore.getState().activeLeafId;
        const errorMsg: Message = {
          id: `temp-error-${Date.now()}`,
          conversation_id: conversationId,
          role: 'assistant',
          content: `**Error:** ${error}`,
          parent_id: leaf,
          created_at: new Date().toISOString(),
        };
        addMessage(errorMsg);
        useStore.getState().setActiveLeaf(errorMsg.id);
      },
      (chunk) => {
        appendStreamReasoning(conversationId, chunk);
        appendStreamReasoningEvent(conversationId, chunk);
      },
      controller.signal,
      reasoningOverride,
      (data) => upsertStreamToolCall(conversationId, data),
      (data) => completeStreamToolCall(conversationId, data),
      attachments,
      pdf_engine,
      model,
      providerRouting,
      invokeAgentId,
      (data) => updateConversationTitle(data.conversation_id, data.title),
      (data) => appendStreamToolOutputChunk(conversationId, data),
      invokeSkillNames,
      editMessageId,
      (approval: McpApprovalRequiredData) => {
        const approved = confirmMcpApproval(approval);
        void mcpServersApi.resolveApproval(approval.id, approved).catch(() => {
          // The backend remains fail-closed and will expire the pending call.
        });
      },
      (data: ChatArtifact) => {
        useStore.getState().upsertConversationArtifact(conversationId, data);
        if (!artifactPanelOpenRef.current && !turnOpenedArtifactPanelRef.current) {
          useStore.getState().setActiveArtifact(conversationId, data.id);
          turnOpenedArtifactPanelRef.current = true;
        }
      },
    );
  }, [activeConversationId, streamsByConversation, addMessage, beginStream, endStream, setStreamAbortController, appendStreamContent, appendStreamContentEvent, reasoningOverride, appendStreamReasoning, appendStreamReasoningEvent, upsertStreamToolCall, completeStreamToolCall, appendStreamToolOutputChunk, loadMessages, loadConversations, updateConversationTitle, selectedAgentId]);

  /**
   * Re-launches the turn that produced `messageId` (a user message): streams a new
   * variant of that turn with the given content. No-op while a stream is active.
   */
  const relaunchFromMessage = useCallback(async (
    messageId: string,
    opts: { content: string; model?: string | null; providerRouting?: ProviderRoutingConfig | null },
  ): Promise<void> => {
    const state = useStore.getState();
    if (!state.activeConversationId || state.streamsByConversation[state.activeConversationId]) return;
    await sendMessage(opts.content, {
      editMessageId: messageId,
      model: opts.model ?? undefined,
      providerRouting: opts.providerRouting ?? undefined,
    });
  }, [sendMessage]);

  /**
   * Retries the last assistant response: re-runs the last user turn of the ACTIVE
   * thread with the conversation's effective model (no per-message model/routing —
   * the conversation model governs every generation). No-op when the thread has
   * no user message.
   */
  const retryLastAssistant = useCallback(async (): Promise<void> => {
    const store = useStore.getState();
    const thread = buildThread(store.messages, store.activeLeafId);
    const userMsg = [...thread].reverse().find((message) => message.role === 'user');
    if (!userMsg) return;

    await relaunchFromMessage(userMsg.id, { content: userMsg.content });
  }, [relaunchFromMessage]);

  /** The visible thread (root → leaf) of the active conversation, per current store state. */
  const getActiveThread = useCallback((): Message[] => {
    const store = useStore.getState();
    return buildThread(store.messages, store.activeLeafId);
  }, []);

  const cancelStream = useCallback(() => {
    const state = useStore.getState();
    const conversationId = state.activeConversationId;
    if (!conversationId) return;
    // Rewired for the explicit Stop protocol (plan.md S4): 1) ask the server to
    // cancel the upstream generation (best-effort — anything after logging is
    // swallowed, capped ~3s so the click never hangs; a missing turn, e.g.
    // after switch-away, just 404s and proceeds), 2) abort THIS conversation's
    // local fetch and drop ONLY its stream entry, 3) silently reload messages +
    // conversations so whatever was persisted (draft finalized as 'stopped')
    // replaces the optimistic view. Works identically with or without an
    // attached local fetch — including from a reopened tab in poll mode.
    void (async () => {
      try {
        await stopTurnWithTimeout(conversationId, STOP_TURN_TIMEOUT_MS);
      } catch (err) {
        console.error('stopTurn failed (continuing with local teardown):', err);
      }
      // Re-read state: terminal stream callbacks may have run while we awaited.
      const fresh = useStore.getState();
      fresh.streamsByConversation[conversationId]?.abortController?.abort();
      fresh.endStream(conversationId);
      await fresh.loadMessages(conversationId, { silent: true });
      await fresh.loadConversations(fresh.selectedAgentId || undefined);
      void hydrateArtifactsFor(conversationId);
    })();
  }, []);

  const startNewChat = useCallback(async (agentId: string) => {
    try {
      const conversation = await conversationsApi.create(agentId);
      useStore.getState().setActiveConversationId(conversation.id);
      useStore.getState().setCurrentView('chat');
      await loadConversations(agentId);
      await loadMessages(conversation.id);
    } catch (err) {
      console.error('Failed to create conversation:', err);
    }
  }, [loadConversations, loadMessages]);

  const startGeneralChat = useCallback(async () => {
    try {
      const conversation = await conversationsApi.createGeneral();
      useStore.getState().setActiveConversationId(conversation.id);
      useStore.getState().setCurrentView('chat');
      useStore.getState().setSelectedAgentId(null);
      await loadConversations();
      await loadMessages(conversation.id);
    } catch (err) {
      console.error('Failed to create general chat:', err);
    }
  }, [loadConversations, loadMessages]);

  return {
    sendMessage,
    relaunchFromMessage,
    retryLastAssistant,
    getActiveThread,
    cancelStream,
    startNewChat,
    startGeneralChat,
  };
}
