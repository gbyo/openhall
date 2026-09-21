import { Button } from '../primitives/Button';

export type ConnectionState = 'reconnecting' | 'stale' | 'unreachable';

export interface ConnectionStatusProps {
  state: ConnectionState;
  lastConfirmed?: string;
  onRetry?: () => void;
}

export function ConnectionStatus({ state, lastConfirmed, onRetry }: ConnectionStatusProps) {
  if (state === 'reconnecting') {
    return (
      <div className="wf-connection-status wf-connection-status--reconnecting" role="status">
        <span className="wf-connection-status__pulse" aria-hidden="true" />
        Reconnecting…
      </div>
    );
  }
  return (
    <aside className="wf-connection-status wf-connection-status--interrupted" role="status">
      <div>
        <p className="wf-type-body-strong">
          {state === 'stale' ? 'Live updates paused.' : 'WayPass can’t be reached.'}
        </p>
        {lastConfirmed && (
          <p>
            Showing information last confirmed at{' '}
            <time className="wf-tabular">{lastConfirmed}</time>.
          </p>
        )}
      </div>
      <Button variant="secondary" onClick={onRetry}>
        Retry
      </Button>
    </aside>
  );
}
