import { useCallback } from 'react';
import { useStore } from '../stores/store';
import { streamChat } from '../api/client';
import { conversationsApi } from '../api/client';
import { streamCouncilChat } from '../api/councilClient';
import { buildThread, getTurnVariants } from '../utils/threads';
import type { Message, ChatAttachmentInput, PDFEngine, CouncilConfig, ProviderRoutingConfig } from '../types';

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

export function useChat() {
  const {
    activeConversationId,
    isStreaming,
    setIsStreaming,
    streamingContent,
    setStreamingContent,
    appendStreamingContent,
    appendStreamingContentEvent,
    setAbortController,
    setStreamStartTime,
    reasoningContent,
    setReasoningContent,
    appendReasoningContent,
    appendStreamingReasoningEvent,
    reasoningOverride,
    addMessage,
    loadMessages,
    loadConversations,
    updateConversationTitle,
    selectedAgentId,
    upsertStreamingToolCall,
    completeStreamingToolCall,
    appendStreamingToolOutputChunk,
    resetStreamingActivityEvents,
    // Council state
    councilEnabled,
    setCouncilIsExecuting,
    setCouncilMemberProgress,
    setCouncilSynthesisPhase,
    setCouncilStreamingContent,
    appendCouncilStreamingContent,
    resetCouncilState,
  } = useStore();

  const sendMessage = useCallback(async (content: string, options?: SendMessageOptions) => {
    // Check if council mode is enabled or council config is provided
    const useCouncil = councilEnabled || options?.councilConfig;

    if (useCouncil) {
      return sendCouncilMessage(content, options);
    }

    return sendRegularMessage(content, options);
  }, [councilEnabled, activeConversationId, isStreaming, addMessage, setIsStreaming, setStreamingContent, appendStreamingContent, appendStreamingContentEvent, setAbortController, setStreamStartTime, setReasoningContent, appendReasoningContent, appendStreamingReasoningEvent, reasoningOverride, upsertStreamingToolCall, completeStreamingToolCall, resetStreamingActivityEvents, loadMessages, loadConversations, updateConversationTitle, selectedAgentId]);

  const sendCouncilMessage = useCallback(async (content: string, options?: SendMessageOptions) => {
    if (!activeConversationId || isStreaming || !content.trim()) return;

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
      conversation_id: activeConversationId,
      role: 'user',
      content: content.trim(),
      created_at: new Date().toISOString(),
      ...(attachments?.length && { attachments: attachments.map((a) => ({ filename: a.filename })) }),
    };
    addMessage(userMsg);

    // Add placeholder assistant message for synthesis
    const assistantMsg: Message = {
      id: `temp-council-${Date.now()}`,
      conversation_id: activeConversationId,
      role: 'assistant',
      content: '',
      created_at: new Date().toISOString(),
    };
    addMessage(assistantMsg);

    // Create AbortController for cancellation
    const controller = new AbortController();
    setAbortController(controller);

    setCouncilIsExecuting(true);
    setCouncilStreamingContent('');
    setCouncilMemberProgress(new Map());
    setCouncilSynthesisPhase(false);
    setIsStreaming(true);
    setStreamStartTime(Date.now());
    resetStreamingActivityEvents();

    try {
      await streamCouncilChat(
        {
          conversation_id: activeConversationId,
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
            appendStreamingContentEvent(chunk);
          },
          onConversationTitle: (event) => {
            updateConversationTitle(event.conversation_id, event.title);
          },
          onComplete: async () => {
            setCouncilIsExecuting(false);
            setIsStreaming(false);
            setStreamStartTime(null);
            setCouncilStreamingContent('');
            setCouncilMemberProgress(new Map());
            setCouncilSynthesisPhase(false);
            setAbortController(null);
            await loadMessages(activeConversationId, { silent: true });
            await loadConversations(selectedAgentId || undefined);
          },
          onError: async (error) => {
            setCouncilIsExecuting(false);
            setIsStreaming(false);
            setStreamStartTime(null);
            setCouncilStreamingContent('');
            setCouncilMemberProgress(new Map());
            setCouncilSynthesisPhase(false);
            setAbortController(null);
            console.error('Council error:', error);
            await loadMessages(activeConversationId, { silent: true });
            await loadConversations(selectedAgentId || undefined);
          },
        },
        controller.signal
      );
    } catch (err) {
      console.error('Council message error:', err);
      setCouncilIsExecuting(false);
      setIsStreaming(false);
      setStreamStartTime(null);
      setAbortController(null);
      await loadMessages(activeConversationId, { silent: true });
    }
  }, [activeConversationId, isStreaming, addMessage, setIsStreaming, setStreamStartTime, setCouncilIsExecuting, setCouncilMemberProgress, setCouncilSynthesisPhase, setCouncilStreamingContent, appendCouncilStreamingContent, appendStreamingContentEvent, setAbortController, resetStreamingActivityEvents, loadMessages, loadConversations, updateConversationTitle, selectedAgentId]);

  const sendRegularMessage = useCallback(async (content: string, options?: SendMessageOptions) => {
    if (!activeConversationId || isStreaming || !content.trim()) return;

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
        conversation_id: activeConversationId,
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
        conversation_id: activeConversationId,
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
        conversation_id: activeConversationId,
        role: 'user',
        content: trimmed,
        parent_id: store.activeLeafId,
        created_at: now,
        ...(attachments?.length && { attachments: attachments.map((a) => ({ filename: a.filename })) }),
      };
      // Add placeholder assistant message
      assistantMsg = {
        id: `temp-assistant-${Date.now()}`,
        conversation_id: activeConversationId,
        role: 'assistant',
        content: '',
        parent_id: userMsg.id,
        created_at: now,
      };
      addMessage(userMsg);
      addMessage(assistantMsg);
      store.setActiveLeaf(assistantMsg.id);
    }

    // Create AbortController for cancellation
    const controller = new AbortController();
    setAbortController(controller);

    setIsStreaming(true);
    setStreamStartTime(Date.now());
    setStreamingContent('');
    setReasoningContent('');
    resetStreamingActivityEvents();

    await streamChat(
      activeConversationId,
      trimmed,
      (chunk) => {
        appendStreamingContent(chunk);
        appendStreamingContentEvent(chunk);
      },
      async () => {
        setIsStreaming(false);
        setStreamStartTime(null);
        setStreamingContent('');
        setReasoningContent('');
        resetStreamingActivityEvents();
        setAbortController(null);
        await loadMessages(activeConversationId, { silent: true });
        await loadConversations(selectedAgentId || undefined);
      },
      async (error) => {
        setIsStreaming(false);
        setStreamStartTime(null);
        setStreamingContent('');
        setReasoningContent('');
        resetStreamingActivityEvents();
        setAbortController(null);
        await loadMessages(activeConversationId, { silent: true });
        // Join the error message to the visible chain (the server may or may
        // not have persisted the new variant) and make it the active leaf so
        // it renders; `temp-` prefix keeps setActiveLeaf from PUTting it.
        const leaf = useStore.getState().activeLeafId;
        const errorMsg: Message = {
          id: `temp-error-${Date.now()}`,
          conversation_id: activeConversationId,
          role: 'assistant',
          content: `**Error:** ${error}`,
          parent_id: leaf,
          created_at: new Date().toISOString(),
        };
        addMessage(errorMsg);
        useStore.getState().setActiveLeaf(errorMsg.id);
      },
      (chunk) => {
        appendReasoningContent(chunk);
        appendStreamingReasoningEvent(chunk);
      },
      controller.signal,
      reasoningOverride,
      (data) => upsertStreamingToolCall(data),
      (data) => completeStreamingToolCall(data),
      attachments,
      pdf_engine,
      model,
      providerRouting,
      invokeAgentId,
      (data) => updateConversationTitle(data.conversation_id, data.title),
      (data) => appendStreamingToolOutputChunk(data),
      invokeSkillNames,
      editMessageId,
    );
  }, [activeConversationId, isStreaming, addMessage, setIsStreaming, setStreamingContent, appendStreamingContent, appendStreamingContentEvent, setAbortController, setStreamStartTime, setReasoningContent, appendReasoningContent, appendStreamingReasoningEvent, reasoningOverride, upsertStreamingToolCall, completeStreamingToolCall, appendStreamingToolOutputChunk, resetStreamingActivityEvents, loadMessages, loadConversations, updateConversationTitle, selectedAgentId]);

  /**
   * Re-launches the turn that produced `messageId` (a user message): streams a new
   * variant of that turn with the given content. No-op while a stream is active.
   */
  const relaunchFromMessage = useCallback(async (
    messageId: string,
    opts: { content: string; model?: string | null; providerRouting?: ProviderRoutingConfig | null },
  ): Promise<void> => {
    if (useStore.getState().isStreaming) return;
    await sendMessage(opts.content, {
      editMessageId: messageId,
      model: opts.model ?? undefined,
      providerRouting: opts.providerRouting ?? undefined,
    });
  }, [sendMessage]);

  /**
   * Retries the last assistant response: re-runs the last user turn of the ACTIVE
   * thread, reusing the model that produced the previous response (falling back to
   * the user variant's model). No-op when the thread has no user message.
   */
  const retryLastAssistant = useCallback(async (): Promise<void> => {
    const store = useStore.getState();
    const thread = buildThread(store.messages, store.activeLeafId);
    const userMsg = [...thread].reverse().find((message) => message.role === 'user');
    if (!userMsg) return;

    const lastAssistant = [...thread].reverse().find((message) => message.role === 'assistant');
    const model = lastAssistant?.model ?? userMsg.model ?? null;

    await relaunchFromMessage(userMsg.id, {
      content: userMsg.content,
      model,
      providerRouting: userMsg.provider_routing ?? null,
    });
  }, [relaunchFromMessage]);

  /** The visible thread (root → leaf) of the active conversation, per current store state. */
  const getActiveThread = useCallback((): Message[] => {
    const store = useStore.getState();
    return buildThread(store.messages, store.activeLeafId);
  }, []);

  const cancelStream = useCallback(() => {
    const controller = useStore.getState().abortController;
    if (controller) {
      controller.abort();
    }
    setIsStreaming(false);
    setStreamStartTime(null);
    setStreamingContent('');
    setReasoningContent('');
    resetStreamingActivityEvents();
    setAbortController(null);
    // Reload messages to get whatever was saved server-side
    if (activeConversationId) {
      loadMessages(activeConversationId, { silent: true });
      loadConversations(selectedAgentId || undefined);
    }
  }, [activeConversationId, setIsStreaming, setStreamStartTime, setStreamingContent, setReasoningContent, resetStreamingActivityEvents, setAbortController, loadMessages, loadConversations, selectedAgentId]);

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
    isStreaming,
    streamingContent,
    reasoningContent,
  };
}
