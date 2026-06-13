import React from 'react';

interface SurfaceProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Elevation level → --surface-0..3 */
  level?: 0 | 1 | 2 | 3;
  bordered?: boolean;
  inset?: boolean;
}

/** Surface / Panel — elevation-aware container. Styling in index.css (.surface). */
export function Surface({ level = 1, bordered, inset, children, style, className, ...props }: SurfaceProps) {
  return (
    <div
      {...props}
      className={['surface', className].filter(Boolean).join(' ')}
      data-level={level}
      data-bordered={bordered ? 'true' : undefined}
      data-inset={inset ? 'true' : undefined}
      style={style}
    >
      {children}
    </div>
  );
}
