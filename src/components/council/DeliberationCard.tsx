import React from 'react';
import { motion } from 'framer-motion';
import { CheckCircle2, XCircle, Clock, Loader2 } from 'lucide-react';
import { ModelAvatar, getModelDisplayName } from './ModelAvatar';

interface DeliberationCardProps {
  modelId: string;
  status: 'pending' | 'running' | 'complete' | 'error';
  progress?: number;
  responseTimeMs?: number;
  index: number;
}

export function DeliberationCard({
  modelId,
  status,
  progress,
  responseTimeMs,
  index,
}: DeliberationCardProps) {
  const modelName = getModelDisplayName(modelId);

  const getStatusIcon = () => {
    switch (status) {
      case 'complete':
        return <CheckCircle2 size={16} style={{ color: '#7ab88f' }} />;
      case 'error':
        return <XCircle size={16} style={{ color: '#c96b6b' }} />;
      case 'running':
        return (
          <Loader2
            size={16}
            style={{
              color: '#c9956b',
              animation: 'spin 1.5s linear infinite',
            }}
          />
        );
      default:
        return <Clock size={16} style={{ color: 'var(--text-muted)' }} />;
    }
  };

  const getStatusColor = () => {
    switch (status) {
      case 'complete':
        return '#7ab88f';
      case 'error':
        return '#c96b6b';
      case 'running':
        return '#c9956b';
      default:
        return 'var(--text-muted)';
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{
        delay: index * 0.1,
        duration: 0.4,
        ease: [0.16, 1, 0.3, 1],
      }}
      style={{
        padding: '16px',
        background:
          status === 'running'
            ? 'linear-gradient(135deg, rgba(201, 149, 107, 0.12) 0%, rgba(201, 149, 107, 0.04) 100%)'
            : 'var(--bg-surface)',
        border: `1px solid ${
          status === 'running' ? 'var(--council-border)' : 'var(--border)'
        }`,
        borderRadius: 'var(--radius-md)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '10px',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Progress indicator for running state */}
      {status === 'running' && progress !== undefined && (
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            height: '2px',
            width: `${progress}%`,
            background: 'linear-gradient(90deg, #c9956b, #e2b886)',
            transition: 'width 0.3s ease',
          }}
        />
      )}

      {/* Pulsing glow for running state */}
      {status === 'running' && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'radial-gradient(circle at center, rgba(201, 149, 107, 0.1) 0%, transparent 70%)',
            animation: 'councilPulse 2s ease-in-out infinite',
            pointerEvents: 'none',
          }}
        />
      )}

      <ModelAvatar
        modelId={modelId}
        size="lg"
        status={
          status === 'complete'
            ? 'success'
            : status === 'error'
              ? 'error'
              : status === 'running'
                ? 'running'
                : 'pending'
        }
        showGlow={status === 'running'}
      />

      <div
        style={{
          fontSize: '0.8125rem',
          fontWeight: 500,
          color: 'var(--text-primary)',
          textAlign: 'center',
          maxWidth: '100%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {modelName}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          fontSize: '0.6875rem',
          color: getStatusColor(),
          fontWeight: status === 'running' ? 500 : 400,
        }}
      >
        {getStatusIcon()}
        <span style={{ textTransform: 'capitalize' }}>{status}</span>
      </div>

      {responseTimeMs !== undefined && status === 'complete' && (
        <div
          style={{
            fontSize: '0.625rem',
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {responseTimeMs < 1000
            ? `${responseTimeMs}ms`
            : `${(responseTimeMs / 1000).toFixed(1)}s`}
        </div>
      )}
    </motion.div>
  );
}
