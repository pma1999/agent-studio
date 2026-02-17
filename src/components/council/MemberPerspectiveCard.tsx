import React, { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, CheckCircle2, XCircle, Clock, Brain, Terminal, Sparkles } from 'lucide-react';
import { ModelAvatar, getModelDisplayName, getProviderName } from './ModelAvatar';
import { CostBadge } from './CostBadge';
import { MarkdownContent } from '../MarkdownContent';
import { ToolCallTimeline } from '../ToolCallTimeline';
import type { CouncilResponse, ToolExecution, ToolSource, ToolCallSpec, ToolResultRecord } from '../../types';

function inferToolSource(name: string): ToolSource {
  if (name.startsWith('mcp_')) return 'mcp';
  if (name === 'web_search' || name === 'get_current_time' || name === 'web_fetch') return 'builtin';
  if (name.startsWith('http_') || name.includes('_http')) return 'http';
  return 'unknown';
}

/** Normalize tool_calls from API (array or JSON string) to ToolCallSpec[]. */
function normalizeToolCalls(raw: CouncilResponse['tool_calls'] | string): ToolCallSpec[] {
  if (Array.isArray(raw) && raw.length > 0) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Normalize tool_results from API to Map<id, content>. */
function normalizeToolResults(raw: CouncilResponse['tool_results']): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(raw) || raw.length === 0) return map;
  for (const r of raw as ToolResultRecord[]) {
    if (r?.id != null && typeof r.content === 'string') map.set(r.id, r.content);
  }
  return map;
}

/**
 * Build ToolExecution[] for council member response (same shape as chat).
 * Uses stored tool_results when available; legacy runs show a short fallback.
 */
function buildCouncilToolExecutions(
  tool_calls: CouncilResponse['tool_calls'],
  tool_results: CouncilResponse['tool_results']
): ToolExecution[] {
  const specs = normalizeToolCalls(tool_calls);
  if (specs.length === 0) return [];
  const resultsById = normalizeToolResults(tool_results);
  const legacyFallback = 'Result was used by the model (not stored in this run).';

  return specs.map((tc) => {
    const name = tc.function?.name || tc.id;
    const stored = resultsById.get(tc.id);
    const hasStoredResult = stored !== undefined && stored !== '';
    return {
      id: tc.id,
      name,
      arguments: tc.function?.arguments || '{}',
      status: 'done' as const,
      result: hasStoredResult ? stored : legacyFallback,
      ok: true,
      source: inferToolSource(name),
    };
  });
}

interface MemberPerspectiveCardProps {
  response: CouncilResponse;
  index: number;
  isExpanded?: boolean;
}

