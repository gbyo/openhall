import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';
type ButtonSize = 'compact' | 'standard';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  pending?: boolean;
  pendingLabel?: string;
  children: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'standard',
  pending = false,
  pendingLabel = 'Working…',
  disabled,
  className = '',
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      className={`wf-button wf-button--${variant} wf-button--${size} ${className}`.trim()}
      disabled={disabled === true || pending}
      aria-busy={pending || undefined}
    >
      <span
        className={
          pending ? 'wf-button__content wf-button__content--pending' : 'wf-button__content'
        }
      >
        {children}
      </span>
      {pending && <span className="wf-button__pending">{pendingLabel}</span>}
    </button>
  );
}
