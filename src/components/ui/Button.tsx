import React from 'react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: React.ReactNode;
  loading?: boolean;
  className?: string;
}

/**
 * Button — styling lives in index.css (.btn + data-variant/data-size).
 * All interactive states (hover/active/focus-visible/disabled) are real
 * CSS pseudo-classes. The caller's `style`/`className` are merged last so
 * inline overrides keep winning over the class rules.
 */
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
  const classes = ['btn', variant === 'primary' ? 'btn-primary-action' : '', className]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      {...props}
      className={classes}
      data-variant={variant}
      data-size={size}
      data-loading={loading ? 'true' : undefined}
      disabled={disabled || loading}
      style={style}
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
