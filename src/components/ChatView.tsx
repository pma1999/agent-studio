import React, { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Send, ArrowDown, StopCircle, MessageSquare, Bot, Brain, FileUp, Link, X, Users, SlidersHorizontal } from 'lucide-react';
import { CouncilToggle } from './CouncilToggle';
import { CouncilStreamingView } from './CouncilStreamingView';
import { useStore } from '../stores/store';
import { useIsMobile, usePrefersReducedMotion } from '../utils/breakpoints';
import { useChat } from '../hooks/useChat';
import { useAutoScroll } from '../hooks/useAutoScroll';
import { MessageBubble } from './MessageBubble';
import { EmptyState } from './EmptyState';
import { Button } from './ui/Button';
import { ModelSelectorCore } from './ModelSelectorCore';
import { ProviderRoutingSelector } from './ProviderRoutingSelector';
import { conversationsApi } from '../api/client';
import { PremiumMentionInput } from './ui/PremiumMentionInput';
import { Sheet } from './ui/Sheet';
import { ConversationTokenSummary, StreamingTokenCounter } from './TokenCounter';
import type {
  ReasoningEffort,
  ReasoningConfig,
  PDFEngine,
  ChatAttachmentInput,
  ToolExecution,
  ToolSource,
  StreamingActivityEvent,
  ProviderRoutingConfig,
} from '../types';

const MAX_PDF_ATTACHMENTS = 5;
const MAX_PDF_MB = 20;

interface PendingAttachment {
  id: string;
  filename: string;
  file?: File;
  url?: string;
  error?: string;
}

const PDF_ENGINE_OPTIONS: { value: '' | PDFEngine; label: string; title: string }[] = [
  { value: '', label: 'Auto', title: 'Let OpenRouter choose' },
  { value: 'pdf-text', label: 'Text', title: 'Best for text PDFs (free)' },
  { value: 'mistral-ocr', label: 'OCR', title: 'Scanned docs (may have cost)' },
  { value: 'native', label: 'Native', title: 'Model-native when supported' },
];

const EFFORT_OPTIONS: { value: ReasoningEffort; label: string; short: string }[] = [
  { value: 'minimal', label: 'Minimal', short: 'Min' },
  { value: 'low', label: 'Low', short: 'Low' },
  { value: 'medium', label: 'Medium', short: 'Med' },
  { value: 'high', label: 'High', short: 'High' },
  { value: 'xhigh', label: 'Maximum', short: 'Max' },
];

const BUILTIN_TOOL_NAMES = new Set(['web_search', 'get_current_time', 'web_fetch']);

function inferToolSource(name: string): ToolSource {
  if (name.startsWith('mcp_')) return 'mcp';
  if (BUILTIN_TOOL_NAMES.has(name)) return 'builtin';
  return 'http';
}

function inferToolResultOk(result?: string): boolean | undefined {
  if (result === undefined) return undefined;
  const trimmed = result.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith('[Tool execution error]')) return false;
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown };
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      const err = parsed.error;
      return !(err !== undefined && err !== null && String(err).trim().length > 0);
    }
  } catch {
    // Non-JSON outputs are valid results.
  }
  return true;
}

