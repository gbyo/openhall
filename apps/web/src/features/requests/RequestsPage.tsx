import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, confirmed } from '../../api/client';
import { productMessage, UncertainCommandError } from '../../api/problems';
import { queryKeys } from '../../api/query-keys';
import { getCsrfToken } from '../../api/session';
import { Alert } from '../../design-system/primitives/Alert';
import { Button } from '../../design-system/primitives/Button';
import { StatusAnnouncer } from '../../design-system/primitives/StatusAnnouncer';
import { useSchool } from '../../app/school/SchoolShell';

type RequestAction =
  | { kind: 'approval'; id: string; decision: 'approve' | 'deny'; etag: string; key: string }
  | { kind: 'override'; id: string; decision: 'approve' | 'deny'; etag: string; key: string };

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
  const rows = [
    ...(approvals.data?.approvals
      .filter((row) => row.organizationId === organizationId)
      .map((row) => ({
        kind: 'approval' as const,
        id: row.approvalId,
        etag: row.passEtag,
        student: row.student,
        destination: row.destination,
        requestedAt: row.requestedAt,
        context: row.requiredSection.title,
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
  return (
    <section className="workspace" aria-labelledby="requests-title">
      <StatusAnnouncer
        message={
          mutation.isSuccess
            ? mutation.variables.decision === 'approve'
              ? 'Approval granted.'
              : 'Request denied.'
            : ''
        }
      />
      <header className="workspace__header">
        <p className="auth-kicker">Teacher tools</p>
        <h1 className="wf-type-page-title" id="requests-title">
          Requests
        </h1>
        <p>Oldest requests stay first so new arrivals do not move your current task.</p>
      </header>
      {mutation.isError && (
        <Alert tone="danger" title="Request changed">
          <p>{productMessage(mutation.error)}</p>
          {mutation.error instanceof UncertainCommandError && (
            <Button
              variant="secondary"
              onClick={() => {
                mutation.mutate(mutation.variables);
              }}
            >
              Check again
            </Button>
          )}
        </Alert>
      )}
      <div className="request-list">
        {rows.length === 0 && !approvals.isPending && !overrides.isPending ? (
          <p className="empty-copy">No requests need attention.</p>
        ) : (
          rows.map((row) => (
            <article className="request-row" key={`${row.kind}:${row.id}`}>
              <div>
                <h2>{row.student.displayName}</h2>
                <p>
                  {row.destination.displayName} · {row.context}
                </p>
                <time>
                  {new Intl.RelativeTimeFormat([], { numeric: 'auto' }).format(
                    -Math.max(
                      1,
                      Math.round((Date.now() - new Date(row.requestedAt).getTime()) / 60_000),
                    ),
                    'minute',
                  )}
                </time>
              </div>
              <div className="request-row__actions">
                <Button
                  size="compact"
                  pending={
                    mutation.isPending &&
                    mutation.variables.id === row.id &&
                    mutation.variables.decision === 'approve'
                  }
                  pendingLabel="Approving…"
                  onClick={() => {
                    mutation.mutate({
                      kind: row.kind,
                      id: row.id,
                      decision: 'approve',
                      etag: row.etag,
                      key: crypto.randomUUID(),
                    });
                  }}
                >
                  Approve
                </Button>
                <Button
                  size="compact"
                  variant="quiet"
                  pending={
                    mutation.isPending &&
                    mutation.variables.id === row.id &&
                    mutation.variables.decision === 'deny'
                  }
                  pendingLabel="Denying…"
                  onClick={() => {
                    mutation.mutate({
                      kind: row.kind,
                      id: row.id,
                      decision: 'deny',
                      etag: row.etag,
                      key: crypto.randomUUID(),
                    });
                  }}
                >
                  Deny
                </Button>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
