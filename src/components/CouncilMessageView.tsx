import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Building2, Sparkles, ChevronDown, Brain, CheckCircle2 } from 'lucide-react';
import { MarkdownContent } from './MarkdownContent';
import { CouncilHeader } from './council/CouncilHeader';
import { MemberPerspectiveCard } from './council/MemberPerspectiveCard';
import { TotalCostBadge } from './council/CostBadge';
import type { CouncilRunDetail } from '../types';

interface CouncilMessageViewProps {
  content: string;
  reasoningContent?: string;
  councilRun?: CouncilRunDetail;
  isStreaming?: boolean;
}

export function CouncilMessageView({
  content,
  reasoningContent,
  councilRun,
  isStreaming,
}: CouncilMessageViewProps) {
  const [showPerspectives, setShowPerspectives] = useState(false);
  const [showSynthesisReasoning, setShowSynthesisReasoning] = useState(true);

  if (!councilRun) {
    return (
      <div className="markdown-content">
        <MarkdownContent content={content} />
      </div>
    );
  }

  const successfulResponses = councilRun.responses?.filter(r => r.status === 'success') || [];
  const failedResponses = councilRun.responses?.filter(r => r.status !== 'success') || [];
  const synthesizerName = getModelDisplayName(councilRun.synthesizer_model);

  // Calculate duration
  const durationMs = councilRun.completed_at
    ? new Date(councilRun.completed_at).getTime() - new Date(councilRun.started_at).getTime()
    : undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Council Header */}
      <CouncilHeader
        councilRun={councilRun}
        isComplete={!isStreaming}
        durationMs={durationMs}
      />

      {/* Synthesis Section - The Verdict */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        style={{
          position: 'relative',
          background: 'var(--synthesis-gradient)',
          border: '1px solid var(--council-border)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
        }}
      >
        {/* Glow effect */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: '1px',
            background: 'linear-gradient(90deg, transparent, #c9956b, transparent)',
            opacity: 0.5,
          }}
        />

        {/* Synthesis badge */}
        <div
          style={{
            position: 'absolute',
            top: '12px',
            right: '12px',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '6px 12px',
            background: 'rgba(201, 149, 107, 0.15)',
            border: '1px solid rgba(201, 149, 107, 0.3)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          <Sparkles size={14} style={{ color: '#c9956b' }} />
          <span
            style={{
              fontSize: '0.75rem',
              fontWeight: 600,
              color: '#c9956b',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            Consensus Synthesis
          </span>
        </div>

        {/* Synthesis content */}
        <div style={{ padding: '24px' }}>
          {/* Synthesizer info */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              marginBottom: '16px',
              padding: '10px 14px',
              background: 'rgba(201, 149, 107, 0.06)',
              borderRadius: 'var(--radius-md)',
              border: '1px solid rgba(201, 149, 107, 0.15)',
              width: 'fit-content',
            }}
          >
            <Brain size={16} style={{ color: '#c9956b' }} />
            <span style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
              Synthesized by <strong style={{ color: '#e2b886' }}>{synthesizerName}</strong> based on {successfulResponses.length} expert perspectives
            </span>
          </div>

          {/* Synthesis reasoning (if available) */}
          {reasoningContent && (
            <div style={{ marginBottom: '20px' }}>
              <button
                onClick={() => setShowSynthesisReasoning(!showSynthesisReasoning)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '10px 14px',
                  background: 'rgba(212, 165, 87, 0.1)',
                  border: '1px solid rgba(212, 165, 87, 0.2)',
                  borderRadius: 'var(--radius-md)',
                  color: '#d4a557',
                  fontSize: '0.8125rem',
                  fontWeight: 500,
                  cursor: 'pointer',
                  marginBottom: showSynthesisReasoning ? '12px' : 0,
                }}
              >
                <Sparkles size={14} />
                Synthesizer Reasoning
                <motion.div
                  animate={{ rotate: showSynthesisReasoning ? 180 : 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <ChevronDown size={14} />
                </motion.div>
              </button>

              <AnimatePresence>
                {showSynthesisReasoning && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.3 }}
                  >
                    <div
                      style={{
                        padding: '16px',
                        background: 'var(--bg-base)',
                        borderRadius: 'var(--radius-md)',
                        borderLeft: '3px solid #d4a557',
                        fontSize: '0.9375rem',
                        color: 'var(--text-secondary)',
                        fontStyle: 'italic',
                        lineHeight: 1.7,
                      }}
                    >
                      {reasoningContent}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}

          {/* Main synthesis content */}
          <div
            style={{
              fontSize: '0.96875rem',
              lineHeight: 1.75,
              color: 'var(--text-primary)',
            }}
          >
            <MarkdownContent content={content} />
          </div>
        </div>
      </motion.div>

      {/* Expert Perspectives Section - only when show_member_responses is not false */}
      {councilRun.show_member_responses !== false && (
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      >
        {/* Toggle button */}
        <button
          onClick={() => setShowPerspectives(!showPerspectives)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
            padding: '14px 18px',
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'var(--council-border)';
            e.currentTarget.style.background = 'var(--bg-elevated)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'var(--border)';
            e.currentTarget.style.background = 'var(--bg-surface)';
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                background: 'var(--council-bg)',
                border: '1px solid var(--council-border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#c9956b',
              }}
            >
              <Building2 size={16} />
            </div>
            <div>
              <div
                style={{
                  fontSize: '0.9375rem',
                  fontWeight: 500,
                  color: 'var(--text-primary)',
                  textAlign: 'left',
                }}
              >
                Expert Perspectives
              </div>
              <div
                style={{
                  fontSize: '0.75rem',
                  color: 'var(--text-muted)',
                  textAlign: 'left',
                }}
              >
                View individual responses from each council member
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
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
            <motion.div
              animate={{ rotate: showPerspectives ? 180 : 0 }}
              transition={{ duration: 0.2 }}
              style={{ color: 'var(--text-muted)' }}
            >
              <ChevronDown size={20} />
            </motion.div>
          </div>
        </button>

        {/* Perspectives grid */}
        <AnimatePresence>
          {showPerspectives && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
              style={{ overflow: 'hidden' }}
            >
              <div
                style={{
                  marginTop: '16px',
                  padding: '20px',
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-lg)',
                }}
              >
                {/* Section description */}
                <div
                  style={{
                    marginBottom: '20px',
                    padding: '12px 16px',
                    background: 'var(--council-bg)',
                    border: '1px solid var(--council-border)',
                    borderRadius: 'var(--radius-md)',
                    fontSize: '0.875rem',
                    color: 'var(--text-secondary)',
                  }}
                >
                  <CheckCircle2
                    size={14}
                    style={{ display: 'inline', marginRight: '8px', color: '#7ab88f' }}
                  />
                  These are the individual responses from each AI model that contributed to the
                  synthesis above. Click on any card to view the full response and reasoning.
                </div>

                {/* Perspectives grid */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
                    gap: '12px',
                  }}
                >
                  {councilRun.responses?.map((response, index) => (
                    <MemberPerspectiveCard
                      key={response.id}
                      response={response}
                      index={index}
                      isExpanded={false}
                    />
                  ))}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
      )}

      {/* Summary footer */}
      {durationMs && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6 }}
        >
          <TotalCostBadge
            totalCost={councilRun.total_cost}
            totalTokens={councilRun.total_tokens}
            memberCount={councilRun.member_count}
            durationMs={durationMs}
          />
        </motion.div>
      )}
    </div>
  );
}

// Helper function
function getModelDisplayName(modelId: string): string {
  const parts = modelId.split('/');
  const name = parts[parts.length - 1] || modelId;
  return name
    .replace(/-instruct$/, '')
    .replace(/-preview$/, '')
    .replace(/-latest$/, '')
    .replace(/-exp$/, '')
    .replace(/-fast$/, '');
}
