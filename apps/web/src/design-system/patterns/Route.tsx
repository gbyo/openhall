import type { ReactNode } from 'react';

export type RouteStopEvidence = 'recorded' | 'intended';

export interface RouteStopProps {
  label: string;
  evidence: RouteStopEvidence;
  detail?: string;
  time?: string;
  last?: boolean;
}

export function RouteStop({ label, evidence, detail, time, last = false }: RouteStopProps) {
  return (
    <li className={`wf-route-stop wf-route-stop--${evidence}`}>
      <span className="wf-route-stop__track" aria-hidden="true">
        <span className="wf-route-stop__marker">{evidence === 'recorded' ? '✓' : ''}</span>
        {!last && <span className="wf-route-stop__line" />}
      </span>
      <span className="wf-route-stop__content">
        <span className="wf-route-stop__label">{label}</span>
        <span className="wf-route-stop__evidence">
          {detail ?? (evidence === 'recorded' ? 'Recorded' : 'Intended')}
        </span>
      </span>
      {time && <time className="wf-route-stop__time wf-tabular">{time}</time>}
    </li>
  );
}

export interface RouteProps {
  label?: string;
  children: ReactNode;
}

export function Route({ label = 'Pass route', children }: RouteProps) {
  return (
    <ol className="wf-route" aria-label={label}>
      {children}
    </ol>
  );
}
