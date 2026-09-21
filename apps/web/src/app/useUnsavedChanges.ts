import { useEffect } from 'react';
import { useBlocker } from 'react-router';

/** Protect local configuration drafts across in-app navigation and browser unload. */
export function useUnsavedChanges(dirty: boolean): void {
  const blocker = useBlocker(dirty);

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [dirty]);

  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (window.confirm('Leave without saving your changes?')) blocker.proceed();
    else blocker.reset();
  }, [blocker]);
}
