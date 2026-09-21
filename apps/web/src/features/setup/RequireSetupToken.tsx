import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useSetup } from './setup-state';

/** Deep links without the in-memory setup code bounce to the unlock screen. */
export function RequireSetupToken({ children }: { children: ReactNode }) {
  const { state } = useSetup();
  const location = useLocation();
  if (!state.unlocked) {
    return <Navigate to="/setup" replace state={{ lockedOut: true, from: location.pathname }} />;
  }
  return children;
}
