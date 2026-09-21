import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate } from 'react-router';
import { api, confirmed, confirmedResult, requireData } from '../../api/client';
import { useLogicalCommand, type LogicalCommand } from '../../api/commands';
import { ApiProblem, productMessage, UncertainCommandError } from '../../api/problems';
import { queryKeys } from '../../api/query-keys';
import { getCsrfToken } from '../../api/session';
import type { Pass } from '../../api/types';
import { Alert } from '../../design-system/primitives/Alert';
import { Button } from '../../design-system/primitives/Button';
import { StatusAnnouncer } from '../../design-system/primitives/StatusAnnouncer';
import { DestinationRow } from '../../design-system/patterns/DestinationRow';
import { PassCard } from '../../design-system/patterns/PassCard';
import { QueuePosition } from '../../design-system/patterns/QueuePosition';
import { Route, RouteStop } from '../../design-system/patterns/Route';
import { useSchool } from '../../app/school/SchoolShell';
import { presentStudentPass } from './presentation';

interface PassResource {
  pass: Pass | null;
  etag: string | null;
}
type Action = 'depart' | 'arrive' | 'return' | 'complete';

function passResource(result: {
  data?: { pass: Pass | null };
  error?: unknown;
  response: Response;
}): PassResource {
  const data = requireData(result);
  return { pass: data.pass, etag: data.pass ? result.response.headers.get('etag') : null };
}

function time(value: string | null): string | null {
  return value
    ? new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' }).format(new Date(value))
    : null;
}

