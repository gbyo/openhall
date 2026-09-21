import { useRef } from 'react';

export interface LogicalCommand<TBody> {
  readonly idempotencyKey: string;
  readonly body: TBody;
  readonly ifMatch: string | null;
}

/**
 * One object per user intent. Network retries reuse the exact key, body, and
 * If-Match until the server outcome is known; a reviewed stale conflict starts
 * a new command instead of silently replaying against a new revision.
 */
export function useLogicalCommand<TBody>() {
  const current = useRef<LogicalCommand<TBody> | null>(null);
  return {
    begin(body: TBody, ifMatch: string | null): LogicalCommand<TBody> {
      current.current = { idempotencyKey: crypto.randomUUID(), body, ifMatch };
      return current.current;
    },
    retry(): LogicalCommand<TBody> | null {
      return current.current;
    },
    clear(): void {
      current.current = null;
    },
  };
}
