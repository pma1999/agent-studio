import { useCallback } from 'react';
import { useStore } from '../stores/store';
import { streamChat } from '../api/client';
import { conversationsApi } from '../api/client';
import type { Message, ChatAttachmentInput, PDFEngine } from '../types';

export interface SendMessageOptions {
  attachments?: ChatAttachmentInput[];
  pdf_engine?: PDFEngine;
  model?: string;
  invokeAgentId?: string;
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
    selectedAgentId,
    upsertStreamingToolCall,
    completeStreamingToolCall,
    resetStreamingActivityEvents,
  } = useStore();

  const sendMessage = useCallback(async (content: string, options?: SendMessageOptions) => {
    if (!activeConversationId || isStreaming || !content.trim()) return;

    const attachments = options?.attachments;
    const pdf_engine = options?.pdf_engine;
    const model = options?.model;
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
        await loadMessages(activeConversationId);
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
        await loadMessages(activeConversationId);
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
      invokeAgentId,
    );
  }, [activeConversationId, isStreaming, addMessage, setIsStreaming, setStreamingContent, appendStreamingContent, appendStreamingContentEvent, setAbortController, setStreamStartTime, setReasoningContent, appendReasoningContent, appendStreamingReasoningEvent, reasoningOverride, upsertStreamingToolCall, completeStreamingToolCall, resetStreamingActivityEvents, loadMessages, loadConversations, selectedAgentId]);

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
      loadMessages(activeConversationId);
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
