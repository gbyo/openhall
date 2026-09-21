import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, confirmed } from '../../../api/client';
import { queryKeys } from '../../../api/query-keys';
import { useSchool } from '../../../app/school/SchoolShell';
import { PageHeader } from '../../../components/workspace/PageHeader';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

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
  const events = audit.data?.events ?? [];
  return (
    <section className="grid gap-6">
      <PageHeader
        title="Audit"
        description="A chronological record of confirmed school changes. No movement analytics or scoring."
      />
      {audit.isPending ? (
        <div className="grid gap-2" role="status" aria-label="Loading audit events">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : events.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No audit events yet</EmptyTitle>
            <EmptyDescription>
              Confirmed school changes will appear here in chronological order.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table aria-label="Audit events">
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Request ID</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event) => (
                <TableRow key={event.id}>
                  <TableCell>
                    <time>
                      {new Intl.DateTimeFormat([], {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      }).format(new Date(event.occurredAt))}
                    </time>
                  </TableCell>
                  <TableCell>{event.actor.displayName ?? event.actor.kind}</TableCell>
                  <TableCell className="font-medium">{actionLabel(event.action)}</TableCell>
                  <TableCell>{event.target.kind}</TableCell>
                  <TableCell>{event.outcome}</TableCell>
                  <TableCell>
                    <code className="text-xs">{event.requestId}</code>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {audit.data?.nextCursor && (
        <div>
          <Button
            variant="secondary"
            onClick={() => {
              setCursor(audit.data.nextCursor ?? undefined);
            }}
          >
            Next page
          </Button>
        </div>
      )}
    </section>
  );
}
