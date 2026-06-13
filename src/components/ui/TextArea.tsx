import React from 'react';

interface TextAreaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
}

export function TextArea({ label, error, style, className, ...props }: TextAreaProps) {
  return (
    <div className="form-field">
      {label && <label className="form-field-label">{label}</label>}
      <textarea
        {...props}
        className={['field-textarea', className].filter(Boolean).join(' ')}
        data-error={error ? 'true' : undefined}
        style={style}
      />
      {error && <span className="form-field-error">{error}</span>}
    </div>
  );
}
