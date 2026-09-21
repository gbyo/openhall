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
import { useSchool } from '../../app/school/SchoolShell';
import { ActiveStudentPass, type PassAction } from './ActiveStudentPass';
import { presentStudentPass } from './presentation';
import type { StudentCatalogDestination, StudentCategory } from './student-intents.js';
import type { ScheduledAuthorization } from './scheduled-presentation.js';
import { StudentHome, StudentHomeSkeleton } from './StudentHome';
import {
  StudentPassRequestSurface,
  type StudentPassRequestState,
} from './StudentPassRequestSurface';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
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
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
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

const ACTION_COPY: Record<Action, { label: string; pendingLabel: string }> = {
  depart: { label: 'Start WayPass', pendingLabel: 'Starting…' },
  arrive: { label: "I've arrived", pendingLabel: 'Confirming…' },
  return: { label: 'Start return', pendingLabel: 'Starting return…' },
  complete: { label: "I'm back", pendingLabel: 'Finishing…' },
};

interface PendingSelection {
  category: StudentCategory | null;
  secondary: StudentCategory[] | null;
  destinationId: string | null;
}

function toRequestState(
  selection: PendingSelection | null,
  status: { pending: boolean; error: string | null; uncertain: boolean },
): StudentPassRequestState | null {
  if (!selection) return null;
  if (!selection.category) {
    if (!selection.secondary) return null;
    return { kind: 'more', secondary: selection.secondary, ...status };
  }
  return {
    kind: 'category',
    category: selection.category,
    destination:
      selection.category.destinations.find((entry) => entry.id === selection.destinationId) ?? null,
    ...status,
  };
}

