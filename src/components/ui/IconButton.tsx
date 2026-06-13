import React from 'react';

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible label (required) — also used as the title tooltip by default. */
  label: string;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'ghost' | 'solid' | 'accent' | 'danger' | 'primary';
  className?: string;
}

/**
 * IconButton — square icon-only button. Replaces the hand-rolled
 * onMouseEnter/onMouseLeave hover handlers scattered across the app.
 * States live in index.css (.icon-btn + data-size/data-variant).
 */
export function IconButton({
  label,
  size = 'md',
  variant = 'ghost',
  children,
  style,
  className,
  title,
  type,
  ...props
}: IconButtonProps) {
  return (
    <button
      {...props}
      type={type ?? 'button'}
      className={['icon-btn', className].filter(Boolean).join(' ')}
      data-size={size}
      data-variant={variant}
      aria-label={label}
      title={title ?? label}
      style={style}
    >
      {children}
    </button>
  );
}
