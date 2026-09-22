import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router';
import { api, confirmed } from '../../api/client';
import { productMessage } from '../../api/problems';
import { queryKeys } from '../../api/query-keys';
import { getCsrfToken } from '../../api/session';
import { useSchool } from '../../app/school/SchoolShell';
import { PageHeader } from '../../components/workspace/PageHeader';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Empty, EmptyTitle } from '@/components/ui/empty';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';

interface StationAction {
  kind: 'check-in' | 'begin-return' | 'complete';
  passId: string;
  etag: string;
  key: string;
}

const ACTION_COPY: Record<StationAction['kind'], { label: string; pendingLabel: string }> = {
  'check-in': { label: 'Check in', pendingLabel: 'Checking in…' },
  'begin-return': { label: 'Begin return', pendingLabel: 'Starting return…' },
  complete: { label: 'Complete here', pendingLabel: 'Completing…' },
};

function format(value: string): string {
  return new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' }).format(
    new Date(value),
  );
}

function StateGroup({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <h2 className="font-heading text-sm font-medium">{title}</h2>
          <Badge variant="secondary">{count}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        {count === 0 ? (
          <Empty>
            <EmptyTitle>{empty}</EmptyTitle>
          </Empty>
        ) : (
          <ItemGroup aria-label={title}>{children}</ItemGroup>
        )}
      </CardContent>
    </Card>
  );
}

