import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

function FoundationShell() {
  return (
    <main>
      <section aria-labelledby="openhall-title">
        <p className="eyebrow">Foundation build</p>
        <h1 id="openhall-title">OpenHall</h1>
        <p>
          A self-hosted school presence and movement platform. User-facing pass workflows are
          intentionally not part of this foundation release.
        </p>
      </section>
    </main>
  );
}

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Application root element is missing');
createRoot(rootElement).render(
  <StrictMode>
    <FoundationShell />
  </StrictMode>,
);
