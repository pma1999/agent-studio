import React, { useEffect, useState } from 'react';
import { DollarSign, Clock, Cpu } from 'lucide-react';

interface CostBadgeProps {
  cost: number;
  tokens?: number;
  timeMs?: number;
  variant?: 'compact' | 'full' | 'minimal';
  size?: 'sm' | 'md';
  animate?: boolean;
}

export function CostBadge({
  cost,
  tokens,
  timeMs,
  variant = 'compact',
  size = 'sm',
  animate = true,
}: CostBadgeProps) {
  const [displayCost, setDisplayCost] = useState(0);

  useEffect(() => {
    if (!animate) {
      setDisplayCost(cost);
      return;
    }

    const duration = 600;
    const startTime = Date.now();
    const startValue = displayCost;

    const animateValue = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = startValue + (cost - startValue) * eased;

      setDisplayCost(current);

      if (progress < 1) {
        requestAnimationFrame(animateValue);
      }
    };

    requestAnimationFrame(animateValue);
  }, [cost, animate]);

  const formatCost = (c: number) => {
    if (c === 0) return '$0.0000';
    if (c < 0.01) return `$${c.toFixed(4)}`;
    if (c < 0.1) return `$${c.toFixed(3)}`;
    return `$${c.toFixed(2)}`;
  };

  const formatTokens = (t?: number) => {
    if (!t) return '0';
    if (t < 1000) return t.toString();
    return `${(t / 1000).toFixed(1)}k`;
  };

  const formatTime = (ms?: number) => {
    if (!ms) return '0s';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const baseStyles = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: size === 'sm' ? '4px' : '6px',
    fontFamily: 'var(--font-mono)',
    fontSize: size === 'sm' ? '0.6875rem' : '0.75rem',
    padding: size === 'sm' ? '2px 8px' : '4px 10px',
    borderRadius: 'var(--radius-sm)',
    background: 'rgba(201, 149, 107, 0.08)',
    border: '1px solid rgba(201, 149, 107, 0.2)',
    color: '#c9956b',
    transition: 'all 0.2s ease',
  };

  if (variant === 'minimal') {
    return (
      <span style={baseStyles}>
        <DollarSign size={size === 'sm' ? 10 : 12} />
        {formatCost(displayCost)}
      </span>
    );
  }

  if (variant === 'compact') {
    return (
      <span style={baseStyles}>
        <DollarSign size={size === 'sm' ? 10 : 12} />
        {formatCost(displayCost)}
        {tokens !== undefined && (
          <>
            <span style={{ opacity: 0.5, margin: '0 2px' }}>·</span>
            <Cpu size={size === 'sm' ? 10 : 12} />
            {formatTokens(tokens)}
          </>
        )}
      </span>
    );
  }

  // Full variant
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '6px 12px',
        background: 'rgba(201, 149, 107, 0.06)',
        border: '1px solid rgba(201, 149, 107, 0.15)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      <span style={{ ...baseStyles, background: 'transparent', border: 'none', padding: 0 }}>
        <DollarSign size={12} />
        {formatCost(displayCost)}
      </span>
      {tokens !== undefined && (
        <span style={{ ...baseStyles, background: 'transparent', border: 'none', padding: 0, color: 'var(--text-muted)' }}>
          <Cpu size={12} />
          {formatTokens(tokens)} tokens
        </span>
      )}
      {timeMs !== undefined && (
        <span style={{ ...baseStyles, background: 'transparent', border: 'none', padding: 0, color: 'var(--text-muted)' }}>
          <Clock size={12} />
          {formatTime(timeMs)}
        </span>
      )}
    </div>
  );
}

interface TotalCostBadgeProps {
  totalCost: number;
  totalTokens: number;
  memberCount: number;
  durationMs?: number;
}

export function TotalCostBadge({
  totalCost,
  totalTokens,
  memberCount,
  durationMs,
}: TotalCostBadgeProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        padding: '10px 16px',
        background: 'var(--synthesis-gradient)',
        border: '1px solid var(--council-border)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <span style={{ fontSize: '0.625rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
          Total Cost
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '1rem', fontWeight: 600, color: '#c9956b' }}>
          ${totalCost.toFixed(4)}
        </span>
      </div>

      <div style={{ width: 1, height: 24, background: 'var(--border)' }} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <span style={{ fontSize: '0.625rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
          Tokens
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
          {totalTokens.toLocaleString()}
        </span>
      </div>

      <div style={{ width: 1, height: 24, background: 'var(--border)' }} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <span style={{ fontSize: '0.625rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
          Experts
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
          {memberCount}
        </span>
      </div>

      {durationMs && (
        <>
          <div style={{ width: 1, height: 24, background: 'var(--border)' }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <span style={{ fontSize: '0.625rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
              Duration
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
              {durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
