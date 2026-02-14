import React from 'react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: React.ReactNode;
  loading?: boolean;
  className?: string;
}

const styles: Record<string, React.CSSProperties> = {
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    fontFamily: 'var(--font-body)',
    fontWeight: 500,
    borderRadius: 'var(--radius-md)',
    border: '1px solid transparent',
    cursor: 'pointer',
    transition: 'all var(--transition-fast)',
    whiteSpace: 'nowrap',
    lineHeight: 1,
    position: 'relative',
    overflow: 'hidden',
  },
};

const variantStyles: Record<string, React.CSSProperties> = {
  primary: {
    background: 'var(--accent)',
    color: 'var(--text-inverse)',
    border: '1px solid var(--accent)',
  },
  secondary: {
    background: 'var(--bg-elevated)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border)',
  },
  ghost: {
    background: 'transparent',
    color: 'var(--text-secondary)',
    border: '1px solid transparent',
  },
  danger: {
    background: 'rgba(201, 107, 107, 0.1)',
    color: 'var(--error)',
    border: '1px solid rgba(201, 107, 107, 0.2)',
  },
};

const sizeStyles: Record<string, React.CSSProperties> = {
  sm: { fontSize: '0.8125rem', padding: '6px 12px', height: '32px' },
  md: { fontSize: '0.875rem', padding: '8px 16px', height: '38px' },
  lg: { fontSize: '0.9375rem', padding: '10px 20px', height: '44px' },
};

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  loading,
  children,
  disabled,
  style,
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      className={[variant === 'primary' ? 'btn-primary-action' : '', className].filter(Boolean).join(' ') || undefined}
      disabled={disabled || loading}
      style={{
        ...styles.base,
        ...variantStyles[variant],
        ...sizeStyles[size],
        opacity: disabled || loading ? 0.5 : 1,
        cursor: disabled || loading ? 'not-allowed' : 'pointer',
        ...style,
      }}
      onMouseEnter={(e) => {
        if (!disabled && !loading) {
          const target = e.currentTarget;
          if (variant === 'primary') {
            target.style.background = 'var(--accent-hover)';
            target.style.borderColor = 'var(--accent-hover)';
            target.style.boxShadow = 'var(--shadow-glow)';
          } else if (variant === 'ghost') {
            target.style.background = 'var(--bg-hover)';
            target.style.color = 'var(--text-primary)';
          } else if (variant === 'danger') {
            target.style.background = 'rgba(201, 107, 107, 0.2)';
          } else {
            target.style.background = 'var(--bg-hover)';
            target.style.borderColor = 'var(--border-light)';
          }
        }
        props.onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        const target = e.currentTarget;
        Object.assign(target.style, variantStyles[variant]);
        target.style.boxShadow = '';
        props.onMouseLeave?.(e);
      }}
    >
      {loading ? (
        <span style={{ display: 'inline-flex', animation: 'pulse 1.5s ease-in-out infinite' }}>
          {icon || '⏳'}
        </span>
      ) : icon ? (
        <span style={{ display: 'inline-flex', flexShrink: 0 }}>{icon}</span>
      ) : null}
      {children}
    </button>
  );
}
