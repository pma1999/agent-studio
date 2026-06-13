import React from 'react';

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  label?: string;
  options: SelectOption[];
}

export function Select({ label, options, style, className, ...props }: SelectProps) {
  return (
    <div className="form-field">
      {label && <label className="form-field-label">{label}</label>}
      <select
        {...props}
        className={['field-select', className].filter(Boolean).join(' ')}
        style={style}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