export function MemberPerspectiveCard({
  response,
  index,
  isExpanded: initialExpanded = false,
}: MemberPerspectiveCardProps) {
  const [isExpanded, setIsExpanded] = useState(initialExpanded);
  const [showReasoning, setShowReasoning] = useState(false);

  const toolExecutions = useMemo(
    () => buildCouncilToolExecutions(response.tool_calls, response.tool_results),
    [response.tool_calls, response.tool_results]
  );

  const modelName = getModelDisplayName(response.model_id);
  const providerName = getProviderName(response.model_id);

  const getStatusConfig = () => {
    switch (response.status) {
      case 'success':
        return {
          icon: <CheckCircle2 size={16} />,
          color: '#7ab88f',
          bgColor: 'rgba(122, 184, 143, 0.1)',
          borderColor: 'rgba(122, 184, 143, 0.25)',
          label: 'Success',
        };
      case 'error':
        return {
          icon: <XCircle size={16} />,
          color: '#c96b6b',
          bgColor: 'rgba(201, 107, 107, 0.1)',
          borderColor: 'rgba(201, 107, 107, 0.25)',
          label: 'Error',
        };
      case 'timeout':
        return {
          icon: <Clock size={16} />,
          color: '#d4a557',
          bgColor: 'rgba(212, 165, 87, 0.1)',
          borderColor: 'rgba(212, 165, 87, 0.25)',
          label: 'Timeout',
        };
      default:
        return {
          icon: <Clock size={16} />,
          color: 'var(--text-muted)',
          bgColor: 'var(--bg-elevated)',
          borderColor: 'var(--border)',
          label: 'Pending',
        };
    }
  };

  const status = getStatusConfig();

  // Card entrance animation
  const cardVariants = {
    hidden: {
      opacity: 0,
      y: 20,
      scale: 0.96,
    },
    visible: {
      opacity: 1,
      y: 0,
      scale: 1,
      transition: {
        delay: index * 0.08,
        duration: 0.5,
        ease: [0.16, 1, 0.3, 1],
      },
    },
  };

  if (response.status !== 'success') {
    return (
      <motion.div
        variants={cardVariants}
        initial="hidden"
        animate="visible"
        style={{
          padding: '14px 16px',
          background: status.bgColor,
          border: `1px solid ${status.borderColor}`,
          borderRadius: 'var(--radius-md)',
          borderLeft: `3px solid ${status.color}`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <ModelAvatar modelId={response.model_id} size="sm" status={response.status} />
          <div style={{ flex: 1 }}>
            <div
              style={{
                fontSize: '0.875rem',
                fontWeight: 500,
                color: 'var(--text-primary)',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              {modelName}
              <span
                style={{
                  fontSize: '0.6875rem',
                  padding: '2px 8px',
                  background: status.bgColor,
                  border: `1px solid ${status.borderColor}`,
                  borderRadius: 'var(--radius-sm)',
                  color: status.color,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                {status.icon}
                {status.label}
              </span>
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{providerName}</div>
          </div>
        </div>
        {response.error_message && (
          <div
            style={{
              marginTop: '10px',
              padding: '10px',
              background: 'rgba(201, 107, 107, 0.05)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '0.8125rem',
              color: '#c96b6b',
              fontFamily: 'var(--font-mono)',
            }}
          >
            <Terminal size={12} style={{ marginRight: '6px', display: 'inline' }} />
            {response.error_message}
          </div>
        )}
      </motion.div>
    );
  }

  return (
    <motion.div
      variants={cardVariants}
      initial="hidden"
      animate="visible"
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        borderLeft: '3px solid var(--council-accent)',
        transition: 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      {/* Header - Always visible */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        style={{
          width: '100%',
          padding: '14px 16px',
          background: isExpanded ? 'var(--bg-elevated)' : 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          transition: 'background 0.2s ease',
        }}
      >
        <ModelAvatar modelId={response.model_id} size="md" status="success" />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: '0.9375rem',
              fontWeight: 500,
              color: 'var(--text-primary)',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            {modelName}
            {response.reasoning_content && (
              <span
                style={{
                  fontSize: '0.625rem',
                  padding: '2px 6px',
                  background: 'rgba(212, 165, 87, 0.15)',
                  border: '1px solid rgba(212, 165, 87, 0.25)',
                  borderRadius: 'var(--radius-sm)',
                  color: '#d4a557',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '3px',
                }}
              >
                <Brain size={10} />
                Reasoning
              </span>
            )}
          </div>
          <div
            style={{
              fontSize: '0.75rem',
              color: 'var(--text-muted)',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              marginTop: '2px',
            }}
          >
            <span>{providerName}</span>
            <span style={{ opacity: 0.4 }}>·</span>
            <CostBadge
              cost={response.cost}
              tokens={response.tokens_used}
              variant="compact"
              size="sm"
              animate={false}
            />
            <span style={{ opacity: 0.4 }}>·</span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>
              {response.response_time_ms < 1000
                ? `${response.response_time_ms}ms`
                : `${(response.response_time_ms / 1000).toFixed(1)}s`}
            </span>
          </div>
        </div>

        <motion.div
          animate={{ rotate: isExpanded ? 180 : 0 }}
          transition={{ duration: 0.2 }}
          style={{ color: 'var(--text-muted)', flexShrink: 0 }}
        >
          <ChevronDown size={18} />
        </motion.div>
      </button>

      {/* Expanded Content */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          >
            <div
              style={{
                padding: '16px',
                background: 'var(--bg-base)',
                borderTop: '1px solid var(--border)',
              }}
            >
              {/* Reasoning section (if available) */}
              {response.reasoning_content && (
                <div style={{ marginBottom: '16px' }}>
                  <button
                    onClick={() => setShowReasoning(!showReasoning)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '8px 12px',
                      background: 'rgba(212, 165, 87, 0.08)',
                      border: '1px solid rgba(212, 165, 87, 0.2)',
                      borderRadius: 'var(--radius-sm)',
                      color: '#d4a557',
                      fontSize: '0.8125rem',
                      fontWeight: 500,
                      cursor: 'pointer',
                      marginBottom: showReasoning ? '12px' : 0,
                    }}
                  >
                    <Brain size={14} />
                    Reasoning Process
                    <motion.div animate={{ rotate: showReasoning ? 180 : 0 }} transition={{ duration: 0.2 }}>
                      <ChevronDown size={14} />
                    </motion.div>
                  </button>

                  <AnimatePresence>
                    {showReasoning && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        style={{
                          padding: '12px',
                          background: 'var(--bg-elevated)',
                          borderRadius: 'var(--radius-sm)',
                          borderLeft: '2px solid #d4a557',
                          fontSize: '0.875rem',
                          color: 'var(--text-secondary)',
                          fontStyle: 'italic',
                          lineHeight: 1.6,
                        }}
                      >
                        {response.reasoning_content}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}

              {/* Tool calls (same chat-like order: reasoning → tools → answer) */}
              {toolExecutions.length > 0 && (
                <div style={{ marginBottom: '16px' }}>
                  <ToolCallTimeline
                    calls={toolExecutions}
                    isStreaming={false}
                    showHeader={true}
                  />
                </div>
              )}

              {/* Response content */}
              <div
                style={{
                  fontSize: '0.9375rem',
                  lineHeight: 1.7,
                  color: 'var(--text-primary)',
                }}
              >
                <MarkdownContent content={response.content} />
              </div>

              {/* Technical details footer */}
              <div
                style={{
                  marginTop: '16px',
                  paddingTop: '12px',
                  borderTop: '1px solid var(--border)',
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '12px',
                  fontSize: '0.6875rem',
                  color: 'var(--text-muted)',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                <TechDetail label="Prompt" value={response.prompt_tokens.toLocaleString()} />
                <TechDetail label="Completion" value={response.completion_tokens.toLocaleString()} />
                {response.reasoning_tokens > 0 && (
                  <TechDetail label="Reasoning" value={response.reasoning_tokens.toLocaleString()} />
                )}
                {response.cached_tokens > 0 && (
                  <TechDetail label="Cached" value={response.cached_tokens.toLocaleString()} />
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function TechDetail({ label, value }: { label: string; value: string }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
      <span style={{ opacity: 0.6 }}>{label}:</span>
      <span style={{ color: 'var(--text-secondary)' }}>{value}</span>
    </span>
  );
}

interface PerspectivesGridProps {
  responses: CouncilResponse[];
  defaultExpanded?: boolean;
}

export function PerspectivesGrid({ responses, defaultExpanded = false }: PerspectivesGridProps) {
  const [showAll, setShowAll] = useState(defaultExpanded);

  const successfulResponses = responses.filter(r => r.status === 'success');
  const failedResponses = responses.filter(r => r.status !== 'success');

  return (
    <div style={{ marginTop: '24px' }}>
      {/* Section header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '16px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Sparkles size={16} style={{ color: '#c9956b' }} />
          <span
            style={{
              fontSize: '0.8125rem',
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: '#c9956b',
            }}
          >
            Expert Perspectives
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span
            style={{
              fontSize: '0.6875rem',
              padding: '3px 10px',
              background: 'rgba(122, 184, 143, 0.15)',
              border: '1px solid rgba(122, 184, 143, 0.25)',
              borderRadius: 'var(--radius-sm)',
              color: '#7ab88f',
            }}
          >
            {successfulResponses.length} success
          </span>
          {failedResponses.length > 0 && (
            <span
              style={{
                fontSize: '0.6875rem',
                padding: '3px 10px',
                background: 'rgba(201, 107, 107, 0.15)',
                border: '1px solid rgba(201, 107, 107, 0.25)',
                borderRadius: 'var(--radius-sm)',
                color: '#c96b6b',
              }}
            >
              {failedResponses.length} failed
            </span>
          )}
        </div>
      </div>

      {/* Perspectives grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
          gap: '12px',
        }}
      >
        {responses.map((response, index) => (
          <MemberPerspectiveCard
            key={response.id}
            response={response}
            index={index}
            isExpanded={false}
          />
        ))}
      </div>
    </div>
  );
}
