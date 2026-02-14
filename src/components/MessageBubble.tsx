import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { User, Sparkles, Copy, Check, Brain, ChevronDown, ChevronRight, ExternalLink, Globe, FileUp, Braces } from 'lucide-react';
import { MarkdownContent } from './MarkdownContent';
import { MessageTokenPills } from './TokenCounter';
import type { Message, Annotation } from '../types';

function tryParseJson(str: string): unknown | null {
  const trimmed = str.trim();
  if ((!trimmed.startsWith('{') && !trimmed.startsWith('[')) || trimmed.length < 2) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** Try to get parseable JSON from content: direct parse or extract from markdown code block (```json ... ``` or ``` ... ```). */
function getJsonFromContent(content: string): { parsed: unknown; raw: string } | null {
  const trimmed = content.trim();
  const direct = tryParseJson(trimmed);
  if (direct !== null) return { parsed: direct, raw: content };

  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    const inner = codeBlockMatch[1].trim();
    const parsed = tryParseJson(inner);
    if (parsed !== null) return { parsed, raw: content };
  }
  return null;
}

// Collapsible JSON view with Raw / Formatted toggle for structured output responses
function JsonContentView({ content }: { content: string }) {
  const result = React.useMemo(() => getJsonFromContent(content), [content]);
  const [view, setView] = React.useState<'formatted' | 'raw'>('formatted');
  const [expanded, setExpanded] = React.useState(true);

  if (result === null) {
    return <MarkdownContent content={content} />;
  }

  const { parsed, raw } = result;
  const formattedJson = JSON.stringify(parsed, null, 2);

  return (
    <div style={{
      border: '1px solid rgba(99, 102, 241, 0.2)',
      borderRadius: 'var(--radius-sm)',
      overflow: 'hidden',
      background: 'rgba(99, 102, 241, 0.03)',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '6px 10px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-elevated)',
        gap: '8px',
      }}>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--text-secondary)',
            fontSize: '0.75rem',
            fontWeight: 500,
            fontFamily: 'var(--font-body)',
          }}
        >
          <Braces size={12} style={{ color: '#6366f1' }} />
          JSON
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <div style={{ display: 'flex', gap: 0 }}>
          {(['formatted', 'raw'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              style={{
                padding: '4px 10px',
                fontSize: '0.6875rem',
                fontWeight: 500,
                fontFamily: 'var(--font-mono)',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                background: view === v ? 'rgba(99, 102, 241, 0.15)' : 'transparent',
                color: view === v ? '#6366f1' : 'var(--text-muted)',
                textTransform: 'capitalize',
                transition: 'all 0.15s ease',
              }}
            >
              {v}
            </button>
          ))}
        </div>
      </div>
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            style={{ overflow: 'hidden' }}
          >
            <div style={{
              padding: '10px 12px',
              fontSize: '0.8125rem',
              fontFamily: 'var(--font-mono)',
              lineHeight: 1.6,
              color: 'var(--text-primary)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: '400px',
              overflowY: 'auto',
              background: 'var(--bg-base)',
            }}>
              {view === 'formatted' ? formattedJson : raw}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

interface MessageBubbleProps {
  message: Message;
  isStreaming?: boolean;
  streamingContent?: string;
  streamingReasoning?: string;
  agentEmoji?: string;
}

