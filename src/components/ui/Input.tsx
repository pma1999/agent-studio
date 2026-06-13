import React from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export function Input({ label, error, style, className, ...props }: InputProps) {
  return (
    <div className="form-field">
      {label && <label className="form-field-label">{label}</label>}
      <input
        {...props}
        className={['field-input', className].filter(Boolean).join(' ')}
        data-error={error ? 'true' : undefined}
        style={style}
      />
      {error && <span className="form-field-error">{error}</span>}
    </div>
  );
}
