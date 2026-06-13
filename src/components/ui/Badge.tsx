import React from 'react';

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'mono';
  variant?: 'soft' | 'outline';
  className?: string;
}

/** Badge / Pill — tone-driven label chip. Styling in index.css (.badge). */
export function Badge({ tone = 'neutral', variant = 'soft', children, style, className, ...props }: BadgeProps) {
  return (
    <span
      {...props}
      className={['badge', className].filter(Boolean).join(' ')}
      data-tone={tone}
      data-variant={variant}
      style={style}
    >
      {children}
    </span>
  );
}
