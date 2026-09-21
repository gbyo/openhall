import type { ReactNode } from 'react';

export interface PassCardProps {
  context: string;
  title: string;
  supporting?: ReactNode;
  children?: ReactNode;
  primaryAction?: ReactNode;
  secondaryAction?: ReactNode;
  tone?: 'neutral' | 'queued' | 'ready' | 'active' | 'complete';
}

export function PassCard({
  context,
  title,
  supporting,
  children,
  primaryAction,
  secondaryAction,
  tone = 'neutral',
}: PassCardProps) {
  return (
    <article className={`wf-pass-card wf-pass-card--${tone}`}>
      <header className="wf-pass-card__header">
        <p className="wf-pass-card__context">{context}</p>
        <h1 className="wf-pass-card__title">{title}</h1>
        {supporting && <div className="wf-pass-card__supporting">{supporting}</div>}
      </header>
      {children && <div className="wf-pass-card__content">{children}</div>}
      {(primaryAction != null || secondaryAction != null) && (
        <footer className="wf-pass-card__actions">
          {primaryAction}
          {secondaryAction}
        </footer>
      )}
    </article>
  );
}
