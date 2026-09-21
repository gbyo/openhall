import type { ReactNode } from 'react';
import { Link } from 'react-router';

export function AppFrame({ children }: { children: ReactNode }) {
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
      <div className="app-frame__body">{children}</div>
      <footer className="app-frame__footer">
        <span>WayPass</span>
        <span>Private to your school</span>
      </footer>
    </main>
  );
}
