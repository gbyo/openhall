import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router';
import { api, confirmed } from '../../api/client';
import { productMessage } from '../../api/problems';
import { queryKeys } from '../../api/query-keys';
import { getCsrfToken } from '../../api/session';
import { Alert } from '../../design-system/primitives/Alert';
import { Button } from '../../design-system/primitives/Button';
import { useSchool } from '../../app/school/SchoolShell';

interface StationAction {
  kind: 'check-in' | 'begin-return' | 'complete';
  passId: string;
  etag: string;
  key: string;
}

export function StationPage() {
  const { context, organizationId } = useSchool();
  const navigate = useNavigate();
  const destinationId = useParams().destinationId ?? context.staffedDestinations[0]?.id ?? '';
  const queryClient = useQueryClient();
  const station = useQuery({
    queryKey: queryKeys.station(destinationId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/destinations/{destinationId}/station', {
          params: { path: { destinationId } },
        }),
      ),
    staleTime: 3_000,
    refetchOnWindowFocus: true,
  });
  const action = useMutation({
    mutationFn: (input: StationAction) => {
      const options = {
        params: {
          path: { destinationId, passId: input.passId },
          header: { 'idempotency-key': input.key, 'if-match': input.etag },
        },
        headers: {
          'X-CSRF-Token': getCsrfToken(),
          'Idempotency-Key': input.key,
          'If-Match': input.etag,
        },
      } as const;
      return input.kind === 'check-in'
        ? confirmed(
            api.POST('/api/v1/destinations/{destinationId}/passes/{passId}/check-in', options),
          )
        : input.kind === 'begin-return'
          ? confirmed(
              api.POST(
                '/api/v1/destinations/{destinationId}/passes/{passId}/begin-return',
                options,
              ),
            )
          : confirmed(
              api.POST('/api/v1/destinations/{destinationId}/passes/{passId}/complete', options),
            );
    },
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: queryKeys.station(destinationId) }),
    onError: () =>
      void queryClient.invalidateQueries({ queryKey: queryKeys.station(destinationId) }),
  });
  const data = station.data;
  if (!data)
    return (
      <section className="station">
        <p role="status">Opening station…</p>
      </section>
    );
  const run = (kind: StationAction['kind'], passId: string, etag: string) => {
    action.mutate({ kind, passId, etag, key: crypto.randomUUID() });
  };
  return (
    <section className="station" aria-labelledby="station-title">
      <header className="station__header">
        <div>
          <p className="auth-kicker">Destination station</p>
          <h1 className="wf-type-page-title" id="station-title">
            {data.destination.displayName}
          </h1>
        </div>
        <p>
          <strong>{data.atDestination.length}</strong> here ·{' '}
          <strong>{data.outbound.length}</strong> on the way
        </p>
      </header>
      {context.staffedDestinations.length > 1 && (
        <label className="station__switcher">
          Station
          <select
            className="wf-input"
            value={destinationId}
            onChange={(event) => {
              void navigate(`/schools/${organizationId}/stations/${event.target.value}`);
            }}
          >
            {context.staffedDestinations.map((destination) => (
              <option key={destination.id} value={destination.id}>
                {destination.displayName}
              </option>
            ))}
          </select>
        </label>
      )}
      {action.isError && (
        <Alert tone="danger" title="Station action not confirmed">
          <p>{productMessage(action.error)}</p>
        </Alert>
      )}
      <div className="station__groups">
        <StationGroup title="On the way" empty="No one is on the way.">
          {data.outbound.map((entry) => (
            <StationRow
              key={entry.passId}
              name={entry.student.displayName}
              detail={`Departed ${format(entry.departedAt)}`}
              action={
                <Button
                  pending={action.isPending && action.variables.passId === entry.passId}
                  onClick={() => {
                    run('check-in', entry.passId, entry.passEtag);
                  }}
                >
                  Check in
                </Button>
              }
            />
          ))}
        </StationGroup>
        <StationGroup title="Here" empty="No students are checked in.">
          {data.atDestination.map((entry) => (
            <StationRow
              key={entry.passId}
              name={entry.student.displayName}
              {...(entry.expectedReturnAt
                ? { detail: `Expected back ${format(entry.expectedReturnAt)}` }
                : {})}
              action={
                <>
                  <Button
                    pending={action.isPending && action.variables.passId === entry.passId}
                    onClick={() => {
                      run('begin-return', entry.passId, entry.passEtag);
                    }}
                  >
                    Begin return
                  </Button>
                  <Button
                    variant="quiet"
                    onClick={() => {
                      run('complete', entry.passId, entry.passEtag);
                    }}
                  >
                    Complete here
                  </Button>
                </>
              }
            />
          ))}
        </StationGroup>
        <StationGroup title="Ready to leave" empty="No students are ready.">
          {data.ready.map((entry) => (
            <StationRow
              key={entry.passId}
              name={entry.student.displayName}
              detail={`Start by ${format(entry.readyUntil)}`}
            />
          ))}
        </StationGroup>
        <StationGroup title="In line" empty="The line is clear.">
          {data.queued.map((entry) => (
            <StationRow
              key={entry.passId}
              name={entry.student.displayName}
              detail={`Joined ${format(entry.enteredAt)}`}
            />
          ))}
        </StationGroup>
      </div>
    </section>
  );
}

function format(value: string): string {
  return new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' }).format(
    new Date(value),
  );
}
function StationGroup({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section className="station-group">
      <h2>{title}</h2>
      <div>{Array.isArray(children) && children.length === 0 ? <p>{empty}</p> : children}</div>
    </section>
  );
}
function StationRow({
  name,
  detail,
  action,
}: {
  name: string;
  detail?: string;
  action?: React.ReactNode;
}) {
  return (
    <article className="station-row">
      <div>
        <strong>{name}</strong>
        {detail && <span>{detail}</span>}
      </div>
      {action && <div className="station-row__actions">{action}</div>}
    </article>
  );
}
