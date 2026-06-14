import { useCallback } from 'react';
import { useStore } from '../stores/store';
import { streamChat } from '../api/client';
import { conversationsApi } from '../api/client';
import { streamCouncilChat } from '../api/councilClient';
import type { Message, ChatAttachmentInput, PDFEngine, CouncilConfig, ProviderRoutingConfig } from '../types';

export interface SendMessageOptions {
  attachments?: ChatAttachmentInput[];
  pdf_engine?: PDFEngine;
  model?: string;
  providerRouting?: ProviderRoutingConfig | null;
  invokeAgentId?: string;
  councilConfig?: CouncilConfig;
  /** When set, server loads full council config (including tool_ids) from DB instead of using councilConfig inline */
  councilMemberId?: string;
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

    // Add placeholder assistant message
    const assistantMsg: Message = {
      id: `temp-assistant-${Date.now()}`,
      conversation_id: activeConversationId,
      role: 'assistant',
      content: '',
      created_at: new Date().toISOString(),
    };
    addMessage(assistantMsg);

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
      content.trim(),
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
        const errorMsg: Message = {
          id: `error-${Date.now()}`,
          conversation_id: activeConversationId,
          role: 'assistant',
          content: `**Error:** ${error}`,
          created_at: new Date().toISOString(),
        };
        await loadMessages(activeConversationId, { silent: true });
        addMessage(errorMsg);
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
    );
  }, [activeConversationId, isStreaming, addMessage, setIsStreaming, setStreamingContent, appendStreamingContent, appendStreamingContentEvent, setAbortController, setStreamStartTime, setReasoningContent, appendReasoningContent, appendStreamingReasoningEvent, reasoningOverride, upsertStreamingToolCall, completeStreamingToolCall, resetStreamingActivityEvents, loadMessages, loadConversations, updateConversationTitle, selectedAgentId]);

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
    cancelStream,
    startNewChat,
    startGeneralChat,
    isStreaming,
    streamingContent,
    reasoningContent,
  };
}
