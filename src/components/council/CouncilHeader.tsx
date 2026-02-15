import React from 'react';
import { motion } from 'framer-motion';
import { Building2, CheckCircle2, Users, Sparkles } from 'lucide-react';
import { getModelDisplayName } from './ModelAvatar';
import type { CouncilRunDetail } from '../../types';

interface CouncilHeaderProps {
  councilRun: CouncilRunDetail;
  isComplete?: boolean;
  showProgress?: boolean;
  progress?: number;
}

export function CouncilHeader({
  councilRun,
  isComplete = true,
  showProgress = false,
  progress = 100,
}: CouncilHeaderProps) {
  const successfulResponses = councilRun.responses?.filter(r => r.status === 'success').length || 0;
  const totalResponses = councilRun.responses?.length || 0;
  const synthesizerName = getModelDisplayName(councilRun.synthesizer_model);

  return (
    <div
      style={{
        position: 'relative',
        padding: '16px 20px',
        background: 'var(--council-chamber-gradient)',
        border: '1px solid var(--council-border)',
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
      }}
    >
      {/* Background glow effect */}
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: '200px',
          height: '200px',
          background: 'radial-gradient(circle, rgba(201, 149, 107, 0.15) 0%, transparent 70%)',
          pointerEvents: 'none',
        }}
      />

      {/* Content */}
      <div style={{ position: 'relative', zIndex: 1 }}>
        {/* Top row: Title and status */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            marginBottom: '12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 'var(--radius-md)',
                background: 'linear-gradient(135deg, rgba(201, 149, 107, 0.2) 0%, rgba(201, 149, 107, 0.05) 100%)',
                border: '1px solid var(--council-border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#c9956b',
              }}
            >
              <Building2 size={20} />
            </div>
            <div>
              <div
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: '1.1rem',
                  fontWeight: 500,
                  color: '#e2b886',
                  letterSpacing: '0.02em',
                }}
              >
                Model Council Deliberation
              </div>
              <div
                style={{
                  fontSize: '0.75rem',
                  color: 'var(--text-muted)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                }}
              >
                <Users size={12} />
                {totalResponses} experts consulted
                <span style={{ opacity: 0.5 }}>·</span>
                <Sparkles size={12} />
                Synthesized by {synthesizerName}
              </div>
            </div>
          </div>

          {isComplete && (
            <motion.div
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.3, type: 'spring', stiffness: 200 }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '6px 12px',
                background: 'rgba(122, 184, 143, 0.15)',
                border: '1px solid rgba(122, 184, 143, 0.3)',
                borderRadius: 'var(--radius-md)',
                color: '#7ab88f',
                fontSize: '0.75rem',
                fontWeight: 600,
              }}
            >
              <CheckCircle2 size={14} />
              Complete
            </motion.div>
          )}
        </div>

        {/* Progress bar */}
        {showProgress && (
          <div
            style={{
              height: 3,
              background: 'var(--bg-elevated)',
              borderRadius: 2,
              overflow: 'hidden',
              position: 'relative',
            }}
          >
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${progress}%` }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
              style={{
                height: '100%',
                background: 'linear-gradient(90deg, #c9956b 0%, #e2b886 100%)',
                borderRadius: 2,
                position: 'relative',
              }}
            >
              {/* Shimmer effect */}
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent)',
                  animation: 'progressShine 2s linear infinite',
                }}
              />
            </motion.div>
          </div>
        )}

        {/* Stats row */}
        {isComplete && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '16px',
              marginTop: '12px',
              paddingTop: '12px',
              borderTop: '1px solid var(--border)',
            }}
          >
            <StatItem
              label="Total Cost"
              value={`$${councilRun.total_cost.toFixed(4)}`}
              color="#c9956b"
            />
            <StatItem
              label="Total Tokens"
              value={councilRun.total_tokens.toLocaleString()}
            />
            <StatItem
              label="Successful"
              value={`${successfulResponses}/${totalResponses}`}
              color={successfulResponses === totalResponses ? '#7ab88f' : '#d4a557'}
            />
          </motion.div>
        )}
      </div>
    </div>
  );
}

function StatItem({
  label,
  value,
  color = 'var(--text-secondary)',
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <span
        style={{
          fontSize: '0.625rem',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: 'var(--text-muted)',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '0.875rem',
          fontWeight: 500,
          color,
        }}
      >
        {value}
      </span>
    </div>
  );
}