export function ChatView() {
  const {
    messages,
    messagesLoading,
    isStreaming,
    streamingContent,
    reasoningContent,
    activeConversationId,
    conversations,
    agents,
    selectedAgentId,
    setCurrentView,
    reasoningOverride,
    setReasoningOverride,
    streamStartTime,
    streamingActivityEvents,
    conversationModelOverrides,
    setConversationModelOverride,
    conversationProviderRoutingOverrides,
    setConversationProviderRoutingOverride,
    loadConversations,
    generalChatSettings,
    councilEnabled,
    councilConfig,
    selectedCouncilId,
    councilMemberProgress,
    councilSynthesisPhase,
  } = useStore();
  const streamingActivitySignature = useMemo(() => (
    streamingActivityEvents
      .map((ev) => (
        ev.type === 'reasoning'
          ? `r:${ev.id}:${ev.content.length}`
          : ev.type === 'content'
            ? `c:${ev.id}:${ev.content.length}`
            : `t:${ev.tool.id}:${ev.tool.status}:${(ev.tool.result || '').length}`
      ))
      .join('|')
  ), [streamingActivityEvents]);
  const { sendMessage, cancelStream, startNewChat, startGeneralChat } = useChat();
  const [inputValue, setInputValue] = useState('');
  const [showReasoningPopover, setShowReasoningPopover] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [pdfEngine, setPdfEngine] = useState<'' | PDFEngine>('');
  const [pdfUrlInput, setPdfUrlInput] = useState('');
  const [pdfUrlError, setPdfUrlError] = useState('');
  const [messageModelOverride, setMessageModelOverride] = useState<string | null>(null);
  const [messageProviderRoutingOverride, setMessageProviderRoutingOverride] = useState<ProviderRoutingConfig | null>(null);
  const [streamingModelSnapshot, setStreamingModelSnapshot] = useState<string | null>(null);
  const [streamingProviderRoutingSnapshot, setStreamingProviderRoutingSnapshot] = useState<ProviderRoutingConfig | null>(null);
  const [invokeAgentId, setInvokeAgentId] = useState<string | undefined>(undefined);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const reasoningBtnRef = useRef<HTMLButtonElement>(null);
  const reasoningPopoverRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const prevIsStreamingRef = useRef(isStreaming);
  const scrollDependency = useMemo(
    () =>
      isStreaming
        ? `${streamingContent.length}:${reasoningContent.length}:${streamingActivitySignature}`
        : `${messages.length}:${messages[messages.length - 1]?.id ?? ''}`,
    [
      isStreaming,
      streamingContent.length,
      reasoningContent.length,
      streamingActivitySignature,
      messages.length,
      messages[messages.length - 1]?.id,
    ]
  );
  const { containerRef, scrollToBottom, showScrollButton, handleScroll } = useAutoScroll(scrollDependency);

  // When stream ends, keep view at bottom (instant scroll after layout)
  useLayoutEffect(() => {
    const wasStreaming = prevIsStreamingRef.current;
    prevIsStreamingRef.current = isStreaming;
    if (wasStreaming && !isStreaming) {
      setStreamingModelSnapshot(null);
      setStreamingProviderRoutingSnapshot(null);
    }
    if (wasStreaming && !isStreaming && messages.length > 0) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => scrollToBottom('auto'));
      });
    }
  }, [isStreaming, messages.length, scrollToBottom]);

  const activeConversation = conversations.find((c) => c.id === activeConversationId);
  const agent = agents.find((a) => a.id === (activeConversation?.agent_id || selectedAgentId));
  const isGeneralChat = !agent;

  // Default model for this chat: agent's model, or general chat settings model when in general chat
  const defaultModelForChat = agent
    ? agent.model
    : (generalChatSettings?.model ?? 'openrouter/auto');
  const defaultProviderRoutingForChat = agent
    ? (agent.provider_routing ?? null)
    : (generalChatSettings?.provider_routing ?? null);

  const effectiveConversationModel = useMemo(() => {
    if (!activeConversationId) return null;
    const override = conversationModelOverrides[activeConversationId];
    if (override !== undefined) return override;
    return activeConversation?.model ?? null;
  }, [activeConversationId, conversationModelOverrides, activeConversation?.model]);
  const effectiveConversationProviderRouting = useMemo(() => {
    if (!activeConversationId) return null;
    const override = conversationProviderRoutingOverrides[activeConversationId];
    if (override !== undefined) return override;
    return activeConversation?.provider_routing ?? null;
  }, [activeConversationId, conversationProviderRoutingOverrides, activeConversation?.provider_routing]);

  // Model used for the next (or current streaming) message; shown in the assistant bubble when streaming.
  const effectiveModelForThisMessage = messageModelOverride ?? effectiveConversationModel ?? defaultModelForChat;

  const handleConversationModelChange = useCallback(
    async (modelId: string | null) => {
      if (!activeConversationId) return;
      setConversationModelOverride(activeConversationId, modelId);
      setConversationProviderRoutingOverride(activeConversationId, null);
      try {
        await conversationsApi.updateModel(activeConversationId, modelId);
        await loadConversations();
      } catch (err) {
        console.error('Failed to update conversation model:', err);
      }
    },
    [activeConversationId, setConversationModelOverride, setConversationProviderRoutingOverride, loadConversations]
  );

  const handleConversationProviderRoutingChange = useCallback(
    async (routing: ProviderRoutingConfig | null) => {
      if (!activeConversationId) return;
      setConversationProviderRoutingOverride(activeConversationId, routing);
      try {
        await conversationsApi.updateProviderRouting(activeConversationId, routing);
        await loadConversations();
      } catch (err) {
        console.error('Failed to update conversation provider routing:', err);
      }
    },
    [activeConversationId, setConversationProviderRoutingOverride, loadConversations]
  );

  // Determine effective reasoning state: override > agent default > general chat settings (when no agent)
  const effectiveReasoning: ReasoningConfig = useMemo(() => {
    if (reasoningOverride) return reasoningOverride;
    if (agent?.reasoning_enabled) {
      return {
        enabled: true,
        effort: agent.reasoning_effort || undefined,
        max_tokens: agent.reasoning_max_tokens || undefined,
      };
    }
    if (isGeneralChat && generalChatSettings?.reasoning_enabled) {
      return {
        enabled: true,
        effort: generalChatSettings.reasoning_effort || undefined,
        max_tokens: generalChatSettings.reasoning_max_tokens || undefined,
      };
    }
    return { enabled: false };
  }, [reasoningOverride, agent, isGeneralChat, generalChatSettings]);

  const reasoningActive = effectiveReasoning.enabled;
  const currentEffort = effectiveReasoning.effort || 'medium';
  const isMobile = useIsMobile();
  const setComposerFocused = useStore((s) => s.setComposerFocused);
  const [optionsOpen, setOptionsOpen] = useState(false);
  // Clear the composing flag if the chat unmounts while focused.
  useEffect(() => () => setComposerFocused(false), [setComposerFocused]);
  const composerOptionsActive =
    reasoningActive || messageModelOverride !== null || councilEnabled || !!pdfEngine;
  const prefersReducedMotion = usePrefersReducedMotion();

  // Close popover when clicking outside
  useEffect(() => {
    if (!showReasoningPopover) return;
    const handleClick = (e: MouseEvent) => {
      if (
        reasoningPopoverRef.current && !reasoningPopoverRef.current.contains(e.target as Node) &&
        reasoningBtnRef.current && !reasoningBtnRef.current.contains(e.target as Node)
      ) {
        setShowReasoningPopover(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showReasoningPopover]);

  const toggleReasoning = useCallback(() => {
    if (reasoningActive) {
      setReasoningOverride({ enabled: false });
    } else {
      const defaultEffort = agent?.reasoning_effort ?? generalChatSettings?.reasoning_effort ?? 'medium';
      setReasoningOverride({ enabled: true, effort: defaultEffort });
    }
  }, [reasoningActive, agent, generalChatSettings?.reasoning_effort, setReasoningOverride]);

  const setEffort = useCallback((effort: ReasoningEffort) => {
    setReasoningOverride({
      ...effectiveReasoning,
      enabled: true,
      effort,
    });
  }, [effectiveReasoning, setReasoningOverride]);

  // Reset reasoning override when switching conversations
  useEffect(() => {
    setReasoningOverride(null);
    setShowReasoningPopover(false);
    setMessageModelOverride(null);
    setMessageProviderRoutingOverride(null);
  }, [activeConversationId, setReasoningOverride]);

  // Tool results memo (must be before early return)
  const toolResultsByCallId = useMemo(() => {
    const map = new Map<string, string>();
    for (const msg of messages) {
      if (msg.role === 'tool' && msg.tool_call_id) {
        map.set(msg.tool_call_id, msg.content || '');
      }
    }
    return map;
  }, [messages]);

  const toolExecutionsByMessageId = useMemo(() => {
    const map = new Map<string, ToolExecution[]>();
    for (const msg of messages) {
      if (msg.role !== 'assistant' || !msg.tool_calls || msg.tool_calls.length === 0) continue;
      const executions: ToolExecution[] = msg.tool_calls.map((tc) => {
        const toolName = tc.function?.name || tc.id;
        const result = toolResultsByCallId.get(tc.id);
        const ok = inferToolResultOk(result);
        return {
          id: tc.id,
          name: toolName,
          arguments: tc.function?.arguments || '{}',
          status: result === undefined ? 'running' : ok === false ? 'error' : 'done',
          result,
          ok,
          source: inferToolSource(toolName),
        };
      });
      map.set(msg.id, executions);
    }
    return map;
  }, [messages, toolResultsByCallId]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px';
    }
  }, [inputValue]);

  const addAttachmentsFromFiles = useCallback((files: FileList | null) => {
    if (!files?.length) return;
    setPendingAttachments((prev) => {
      const next = [...prev];
      const maxAdd = MAX_PDF_ATTACHMENTS - next.length;
      for (let i = 0; i < Math.min(files.length, maxAdd); i++) {
        const file = files[i];
        if (file.type !== 'application/pdf') continue;
        if (file.size > MAX_PDF_MB * 1024 * 1024) continue;
        next.push({
          id: `att-${Date.now()}-${i}`,
          filename: file.name,
          file,
        });
      }
      return next.slice(0, MAX_PDF_ATTACHMENTS);
    });
  }, []);

  const addAttachmentFromUrl = useCallback(() => {
    const raw = pdfUrlInput.trim();
    setPdfUrlError('');
    if (!raw) return;
    try {
      const url = new URL(raw);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        setPdfUrlError('URL must be http or https');
        return;
      }
    } catch {
      setPdfUrlError('Enter a valid URL');
      return;
    }
    const filename = raw.split('/').pop()?.split('?')[0] || 'document.pdf';
    const name = filename.toLowerCase().endsWith('.pdf') ? filename : `${filename}.pdf`;
    setPendingAttachments((prev) => {
      const next = prev.length >= MAX_PDF_ATTACHMENTS ? prev.slice(0, MAX_PDF_ATTACHMENTS - 1) : [...prev];
      next.push({ id: `att-url-${Date.now()}`, filename: name, url: raw });
      return next;
    });
    setPdfUrlInput('');
  }, [pdfUrlInput]);

  const removeAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const handleSend = useCallback(async () => {
    if (!inputValue.trim() || isStreaming) return;

    let attachmentsPayload: ChatAttachmentInput[] | undefined;
    if (pendingAttachments.length > 0) {
      attachmentsPayload = [];
      for (const a of pendingAttachments) {
        if (a.url) {
          attachmentsPayload.push({ filename: a.filename, url: a.url });
        } else if (a.file) {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result as string);
            r.onerror = () => reject(new Error('Failed to read file'));
            r.readAsDataURL(a.file!);
          });
          attachmentsPayload.push({ filename: a.filename, file_data: dataUrl });
        }
      }
    }

    const usesCouncil = councilEnabled && !!councilConfig;
    const outgoingModel = messageModelOverride ?? effectiveConversationModel ?? defaultModelForChat;
    const outgoingProviderRouting = usesCouncil
      ? null
      : messageProviderRoutingOverride ?? effectiveConversationProviderRouting ?? defaultProviderRoutingForChat ?? { mode: 'auto' as const };
    setStreamingModelSnapshot(outgoingModel);
    setStreamingProviderRoutingSnapshot(outgoingProviderRouting);

    sendMessage(inputValue, {
      ...(attachmentsPayload?.length && { attachments: attachmentsPayload }),
      ...(pdfEngine && { pdf_engine: pdfEngine }),
      ...(messageModelOverride && { model: messageModelOverride }),
      ...(messageProviderRoutingOverride && { providerRouting: messageProviderRoutingOverride }),
      ...(invokeAgentId && { invokeAgentId }),
      ...(councilEnabled && councilConfig && {
      councilConfig,
      ...(selectedCouncilId && { councilMemberId: selectedCouncilId }),
    }),
    });
    setInputValue('');
    setPendingAttachments([]);
    setMessageModelOverride(null);
    setMessageProviderRoutingOverride(null);
    setInvokeAgentId(undefined);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [inputValue, isStreaming, pendingAttachments, pdfEngine, sendMessage, messageModelOverride, messageProviderRoutingOverride, invokeAgentId, councilEnabled, councilConfig, selectedCouncilId, effectiveConversationModel, defaultModelForChat, effectiveConversationProviderRouting, defaultProviderRoutingForChat]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // No active conversation
  if (!activeConversationId) {
    return (
      <EmptyState
        icon={<MessageSquare size={32} />}
        title="Start a Conversation"
        description="Start a new chat to begin. Use @ to mention an agent for specialized help."
        action={
          <Button
            variant="primary"
            icon={<MessageSquare size={16} />}
            onClick={() => startGeneralChat()}
          >
            New Chat
          </Button>
        }
      />
    );
  }

  // Build display messages including streaming
  const displayMessages = messages.filter((m) => m.role !== 'tool');
  const lastMsg = displayMessages[displayMessages.length - 1];
  const isLastMsgStreamingPlaceholder = lastMsg && lastMsg.role === 'assistant' && lastMsg.id.startsWith('temp-');

  return (
    <div
      className="chat-view"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {/* Chat Header — hidden on mobile; the title lives in the sticky top app bar */}
      {!isMobile && (
      <header className="chat-view-header" aria-label="Conversation header">
        <div className="chat-view-header-icon">
          {agent ? (
            <span className="chat-view-header-icon-inner chat-view-header-icon-agent" aria-hidden="true">
              {agent.emoji}
            </span>
          ) : (
            <span className="chat-view-header-icon-inner chat-view-header-icon-general" aria-hidden="true">
              {generalChatSettings?.emoji ?? '💬'}
            </span>
          )}
        </div>
        <div className="chat-view-header-main">
          <h1 className="chat-view-header-title">
            {activeConversation?.title || 'New conversation'}
          </h1>
          <div className="chat-view-header-meta">
            {agent?.name || 'General Chat'} ·
            <span className="chat-view-header-model-wrap">
              <ModelSelectorCore
                variant="conversation"
                value={effectiveConversationModel}
                onChange={handleConversationModelChange}
                agentModel={defaultModelForChat}
                conversationModel={activeConversation?.model}
                ariaLabel="Select AI model for this conversation"
              />
              <ProviderRoutingSelector
                modelId={effectiveConversationModel ?? defaultModelForChat}
                value={effectiveConversationProviderRouting}
                onChange={handleConversationProviderRoutingChange}
                inheritedRouting={defaultProviderRoutingForChat}
                disabled={isStreaming}
                allowDefault
                compact
              />
            </span>
          </div>
        </div>
        <ConversationTokenSummary messages={messages} />
      </header>
      )}

      {/* Messages + FAB wrapper (position relative so FAB is positioned above input) */}
      <div className="chat-view-messages-wrapper" style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="chat-view-messages-scroll"
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: `0 var(--content-padding-x)`,
          }}
        >
        <div className="chat-view-messages-inner" style={{
          maxWidth: 'var(--chat-content-max-width, 800px)',
          margin: '0 auto',
          paddingBottom: 'var(--content-padding-y)',
        }}>
          {messagesLoading ? (
            <div className="chat-loading-skeleton" aria-live="polite" aria-busy="true">
              {prefersReducedMotion ? (
                <div className="chat-loading-simple">
                  <div className="chat-loading-dots" aria-hidden="true">
                    <span className="chat-loading-dot" />
                    <span className="chat-loading-dot" />
                    <span className="chat-loading-dot" />
                  </div>
                  <p>Loading conversation...</p>
                </div>
              ) : (
                <>
                  <div className="chat-loading-skeleton-row">
                    <div className="chat-loading-skeleton-avatar" />
                    <div className="chat-loading-skeleton-content">
                      <div className="chat-loading-skeleton-line chat-loading-skeleton-line-short" />
                      <div className="chat-loading-skeleton-line" />
                    </div>
                  </div>
                  <div className="chat-loading-skeleton-row">
                    <div className="chat-loading-skeleton-avatar" />
                    <div className="chat-loading-skeleton-content">
                      <div className="chat-loading-skeleton-line" />
                      <div className="chat-loading-skeleton-line chat-loading-skeleton-line-medium" />
                    </div>
                  </div>
                  <div className="chat-loading-skeleton-row">
                    <div className="chat-loading-skeleton-avatar" />
                    <div className="chat-loading-skeleton-content">
                      <div className="chat-loading-skeleton-line chat-loading-skeleton-line-short" />
                    </div>
                  </div>
                </>
              )}
            </div>
          ) : messages.length === 0 ? (
            <motion.div
              className="chat-welcome-state"
              initial={prefersReducedMotion ? false : { opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: prefersReducedMotion ? 0 : 0.4, ease: [0.4, 0, 0.2, 1] }}
            >
              <div className="chat-welcome-icon" aria-hidden="true">
                {agent?.emoji ?? (generalChatSettings?.emoji ?? '✨')}
              </div>
              <h2 className="chat-welcome-title">
                Chat with {agent?.name ?? (isGeneralChat ? 'General Chat' : 'Agent')}
              </h2>
              <p className="chat-welcome-description">
                {agent?.description || 'Send a message to start the conversation.'}
              </p>
              <div className="chat-welcome-suggestions">
                {[
                  agent?.description ? 'What can you help me with?' : 'Ask anything',
                  'Explain a concept simply',
                  'Help me brainstorm',
                ].slice(0, 3).map((label, i) => (
                  <button
                    key={i}
                    type="button"
                    className="chat-welcome-suggestion-chip"
                    onClick={() => setInputValue(label)}
                    aria-label={`Suggested: ${label}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </motion.div>
          ) : (
            <>
              {/* Council Streaming View */}
              {(councilEnabled || councilMemberProgress.size > 0) && isStreaming && (
                <CouncilStreamingView
                  memberProgress={councilMemberProgress}
                  synthesisPhase={councilSynthesisPhase}
                  streamingContent={streamingContent}
                />
              )}
              {displayMessages.map((msg, i) => {
              const isStreamingMsg = isLastMsgStreamingPlaceholder && i === displayMessages.length - 1;
              const timelineCalls = !isStreamingMsg
                ? toolExecutionsByMessageId.get(msg.id)
                : undefined;
              const activityEvents: StreamingActivityEvent[] | undefined = isStreamingMsg
                ? streamingActivityEvents
                : undefined;
              return (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  isStreaming={isStreamingMsg}
                  streamingContent={isStreamingMsg ? streamingContent : undefined}
                  streamingReasoning={isStreamingMsg ? reasoningContent : undefined}
                  streamingActivityEvents={activityEvents}
                  agentEmoji={agent?.emoji}
                  toolExecutions={timelineCalls}
                  toolActivityLive={isStreamingMsg && !!activityEvents?.some((ev) => ev.type === 'tool')}
                  streamingModel={isStreamingMsg ? (streamingModelSnapshot ?? effectiveModelForThisMessage) : undefined}
                  streamingProviderRouting={isStreamingMsg ? streamingProviderRoutingSnapshot : undefined}
                />
              );
            })}
            </>
          )}
        </div>
        </div>
        {/* Scroll to bottom (inside wrapper so positioned relative to messages area) */}
        <AnimatePresence>
          {showScrollButton && (
            <motion.button
              type="button"
              aria-label="Scroll to bottom"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              onClick={() => scrollToBottom()}
              className="chat-scroll-btn"
              style={{
                position: 'absolute',
                left: '50%',
                transform: 'translateX(-50%)',
                bottom: 'var(--chat-scroll-fab-bottom, 100px)',
                width: '36px',
                height: '36px',
                borderRadius: '50%',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                color: 'var(--text-secondary)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: 'var(--shadow-md)',
                zIndex: 10,
                transition: 'background var(--transition-fast), color var(--transition-fast), transform var(--transition-fast)',
              }}
            >
              <ArrowDown size={16} />
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      {/* Input Area */}
      <div className="chat-view-input">
        <div className="chat-view-input-inner">
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            minWidth: 0,
          }} className="chat-input-container">
            {/* Toolbar row — desktop only; on mobile these controls move into the options sheet */}
            {!isMobile && (
            <div style={{
              display: 'flex',
              gap: '8px',
              alignItems: 'center',
              justifyContent: 'flex-start',
              flexWrap: 'wrap',
            }} className="chat-input-toolbar">
              {/* Reasoning toggle button */}
              {(
                <div style={{ position: 'relative', flexShrink: 0 }}>
                  <button
                    ref={reasoningBtnRef}
                    type="button"
                    aria-label={reasoningActive ? `Thinking: ${currentEffort}` : 'Enable thinking'}
                    aria-expanded={showReasoningPopover}
                    onClick={() => setShowReasoningPopover(!showReasoningPopover)}
                    title={reasoningActive ? `Thinking: ${currentEffort}` : 'Enable thinking'}
                    style={{
                      height: '32px',
                      padding: '0 10px',
                      borderRadius: 'var(--radius-md)',
                      background: reasoningActive ? 'var(--accent-soft)' : 'var(--bg-surface)',
                      border: `1px solid ${reasoningActive ? 'var(--border-accent)' : 'var(--border)'}`,
                      color: reasoningActive ? 'var(--accent)' : 'var(--text-muted)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      transition: 'all 0.2s ease',
                      position: 'relative',
                      fontSize: '0.75rem',
                      fontWeight: 500,
                    }}
                    onMouseEnter={(e) => {
                      if (!reasoningActive) {
                        e.currentTarget.style.background = 'var(--bg-hover)';
                        e.currentTarget.style.borderColor = 'var(--border-light)';
                      } else {
                        e.currentTarget.style.background = 'var(--accent-soft)';
                        e.currentTarget.style.boxShadow = '0 0 12px var(--accent-soft)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!reasoningActive) {
                        e.currentTarget.style.background = 'var(--bg-surface)';
                        e.currentTarget.style.borderColor = 'var(--border)';
                      } else {
                        e.currentTarget.style.background = 'var(--accent-soft)';
                        e.currentTarget.style.boxShadow = 'none';
                      }
                    }}
                  >
                    <Brain size={14} />
                    <span className="toolbar-button-text">Think</span>
                    {/* Active glow dot */}
                    {reasoningActive && (
                      <div style={{
                        position: 'absolute',
                        top: '4px',
                        right: '4px',
                        width: '5px',
                        height: '5px',
                        borderRadius: '50%',
                        background: 'var(--accent)',
                        boxShadow: '0 0 6px rgb(var(--copper-rgb) / 0.6)',
                      }} />
                    )}
                  </button>

                  {/* Reasoning Popover */}
                  <AnimatePresence>
                    {showReasoningPopover && (
                      <motion.div
                        ref={reasoningPopoverRef}
                        initial={{ opacity: 0, y: 8, scale: 0.96 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 8, scale: 0.96 }}
                        transition={{ duration: 0.15 }}
                        style={{
                          position: 'absolute',
                          bottom: 'calc(100% + 8px)',
                          left: '0',
                          width: '260px',
                          maxWidth: 'calc(100vw - 24px)',
                          background: 'var(--bg-elevated)',
                          border: '1px solid var(--border-light)',
                          borderRadius: 'var(--radius-md)',
                          boxShadow: 'var(--shadow-lg)',
                          overflow: 'hidden',
                          zIndex: 100,
                        }}
                      >
                        {/* Header with toggle */}
                        <div style={{
                          padding: '12px 14px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          borderBottom: '1px solid var(--border)',
                        }}>
                          <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                          }}>
                            <Brain size={14} style={{ color: reasoningActive ? 'var(--accent)' : 'var(--text-muted)' }} />
                            <span style={{
                              fontSize: '0.8125rem',
                              fontWeight: 600,
                              color: 'var(--text-primary)',
                              letterSpacing: '0.01em',
                            }}>
                              Thinking
                            </span>
                          </div>
                          {/* Mini toggle */}
                          <div
                            onClick={(e) => { e.stopPropagation(); toggleReasoning(); }}
                            style={{
                              width: '34px',
                              height: '18px',
                              borderRadius: '9px',
                              background: reasoningActive ? 'var(--accent)' : 'var(--bg-base)',
                              border: `1px solid ${reasoningActive ? 'var(--accent)' : 'var(--border)'}`,
                              position: 'relative',
                              cursor: 'pointer',
                              transition: 'all 0.2s ease',
                              flexShrink: 0,
                            }}
                          >
                            <div style={{
                              width: '14px',
                              height: '14px',
                              borderRadius: '50%',
                              background: reasoningActive ? '#ffffff' : 'var(--text-muted)',
                              position: 'absolute',
                              top: '1px',
                              left: reasoningActive ? '17px' : '1px',
                              transition: 'all 0.2s ease',
                            }} />
                          </div>
                        </div>

                        {/* Effort levels */}
                        {reasoningActive && (
                          <div style={{ padding: '10px 14px 12px' }}>
                            <div style={{
                              fontSize: '0.625rem',
                              fontWeight: 600,
                              color: 'var(--text-muted)',
                              textTransform: 'uppercase',
                              letterSpacing: '0.08em',
                              marginBottom: '8px',
                            }}>
                              Effort
                            </div>
                            <div style={{
                              display: 'flex',
                              gap: '0',
                              background: 'var(--bg-base)',
                              borderRadius: 'var(--radius-sm)',
                              border: '1px solid var(--border)',
                              padding: '2px',
                            }}>
                              {EFFORT_OPTIONS.map((opt) => {
                                const isActive = currentEffort === opt.value;
                                return (
                                  <button
                                    key={opt.value}
                                    onClick={() => setEffort(opt.value)}
                                    style={{
                                      flex: 1,
                                      padding: '5px 2px',
                                      fontSize: '0.6875rem',
                                      fontWeight: isActive ? 600 : 400,
                                      fontFamily: 'var(--font-body)',
                                      border: 'none',
                                      borderRadius: 'calc(var(--radius-sm) - 2px)',
                                      cursor: 'pointer',
                                      transition: 'all 0.12s ease',
                                      background: isActive ? 'var(--accent-soft)' : 'transparent',
                                      color: isActive ? 'var(--accent)' : 'var(--text-muted)',
                                    }}
                                  >
                                    {opt.short}
                                  </button>
                                );
                              })}
                            </div>

                            {/* Info line */}
                            <div style={{
                              marginTop: '8px',
                              fontSize: '0.625rem',
                              color: 'var(--text-muted)',
                              lineHeight: 1.4,
                            }}>
                              Model will show its reasoning process before responding.
                              {!reasoningOverride && (agent?.reasoning_enabled ? (
                                <span style={{ color: 'var(--text-secondary)' }}> Using agent defaults.</span>
                              ) : isGeneralChat && generalChatSettings?.reasoning_enabled ? (
                                <span style={{ color: 'var(--text-secondary)' }}> Using general chat defaults.</span>
                              ) : null)}
                            </div>
                          </div>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}

              {/* Council Toggle */}
              <CouncilToggle disabled={isStreaming} placement="above" />

              {/* Message Model Selector */}
              <div style={{ position: 'relative', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                <ModelSelectorCore
                  variant="message"
                  value={messageModelOverride}
                  onChange={(modelId) => {
                    setMessageModelOverride(modelId);
                    setMessageProviderRoutingOverride(null);
                  }}
                  agentModel={defaultModelForChat}
                  conversationModel={activeConversation?.model}
                  disabled={isStreaming}
                  compact
                  placement="above"
                />
                <ProviderRoutingSelector
                  modelId={messageModelOverride ?? effectiveConversationModel ?? defaultModelForChat}
                  value={messageProviderRoutingOverride}
                  onChange={setMessageProviderRoutingOverride}
                  inheritedRouting={effectiveConversationProviderRouting ?? defaultProviderRoutingForChat}
                  disabled={isStreaming}
                  allowDefault
                  compact
                  placement="above"
                />
              </div>
            </div>
            )}

            {/* Main input row - textarea and send button */}
            <div style={{
              display: 'flex',
              gap: '10px',
              alignItems: 'flex-end',
              minWidth: 0,
            }} className="chat-input-main-row">
            {isMobile && (
              <button
                type="button"
                onClick={() => setOptionsOpen(true)}
                aria-label="Message options"
                style={{
                  width: 44,
                  height: 44,
                  flexShrink: 0,
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border)',
                  color: composerOptionsActive ? 'var(--accent)' : 'var(--text-secondary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  position: 'relative',
                }}
              >
                <SlidersHorizontal size={20} />
                {composerOptionsActive && (
                  <span
                    style={{
                      position: 'absolute',
                      top: 6,
                      right: 6,
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      background: 'var(--accent)',
                    }}
                  />
                )}
              </button>
            )}
            <div style={{
              flex: 1,
              minWidth: 0,
              background: 'var(--bg-surface)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-lg)',
              overflow: 'hidden',
              transition: 'border-color var(--transition-fast)',
            }}>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,application/pdf"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => {
                  addAttachmentsFromFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              {/* PDF attachments + URL row */}
              {(pendingAttachments.length > 0 || !isStreaming) && (
                <div style={{
                  padding: '10px 14px 0',
                  borderBottom: pendingAttachments.length > 0 ? '1px solid var(--border)' : 'none',
                  paddingBottom: pendingAttachments.length > 0 ? 10 : 0,
                  marginBottom: pendingAttachments.length > 0 ? 0 : 0,
                }}>
                  {pendingAttachments.length > 0 && (
                    <div style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: '6px',
                      marginBottom: '8px',
                    }}>
                      <AnimatePresence>
                        {pendingAttachments.map((a) => (
                          <motion.div
                            key={a.id}
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.9 }}
                            transition={{ duration: 0.15 }}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '6px',
                              padding: '4px 8px',
                              borderRadius: 'var(--radius-sm)',
                              background: 'var(--accent-glow)',
                              border: '1px solid var(--border-accent)',
                              fontSize: '0.75rem',
                              color: 'var(--text-primary)',
                              maxWidth: '100%',
                            }}
                          >
                            <FileUp size={12} style={{ flexShrink: 0 }} />
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.filename}>
                              {a.filename}
                            </span>
                            {a.url && <span style={{ color: 'var(--text-muted)', fontSize: '0.625rem' }}>URL</span>}
                            <button
                              type="button"
                              aria-label="Remove attachment"
                              onClick={() => removeAttachment(a.id)}
                              style={{
                                padding: 0,
                                border: 'none',
                                background: 'none',
                                color: 'var(--text-muted)',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                              }}
                              onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--error)'; }}
                              onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
                            >
                              <X size={12} />
                            </button>
                          </motion.div>
                        ))}
                      </AnimatePresence>
                    </div>
                  )}
                  {pendingAttachments.length > 0 && !!(agent as { structured_output_enabled?: boolean })?.structured_output_enabled && (
                    <div style={{
                      fontSize: '0.6875rem',
                      color: 'var(--text-muted)',
                      marginBottom: 6,
                      padding: '4px 0',
                    }}>
                      This agent uses structured JSON output; with PDFs the model may return plain text instead.
                    </div>
                  )}
                  {!isStreaming && !isMobile && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={pendingAttachments.length >= MAX_PDF_ATTACHMENTS}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          padding: '4px 10px',
                          fontSize: '0.75rem',
                          fontFamily: 'var(--font-body)',
                          color: 'var(--text-secondary)',
                          background: 'var(--bg-base)',
                          border: '1px solid var(--border)',
                          borderRadius: 'var(--radius-sm)',
                          cursor: pendingAttachments.length >= MAX_PDF_ATTACHMENTS ? 'not-allowed' : 'pointer',
                          opacity: pendingAttachments.length >= MAX_PDF_ATTACHMENTS ? 0.6 : 1,
                        }}
                      >
                        <FileUp size={12} />
                        Attach PDF
                      </button>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: 1, minWidth: '120px' }}>
                        <Link size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                        <input
                          type="url"
                          value={pdfUrlInput}
                          onChange={(e) => setPdfUrlInput(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addAttachmentFromUrl())}
                          placeholder="PDF URL"
                          style={{
                            flex: 1,
                            minWidth: 0,
                            padding: '4px 8px',
                            fontSize: '0.75rem',
                            fontFamily: 'var(--font-body)',
                            background: 'var(--bg-base)',
                            border: `1px solid ${pdfUrlError ? 'var(--error)' : 'var(--border)'}`,
                            borderRadius: 'var(--radius-sm)',
                            color: 'var(--text-primary)',
                            outline: 'none',
                          }}
                          aria-label="PDF URL"
                        />
                        <button
                          type="button"
                          onClick={addAttachmentFromUrl}
                          style={{
                            padding: '4px 8px',
                            fontSize: '0.6875rem',
                            fontFamily: 'var(--font-body)',
                            color: 'var(--accent)',
                            background: 'transparent',
                            border: '1px solid var(--border-accent)',
                            borderRadius: 'var(--radius-sm)',
                            cursor: 'pointer',
                          }}
                        >
                          Add
                        </button>
                      </div>
                      {pdfUrlError && <span style={{ fontSize: '0.6875rem', color: 'var(--error)' }}>{pdfUrlError}</span>}
                    </div>
                  )}
                </div>
              )}
              <PremiumMentionInput
                value={inputValue}
                onChange={(val, agentId) => {
                  setInputValue(val);
                  setInvokeAgentId(agentId);
                }}
                disabled={isStreaming}
                placeholder={isStreaming ? 'Waiting for response...' : 'Send a message... Use @ to mention an agent'}
                agents={agents}
                onSubmit={handleSend}
                submitDisabled={!inputValue.trim() || isStreaming}
                onFocus={() => setComposerFocused(true)}
                onBlur={() => setComposerFocused(false)}
                minRows={1}
                maxRows={10}
              />
            </div>
            {/* Send / Stop button */}
            {isStreaming ? (
              <button
                type="button"
                className="chat-send-btn chat-stop-btn"
                aria-label="Stop generating"
                onClick={cancelStream}
                title="Stop generating"
                style={{
                  width: '44px',
                  height: '44px',
                  borderRadius: 'var(--radius-md)',
                  background: 'rgba(201, 107, 107, 0.15)',
                  border: '1px solid rgba(201, 107, 107, 0.3)',
                  color: 'var(--error)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  transition: 'all var(--transition-fast)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(201, 107, 107, 0.25)';
                  e.currentTarget.style.boxShadow = '0 0 12px rgba(201, 107, 107, 0.2)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(201, 107, 107, 0.15)';
                  e.currentTarget.style.boxShadow = 'none';
                }}
              >
                <StopCircle size={20} />
              </button>
            ) : (
              <button
                type="button"
                className="chat-send-btn"
                aria-label="Send message"
                onClick={handleSend}
                disabled={!inputValue.trim()}
                style={{
                  width: '44px',
                  height: '44px',
                  borderRadius: 'var(--radius-md)',
                  background: inputValue.trim() ? 'var(--accent)' : 'var(--bg-elevated)',
                  border: '1px solid transparent',
                  color: inputValue.trim() ? 'var(--text-inverse)' : 'var(--text-muted)',
                  cursor: inputValue.trim() ? 'pointer' : 'not-allowed',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  transition: 'all var(--transition-fast)',
                }}
                onMouseEnter={(e) => {
                  if (inputValue.trim()) {
                    e.currentTarget.style.background = 'var(--accent-hover)';
                    e.currentTarget.style.boxShadow = 'var(--shadow-glow)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (inputValue.trim()) {
                    e.currentTarget.style.background = 'var(--accent)';
                    e.currentTarget.style.boxShadow = 'none';
                  }
                }}
              >
                <Send size={18} />
              </button>
            )}
          </div>
          </div>
          <div className="chat-input-hints" style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '8px 4px 0',
            gap: '12px',
            flexWrap: 'wrap',
          }}>
            <span style={{
              fontSize: '0.6875rem',
              color: isStreaming ? 'var(--error)' : 'var(--text-muted)',
              fontFamily: 'var(--font-mono)',
            }}>
              {isStreaming ? (
                <>
                  <StreamingTokenCounter
                    streamingContent={streamingContent}
                    reasoningContent={reasoningContent}
                    streamStartTime={streamStartTime}
                  />
                  <span style={{ marginLeft: '8px', color: 'var(--error)' }}>
                    {isMobile ? '· stop' : '· click stop to cancel'}
                  </span>
                </>
              ) : (
                <>
                  {isMobile ? 'Enter to send' : 'Enter to send · Shift+Enter for new line'}
                  {reasoningActive && (
                    <span style={{ color: 'var(--accent)', marginLeft: '8px' }}>
                      · Thinking: {currentEffort}
                    </span>
                  )}
                  {pendingAttachments.length > 0 && (
                    <span style={{ marginLeft: '8px' }}>
                      · {pendingAttachments.length} PDF{pendingAttachments.length !== 1 ? 's' : ''} (max {MAX_PDF_ATTACHMENTS}, {MAX_PDF_MB} MB each)
                    </span>
                  )}
                </>
              )}
            </span>
            {!isStreaming && !isMobile && (
              <select
                value={pdfEngine}
                onChange={(e) => setPdfEngine((e.target.value || '') as '' | PDFEngine)}
                title="PDF processing engine"
                aria-label="PDF engine"
                style={{
                  fontSize: '0.6875rem',
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-secondary)',
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '2px 6px',
                  cursor: 'pointer',
                }}
              >
                {PDF_ENGINE_OPTIONS.map((opt) => (
                  <option key={opt.value || 'auto'} value={opt.value} title={opt.title}>
                    PDF: {opt.label}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      </div>

      {/* Mobile composer options — everything that used to crowd the toolbar */}
      {isMobile && (
        <Sheet isOpen={optionsOpen} onClose={() => setOptionsOpen(false)} title="Message options">
          <div className="composer-options">
            <section className="composer-options-section">
              <div className="composer-options-row">
                <span className="composer-options-label"><Brain size={15} /> Thinking</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={reasoningActive}
                  onClick={toggleReasoning}
                  className={`composer-switch ${reasoningActive ? 'is-on' : ''}`}
                  aria-label="Toggle thinking"
                >
                  <span className="composer-switch-knob" />
                </button>
              </div>
              {reasoningActive && (
                <div className="composer-effort">
                  {EFFORT_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className={currentEffort === opt.value ? 'is-active' : ''}
                      onClick={() => setEffort(opt.value)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section className="composer-options-section">
              <span className="composer-options-label"><Users size={15} /> Council</span>
              <CouncilToggle disabled={isStreaming} placement="above" />
            </section>

            <section className="composer-options-section">
              <span className="composer-options-label">Model for this message</span>
              <div className="composer-options-controls">
                <ModelSelectorCore
                  variant="message"
                  value={messageModelOverride}
                  onChange={(modelId) => {
                    setMessageModelOverride(modelId);
                    setMessageProviderRoutingOverride(null);
                  }}
                  agentModel={defaultModelForChat}
                  conversationModel={activeConversation?.model}
                  disabled={isStreaming}
                  compact
                />
                <ProviderRoutingSelector
                  modelId={messageModelOverride ?? effectiveConversationModel ?? defaultModelForChat}
                  value={messageProviderRoutingOverride}
                  onChange={setMessageProviderRoutingOverride}
                  inheritedRouting={effectiveConversationProviderRouting ?? defaultProviderRoutingForChat}
                  disabled={isStreaming}
                  allowDefault
                  compact
                />
              </div>
            </section>

            {!isStreaming && (
              <section className="composer-options-section">
                <span className="composer-options-label"><FileUp size={15} /> PDF attachments</span>
                <div className="composer-options-controls">
                  <button
                    type="button"
                    className="composer-options-btn"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={pendingAttachments.length >= MAX_PDF_ATTACHMENTS}
                  >
                    <FileUp size={14} /> Attach PDF
                  </button>
                </div>
                <div className="composer-options-controls">
                  <Link size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                  <input
                    type="url"
                    value={pdfUrlInput}
                    onChange={(e) => setPdfUrlInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addAttachmentFromUrl())}
                    placeholder="PDF URL"
                    className="composer-options-input"
                    aria-label="PDF URL"
                  />
                  <button type="button" className="composer-options-btn" onClick={addAttachmentFromUrl}>
                    Add
                  </button>
                </div>
                {pdfUrlError && (
                  <span style={{ fontSize: '0.6875rem', color: 'var(--error)' }}>{pdfUrlError}</span>
                )}
                <span className="composer-options-label" style={{ marginTop: 4 }}>PDF engine</span>
                <select
                  value={pdfEngine}
                  onChange={(e) => setPdfEngine((e.target.value || '') as '' | PDFEngine)}
                  className="composer-options-input"
                  aria-label="PDF engine"
                >
                  {PDF_ENGINE_OPTIONS.map((opt) => (
                    <option key={opt.value || 'auto'} value={opt.value} title={opt.title}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </section>
            )}
          </div>
        </Sheet>
      )}
    </div>
  );
}
