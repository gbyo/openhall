import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router';

/** Shared contract for Questionnaire step content: validate local fields,
 * commit drafts to setup memory, and report whether advancing is allowed. */
export interface StepHandle {
  validateAndCommit: () => boolean;
}

export interface SetupLayoutProps {
  kicker?: string | undefined;
  children: ReactNode;
}

/** Quiet white canvas with a focused column. Step progression, progress, and
 * focus transfer belong to Questionnaire; this shell never navigates. */
export function SetupLayout({ kicker, children }: SetupLayoutProps) {
  return (
    <main className="setup-page">
      <div className="setup-column">
        <p className="setup-brand">
          <Link to="/setup" aria-label="WayPass setup">
            WayPass
          </Link>
        </p>
        {kicker ? <p className="setup-kicker">{kicker}</p> : null}
        {children}
      </div>
    </main>
  );
}

export function useFocusField(fieldId: string | null): void {
  useEffect(() => {
    if (fieldId === null) return;
    document.getElementById(fieldId)?.focus({ preventScroll: true });
  }, [fieldId]);
}
