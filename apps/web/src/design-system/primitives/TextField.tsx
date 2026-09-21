import type { InputHTMLAttributes } from 'react';
import { Field } from './Field';

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  helperText?: string | undefined;
  error?: string | undefined;
}

export function TextField({
  label,
  helperText,
  error,
  id,
  className = '',
  ...props
}: TextFieldProps) {
  if (!id) throw new Error('TextField requires an id');
  const describedBy = error ? `${id}-error` : helperText ? `${id}-description` : undefined;
  return (
    <Field label={label} htmlFor={id} helperText={helperText} error={error}>
      <input
        {...props}
        id={id}
        className={`wf-input ${className}`.trim()}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy}
      />
    </Field>
  );
}