export function StationPage() {
  const { context, organizationId } = useSchool();
  const navigate = useNavigate();
  const roomId = useParams().roomId ?? context.staffedRooms[0]?.id ?? '';
  const queryClient = useQueryClient();
  const station = useQuery({
    queryKey: queryKeys.station(roomId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/rooms/{roomId}/station', {
          params: { path: { roomId } },
        }),
      ),
    staleTime: 3_000,
    refetchOnWindowFocus: true,
  });
  const action = useMutation({
    mutationFn: (input: StationAction) => {
      const options = {
        params: {
          path: { roomId, passId: input.passId },
          header: { 'idempotency-key': input.key, 'if-match': input.etag },
        },
        headers: {
          'X-CSRF-Token': getCsrfToken(),
          'Idempotency-Key': input.key,
          'If-Match': input.etag,
        },
      } as const;
      return input.kind === 'check-in'
        ? confirmed(api.POST('/api/v1/rooms/{roomId}/passes/{passId}/check-in', options))
        : input.kind === 'begin-return'
          ? confirmed(api.POST('/api/v1/rooms/{roomId}/passes/{passId}/begin-return', options))
          : confirmed(api.POST('/api/v1/rooms/{roomId}/passes/{passId}/complete', options));
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.station(roomId) }),
    onError: () => void queryClient.invalidateQueries({ queryKey: queryKeys.station(roomId) }),
  });
  const data = station.data;

  function run(kind: StationAction['kind'], passId: string, etag: string) {
    action.mutate({ kind, passId, etag, key: crypto.randomUUID() });
  }

  function rowAction(kind: StationAction['kind'], passId: string, etag: string) {
    const copy = ACTION_COPY[kind];
    const pending = action.isPending && action.variables.passId === passId;
    const active = pending && action.variables.kind === kind;
    return (
      <Button
        size="sm"
        disabled={pending}
        aria-busy={active}
        onClick={() => {
          run(kind, passId, etag);
        }}
      >
        {active ? <Spinner data-icon="inline-start" /> : null}
        {active ? copy.pendingLabel : copy.label}
      </Button>
    );
  }

  if (station.isPending)
    return (
      <section aria-labelledby="station-title" className="flex flex-col gap-4">
        <PageHeader title="Station" description="Loading station status." />
        <div role="status" aria-label="Loading station" className="flex flex-col gap-2">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
          <span className="sr-only">Opening station…</span>
        </div>
      </section>
    );
  if (station.isError || !data)
    return (
      <section aria-labelledby="station-title" className="flex flex-col gap-4">
        <PageHeader title="Station" />
        <Alert variant="destructive">
          <AlertTitle>Station not confirmed</AlertTitle>
          <AlertDescription>
            The station status could not be loaded. Confirmed students will reappear on retry.
          </AlertDescription>
          <AlertAction>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void station.refetch();
              }}
            >
              Retry
            </Button>
          </AlertAction>
        </Alert>
      </section>
    );
  return (
    <section aria-labelledby="station-title" className="flex flex-col gap-4">
      <PageHeader
        title={data.room.name}
        description={`${String(data.atDestination.length)} here · ${String(data.outbound.length)} on the way`}
      />
      {context.staffedRooms.length > 1 && (
        <div className="flex max-w-xs flex-col gap-1.5">
          <Label htmlFor="station-switcher">Station</Label>
          <Select
            value={roomId}
            onValueChange={(value) => {
              if (value) void navigate(`/schools/${organizationId}/stations/${value}`);
            }}
          >
            <SelectTrigger id="station-switcher">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {context.staffedRooms.map((room) => (
                <SelectItem key={room.id} value={room.id}>
                  {room.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {action.isError && (
        <Alert variant="destructive">
          <AlertTitle>Station action not confirmed</AlertTitle>
          <AlertDescription>{productMessage(action.error)}</AlertDescription>
        </Alert>
      )}
      <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StateGroup title="On the way" count={data.outbound.length} empty="No one is on the way.">
          {data.outbound.map((entry) => (
            <Item role="listitem" key={entry.passId}>
              <ItemContent>
                <ItemTitle>{entry.student.displayName}</ItemTitle>
                <ItemDescription>Departed {format(entry.departedAt)}</ItemDescription>
              </ItemContent>
              <ItemActions>{rowAction('check-in', entry.passId, entry.passEtag)}</ItemActions>
            </Item>
          ))}
        </StateGroup>
        <StateGroup
          title="Here"
          count={data.atDestination.length}
          empty="No students are checked in."
        >
          {data.atDestination.map((entry) => {
            const rowPending = action.isPending && action.variables.passId === entry.passId;
            const completing = rowPending && action.variables.kind === 'complete';
            return (
              <Item role="listitem" key={entry.passId}>
                <ItemContent>
                  <ItemTitle>{entry.student.displayName}</ItemTitle>
                  {entry.expectedReturnAt ? (
                    <ItemDescription>
                      Expected back {format(entry.expectedReturnAt)}
                    </ItemDescription>
                  ) : null}
                </ItemContent>
                <ItemActions>
                  <ButtonGroup aria-label={`Actions for ${entry.student.displayName}`}>
                    {rowAction('begin-return', entry.passId, entry.passEtag)}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={rowPending}
                      aria-busy={completing}
                      onClick={() => {
                        run('complete', entry.passId, entry.passEtag);
                      }}
                    >
                      {completing ? <Spinner data-icon="inline-start" /> : null}
                      {completing ? 'Completing…' : 'Complete here'}
                    </Button>
                  </ButtonGroup>
                </ItemActions>
              </Item>
            );
          })}
        </StateGroup>
        <StateGroup title="Ready to leave" count={data.ready.length} empty="No students are ready.">
          {data.ready.map((entry) => (
            <Item role="listitem" key={entry.passId}>
              <ItemContent>
                <ItemTitle>{entry.student.displayName}</ItemTitle>
                <ItemDescription>Start by {format(entry.readyUntil)}</ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </StateGroup>
        <StateGroup title="In line" count={data.queued.length} empty="The line is clear.">
          {data.queued.map((entry) => (
            <Item role="listitem" key={entry.passId}>
              <ItemContent>
                <ItemTitle>{entry.student.displayName}</ItemTitle>
                <ItemDescription>Joined {format(entry.enteredAt)}</ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </StateGroup>
      </div>
    </section>
  );
}
