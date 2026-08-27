import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { createPortal } from 'react-dom';
import { User, Sparkles, Copy, Check, Brain, ChevronDown, ChevronRight, ChevronLeft, ExternalLink, Globe, FileUp, Braces, Users, Laptop, Pencil, RotateCcw, GitBranch, Send } from 'lucide-react';
import { MarkdownContent } from './MarkdownContent';
import { MessageTokenPills } from './TokenCounter';
import { ToolCallTimeline } from './ToolCallTimeline';
import { CouncilMessageView } from './CouncilMessageView';
import { Button } from './ui/Button';
import { formatModelId, getModelAuthor, getAuthorColor, formatAuthor } from '../utils/modelUtils';
import { useIsMobile } from '../utils/breakpoints';
import { getCouncilRun } from '../api/councilClient';
import { formatVariantTime } from '../utils/variantUtils';
import { isSafeHttpUrl } from '../utils/url';
import { Badge } from './ui/Badge';
import type { Message, Annotation, ToolExecution, StreamingActivityEvent, CouncilRunDetail, ProviderRoutingConfig, ChatArtifact } from '../types';

/** Compact pill showing which model generated the message; provider color and full id in tooltip. */
function MessageModelBadge({ modelId, title }: { modelId: string; title?: string }) {
  const author = getModelAuthor(modelId);
  const shortName = formatModelId(modelId);
  const displayName = shortName === 'auto' ? 'Auto' : shortName;
  const color = getAuthorColor(author);
  const tooltip = title ?? (author !== 'other' ? `${formatAuthor(author)} — ${modelId}` : modelId);
  const isHex = color.startsWith('#');
  const bg = isHex ? `${color}14` : 'var(--bg-elevated)';
  return (
    <span
      className="message-bubble-model-pill"
      title={tooltip}
      style={{
        color,
        borderColor: color,
        background: bg,
      }}
    >
      {displayName}
    </span>
  );
}

function ProviderRoutingBadge({ routing }: { routing: ProviderRoutingConfig }) {
  const label = routing.mode === 'auto' ? 'Auto route' : routing.provider_slug;
  const title = routing.mode === 'auto'
    ? 'OpenRouter automatic provider routing'
    : `Requested provider endpoint: ${routing.provider_slug}${routing.allow_fallbacks ? ' with fallbacks' : ' without fallbacks'}`;
  return (
    <span
      className="message-bubble-model-pill"
      title={title}
      style={{
        color: 'var(--text-muted)',
        borderColor: 'var(--border)',
        background: 'var(--bg-elevated)',
      }}
    >
      {label}
    </span>
  );
}

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
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-sm)',
      overflow: 'hidden',
      background: 'var(--surface-2)',
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
          <Braces size={12} style={{ color: 'var(--accent)' }} />
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
                background: view === v ? 'var(--accent-soft)' : 'transparent',
                color: view === v ? 'var(--accent)' : 'var(--text-muted)',
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

// ---------- Edit mode (user messages) ----------

interface MessageEditEditorProps {
  content: string;
  onContentChange: (content: string) => void;
  /** Model that produced the original response (informational badge only). */
  originalModel?: string | null;
  /** Effective conversation model used for the re-run (informational hint only). */
  relaunchModel?: string | null;
  disabled?: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}

