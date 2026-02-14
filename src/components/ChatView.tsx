import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Send, ArrowDown, StopCircle, MessageSquare, Bot, Brain, FileUp, Link, X } from 'lucide-react';
import { useStore } from '../stores/store';
import { useIsMobile } from '../utils/breakpoints';
import { useChat } from '../hooks/useChat';
import { useAutoScroll } from '../hooks/useAutoScroll';
import { MessageBubble } from './MessageBubble';
import { EmptyState } from './EmptyState';
import { Button } from './ui/Button';
import { ConversationTokenSummary, StreamingTokenCounter } from './TokenCounter';
import type { ReasoningEffort, ReasoningConfig, PDFEngine, ChatAttachmentInput, ToolExecution, ToolSource } from '../types';

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

const BUILTIN_TOOL_NAMES = new Set(['web_search', 'get_current_time']);

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
    streamingToolEvents,
  } = useStore();
  const { sendMessage, cancelStream, startNewChat } = useChat();
  const [inputValue, setInputValue] = useState('');
  const [showReasoningPopover, setShowReasoningPopover] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [pdfEngine, setPdfEngine] = useState<'' | PDFEngine>('');
  const [pdfUrlInput, setPdfUrlInput] = useState('');
  const [pdfUrlError, setPdfUrlError] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const reasoningBtnRef = useRef<HTMLButtonElement>(null);
  const reasoningPopoverRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { containerRef, scrollToBottom, showScrollButton, handleScroll } = useAutoScroll(
    isStreaming
      ? `${streamingContent.length}:${reasoningContent.length}:${streamingToolEvents.length}`
      : messages.length
  );

  const activeConversation = conversations.find((c) => c.id === activeConversationId);
  const agent = agents.find((a) => a.id === (activeConversation?.agent_id || selectedAgentId));

  // Determine effective reasoning state: override > agent default
  const effectiveReasoning: ReasoningConfig = useMemo(() => {
    if (reasoningOverride) return reasoningOverride;
    if (agent?.reasoning_enabled) {
      return {
        enabled: true,
        effort: agent.reasoning_effort || undefined,
        max_tokens: agent.reasoning_max_tokens || undefined,
      };
    }
    return { enabled: false };
  }, [reasoningOverride, agent]);

  const reasoningActive = effectiveReasoning.enabled;
  const currentEffort = effectiveReasoning.effort || 'medium';
  const isMobile = useIsMobile();

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
      setReasoningOverride({ enabled: true, effort: agent?.reasoning_effort || 'medium' });
    }
  }, [reasoningActive, agent, setReasoningOverride]);

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
  }, [activeConversationId, setReasoningOverride]);


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

    sendMessage(inputValue, {
      ...(attachmentsPayload?.length && { attachments: attachmentsPayload }),
      ...(pdfEngine && { pdf_engine: pdfEngine }),
    });
    setInputValue('');
    setPendingAttachments([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [inputValue, isStreaming, pendingAttachments, pdfEngine, sendMessage]);

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
        description={
          selectedAgentId
            ? "Start a new chat with this agent, or select a conversation from the sidebar."
            : "Select an agent first, then start chatting."
        }
        action={
          selectedAgentId ? (
            <Button
              variant="primary"
              icon={<MessageSquare size={16} />}
              onClick={() => startNewChat(selectedAgentId)}
            >
              New Chat
            </Button>
          ) : (
            <Button
              variant="primary"
              icon={<Bot size={16} />}
              onClick={() => setCurrentView('agents')}
            >
              Browse Agents
            </Button>
          )
        }
      />
    );
  }

  // Build display messages including streaming
  const displayMessages = messages.filter((m) => m.role !== 'tool');
  const lastMsg = displayMessages[displayMessages.length - 1];
  const isLastMsgStreamingPlaceholder = lastMsg && lastMsg.role === 'assistant' && lastMsg.id.startsWith('temp-');
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

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      overflow: 'hidden',
    }}>
      {/* Chat Header */}
      <div style={{
        padding: '12px var(--content-padding-x)',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-base)',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        flexShrink: 0,
        flexWrap: 'wrap',
      }}>
        {agent && (
          <div style={{
            width: '32px',
            height: '32px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--accent-glow)',
            border: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '1rem',
            flexShrink: 0,
          }}>
            {agent.emoji}
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: '0.938rem',
            fontWeight: 500,
            color: 'var(--text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {activeConversation?.title || 'New conversation'}
          </div>
          <div style={{
            fontSize: '0.75rem',
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-mono)',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            flexWrap: 'wrap',
          }}>
            {agent?.name || 'Agent'} · {agent?.model || 'openrouter/auto'}
          </div>
        </div>
        {/* Conversation token summary */}
        <ConversationTokenSummary messages={messages} />
      </div>

      {/* Messages */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: `0 var(--content-padding-x)`,
        }}
      >
        <div style={{
          maxWidth: '800px',
          margin: '0 auto',
          paddingBottom: 'var(--content-padding-y)',
        }}>
          {messagesLoading ? (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '64px',
              color: 'var(--text-muted)',
            }}>
              Loading messages...
            </div>
          ) : messages.length === 0 ? (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '80px 24px',
                textAlign: 'center',
                gap: '16px',
              }}
            >
              <div style={{
                fontSize: '3rem',
                marginBottom: '8px',
              }}>
                {agent?.emoji || '✨'}
              </div>
              <h2 style={{
                fontFamily: 'var(--font-display)',
                fontSize: '1.75rem',
                fontWeight: 500,
                color: 'var(--text-primary)',
              }}>
                Chat with {agent?.name || 'Agent'}
              </h2>
              <p style={{
                color: 'var(--text-muted)',
                maxWidth: '400px',
                lineHeight: 1.6,
                fontSize: '0.938rem',
              }}>
                {agent?.description || 'Send a message to start the conversation.'}
              </p>
            </motion.div>
          ) : (
            displayMessages.map((msg, i) => {
              const isStreamingMsg = isLastMsgStreamingPlaceholder && i === displayMessages.length - 1;
              const timelineCalls = isStreamingMsg
                ? streamingToolEvents
                : toolExecutionsByMessageId.get(msg.id);
              return (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  isStreaming={isStreamingMsg}
                  streamingContent={isStreamingMsg ? streamingContent : undefined}
                  streamingReasoning={isStreamingMsg ? reasoningContent : undefined}
                  agentEmoji={agent?.emoji}
                  toolExecutions={timelineCalls}
                  toolActivityLive={isStreamingMsg && timelineCalls !== undefined && timelineCalls.length > 0}
                />
              );
            })
          )}
        </div>
      </div>

      {/* Scroll to bottom */}
      <AnimatePresence>
        {showScrollButton && (
          <motion.button
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            onClick={scrollToBottom}
            style={{
            position: 'absolute',
            left: '50%',
            transform: 'translateX(-50%)',
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
            }}
            className="chat-scroll-btn"
          >
            <ArrowDown size={16} />
          </motion.button>
        )}
      </AnimatePresence>

      {/* Input Area */}
      <div style={{
        padding: '16px var(--content-padding-x) 20px',
        paddingBottom: 'calc(20px + env(safe-area-inset-bottom, 0px))',
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-base)',
        flexShrink: 0,
      }}>
        <div style={{
          maxWidth: '800px',
          margin: '0 auto',
        }}>
          <div style={{
            display: 'flex',
            gap: '10px',
            alignItems: 'flex-end',
            minWidth: 0,
          }}>
            {/* Reasoning toggle button (OpenRouter only) */}
            {(
              <div style={{ position: 'relative', flexShrink: 0 }}>
                <button
                  ref={reasoningBtnRef}
                  onClick={() => setShowReasoningPopover(!showReasoningPopover)}
                  title={reasoningActive ? `Thinking: ${currentEffort}` : 'Enable thinking'}
                  style={{
                    width: '44px',
                    height: '44px',
                    borderRadius: 'var(--radius-md)',
                    background: reasoningActive ? 'rgba(212, 160, 48, 0.12)' : 'var(--bg-surface)',
                    border: `1px solid ${reasoningActive ? 'rgba(212, 160, 48, 0.3)' : 'var(--border)'}`,
                    color: reasoningActive ? '#d4a030' : 'var(--text-muted)',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'all 0.2s ease',
                    position: 'relative',
                  }}
                  onMouseEnter={(e) => {
                    if (!reasoningActive) {
                      e.currentTarget.style.background = 'var(--bg-hover)';
                      e.currentTarget.style.borderColor = 'var(--border-light)';
                    } else {
                      e.currentTarget.style.background = 'rgba(212, 160, 48, 0.18)';
                      e.currentTarget.style.boxShadow = '0 0 12px rgba(212, 160, 48, 0.12)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!reasoningActive) {
                      e.currentTarget.style.background = 'var(--bg-surface)';
                      e.currentTarget.style.borderColor = 'var(--border)';
                    } else {
                      e.currentTarget.style.background = 'rgba(212, 160, 48, 0.12)';
                      e.currentTarget.style.boxShadow = 'none';
                    }
                  }}
                >
                  <Brain size={18} />
                  {/* Active glow dot */}
                  {reasoningActive && (
                    <div style={{
                      position: 'absolute',
                      top: '6px',
                      right: '6px',
                      width: '6px',
                      height: '6px',
                      borderRadius: '50%',
                      background: '#d4a030',
                      boxShadow: '0 0 6px rgba(212, 160, 48, 0.6)',
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
                          <Brain size={14} style={{ color: reasoningActive ? '#d4a030' : 'var(--text-muted)' }} />
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
                            background: reasoningActive ? '#d4a030' : 'var(--bg-base)',
                            border: `1px solid ${reasoningActive ? '#d4a030' : 'var(--border)'}`,
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
                                    background: isActive ? 'rgba(212, 160, 48, 0.18)' : 'transparent',
                                    color: isActive ? '#d4a030' : 'var(--text-muted)',
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
                            {agent?.reasoning_enabled && !reasoningOverride && (
                              <span style={{ color: 'var(--text-secondary)' }}> Using agent defaults.</span>
                            )}
                          </div>
                        </div>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
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
                  {!isStreaming && (
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
              <textarea
                ref={textareaRef}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={isStreaming ? 'Waiting for response...' : 'Send a message...'}
                disabled={isStreaming}
                rows={1}
                style={{
                  width: '100%',
                  padding: '14px 18px',
                  fontSize: '0.938rem',
                  fontFamily: 'var(--font-body)',
                  background: 'transparent',
                  color: 'var(--text-primary)',
                  border: 'none',
                  outline: 'none',
                  resize: 'none',
                  lineHeight: 1.5,
                  maxHeight: '200px',
                }}
                onFocus={(e) => {
                  (e.currentTarget.parentElement as HTMLElement).style.borderColor = 'var(--accent)';
                }}
                onBlur={(e) => {
                  (e.currentTarget.parentElement as HTMLElement).style.borderColor = 'var(--border)';
                }}
              />
            </div>
            {/* Send / Stop button */}
            {isStreaming ? (
              <button
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
          <div style={{
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
                    · click stop to cancel
                  </span>
                </>
              ) : (
                <>
                  {isMobile ? 'Enter to send' : 'Enter to send · Shift+Enter for new line'}
                  {reasoningActive && (
                    <span style={{ color: '#d4a030', marginLeft: '8px' }}>
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
            {!isStreaming && (
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
    </div>
  );
}
