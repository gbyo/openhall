import type { ReactNode } from 'react';

export interface AlertProps {
  tone?: 'information' | 'warning' | 'danger';
  title?: string;
  children: ReactNode;
  role?: 'alert' | 'status';
}

export function Alert({ tone = 'information', title, children, role }: AlertProps) {
  return (
    <div className={`wf-alert wf-alert--${tone}`} role={role}>
      <span className="wf-alert__marker" aria-hidden="true" />
      <div>
        {title && <p className="wf-type-body-strong">{title}</p>}
        <div className="wf-alert__content">{children}</div>
      </div>
    </div>
  );
}
