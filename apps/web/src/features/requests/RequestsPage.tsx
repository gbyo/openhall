import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, confirmed } from '../../api/client';
import { productMessage, UncertainCommandError } from '../../api/problems';
import { queryKeys } from '../../api/query-keys';
import { getCsrfToken } from '../../api/session';
import { StatusAnnouncer } from '../../components/StatusAnnouncer';
import { useSchool } from '../../app/school/SchoolShell';
import { PageHeader } from '../../components/workspace/PageHeader';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';

type RequestAction =
  | { kind: 'approval'; id: string; decision: 'approve' | 'deny'; etag: string; key: string }
  | { kind: 'override'; id: string; decision: 'approve' | 'deny'; etag: string; key: string };

interface RequestRow {
  kind: 'approval' | 'override';
  id: string;
  etag: string;
  student: { displayName: string };
  destination: { name: string };
  requestedAt: string;
  context: string;
}

function relativeMinutes(requestedAt: string): string {
  return new Intl.RelativeTimeFormat([], { numeric: 'auto' }).format(
    -Math.max(1, Math.round((Date.now() - new Date(requestedAt).getTime()) / 60_000)),
    'minute',
  );
}

export function RequestsPage() {
  const { organizationId } = useSchool();
  const queryClient = useQueryClient();
  const approvals = useQuery({
    queryKey: queryKeys.pendingApprovals,
    queryFn: () => confirmed(api.GET('/api/v1/me/pass-approvals/pending')),
    staleTime: 5_000,
  });
  const overrides = useQuery({
    queryKey: queryKeys.pendingOverrides,
    queryFn: () => confirmed(api.GET('/api/v1/me/pass-overrides/pending')),
    staleTime: 5_000,
  });
  const mutation = useMutation({
    mutationFn: async (action: RequestAction) => {
      const headers = {
        'X-CSRF-Token': getCsrfToken(),
        'Idempotency-Key': action.key,
        'If-Match': action.etag,
      };
      const header = {
        'idempotency-key': headers['Idempotency-Key'],
        'if-match': action.etag,
      };
      if (action.kind === 'approval')
        return action.decision === 'approve'
          ? confirmed(
              api.POST('/api/v1/pass-approvals/{approvalId}/approve', {
                params: { path: { approvalId: action.id }, header },
                headers,
              }),
            )
          : confirmed(
              api.POST('/api/v1/pass-approvals/{approvalId}/deny', {
                params: { path: { approvalId: action.id }, header },
                headers,
              }),
            );
      return action.decision === 'approve'
        ? confirmed(
            api.POST('/api/v1/pass-overrides/{overrideId}/approve', {
              params: { path: { overrideId: action.id }, header },
              headers,
            }),
          )
        : confirmed(
            api.POST('/api/v1/pass-overrides/{overrideId}/deny', {
              params: { path: { overrideId: action.id }, header },
              headers,
            }),
          );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.pendingApprovals });
      void queryClient.invalidateQueries({ queryKey: queryKeys.pendingOverrides });
      void queryClient.invalidateQueries({ queryKey: ['section-live'] });
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.pendingApprovals });
      void queryClient.invalidateQueries({ queryKey: queryKeys.pendingOverrides });
    },
  });
  const rows: RequestRow[] = [
    ...(approvals.data?.approvals
      .filter((row) => row.organizationId === organizationId)
      .map((row) => ({
        kind: 'approval' as const,
        id: row.approvalId,
        etag: row.passEtag,
        student: row.student,
        destination: row.destination,
        requestedAt: row.requestedAt,
        context: row.requiredRoom?.name ?? row.requiredSection.title ?? 'Staff review',
      })) ?? []),
    ...(overrides.data?.overrides
      .filter((row) => row.organizationId === organizationId)
      .map((row) => ({
        kind: 'override' as const,
        id: row.overrideId,
        etag: row.passEtag,
        student: row.student,
        destination: row.destination,
        requestedAt: row.requestedAt,
        context: 'Staff review',
      })) ?? []),
  ].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  const loading = approvals.isPending || overrides.isPending;
  const active = mutation.isPending ? mutation.variables : null;

  function resolve(row: RequestRow, decision: 'approve' | 'deny') {
    mutation.mutate({
      kind: row.kind,
      id: row.id,
      decision,
      etag: row.etag,
      key: crypto.randomUUID(),
    });
  }

  return (
    <section aria-labelledby="requests-title" className="flex flex-col gap-4">
      <StatusAnnouncer
        message={
          mutation.isSuccess
            ? mutation.variables.decision === 'approve'
              ? 'Approval granted.'
              : 'Request denied.'
            : ''
        }
      />
      <PageHeader
        title="Requests"
        description="Oldest requests stay first so new arrivals do not move your current task."
      />
      {mutation.isError && (
        <Alert variant="destructive">
          <AlertTitle>Request changed</AlertTitle>
          <AlertDescription>{productMessage(mutation.error)}</AlertDescription>
          {mutation.error instanceof UncertainCommandError && (
            <AlertAction>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  mutation.mutate(mutation.variables);
                }}
              >
                Check again
              </Button>
            </AlertAction>
          )}
        </Alert>
      )}
      {loading ? (
        <div role="status" aria-label="Loading requests" className="flex flex-col gap-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <span className="sr-only">Loading requests…</span>
        </div>
      ) : rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No requests need attention.</EmptyTitle>
            <EmptyDescription>
              New student requests will appear here, oldest first.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup aria-label="Pending requests">
          {rows.map((row) => {
            const rowBusy = active !== null && active.id === row.id;
            const approving =
              active !== null && active.id === row.id && active.decision === 'approve';
            const denying = active !== null && active.id === row.id && active.decision === 'deny';
            return (
              <Item role="listitem" key={`${row.kind}:${row.id}`}>
                <ItemContent>
                  <div className="flex flex-wrap items-center gap-2">
                    <ItemTitle>{row.student.displayName}</ItemTitle>
                    {row.kind === 'override' ? <Badge>Staff review</Badge> : null}
                  </div>
                  <ItemDescription>
                    {row.destination.name} · {row.context} ·{' '}
                    <time dateTime={row.requestedAt}>{relativeMinutes(row.requestedAt)}</time>
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <ButtonGroup aria-label={`Decide request from ${row.student.displayName}`}>
                    <Button
                      size="sm"
                      disabled={rowBusy}
                      aria-busy={approving}
                      onClick={() => {
                        resolve(row, 'approve');
                      }}
                    >
                      {approving ? <Spinner data-icon="inline-start" /> : null}
                      {approving ? 'Approving…' : 'Approve'}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={rowBusy}
                      aria-busy={denying}
                      onClick={() => {
                        resolve(row, 'deny');
                      }}
                    >
                      {denying ? <Spinner data-icon="inline-start" /> : null}
                      {denying ? 'Denying…' : 'Deny'}
                    </Button>
                  </ButtonGroup>
                </ItemActions>
              </Item>
            );
          })}
        </ItemGroup>
      )}
    </section>
  );
}
