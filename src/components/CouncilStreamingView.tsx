import React from 'react';
import { motion } from 'framer-motion';
import { Building2, Brain, Loader2, Sparkles } from 'lucide-react';
import { DeliberationCard } from './council/DeliberationCard';
import { getModelDisplayName } from './council/ModelAvatar';

interface CouncilStreamingViewProps {
  memberProgress: Map<number, {
    status: 'pending' | 'running' | 'complete' | 'error';
    modelId: string;
    progress?: number;
  }>;
  synthesisPhase: boolean;
  synthesisModel?: string;
  streamingContent: string;
}

export function CouncilStreamingView({
  memberProgress,
  synthesisPhase,
  synthesisModel,
  streamingContent,
}: CouncilStreamingViewProps) {
  const entries = Array.from(memberProgress.entries()).sort((a, b) => a[0] - b[0]);
  const totalMembers = entries.length;
  const completedMembers = entries.filter(
    ([_, p]) => p.status === 'complete' || p.status === 'error'
  ).length;
  const progress = totalMembers > 0 ? (completedMembers / totalMembers) * 100 : 0;

  return (
    <div
      style={{
        position: 'relative',
        padding: '24px',
        background: 'var(--council-chamber-gradient)',
        border: '1px solid var(--council-border)',
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
      }}
    >
      {/* Ambient glow */}
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: '300px',
          height: '300px',
          background:
            'radial-gradient(circle, rgba(201, 149, 107, 0.12) 0%, transparent 60%)',
          pointerEvents: 'none',
          animation: 'councilGlow 4s ease-in-out infinite',
        }}
      />

      {/* Content */}
      <div style={{ position: 'relative', zIndex: 1 }}>
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '16px',
            marginBottom: '24px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 'var(--radius-md)',
                background:
                  'linear-gradient(135deg, rgba(201, 149, 107, 0.2) 0%, rgba(201, 149, 107, 0.08) 100%)',
                border: '1px solid var(--council-border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#c9956b',
                animation: synthesisPhase ? 'councilPulse 2s ease-in-out infinite' : 'none',
              }}
            >
              {synthesisPhase ? (
                <Brain size={22} />
              ) : (
                <Building2 size={22} />
              )}
            </div>
            <div>
              <div
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: '1.15rem',
                  fontWeight: 500,
                  color: '#e2b886',
                  letterSpacing: '0.02em',
                }}
              >
                {synthesisPhase
                  ? 'Synthesizing Perspectives'
                  : 'Council in Deliberation'}
              </div>
              <div
                style={{
                  fontSize: '0.8125rem',
                  color: 'var(--text-muted)',
                  marginTop: '2px',
                }}
              >
                {synthesisPhase
                  ? `Creating consensus from ${completedMembers} expert responses`
                  : `Consulting ${totalMembers} models (${completedMembers}/${totalMembers} complete)`}
              </div>
            </div>
          </div>

          {/* Status indicator */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '8px 14px',
              background: synthesisPhase
                ? 'rgba(201, 149, 107, 0.15)'
                : 'rgba(122, 184, 143, 0.15)',
              border: `1px solid ${
                synthesisPhase
                  ? 'rgba(201, 149, 107, 0.3)'
                  : 'rgba(122, 184, 143, 0.3)'
              }`,
              borderRadius: 'var(--radius-md)',
            }}
          >
            <Loader2
              size={14}
              style={{
                color: synthesisPhase ? '#c9956b' : '#7ab88f',
                animation: 'spin 1.5s linear infinite',
              }}
            />
            <span
              style={{
                fontSize: '0.75rem',
                fontWeight: 500,
                color: synthesisPhase ? '#c9956b' : '#7ab88f',
              }}
            >
              {synthesisPhase ? 'Synthesizing' : 'Deliberating'}
            </span>
          </div>
        </div>

        {/* Progress bar */}
        {!synthesisPhase && (
          <div
            style={{
              height: '4px',
              background: 'var(--bg-elevated)',
              borderRadius: '2px',
              overflow: 'hidden',
              marginBottom: '24px',
              position: 'relative',
            }}
          >
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${progress}%` }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
              style={{
                height: '100%',
                background: 'linear-gradient(90deg, #7ab88f 0%, #c9956b 100%)',
                borderRadius: '2px',
                position: 'relative',
              }}
            >
              {/* Shimmer effect */}
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background:
                    'linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent)',
                  animation: 'progressShine 2s linear infinite',
                }}
              />
            </motion.div>
          </div>
        )}

        {/* Deliberation Grid */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
            gap: '12px',
            marginBottom: synthesisPhase ? '20px' : 0,
          }}
        >
          {entries.map(([index, member]) => (
            <DeliberationCard
              key={index}
              modelId={member.modelId}
              status={member.status}
              progress={member.progress}
              index={index}
            />
          ))}
        </div>

        {/* Synthesis Section */}
        {synthesisPhase && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            style={{
              marginTop: '24px',
              padding: '20px',
              background:
                'linear-gradient(135deg, rgba(201, 149, 107, 0.12) 0%, rgba(201, 149, 107, 0.04) 100%)',
              border: '1px solid var(--council-border)',
              borderRadius: 'var(--radius-md)',
              position: 'relative',
            }}
          >
            {/* Synthesis header */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                marginBottom: streamingContent ? '16px' : 0,
              }}
            >
              <Sparkles size={16} style={{ color: '#c9956b' }} />
              <span
                style={{
                  fontSize: '0.8125rem',
                  fontWeight: 600,
                  color: '#c9956b',
                }}
              >
                {synthesisModel
                  ? `Synthesizing with ${getModelDisplayName(synthesisModel)}`
                  : 'Creating synthesis...'}
              </span>
            </div>

            {/* Streaming content preview */}
            {streamingContent && (
              <div
                style={{
                  position: 'relative',
                  padding: '16px',
                  background: 'var(--bg-base)',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: '0.9375rem',
                  lineHeight: 1.7,
                  color: 'var(--text-secondary)',
                  maxHeight: '200px',
                  overflow: 'hidden',
                }}
              >
                {streamingContent}
                {/* Fade gradient */}
                <div
                  style={{
                    position: 'absolute',
                    bottom: 0,
                    left: 0,
                    right: 0,
                    height: '60px',
                    background:
                      'linear-gradient(to bottom, transparent, var(--bg-base))',
                    pointerEvents: 'none',
                  }}
                />
              </div>
            )}

            {/* Animated typing indicator */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                marginTop: '12px',
              }}
            >
              <div style={{ display: 'flex', gap: '4px' }}>
                {[0, 1, 2].map((i) => (
                  <motion.div
                    key={i}
                    animate={{
                      scale: [1, 1.2, 1],
                      opacity: [0.5, 1, 0.5],
                    }}
                    transition={{
                      duration: 1,
                      repeat: Infinity,
                      delay: i * 0.15,
                    }}
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: '#c9956b',
                    }}
                  />
                ))}
              </div>
              <span
                style={{
                  fontSize: '0.75rem',
                  color: 'var(--text-muted)',
                  fontStyle: 'italic',
                }}
              >
                Crafting consensus response...
              </span>
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
}
