import React from 'react';

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Use only when the card IS the interaction (hover/focus affordance). */
  interactive?: boolean;
  selected?: boolean;
}

/** Card — bordered surface. Styling in index.css (.card). */
export function Card({ interactive, selected, children, style, className, ...props }: CardProps) {
  return (
    <div
      {...props}
      className={['card', className].filter(Boolean).join(' ')}
      data-interactive={interactive ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      style={style}
    >
      {children}
    </div>
  );
}