function formatCost(cost: number): string {
  if (cost === 0) return '';
  if (cost < 0.0001) return '<$0.0001';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(4)}`;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// Extract a display-friendly domain from a URL
function extractDomain(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// Deduplicate annotations by URL (only keeps annotations that have a url)
function dedupeAnnotations(annotations: Annotation[]): Annotation[] {
  const seen = new Set<string>();
  const result: Annotation[] = [];
  for (const ann of annotations) {
    const u = ann.url;
    if (u && !seen.has(u)) {
      seen.add(u);
      result.push(ann);
    }
  }
  return result;
}

// Collapsible reasoning/thinking block
function ReasoningBlock({
  content,
  isStreaming,
  tokenCount,
}: {
  content: string;
  isStreaming: boolean;
  tokenCount?: number;
}) {
  const [expanded, setExpanded] = React.useState(isStreaming);

  // Auto-expand while streaming, auto-collapse when done
  React.useEffect(() => {
    if (isStreaming) {
      setExpanded(true);
    }
  }, [isStreaming]);

  if (!content) return null;

  return (
    <div style={{
      marginBottom: '10px',
      borderRadius: 'var(--radius-sm)',
      border: '1px solid rgba(139, 92, 246, 0.15)',
      background: 'rgba(139, 92, 246, 0.04)',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          width: '100%',
          padding: '8px 12px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: '#a78bfa',
          fontSize: '0.75rem',
          fontWeight: 600,
          fontFamily: 'var(--font-body)',
          letterSpacing: '0.02em',
        }}
      >
        <Brain size={13} />
        {isStreaming ? (
          <motion.span
            animate={{ opacity: [0.5, 1, 0.5] }}
            transition={{ duration: 1.5, repeat: Infinity }}
          >
            Thinking...
          </motion.span>
        ) : (
          <span>Reasoning</span>
        )}
        {tokenCount !== undefined && tokenCount > 0 && (
          <span style={{
            fontSize: '0.625rem',
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-mono)',
            fontWeight: 400,
          }}>
            ({formatTokens(tokenCount)} tokens)
          </span>
        )}
        <span style={{ marginLeft: 'auto' }}>
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      </button>

      {/* Content */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            style={{ overflow: 'hidden' }}
          >
            <div style={{
              padding: '0 12px 10px',
              fontSize: '0.8125rem',
              lineHeight: 1.65,
              color: 'var(--text-muted)',
              fontStyle: 'italic',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: '300px',
              overflowY: 'auto',
            }}>
              {content}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Citation links from web search (only annotations with url)
function CitationLinks({ annotations }: { annotations: Annotation[] }) {
  const withUrl = annotations.filter((a): a is Annotation & { url: string } => !!a.url);
  const unique = dedupeAnnotations(withUrl);
  if (unique.length === 0) return null;

  return (
    <div style={{
      marginTop: '10px',
      padding: '8px 12px',
      background: 'rgba(139, 92, 246, 0.04)',
      border: '1px solid rgba(139, 92, 246, 0.12)',
      borderRadius: 'var(--radius-sm)',
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '5px',
        fontSize: '0.6875rem',
        fontWeight: 600,
        color: 'var(--text-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
      }}>
        <Globe size={11} />
        Sources
      </div>
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '6px',
      }}>
        {unique.map((ann, i) => (
          <a
            key={`${ann.url}-${i}`}
            href={ann.url}
            target="_blank"
            rel="noopener noreferrer"
            className="message-citation-link"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              padding: '3px 8px',
              fontSize: '0.6875rem',
              fontFamily: 'var(--font-mono)',
              color: '#a78bfa',
              background: 'rgba(139, 92, 246, 0.08)',
              border: '1px solid rgba(139, 92, 246, 0.15)',
              borderRadius: '4px',
              textDecoration: 'none',
              transition: 'all 0.15s ease',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(139, 92, 246, 0.15)';
              e.currentTarget.style.borderColor = 'rgba(139, 92, 246, 0.3)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(139, 92, 246, 0.08)';
              e.currentTarget.style.borderColor = 'rgba(139, 92, 246, 0.15)';
            }}
          >
            <span style={{ flexShrink: 0, opacity: 0.7 }}>[{i + 1}]</span>
            {ann.title || (ann.url ? extractDomain(ann.url) : '')}
            <ExternalLink size={9} style={{ flexShrink: 0, opacity: 0.6 }} />
          </a>
        ))}
      </div>
    </div>
  );
}

export function MessageBubble({ message, isStreaming, streamingContent, streamingReasoning, agentEmoji }: MessageBubbleProps) {
  const [copied, setCopied] = React.useState(false);
  const isUser = message.role === 'user';
  const displayContent = isStreaming ? (streamingContent || '') : message.content;

  // Reasoning: use streaming reasoning during stream, or persisted reasoning_content
  const reasoningText = isStreaming ? (streamingReasoning || '') : (message.reasoning_content || '');
  const reasoningTokens = message.reasoning_tokens;

  // Annotations
  const annotations = message.annotations || [];

  const handleCopy = () => {
    navigator.clipboard.writeText(displayContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (message.role === 'system' || message.role === 'tool') return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
      className="message-bubble-container"
      style={{
        display: 'flex',
        gap: '14px',
        alignItems: 'flex-start',
        maxWidth: '100%',
      }}
    >
      {/* Avatar */}
      <div style={{
        width: '36px',
        height: '36px',
        borderRadius: '50%',
        background: isUser ? 'var(--bg-elevated)' : 'var(--accent-glow)',
        border: `1px solid ${isUser ? 'var(--border)' : 'var(--border-accent)'}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        fontSize: isUser ? '0' : '1.1rem',
      }}>
        {isUser ? (
          <User size={16} style={{ color: 'var(--text-secondary)' }} />
        ) : (
          agentEmoji || <Sparkles size={16} style={{ color: 'var(--accent)' }} />
        )}
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
        {/* Role label */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '6px',
        }}>
          <span style={{
            fontSize: '0.75rem',
            fontWeight: 600,
            color: isUser ? 'var(--text-secondary)' : 'var(--accent)',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            fontFamily: 'var(--font-body)',
          }}>
            {isUser ? 'You' : 'Assistant'}
          </span>
          {!isUser && displayContent && !isStreaming && (
            <button
              onClick={handleCopy}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                background: 'transparent',
                border: 'none',
                color: copied ? 'var(--success)' : 'var(--text-muted)',
                cursor: 'pointer',
                fontSize: '0.6875rem',
                fontFamily: 'var(--font-mono)',
                padding: '2px 8px',
                borderRadius: '4px',
                transition: 'all var(--transition-fast)',
                opacity: 0.6,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.opacity = '1';
                if (!copied) e.currentTarget.style.color = 'var(--text-primary)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = '0.6';
                if (!copied) e.currentTarget.style.color = 'var(--text-muted)';
              }}
            >
              {copied ? <Check size={11} /> : <Copy size={11} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          )}
        </div>

        {/* Message body */}
        {isUser ? (
          <>
            <div style={{
              fontSize: '0.938rem',
              lineHeight: 1.7,
              color: 'var(--text-primary)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>
              {displayContent}
            </div>
            {message.attachments && message.attachments.length > 0 && (
              <div style={{
                marginTop: '8px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                flexWrap: 'wrap',
                fontSize: '0.75rem',
                color: 'var(--text-muted)',
              }}>
                <FileUp size={12} style={{ flexShrink: 0 }} />
                <span>
                  Attached: {message.attachments.map((a) => a.filename).join(', ')}
                </span>
              </div>
            )}
          </>
        ) : (
          <>
            {/* Reasoning / Thinking block */}
            {reasoningText && (
              <ReasoningBlock
                content={reasoningText}
                isStreaming={!!isStreaming}
                tokenCount={reasoningTokens}
              />
            )}

            {displayContent ? (
              !isStreaming && getJsonFromContent(displayContent) !== null ? (
                <JsonContentView content={displayContent} />
              ) : (
                <MarkdownContent content={displayContent} />
              )
            ) : (
              isStreaming && !reasoningText && (
                <div style={{
                  display: 'flex',
                  gap: '4px',
                  padding: '8px 0',
                }}>
                  {[0, 1, 2].map((i) => (
                    <motion.div
                      key={i}
                      animate={{ opacity: [0.3, 1, 0.3] }}
                      transition={{
                        duration: 1.2,
                        repeat: Infinity,
                        delay: i * 0.2,
                      }}
                      style={{
                        width: '6px',
                        height: '6px',
                        borderRadius: '50%',
                        background: 'var(--accent)',
                      }}
                    />
                  ))}
                </div>
              )
            )}

            {/* Web search citation links */}
            {!isStreaming && annotations.length > 0 && (
              <CitationLinks annotations={annotations} />
            )}

            {/* PDF/document annotations (file type from OpenRouter) */}
            {!isStreaming && annotations.some((a) => a.type === 'file' && a.file?.name) && (
              <div style={{
                marginTop: '8px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                flexWrap: 'wrap',
                fontSize: '0.75rem',
                color: 'var(--text-muted)',
              }}>
                <FileUp size={12} style={{ flexShrink: 0 }} />
                <span>
                  Document(s) used: {annotations.filter((a) => a.type === 'file' && a.file?.name).map((a) => a.file!.name).join(', ')}
                </span>
              </div>
            )}

            {/* Tools used (assistant messages with tool_calls) */}
            {!isStreaming && message.tool_calls && message.tool_calls.length > 0 && (
              <div style={{
                marginTop: '10px',
                display: 'flex',
                flexWrap: 'wrap',
                gap: '6px',
                alignItems: 'center',
              }}>
                <span style={{
                  fontSize: '0.6875rem',
                  fontWeight: 600,
                  color: 'var(--text-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  marginRight: '4px',
                }}>
                  Used
                </span>
                {message.tool_calls.map((tc) => (
                  <span
                    key={tc.id}
                    style={{
                      fontSize: '0.75rem',
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--accent)',
                      background: 'rgba(139, 92, 246, 0.08)',
                      border: '1px solid rgba(139, 92, 246, 0.2)',
                      borderRadius: '4px',
                      padding: '3px 8px',
                    }}
                  >
                    {tc.function?.name?.replace(/_/g, ' ') ?? tc.id}
                  </span>
                ))}
              </div>
            )}

            {/* Token/cost pills (always visible) */}
            {!isUser && !isStreaming && (
              <MessageTokenPills message={message} />
            )}
          </>
        )}
      </div>
    </motion.div>
  );
}
