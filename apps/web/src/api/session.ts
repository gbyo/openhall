let csrfToken: string | null = null;
let expiredHandler: (() => void) | null = null;

export function setCsrfToken(value: string): void {
  csrfToken = value;
}

export function getCsrfToken(): string {
  if (csrfToken === null) throw new Error('Authenticated command attempted without a CSRF token.');
  return csrfToken;
}

export function clearSessionMemory(): void {
  csrfToken = null;
}

export function onSessionExpired(handler: () => void): () => void {
  expiredHandler = handler;
  return () => {
    if (expiredHandler === handler) expiredHandler = null;
  };
}

export function signalSessionExpired(): void {
  clearSessionMemory();
  expiredHandler?.();
}