function MessageEditEditor({
  content,
  onContentChange,
  originalModel = null,
  relaunchModel = null,
  disabled = false,
  onCancel,
  onSubmit,
}: MessageEditEditorProps) {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  // Focus and place the cursor at the end when the editor mounts.
  React.useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, []);

  // Auto-resize to content (same trick as the composer).
  React.useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`;
  }, [content]);

  const canSubmit = !disabled && content.trim().length > 0;

  return (
    <div className="message-edit-editor">
      <textarea
        ref={textareaRef}
        className="message-edit-textarea"
        value={content}
        onChange={(e) => onContentChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            if (canSubmit) onSubmit();
          }
        }}
        placeholder="Edita tu mensaje..."
        aria-label="Edit message"
        disabled={disabled}
        rows={Math.max(2, Math.min(content.split('\n').length + 1, 8))}
      />
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flexWrap: 'wrap',
        padding: '10px 12px',
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-surface)',
      }}>
        {originalModel && (
          <MessageModelBadge modelId={originalModel} title="Model that produced the original response" />
        )}
        {relaunchModel && (
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            Re-run with {formatModelId(relaunchModel)}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={disabled}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          icon={<Send size={13} />}
          onClick={onSubmit}
          disabled={!canSubmit}
        >
          Re-run
        </Button>
      </div>
    </div>
  );
}

// ---------- Variant navigation (‹ 1/2 › + list popover) ----------

interface VariantSelectorProps {
  /** 1-based position of the active variant. */
  index: number;
  total: number;
  /** All user variants of this turn, ordered by variant_seq. */
  variants: Message[];
  modelsByVariantId: Record<string, string | null>;
  activeVariantId?: string;
  onNavigate: (direction: -1 | 1) => void;
  onSelect: (variantId: string) => void;
  disabled?: boolean;
}

function VariantSelector({
  index,
  total,
  variants,
  modelsByVariantId,
  activeVariantId,
  onNavigate,
  onSelect,
  disabled = false,
}: VariantSelectorProps) {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<{ top: number; left: number } | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  const canPrev = !disabled && index > 1;
  const canNext = !disabled && index < total;

  // Popover follows the counter on scroll/resize (fixed positioning so it escapes
  // the bubble's overflow:hidden content box).
  React.useEffect(() => {
    if (!open) return;
    const update = () => {
      const el = triggerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const width = Math.min(340, window.innerWidth - 24);
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      setPos({ top: rect.bottom + 8, left });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  // Close on outside click / Escape.
  React.useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (triggerRef.current && triggerRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const handleSelect = (variantId: string) => {
    setOpen(false);
    onSelect(variantId);
  };

  const popoverWidth = Math.min(340, window.innerWidth - 24);

  return (
    <div className="message-variant-control" role="group" aria-label={`Variant ${index} of ${total}`}>
      <button
        type="button"
        className="message-variant-arrow"
        onClick={() => onNavigate(-1)}
        disabled={!canPrev}
        aria-label="Previous variant"
        title="Previous variant"
      >
        <ChevronLeft size={13} />
      </button>
      <button
        ref={triggerRef}
        type="button"
        className="message-variant-counter"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`Variant ${index} of ${total}`}
        title="View variants"
      >
        <span>{index}</span>/<span>{total}</span>
      </button>
      <button
        type="button"
        className="message-variant-arrow"
        onClick={() => onNavigate(1)}
        disabled={!canNext}
        aria-label="Next variant"
        title="Next variant"
      >
        <ChevronRight size={13} />
      </button>

      {createPortal(
        <AnimatePresence>
          {open && pos && (
            <motion.div
              role="listbox"
              aria-label={`Message variants (${total})`}
              initial={{ opacity: 0, y: -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.98 }}
              transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
              style={{
                position: 'fixed',
                top: pos.top,
                left: pos.left,
                width: popoverWidth,
                maxHeight: 'min(60vh, 420px)',
                display: 'flex',
                flexDirection: 'column',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-light)',
                borderRadius: 'var(--radius-lg)',
                boxShadow: 'var(--shadow-lg), 0 0 0 1px rgba(255,255,255,0.04)',
                zIndex: 1000,
                overflow: 'hidden',
              }}
            >
              <div style={{
                padding: '10px 14px',
                borderBottom: '1px solid var(--border)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexShrink: 0,
              }}>
                <GitBranch size={14} style={{ color: 'var(--accent)' }} />
                <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                  Message variants
                </span>
                <span style={{
                  marginLeft: 'auto',
                  fontSize: '0.6875rem',
                  color: 'var(--text-muted)',
                  fontFamily: 'var(--font-mono)',
                }}>
                  {index}/{total}
                </span>
              </div>
              <div style={{ overflow: 'auto', WebkitOverflowScrolling: 'touch', padding: '4px' }}>
                {variants.map((v, i) => {
                  const num = v.variant_seq ?? i + 1;
                  const isActive = v.id === activeVariantId;
                  const modelId = modelsByVariantId[v.id] ?? null;
                  return (
                    <button
                      key={v.id}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      onClick={() => handleSelect(v.id)}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 10,
                        width: '100%',
                        padding: '10px 12px',
                        marginBottom: '2px',
                        textAlign: 'left',
                        background: isActive ? 'var(--accent-muted)' : 'transparent',
                        border: 'none',
                        borderLeft: `3px solid ${isActive ? 'var(--accent)' : 'transparent'}`,
                        borderRadius: 'var(--radius-md)',
                        cursor: 'pointer',
                        color: 'var(--text-primary)',
                        transition: 'background var(--transition-fast)',
                      }}
                      onMouseEnter={(e) => {
                        if (!isActive) e.currentTarget.style.background = 'var(--bg-hover)';
                      }}
                      onMouseLeave={(e) => {
                        if (!isActive) e.currentTarget.style.background = 'transparent';
                      }}
                    >
                      <span style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        minWidth: 22,
                        height: 22,
                        padding: '0 6px',
                        marginTop: 1,
                        borderRadius: 'var(--radius-sm)',
                        background: isActive ? 'var(--accent-ghost)' : 'var(--bg-surface)',
                        border: '1px solid var(--border)',
                        fontSize: '0.6875rem',
                        fontFamily: 'var(--font-mono)',
                        fontWeight: 600,
                        color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
                        flexShrink: 0,
                      }}>
                        {num}
                      </span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          flexWrap: 'wrap',
                          marginBottom: 3,
                        }}>
                          {modelId && <MessageModelBadge modelId={modelId} />}
                          <span style={{
                            fontSize: '0.625rem',
                            color: 'var(--text-muted)',
                            fontFamily: 'var(--font-mono)',
                          }}>
                            {formatVariantTime(v.created_at)}
                          </span>
                        </span>
                        <span style={{
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                          fontSize: '0.75rem',
                          lineHeight: 1.5,
                          color: 'var(--text-muted)',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                        }}>
                          {v.content || '(sin contenido)'}
                        </span>
                      </span>
                      {isActive && (
                        <Check size={14} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 4 }} />
                      )}
                    </button>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </div>
  );
}

interface MessageBubbleProps {
  message: Message;
  isStreaming?: boolean;
  streamingContent?: string;
  streamingReasoning?: string;
  streamingActivityEvents?: StreamingActivityEvent[];
  agentEmoji?: string;
  toolExecutions?: ToolExecution[];
  toolActivityLive?: boolean;
  /** Shows the pulsing "generating…" affordance (GC13) for rows rendered live
   *  from poll mode (server-reported streaming draft, no local stream). */
  showGeneratingIndicator?: boolean;
  /** Model used for this message when streaming (before message.model is set). */
  streamingModel?: string;
  streamingProviderRouting?: ProviderRoutingConfig | null;

  // --- Editing (user messages) ---
  isEditing?: boolean;
  editContent?: string;
  onEditContentChange?: (content: string) => void;
  /** Model that produced the original response (informational badge in the editor). */
  editOriginalModel?: string | null;
  /** Effective conversation model used for the re-run (informational hint in the editor). */
  relaunchModel?: string | null;
  onStartEdit?: () => void;
  onCancelEdit?: () => void;
  onSubmitEdit?: () => void;
  /** Disable edit affordances while a stream is running (pencil, save button). */
  streamingDisabled?: boolean;

  // --- Variants (active turn, user messages) ---
  variantTotal?: number;
  variantIndex?: number;
  variantMessages?: Message[];
  variantModels?: Record<string, string | null>;
  activeVariantId?: string;
  onNavigateVariant?: (direction: -1 | 1, userMessageId: string) => void;
  onSelectVariant?: (variantId: string) => void;

  // --- Retry (last assistant message of the active thread) ---
  showRetry?: boolean;
  onRetry?: () => void;

  // --- Artifacts (per-message chips via message_id association) ---
  linkedArtifacts?: ChatArtifact[];
  onOpenArtifact?: (conversationId: string, artifactId: string) => void;
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
  const isMobile = useIsMobile();
  // On mobile, keep reasoning collapsed by default (even while streaming) to
  // save vertical space; on desktop it auto-expands while streaming as before.
  const [expanded, setExpanded] = React.useState(isStreaming && !isMobile);

  React.useEffect(() => {
    if (isStreaming && !isMobile) {
      setExpanded(true);
    }
  }, [isStreaming, isMobile]);

  if (!content) return null;

  return (
    <div style={{
      marginBottom: '10px',
      borderRadius: 'var(--radius-sm)',
      border: '1px solid var(--border-subtle)',
      background: 'var(--surface-2)',
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
          color: 'var(--text-accent)',
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

function StreamingContentBlock({ content }: { content: string }) {
  if (!content.trim()) return null;
  return (
    <div style={{ marginTop: '2px' }}>
      <MarkdownContent content={content} />
    </div>
  );
}

// Citation links from web search (only annotations whose url passes the shared
// http(s)-only href allowlist; unsafe entries are skipped entirely — FMT8-02)
function CitationLinks({ annotations }: { annotations: Annotation[] }) {
  const withUrl = annotations.filter(
    (a): a is Annotation & { url: string } => !!a.url && isSafeHttpUrl(a.url),
  );
  const unique = dedupeAnnotations(withUrl);
  if (unique.length === 0) return null;

  return (
    <div style={{
      marginTop: '10px',
      padding: '8px 12px',
      background: 'var(--accent-ghost)',
      border: '1px solid var(--border-accent)',
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

export function MessageBubble({
  message,
  isStreaming,
  streamingContent,
  streamingReasoning,
  streamingActivityEvents,
  agentEmoji,
  toolExecutions,
  toolActivityLive,
  showGeneratingIndicator,
  streamingModel,
  streamingProviderRouting,
  isEditing,
  editContent,
  onEditContentChange,
  editOriginalModel,
  relaunchModel,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  streamingDisabled,
  variantTotal,
  variantIndex,
  variantMessages,
  variantModels,
  activeVariantId,
  onNavigateVariant,
  onSelectVariant,
  showRetry,
  onRetry,
  linkedArtifacts,
  onOpenArtifact,
}: MessageBubbleProps) {
  const [copied, setCopied] = React.useState(false);
  const [councilRun, setCouncilRun] = React.useState<CouncilRunDetail | null>(null);
  const isUser = message.role === 'user';
  const displayContent = isStreaming ? (streamingContent || '') : message.content;
  const isCouncilMessage = !isUser && (message.is_council_synthesis === true || !!message.council_run_id);

  // Load council run detail when message has council_run_id (and not streaming)
  React.useEffect(() => {
    if (!message.council_run_id || isStreaming) {
      setCouncilRun(null);
      return;
    }
    let cancelled = false;
    getCouncilRun(message.council_run_id)
      .then((run) => {
        if (!cancelled) setCouncilRun(run);
      })
      .catch(() => {
        if (!cancelled) setCouncilRun(null);
      });
    return () => {
      cancelled = true;
    };
  }, [message.council_run_id, message.id, isStreaming]);

  // Reasoning: use streaming reasoning during stream, or persisted reasoning_content
  const reasoningText = isStreaming ? (streamingReasoning || '') : (message.reasoning_content || '');
  const reasoningTokens = message.reasoning_tokens;

  // Annotations
  const annotations = message.annotations || [];
  const orderedStreamingEvents = streamingActivityEvents || [];
  const hasOrderedStreamingEvents = !!isStreaming && orderedStreamingEvents.length > 0;
  const shouldRenderStandaloneContent = !hasOrderedStreamingEvents;

  const handleCopy = () => {
    navigator.clipboard.writeText(displayContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Variant switcher only makes sense under the ACTIVE variant's user message
  // (ChatView passes the data) — never while streaming or editing.
  const showVariants =
    isUser &&
    !isEditing &&
    !streamingDisabled &&
    variantTotal !== undefined &&
    variantTotal > 1 &&
    variantIndex !== undefined &&
    !!variantMessages &&
    variantMessages.length > 1;

  if (message.role === 'system' || message.role === 'tool') return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
      className={`message-bubble-container ${!isUser ? 'message-bubble-assistant' : ''}`}
    >
      {/* Avatar */}
      <div className="message-bubble-avatar" data-user={isUser ? 'true' : undefined}>
        {isUser ? (
          <User size={16} style={{ color: 'var(--text-secondary)' }} />
        ) : (
          agentEmoji || <Sparkles size={16} style={{ color: 'var(--accent)' }} />
        )}
      </div>

      {/* Content */}
      <div
        className="message-bubble-content"
      >
        {/* Role label */}
        <div className="message-bubble-role-row">
          <div className="message-bubble-role-left">
            <span className={`message-bubble-role-label ${isUser ? 'message-bubble-role-user' : 'message-bubble-role-assistant'}`}>
              {isUser ? 'You' : 'Assistant'}
            </span>
            {!isUser && message.processed_by_agent_id && message.processed_by_agent_name && (
              <motion.span
                className="message-bubble-via-badge"
                initial={{ opacity: 0, scale: 0.9, x: -10 }}
                animate={{ opacity: 1, scale: 1, x: 0 }}
                transition={{ duration: 0.2, delay: 0.1 }}
                title={`Processed by ${message.processed_by_agent_name}`}
              >
                <Sparkles size={10} />
                via {message.processed_by_agent_name}
              </motion.span>
            )}
            {!isUser && (message.model ?? (isStreaming && streamingModel ? streamingModel : null)) && (
              <MessageModelBadge modelId={message.model ?? streamingModel!} />
            )}
            {!isUser && (message.provider_routing ?? (isStreaming ? streamingProviderRouting : null)) && (
              <ProviderRoutingBadge routing={(message.provider_routing ?? streamingProviderRouting)!} />
            )}
            {!isUser && message.is_council_synthesis && (
              <span
                className="message-bubble-model-pill"
                title="This response was synthesized from multiple AI models"
                style={{
                  color: 'var(--accent)',
                  borderColor: 'var(--border-accent)',
                  background: 'var(--accent-ghost)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                <Users size={10} />
                Council
              </span>
            )}
          </div>
          <div className="message-bubble-role-actions">
            {!isUser && displayContent && !isStreaming && (
              <button
                type="button"
                className="message-bubble-copy-btn"
                onClick={handleCopy}
                aria-label={copied ? 'Copied' : 'Copy message'}
                style={{ color: copied ? 'var(--success)' : undefined }}
              >
                {copied ? <Check size={11} /> : <Copy size={11} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            )}
            {!isUser && showRetry && !isStreaming && (
              <button
                type="button"
                className="message-bubble-action-btn"
                onClick={onRetry}
                aria-label="Retry response"
                title="Retry"
              >
                <RotateCcw size={11} />
              </button>
            )}
            {isUser && !isEditing && !isStreaming && !streamingDisabled && (
              <button
                type="button"
                className="message-bubble-action-btn"
                onClick={onStartEdit}
                aria-label="Edit message"
                title="Edit"
              >
                <Pencil size={11} />
                Edit
              </button>
            )}
          </div>
        </div>

        {/* Message body */}
        {isUser ? (
          <>
            <AnimatePresence mode="wait" initial={false}>
              {isEditing ? (
                <motion.div
                  key="edit"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
                >
                  <MessageEditEditor
                    content={editContent ?? ''}
                    onContentChange={onEditContentChange ?? (() => {})}
                    originalModel={editOriginalModel ?? null}
                    relaunchModel={relaunchModel ?? null}
                    disabled={streamingDisabled}
                    onCancel={onCancelEdit ?? (() => {})}
                    onSubmit={onSubmitEdit ?? (() => {})}
                  />
                </motion.div>
              ) : (
                <motion.div
                  key="content"
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 6 }}
                  transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
                >
                  <div style={{
                    fontSize: '0.938rem',
                    lineHeight: 1.7,
                    color: 'var(--text-primary)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}>
                    {displayContent}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            {!isEditing && message.attachments && message.attachments.length > 0 && (
              <div style={{
                marginTop: '8px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                flexWrap: 'wrap',
                fontSize: '0.75rem',
                color: 'var(--text-muted)',
              }}>
                {message.attachments.some((a) => a.deliveredPath) ? (
                  <>
                    <Laptop size={12} style={{ flexShrink: 0 }} />
                    <span>
                      Delivered to your computer: {message.attachments.map((a) => a.filename).join(', ')}
                    </span>
                  </>
                ) : (
                  <>
                    <FileUp size={12} style={{ flexShrink: 0 }} />
                    <span>
                      Attached: {message.attachments.map((a) => a.filename).join(', ')}
                    </span>
                  </>
                )}
              </div>
            )}
            {showVariants && (
              <VariantSelector
                index={variantIndex!}
                total={variantTotal!}
                variants={variantMessages!}
                modelsByVariantId={variantModels ?? {}}
                activeVariantId={activeVariantId}
                onNavigate={(dir) => onNavigateVariant?.(dir, message.id)}
                onSelect={onSelectVariant ?? (() => {})}
                disabled={streamingDisabled}
              />
            )}
          </>
        ) : isCouncilMessage ? (
          <>
            <CouncilMessageView
              content={displayContent}
              reasoningContent={reasoningText || undefined}
              councilRun={councilRun ?? undefined}
              isStreaming={!!isStreaming}
            />
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
            {!isUser && !isStreaming && (
              <MessageTokenPills message={message} />
            )}
          </>
        ) : (
          <div className="message-bubble-body" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {/* Chat-like order: reasoning → tool calls → answer */}
            {hasOrderedStreamingEvents ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {orderedStreamingEvents.map((ev) => (
                  ev.type === 'reasoning' ? (
                    <ReasoningBlock
                      key={ev.id}
                      content={ev.content}
                      isStreaming={true}
                      tokenCount={undefined}
                    />
                  ) : ev.type === 'content' ? (
                    <StreamingContentBlock
                      key={ev.id}
                      content={ev.content}
                    />
                  ) : (
                    <ToolCallTimeline
                      key={ev.id}
                      calls={[ev.tool]}
                      isStreaming={!!toolActivityLive}
                      showHeader={false}
                    />
                  )
                ))}
              </div>
            ) : (
              <>
                {reasoningText && (
                  <ReasoningBlock
                    content={reasoningText}
                    isStreaming={!!isStreaming}
                    tokenCount={reasoningTokens}
                  />
                )}

                {toolExecutions && toolExecutions.length > 0 && (
                  <ToolCallTimeline
                    calls={toolExecutions}
                    isStreaming={!!toolActivityLive}
                    showHeader={true}
                  />
                )}
              </>
            )}

            {shouldRenderStandaloneContent && (
              displayContent ? (
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
              )
            )}

            {showGeneratingIndicator && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                color: 'var(--text-muted)',
                fontSize: '0.75rem',
              }}>
                <span style={{ display: 'flex', gap: '4px' }} aria-hidden="true">
                  {[0, 1, 2].map((i) => (
                    <motion.span
                      key={i}
                      animate={{ opacity: [0.3, 1, 0.3] }}
                      transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }}
                      style={{
                        width: '5px',
                        height: '5px',
                        borderRadius: '50%',
                        background: 'var(--accent)',
                      }}
                    />
                  ))}
                </span>
                <span>generating…</span>
              </div>
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

            {/* Artifact chips (linked via message_id) */}
            {!isUser && linkedArtifacts && linkedArtifacts.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {linkedArtifacts.map((art) => (
                  <button
                    key={art.id}
                    type="button"
                    onClick={() => onOpenArtifact?.(art.conversation_id, art.id)}
                    aria-label={`Open artifact ${art.title}`}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '4px 10px',
                      borderRadius: '9999px',
                      border: '1px solid var(--border-accent)',
                      background: 'var(--accent-ghost)',
                      color: 'var(--accent)',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    <Braces size={12} />
                    <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{art.title || art.kind}</span>
                    <Badge tone="mono" variant="soft">v{art.version}</Badge>
                  </button>
                ))}
              </div>
            )}

            {/* Token/cost pills (always visible) */}
            {!isUser && !isStreaming && (
              <MessageTokenPills message={message} />
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}
