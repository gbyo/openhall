import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate } from 'react-router';
import { api, confirmed, confirmedResult, requireData } from '../../api/client';
import { useLogicalCommand, type LogicalCommand } from '../../api/commands';
import { ApiProblem, productMessage, UncertainCommandError } from '../../api/problems';
import { queryKeys } from '../../api/query-keys';
import { getCsrfToken } from '../../api/session';
import type { Pass } from '../../api/types';
import { StatusAnnouncer } from '../../components/StatusAnnouncer';
import { QueuePosition } from '../../design-system/patterns/QueuePosition';
import { Route, RouteStop } from '../../design-system/patterns/Route';
import { useSchool } from '../../app/school/SchoolShell';
import { presentStudentPass, type StudentPassPresentation } from './presentation';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from '@/components/ui/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';

interface PassResource {
  pass: Pass | null;
  etag: string | null;
}
type Action = 'depart' | 'arrive' | 'return' | 'complete';
type ReviewCategory = 'urgent' | 'private' | 'safety' | 'staff_directed';

const REVIEW_CATEGORIES: { value: ReviewCategory; label: string }[] = [
  { value: 'urgent', label: 'Urgent' },
  { value: 'private', label: 'Private' },
  { value: 'safety', label: 'Safety' },
  { value: 'staff_directed', label: 'Staff directed' },
];

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

function stateBadge(presentation: StudentPassPresentation): string {
  switch (presentation.kind) {
    case 'waiting-approval':
      return 'Waiting';
    case 'staff-review-available':
      return 'Needs review';
    case 'staff-review-pending':
      return 'In review';
    case 'queued':
      return 'In line';
    case 'ready':
      return 'Ready';
    case 'outbound-lightweight':
    case 'outbound-optional':
    case 'outbound-station-required':
      return 'Active';
    case 'at-destination':
      return 'Arrived';
    case 'returning':
      return 'Returning';
    case 'terminal':
      return 'Done';
  }
}

const ACTION_COPY: Record<Action, { label: string; pendingLabel: string }> = {
  depart: { label: 'Start pass', pendingLabel: 'Starting…' },
  arrive: { label: "I've arrived", pendingLabel: 'Confirming…' },
  return: { label: 'Start return', pendingLabel: 'Starting return…' },
  complete: { label: "I'm back", pendingLabel: 'Finishing…' },
};

