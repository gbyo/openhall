import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, confirmed } from '../../../api/client';
import { queryKeys } from '../../../api/query-keys';
import { Button } from '../../../design-system/primitives/Button';
import { useSchool } from '../../../app/school/SchoolShell';

function actionLabel(value: string): string {
  return value
    .replaceAll('.', ' ')
    .replaceAll('_', ' ')
    .replace(/^./, (letter) => letter.toUpperCase());
}

export function Component() {
  const { organizationId } = useSchool();
  const [cursor, setCursor] = useState<string | undefined>();
  const audit = useQuery({
    queryKey: [...queryKeys.audit(organizationId), cursor ?? 'first'],
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/audit-events', {
          params: { path: { organizationId }, query: { limit: 50, ...(cursor ? { cursor } : {}) } },
        }),
      ),
  });
  return (
    <section className="workspace">
      <header className="workspace__header">
        <p className="auth-kicker">Accountability</p>
        <h1 className="wf-type-page-title">Audit</h1>
        <p>A chronological record of confirmed school changes. No movement analytics or scoring.</p>
      </header>
      <div className="data-table audit-table">
        <div className="data-table__head">
          <span>Time</span>
          <span>Actor</span>
          <span>Action</span>
          <span>Target</span>
          <span>Outcome</span>
          <span>Request ID</span>
        </div>
        {audit.data?.events.map((event) => (
          <div className="data-table__row" key={event.id}>
            <time>
              {new Intl.DateTimeFormat([], { dateStyle: 'short', timeStyle: 'short' }).format(
                new Date(event.occurredAt),
              )}
            </time>
            <span>{event.actor.displayName ?? event.actor.kind}</span>
            <strong>{actionLabel(event.action)}</strong>
            <span>{event.target.kind}</span>
            <span>{event.outcome}</span>
            <code>{event.requestId}</code>
          </div>
        ))}
      </div>
      {audit.data?.nextCursor && (
        <Button
          variant="secondary"
          onClick={() => {
            setCursor(audit.data.nextCursor ?? undefined);
          }}
        >
          Next page
        </Button>
      )}
    </section>
  );
}
