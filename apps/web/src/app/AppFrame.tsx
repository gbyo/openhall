import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  SetupAccessBanner,
  formatSetupDeadline,
} from '../design-system/patterns/SetupAccessBanner';
import { sessionQuery } from './queries';

export function AppFrame({ children }: { children: ReactNode }) {
  const { data: session } = useQuery(sessionQuery);
  const setupSession =
    session?.authenticated === true && session.authenticationMethod === 'setup' ? session : null;
  return (
    <main className="app-frame">
      <header className="app-frame__header">
        <Link className="app-wordmark" to="/" aria-label="WayPass home">
          <span className="app-wordmark__route" aria-hidden="true">
            <i />
            <i />
          </span>
          <span>WayPass</span>
        </Link>
        <span className="app-frame__descriptor">School movement, clearly understood</span>
      </header>
      {setupSession ? (
        <div className="px-4 py-2 sm:px-6">
          <SetupAccessBanner
            compact
            deadlineLabel={formatSetupDeadline(setupSession.absoluteExpiresAt)}
          />
        </div>
      ) : null}
      <div className="app-frame__body">{children}</div>
      <footer className="app-frame__footer">
        <span>WayPass</span>
        <span>Private to your school</span>
      </footer>
    </main>
  );
}
