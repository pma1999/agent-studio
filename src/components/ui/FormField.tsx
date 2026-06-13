import React from 'react';

interface FormFieldProps {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}

/**
 * FormField — label + control + hint/error wrapper for non-primitive
 * controls (custom selects, toggles, model pickers). Styling in index.css.
 */
export function FormField({ label, hint, error, htmlFor, children, className }: FormFieldProps) {
  return (
    <div className={['form-field', className].filter(Boolean).join(' ')}>
      {label && (
        <label className="form-field-label" htmlFor={htmlFor}>
          {label}
        </label>
      )}
      {children}
      {hint && !error && <span className="form-field-hint">{hint}</span>}
      {error && <span className="form-field-error">{error}</span>}
    </div>
  );
}
