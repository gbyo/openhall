/// <reference types="vite/client" />

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import '@fontsource-variable/public-sans/wght.css';
import './design-system/tokens.css';
import './design-system/reset.css';
import './design-system/typography.css';
import './design-system/motion.css';
import './design-system/utilities.css';
import './design-system/components.css';
import './features/setup/maia-theme.css';
import './features/setup/setup.css';
import './styles.css';
import { queryClient } from './app/query-client';
import { router } from './app/router';
import { onSessionExpired } from './api/session';

const container = document.getElementById('root');
if (container === null) throw new Error('WayPass root element is missing.');
const root = createRoot(container);

onSessionExpired(() => {
  const returnPath = `${window.location.pathname}${window.location.search}`;
  queryClient.clear();
  void router.navigate(`/login?return_path=${encodeURIComponent(returnPath)}`, { replace: true });
});

if (import.meta.env.DEV && window.location.pathname === '/__wayfinder') {
  const { WayfinderReferencePage } =
    await import('./design-system/reference/WayfinderReferencePage');
  root.render(
    <StrictMode>
      <WayfinderReferencePage />
    </StrictMode>,
  );
} else {
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
}