export function StudentPage() {
  const { organizationId, context } = useSchool();
  const queryClient = useQueryClient();
  const commands = useLogicalCommand<Record<string, never>>();
  const scheduledCommands = useLogicalCommand<{ scheduledAuthorizationId: string }>();
  const reviewCommands = useLogicalCommand<{ category: ReviewCategory }>();
  const [announcement, setAnnouncement] = useState('');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewCategory, setReviewCategory] = useState<ReviewCategory | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
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
  useEffect(() => {
    const nextBoundary = (scheduled.data?.authorizations ?? [])
      .filter((item) => item.organizationId === organizationId && item.status === 'active')
      .flatMap((item) => [Date.parse(item.validFrom), Date.parse(item.validUntil)])
      .filter((boundary) => Number.isFinite(boundary) && boundary > nowMs)
      .reduce(
        (earliest, boundary) => Math.min(earliest, boundary),
        Number.POSITIVE_INFINITY,
      );
    if (!Number.isFinite(nextBoundary)) return;

    const timer = window.setTimeout(
      () => {
        setNowMs(Date.now());
      },
      Math.min(Math.max(0, nextBoundary - Date.now()) + 1, 2_147_483_647),
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [nowMs, organizationId, scheduled.data?.authorizations]);
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
    mutationFn: async (command: LogicalCommand<{ category: ReviewCategory }>) => {
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
      setReviewCategory(null);
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
      <section aria-label="WayPass" className="flex flex-col gap-4">
        <div role="status" aria-label="Checking your WayPass" className="flex flex-col gap-3">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <span className="sr-only">Checking your WayPass…</span>
        </div>
      </section>
    );
  if (pass && pass.organizationId !== organizationId)
    return <Navigate replace to={`/schools/${pass.organizationId}/pass`} />;
  if (!pass) {
    const upcoming =
      scheduled.data?.authorizations.filter(
        (item) => item.organizationId === organizationId && item.status === 'active',
      ) ?? [];
    const loaded = !destinations.isPending && !scheduled.isPending;
    const requestingId = request.isPending ? request.variables.body.destinationId : null;
    return (
      <section aria-labelledby="destination-title" className="flex flex-col gap-6">
        <StatusAnnouncer message={announcement} />
        <div className="flex flex-col gap-1">
          <p className="text-sm font-semibold text-muted-foreground">{context.organization.name}</p>
          <h1 id="destination-title" className="text-xl font-semibold tracking-tight text-balance">
            Where do you need to go?
          </h1>
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Request not confirmed</AlertTitle>
            <AlertDescription>{productMessage(error)}</AlertDescription>
            {error instanceof UncertainCommandError && (
              <AlertAction>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (request.variables) request.mutate(request.variables);
                  }}
                >
                  Check again
                </Button>
              </AlertAction>
            )}
          </Alert>
        )}
        {!loaded ? (
          <div role="status" aria-label="Loading destinations" className="flex flex-col gap-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <span className="sr-only">Loading destinations…</span>
          </div>
        ) : (destinations.data?.destinations.length ?? 0) === 0 && upcoming.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No destinations available.</EmptyTitle>
              <EmptyDescription>
                Ask a teacher or the office if you need to leave class.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ItemGroup aria-label="Destinations">
            {destinations.data?.destinations.map((destination) => {
              const requesting = requestingId === destination.id;
              return (
                <div role="listitem" key={destination.id}>
                  <Item
                    render={
                      <button
                        type="button"
                        disabled={request.isPending}
                        aria-busy={requesting}
                        onClick={() => {
                          request.mutate({
                            idempotencyKey: crypto.randomUUID(),
                            body: { destinationId: destination.id },
                            ifMatch: null,
                          });
                        }}
                      />
                    }
                  >
                    <ItemContent>
                      <ItemTitle>{destination.displayName}</ItemTitle>
                      <ItemDescription>{destination.serviceType}</ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      {destination.checkInMode === 'required' ? (
                        <Badge variant="secondary">Check-in</Badge>
                      ) : null}
                      {requesting ? (
                        <Spinner data-icon="inline-start" aria-label="Requesting…" />
                      ) : null}
                    </ItemActions>
                  </Item>
                </div>
              );
            })}
          </ItemGroup>
        )}
        {upcoming.length > 0 && (
          <section aria-labelledby="upcoming-title" className="flex flex-col gap-3">
            <h2 id="upcoming-title" className="text-base font-semibold tracking-tight">
              Upcoming
            </h2>
            <ItemGroup aria-label="Upcoming scheduled passes">
              {upcoming.map((item) => {
                const starting =
                  startScheduled.isPending &&
                  startScheduled.variables.body.scheduledAuthorizationId === item.id;
                const fromMs = Date.parse(item.validFrom);
                const untilMs = Date.parse(item.validUntil);
                const notYet = Number.isFinite(fromMs) && nowMs < fromMs;
                const ended = Number.isFinite(untilMs) && nowMs >= untilMs;
                const startable = !notYet && !ended;
                const opensLabel = time(item.validFrom) ?? 'soon';
                return (
                  <Item role="listitem" key={item.id}>
                    <ItemContent>
                      <ItemTitle>{item.destination.displayName}</ItemTitle>
                      <ItemDescription>
                        <time>{time(item.validFrom)}</time>
                        {' · '}
                        Available {time(item.validFrom)}–{time(item.validUntil)}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Button
                        size="sm"
                        disabled={startScheduled.isPending || !startable}
                        aria-busy={starting}
                        title={
                          notYet
                            ? `Opens ${opensLabel}`
                            : ended
                              ? 'This appointment has ended'
                              : undefined
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
                        {starting ? <Spinner data-icon="inline-start" /> : null}
                        {starting ? 'Starting…' : 'Start WayPass'}
                      </Button>
                    </ItemActions>
                  </Item>
                );
              })}
            </ItemGroup>
          </section>
        )}
      </section>
    );
  }
  const run = (actionName: Action) => {
    const command = commands.begin({}, active.data?.etag ?? null);
    action.mutate({ actionName, command });
  };
  const retry =
    action.error instanceof UncertainCommandError
      ? () => {
          if (action.variables) action.mutate(action.variables);
        }
      : null;
  const primaryAction = presentation?.action;
  const primaryCopy =
    primaryAction && primaryAction !== 'request-review' ? ACTION_COPY[primaryAction] : null;
  const primaryPending = action.isPending;
  return (
    <section aria-labelledby="pass-title" className="flex flex-col gap-4">
      <StatusAnnouncer message={announcement} />
      {error && (
        <Alert variant="destructive">
          <AlertTitle>
            {error instanceof UncertainCommandError && action.variables?.actionName === 'depart'
              ? 'Checking whether your pass started…'
              : 'Pass update not confirmed'}
          </AlertTitle>
          <AlertDescription>{productMessage(error)}</AlertDescription>
          {retry && (
            <AlertAction>
              <Button variant="outline" size="sm" onClick={retry}>
                Check again
              </Button>
            </AlertAction>
          )}
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardDescription>{pass.destination.displayName}</CardDescription>
          <div className="flex flex-wrap items-center gap-2">
            <h1 id="pass-title" className="font-heading text-base font-medium text-balance">
              {presentation?.title ?? 'WayPass'}
            </h1>
            {presentation ? <Badge variant="secondary">{stateBadge(presentation)}</Badge> : null}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {pass.movement.expectedReturnAt ? (
            <p className="text-sm text-muted-foreground">
              Expected back around <time>{time(pass.movement.expectedReturnAt)}</time>
            </p>
          ) : null}
          {presentation?.kind === 'queued' && queue.data && (
            <QueuePosition ahead={queue.data.ahead} />
          )}
          {presentation?.kind === 'ready' && pass.movement.readyUntil && (
            <p className="text-sm">
              Start by <strong>{time(pass.movement.readyUntil)}</strong>
            </p>
          )}
          {presentation?.kind === 'waiting-approval' && (
            <p className="text-sm text-muted-foreground">No action needed.</p>
          )}
          {presentation?.kind === 'outbound-station-required' && (
            <p className="text-sm text-muted-foreground">
              Check in when you arrive. Station staff will record it.
            </p>
          )}
          {(presentation?.kind === 'at-destination' || presentation?.kind === 'returning') && (
            <Route>
              <RouteStop label={pass.destination.displayName} evidence="recorded" />
              <RouteStop
                label={pass.origin.location?.name ?? 'Return location'}
                evidence="intended"
                last
              />
            </Route>
          )}
        </CardContent>
        {primaryCopy ||
        presentation?.action === 'request-review' ||
        presentation?.kind === 'outbound-optional' ? (
          <>
            <Separator />
            <CardFooter className="flex flex-wrap gap-2">
              {primaryAction === 'request-review' ? (
                <Button
                  onClick={() => {
                    requestReview.reset();
                    setReviewCategory(null);
                    setReviewOpen(true);
                  }}
                >
                  Ask for staff review
                </Button>
              ) : primaryCopy && primaryAction ? (
                <Button
                  disabled={primaryPending}
                  aria-busy={primaryPending}
                  onClick={() => {
                    run(primaryAction);
                  }}
                >
                  {primaryPending ? <Spinner data-icon="inline-start" /> : null}
                  {primaryPending ? primaryCopy.pendingLabel : primaryCopy.label}
                </Button>
              ) : null}
              {presentation?.kind === 'outbound-optional' ? (
                <Button
                  variant="outline"
                  disabled={primaryPending}
                  onClick={() => {
                    run('complete');
                  }}
                >
                  I&apos;m back
                </Button>
              ) : null}
            </CardFooter>
          </>
        ) : null}
      </Card>
      <Dialog
        open={reviewOpen}
        onOpenChange={(open) => {
          if (!open && !requestReview.isPending) {
            setReviewOpen(false);
            setReviewCategory(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ask for staff review</DialogTitle>
            <DialogDescription>
              Choose the reason staff should review this request.
            </DialogDescription>
          </DialogHeader>
          <RadioGroup
            aria-label="Reason for staff review"
            value={reviewCategory ?? ''}
            onValueChange={(value) => {
              setReviewCategory(value as ReviewCategory);
            }}
          >
            {REVIEW_CATEGORIES.map((category) => (
              <div key={category.value} className="flex items-center gap-2">
                <RadioGroupItem value={category.value} id={`review-${category.value}`} />
                <Label htmlFor={`review-${category.value}`}>{category.label}</Label>
              </div>
            ))}
          </RadioGroup>
          {requestReview.isError && (
            <Alert variant="destructive">
              <AlertTitle>Review not requested</AlertTitle>
              <AlertDescription>{productMessage(requestReview.error)}</AlertDescription>
              {requestReview.error instanceof UncertainCommandError && (
                <AlertAction>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      requestReview.mutate(requestReview.variables);
                    }}
                  >
                    Check again
                  </Button>
                </AlertAction>
              )}
            </Alert>
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              disabled={requestReview.isPending || reviewCategory === null}
              aria-busy={requestReview.isPending}
              onClick={() => {
                if (reviewCategory) {
                  requestReview.mutate(
                    reviewCommands.begin({ category: reviewCategory }, active.data?.etag ?? null),
                  );
                }
              }}
            >
              {requestReview.isPending ? <Spinner data-icon="inline-start" /> : null}
              {requestReview.isPending ? 'Requesting…' : 'Request review'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