export function StudentPage() {
  const { organizationId, context } = useSchool();
  const queryClient = useQueryClient();
  const commands = useLogicalCommand<Record<string, never>>();
  const scheduledCommands = useLogicalCommand<{ scheduledAuthorizationId: string }>();
  const reviewCommands = useLogicalCommand<{
    category: 'urgent' | 'private' | 'safety' | 'staff_directed';
  }>();
  const [announcement, setAnnouncement] = useState('');
  const [reviewOpen, setReviewOpen] = useState(false);
  const active = useQuery({
    queryKey: queryKeys.activeSelfPass,
    queryFn: async () => passResource(await api.GET('/api/v1/me/passes/active')),
    staleTime: 5_000,
  });
  const destinations = useQuery({
    queryKey: queryKeys.destinations(organizationId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/me/organizations/{organizationId}/destinations', {
          params: { path: { organizationId } },
        }),
      ),
  });
  const scheduled = useQuery({
    queryKey: queryKeys.selfScheduled,
    queryFn: () => confirmed(api.GET('/api/v1/me/scheduled-authorizations')),
  });
  const pass = active.data?.pass ?? null;
  const presentation = pass ? presentStudentPass(pass) : null;
  const queue = useQuery({
    queryKey: queryKeys.queueStatus(pass?.id ?? 'none'),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/me/passes/{passId}/queue-status', {
          params: { path: { passId: pass?.id ?? '' } },
        }),
      ),
    enabled: pass?.lifecycleState === 'queued',
    refetchInterval: pass?.lifecycleState === 'queued' ? 10_000 : false,
    staleTime: 5_000,
  });
  const request = useMutation({
    mutationFn: async (command: LogicalCommand<{ destinationId: string }>) => {
      const result = await confirmedResult(
        api.POST('/api/v1/me/passes', {
          params: { header: { 'idempotency-key': command.idempotencyKey } },
          headers: { 'X-CSRF-Token': getCsrfToken(), 'Idempotency-Key': command.idempotencyKey },
          body: command.body,
        }),
      );
      return passResource(result);
    },
    onSuccess: (resource) => {
      commands.clear();
      queryClient.setQueryData(queryKeys.activeSelfPass, resource);
      void queryClient.invalidateQueries({ queryKey: queryKeys.schoolLive(organizationId) });
    },
  });
  const action = useMutation({
    mutationFn: async ({
      actionName,
      command,
    }: {
      actionName: Action;
      command: LogicalCommand<Record<string, never>>;
    }) => {
      if (!pass || !command.ifMatch) throw new Error('Pass revision unavailable.');
      const options = {
        params: {
          path: { passId: pass.id },
          header: {
            'idempotency-key': command.idempotencyKey,
            'if-match': command.ifMatch,
          },
        },
        headers: {
          'X-CSRF-Token': getCsrfToken(),
          'Idempotency-Key': command.idempotencyKey,
          'If-Match': command.ifMatch,
        },
      } as const;
      const result =
        actionName === 'depart'
          ? await confirmedResult(api.POST('/api/v1/me/passes/{passId}/depart', options))
          : actionName === 'arrive'
            ? await confirmedResult(api.POST('/api/v1/me/passes/{passId}/arrive', options))
            : actionName === 'return'
              ? await confirmedResult(api.POST('/api/v1/me/passes/{passId}/return', options))
              : await confirmedResult(api.POST('/api/v1/me/passes/{passId}/complete', options));
      return passResource(result);
    },
    onSuccess: (resource, variables) => {
      commands.clear();
      queryClient.setQueryData(queryKeys.activeSelfPass, resource);
      setAnnouncement(
        variables.actionName === 'depart'
          ? 'Pass started.'
          : variables.actionName === 'complete'
            ? 'Pass completed.'
            : 'Pass updated.',
      );
      if (
        resource.pass &&
        ['completed', 'denied', 'cancelled', 'expired'].includes(resource.pass.lifecycleState)
      )
        window.setTimeout(
          () => void queryClient.invalidateQueries({ queryKey: queryKeys.activeSelfPass }),
          2200,
        );
    },
    onError: (error) => {
      if (error instanceof ApiProblem && error.status === 412) {
        commands.clear();
        void active.refetch();
      }
    },
  });
  const startScheduled = useMutation({
    mutationFn: async (command: LogicalCommand<{ scheduledAuthorizationId: string }>) => {
      if (!command.ifMatch) throw new Error('Appointment revision unavailable.');
      const result = await confirmedResult(
        api.POST('/api/v1/me/scheduled-authorizations/{scheduledAuthorizationId}/start', {
          params: {
            path: { scheduledAuthorizationId: command.body.scheduledAuthorizationId },
            header: {
              'idempotency-key': command.idempotencyKey,
              'if-match': command.ifMatch,
            },
          },
          headers: {
            'X-CSRF-Token': getCsrfToken(),
            'Idempotency-Key': command.idempotencyKey,
            'If-Match': command.ifMatch,
          },
        }),
      );
      return passResource(result);
    },
    onSuccess: (resource) => {
      scheduledCommands.clear();
      queryClient.setQueryData(queryKeys.activeSelfPass, resource);
      void queryClient.invalidateQueries({ queryKey: queryKeys.selfScheduled });
    },
  });
  const requestReview = useMutation({
    mutationFn: async (
      command: LogicalCommand<{
        category: 'urgent' | 'private' | 'safety' | 'staff_directed';
      }>,
    ) => {
      if (!pass || !command.ifMatch) throw new Error('Pass revision unavailable.');
      const result = await confirmedResult(
        api.POST('/api/v1/me/passes/{passId}/overrides', {
          params: {
            path: { passId: pass.id },
            header: { 'idempotency-key': command.idempotencyKey, 'if-match': command.ifMatch },
          },
          headers: {
            'X-CSRF-Token': getCsrfToken(),
            'Idempotency-Key': command.idempotencyKey,
            'If-Match': command.ifMatch,
          },
          body: command.body,
        }),
      );
      return passResource(result);
    },
    onSuccess: (resource) => {
      reviewCommands.clear();
      setReviewOpen(false);
      queryClient.setQueryData(queryKeys.activeSelfPass, resource);
      setAnnouncement('Staff review requested.');
    },
  });
  useEffect(() => {
    if (pass?.lifecycleState === 'ready') setAnnouncement("You're ready to start your pass.");
  }, [pass?.lifecycleState]);
  const error = request.error ?? action.error ?? startScheduled.error ?? requestReview.error;
  if (active.isPending)
    return (
      <section className="student-page">
        <p role="status">Checking your WayPass…</p>
      </section>
    );
  if (pass && pass.organizationId !== organizationId)
    return <Navigate replace to={`/schools/${pass.organizationId}/pass`} />;
  if (!pass)
    return (
      <section className="student-page" aria-labelledby="destination-title">
        <StatusAnnouncer message={announcement} />
        <header className="student-page__intro">
          <p className="student-page__school">{context.organization.name}</p>
          <h1 className="wf-type-page-title" id="destination-title">
            Where do you need to go?
          </h1>
        </header>
        {error && (
          <Alert tone="danger" title="Request not confirmed">
            <p>{productMessage(error)}</p>
            {error instanceof UncertainCommandError && request.variables && (
              <Button
                variant="secondary"
                onClick={() => {
                  request.mutate(request.variables);
                }}
              >
                Check again
              </Button>
            )}
          </Alert>
        )}
        <div className="destination-list">
          {destinations.data?.destinations.map((destination) => (
            <DestinationRow
              key={destination.id}
              name={destination.displayName}
              description={destination.serviceType}
              disabled={request.isPending}
              onClick={() => {
                request.mutate({
                  idempotencyKey: crypto.randomUUID(),
                  body: { destinationId: destination.id },
                  ifMatch: null,
                });
              }}
            />
          ))}
        </div>
        {(scheduled.data?.authorizations.length ?? 0) > 0 && (
          <section className="upcoming">
            <h2>Upcoming</h2>
            {scheduled.data?.authorizations
              .filter((item) => item.organizationId === organizationId && item.status === 'active')
              .map((item) => (
                <article key={item.id}>
                  <time>{time(item.validFrom)}</time>
                  <strong>{item.destination.displayName}</strong>
                  <span>
                    Available {time(item.validFrom)}–{time(item.validUntil)}
                  </span>
                  <Button
                    pending={
                      startScheduled.isPending &&
                      startScheduled.variables.body.scheduledAuthorizationId === item.id
                    }
                    onClick={() => {
                      startScheduled.mutate(
                        scheduledCommands.begin(
                          { scheduledAuthorizationId: item.id },
                          item.authorizationEtag,
                        ),
                      );
                    }}
                  >
                    Start WayPass
                  </Button>
                </article>
              ))}
          </section>
        )}
      </section>
    );
  const run = (actionName: Action) => {
    const command = commands.begin({}, active.data?.etag ?? null);
    action.mutate({ actionName, command });
  };
  const retry =
    action.error instanceof UncertainCommandError && action.variables
      ? () => {
          action.mutate(action.variables);
        }
      : null;
  return (
    <section className="student-page student-page--pass">
      <StatusAnnouncer message={announcement} />
      {error && (
        <Alert
          tone="danger"
          title={
            error instanceof UncertainCommandError && action.variables?.actionName === 'depart'
              ? 'Checking whether your pass started…'
              : 'Pass update not confirmed'
          }
        >
          <p>{productMessage(error)}</p>
          {retry && (
            <Button variant="secondary" onClick={retry}>
              Check again
            </Button>
          )}
        </Alert>
      )}
      <PassCard
        context={pass.destination.displayName}
        title={presentation?.title ?? 'WayPass'}
        tone={
          presentation?.kind === 'ready'
            ? 'ready'
            : presentation?.kind === 'queued'
              ? 'queued'
              : presentation?.kind === 'terminal'
                ? 'complete'
                : 'active'
        }
        supporting={
          pass.movement.expectedReturnAt ? (
            <>
              Expected back around <time>{time(pass.movement.expectedReturnAt)}</time>
            </>
          ) : undefined
        }
        primaryAction={
          presentation?.action === 'request-review' ? (
            <Button
              onClick={() => {
                setReviewOpen(true);
              }}
            >
              Ask for staff review
            </Button>
          ) : presentation?.action === 'depart' ? (
            <Button
              pending={action.isPending}
              pendingLabel="Starting…"
              onClick={() => {
                run('depart');
              }}
            >
              Start pass
            </Button>
          ) : presentation?.action === 'arrive' ? (
            <Button
              pending={action.isPending}
              onClick={() => {
                run('arrive');
              }}
            >
              I've arrived
            </Button>
          ) : presentation?.action === 'return' ? (
            <Button
              pending={action.isPending}
              onClick={() => {
                run('return');
              }}
            >
              Start return
            </Button>
          ) : presentation?.action === 'complete' ? (
            <Button
              pending={action.isPending}
              onClick={() => {
                run('complete');
              }}
            >
              I'm back
            </Button>
          ) : undefined
        }
        secondaryAction={
          presentation?.kind === 'outbound-optional' ? (
            <Button
              variant="secondary"
              pending={action.isPending}
              onClick={() => {
                run('complete');
              }}
            >
              I'm back
            </Button>
          ) : undefined
        }
      >
        {presentation?.kind === 'queued' && queue.data && (
          <QueuePosition ahead={queue.data.ahead} />
        )}
        {presentation?.kind === 'ready' && pass.movement.readyUntil && (
          <p>
            Start by <strong>{time(pass.movement.readyUntil)}</strong>
          </p>
        )}
        {presentation?.kind === 'waiting-approval' && <p>No action needed.</p>}
        {reviewOpen && (
          <div className="review-categories" aria-label="Reason for staff review">
            <p>Choose the reason staff should review this request.</p>
            {(
              [
                ['urgent', 'Urgent'],
                ['private', 'Private'],
                ['safety', 'Safety'],
                ['staff_directed', 'Staff directed'],
              ] as const
            ).map(([category, label]) => (
              <Button
                key={category}
                variant="secondary"
                pending={
                  requestReview.isPending && requestReview.variables.body.category === category
                }
                onClick={() => {
                  requestReview.mutate(
                    reviewCommands.begin({ category }, active.data?.etag ?? null),
                  );
                }}
              >
                {label}
              </Button>
            ))}
          </div>
        )}
        {presentation?.kind === 'outbound-station-required' && (
          <p>Check in when you arrive. Station staff will record it.</p>
        )}
        {(presentation?.kind === 'at-destination' || presentation?.kind === 'returning') && (
          <Route>
            <RouteStop label={pass.destination.displayName} evidence="recorded" />
            <RouteStop
              label={pass.origin.location?.name ?? 'Return location'}
              evidence={presentation.kind === 'returning' ? 'intended' : 'intended'}
              last
            />
          </Route>
        )}
      </PassCard>
    </section>
  );
}
