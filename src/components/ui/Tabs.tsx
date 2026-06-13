import React from 'react';

interface TabItem {
  value: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
}

interface TabsProps {
  tabs: TabItem[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

/** Tabs — underline tab strip. Styling in index.css (.tabs-list / .tab). */
export function Tabs({ tabs, value, onChange, className }: TabsProps) {
  return (
    <div className={['tabs-list', className].filter(Boolean).join(' ')} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={value === t.value}
          className="tab"
          onClick={() => onChange(t.value)}
        >
          {t.icon}
          {t.label}
        </button>
      ))}
    </div>
  );
}
