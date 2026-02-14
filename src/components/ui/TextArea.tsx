import React from 'react';

interface TextAreaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
}

const textareaStyle: React.CSSProperties = {
  width: '100%',
  minWidth: 0,
  padding: '10px 14px',
  fontSize: '0.875rem',
  fontFamily: 'var(--font-body)',
  background: 'var(--bg-surface)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  outline: 'none',
  transition: 'border-color var(--transition-fast), box-shadow var(--transition-fast)',
  lineHeight: 1.6,
  resize: 'vertical',
  minHeight: '80px',
};

export function TextArea({ label, error, style, ...props }: TextAreaProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 }}>
      {label && (
        <label style={{
          fontSize: '0.8125rem',
          fontWeight: 500,
          color: 'var(--text-secondary)',
          fontFamily: 'var(--font-body)',
          letterSpacing: '0.02em',
        }}>
          {label}
        </label>
      )}
      <textarea
        {...props}
        style={{
          ...textareaStyle,
          borderColor: error ? 'var(--error)' : 'var(--border)',
          ...style,
        }}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = 'var(--accent)';
          e.currentTarget.style.boxShadow = '0 0 0 3px var(--accent-muted)';
          props.onFocus?.(e);
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = error ? 'var(--error)' : 'var(--border)';
          e.currentTarget.style.boxShadow = 'none';
          props.onBlur?.(e);
        }}
      />
      {error && (
        <span style={{ fontSize: '0.75rem', color: 'var(--error)' }}>{error}</span>
      )}
    </div>
  );
}
