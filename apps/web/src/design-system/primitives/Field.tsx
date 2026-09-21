import type { ReactNode } from 'react';

export interface FieldProps {
  label: string;
  htmlFor: string;
  helperText?: string | undefined;
  error?: string | undefined;
  children: ReactNode;
  className?: string;
}

export function Field({ label, htmlFor, helperText, error, children, className = '' }: FieldProps) {
  return (
    <div className={`wf-field ${className}`.trim()}>
      <label className="wf-field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {helperText && !error && (
        <p className="wf-field__helper" id={`${htmlFor}-description`}>
          {helperText}
        </p>
      )}
      {error && (
        <p className="wf-field__error" id={`${htmlFor}-error`} role="alert">
          <span aria-hidden="true">! </span>
          {error}
        </p>
      )}
    </div>
  );
}
