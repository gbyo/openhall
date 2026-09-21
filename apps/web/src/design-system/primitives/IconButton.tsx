import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-label'
> {
  'aria-label': string;
  children: ReactNode;
}

export function IconButton({ className = '', children, ...props }: IconButtonProps) {
  return (
    <button {...props} className={`wf-icon-button ${className}`.trim()}>
      {children}
    </button>
  );
}