export function StudentPage() {
  const { organizationId, context } = useSchool();
  const queryClient = useQueryClient();
  const commands = useLogicalCommand<Record<string, never>>();
  const requestCommands = useLogicalCommand<{ destinationId: string }>();
  const scheduledCommands = useLogicalCommand<{ scheduledAuthorizationId: string }>();
  const reviewCommands = useLogicalCommand<{ category: ReviewCategory }>();
  const [announcement, setAnnouncement] = useState('');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewCategory, setReviewCategory] = useState<ReviewCategory | null>(null);
  const [selection, setSelection] = useState<PendingSelection | null>(null);
  const timeZone = context.organization.timeZone;
  const active = useQuery({
    queryKey: queryKeys.activeSelfPass,
    queryFn: async () => passResource(await api.GET('/api/v1/me/passes/active')),
    staleTime: 5_000,
  });
  const catalog = useQuery({
    queryKey: queryKeys.studentCatalog(organizationId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/me/organizations/{organizationId}/student-destination-catalog', {
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
      requestCommands.clear();
      setSelection(null);
      queryClient.setQueryData(queryKeys.activeSelfPass, resource);
      setAnnouncement('WayPass requested.');
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
      setAnnouncement('WayPass started.');
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
  if (active.isPending)
    return (
      <section aria-label="WayPass" className="flex flex-col gap-4">
        <div role="status" aria-label="Checking your WayPass" className="flex flex-col gap-3">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-64 w-full" />
          <span className="sr-only">Checking your WayPass…</span>
        </div>
      </section>
    );
  if (pass && pass.organizationId !== organizationId)
    return <Navigate replace to={`/schools/${pass.organizationId}/pass`} />;
  if (!pass) {
    const authorizations =
      scheduled.data?.authorizations.filter((item) => item.organizationId === organizationId) ?? [];
    const categories = catalog.data?.categories ?? [];
    const loaded = !catalog.isPending && !scheduled.isPending;
    const startScheduledError = startScheduled.error;
    const selectCategory = (category: StudentCategory) => {
      request.reset();
      setSelection({ category, secondary: null, destinationId: null });
    };
    const selectMore = (secondary: StudentCategory[]) => {
      request.reset();
      setSelection({ category: null, secondary, destinationId: null });
    };
    const pickCategory = (category: StudentCategory) => {
      request.reset();
      setSelection({ category, secondary: null, destinationId: null });
    };
    const pickDestination = (destination: StudentCatalogDestination) => {
      setSelection((current) =>
        current ? { ...current, destinationId: destination.id } : current,
      );
    };
    const confirmRequest = () => {
      if (!selection?.category) return;
      const destinationId =
        selection.destinationId ?? selection.category.destinations[0]?.id ?? null;
      if (!destinationId) return;
      request.mutate(requestCommands.begin({ destinationId }, null));
    };
    const retryRequest = () => {
      if (request.variables) request.mutate(request.variables);
      else confirmRequest();
    };
    const closeRequest = () => {
      if (!request.isPending) setSelection(null);
    };
    return (
      <section aria-labelledby="destination-title" className="flex flex-col gap-6">
        <StatusAnnouncer message={announcement} />
        {startScheduledError && (
          <Alert variant="destructive">
            <AlertTitle>Appointment not started</AlertTitle>
            <AlertDescription>{productMessage(startScheduledError)}</AlertDescription>
            {startScheduledError instanceof UncertainCommandError && (
              <AlertAction>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    startScheduled.mutate(startScheduled.variables);
                  }}
                >
                  Check again
                </Button>
              </AlertAction>
            )}
          </Alert>
        )}
        {!loaded ? (
          <StudentHomeSkeleton />
        ) : categories.length === 0 && authorizations.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No destinations available.</EmptyTitle>
              <EmptyDescription>
                Ask a teacher or the office if you need to leave class.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <StudentHome
            categories={categories}
            authorizations={authorizations}
            timeZone={timeZone}
            startingId={
              startScheduled.isPending
                ? startScheduled.variables.body.scheduledAuthorizationId
                : null
            }
            startPending={startScheduled.isPending}
            actionsDisabled={request.isPending}
            onSelectCategory={selectCategory}
            onSelectMore={selectMore}
            onStartScheduled={(authorization: ScheduledAuthorization) => {
              startScheduled.mutate(
                scheduledCommands.begin(
                  { scheduledAuthorizationId: authorization.id },
                  authorization.authorizationEtag,
                ),
              );
            }}
          />
        )}
        <StudentPassRequestSurface
          request={toRequestState(selection, {
            pending: request.isPending,
            error: request.error ? productMessage(request.error) : null,
            uncertain: request.error instanceof UncertainCommandError,
          })}
          onPickCategory={pickCategory}
          onPickDestination={pickDestination}
          onConfirm={confirmRequest}
          onRetry={retryRequest}
          onClose={closeRequest}
        />
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
  const error = action.error ?? requestReview.error;
  const primaryAction = presentation?.action;
  const toPassAction = (
    actionName: Exclude<Action, never> | 'request-review',
  ): PassAction | null => {
    if (actionName === 'request-review') {
      return {
        label: 'Ask for staff review',
        pendingLabel: 'Requesting…',
        pending: false,
        onRun: () => {
          requestReview.reset();
          setReviewCategory(null);
          setReviewOpen(true);
        },
      };
    }
    const copy = ACTION_COPY[actionName];
    return {
      label: copy.label,
      pendingLabel: copy.pendingLabel,
      pending: action.isPending,
      onRun: () => {
        run(actionName);
      },
    };
  };
  const primary = primaryAction ? toPassAction(primaryAction) : null;
  const secondary =
    presentation?.kind === 'outbound-optional'
      ? {
          label: "I'm back",
          pendingLabel: 'Finishing…',
          pending: action.isPending,
          onRun: () => {
            run('complete');
          },
        }
      : null;
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
      {presentation && (
        <ActiveStudentPass
          pass={pass}
          presentation={presentation}
          queueAhead={queue.data?.ahead ?? null}
          timeZone={timeZone}
          primary={primary}
          secondary={secondary}
        />
      )}
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
