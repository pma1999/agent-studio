import React from 'react';

interface ViewHeaderProps {
  icon?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

/**
 * ViewHeader — shared slim header for management views (Agents / Councils /
 * Tools / MCP). Not a hero: small chip + serif title + one orientation line
 * + right-aligned actions. Styling in index.css (.view-header).
 */
export function ViewHeader({ icon, title, subtitle, actions, className }: ViewHeaderProps) {
  return (
    <div className={['view-header', className].filter(Boolean).join(' ')}>
      <div className="view-header-titles">
        <div className="view-header-title-row">
          {icon && <span className="view-header-chip">{icon}</span>}
          <h1 className="view-header-title">{title}</h1>
        </div>
        {subtitle && <p className="view-header-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="view-header-actions">{actions}</div>}
    </div>
  );
}
