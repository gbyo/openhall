import { useEffect, useState, type SubmitEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { api, confirmed, requireData } from '../../../api/client';
import { ApiProblem, productMessage } from '../../../api/problems';
import { queryKeys } from '../../../api/query-keys';
import { getCsrfToken } from '../../../api/session';
import { Alert } from '../../../design-system/primitives/Alert';
import { Button } from '../../../design-system/primitives/Button';
import { ConflictNotice } from '../../../design-system/patterns/ConflictNotice';
import { useSchool } from '../../../app/school/SchoolShell';
import { useUnsavedChanges } from '../../../app/useUnsavedChanges';

export function DestinationDetailPage() {
  const { organizationId } = useSchool();
  const destinationId = useParams().destinationId ?? '';
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: queryKeys.destination(destinationId),
    queryFn: async () => {
      const result = await api.GET('/api/v1/destinations/{destinationId}', {
        params: { path: { destinationId } },
      });
      return {
        destination: requireData(result).destination,
        etag: result.response.headers.get('etag') ?? '',
      };
    },
  });
  const locations = useQuery({
    queryKey: queryKeys.locations(organizationId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/locations', {
          params: { path: { organizationId } },
        }),
      ),
  });
  const [draft, setDraft] = useState<NonNullable<typeof detail.data>['destination'] | null>(null);
  useEffect(() => {
    if (detail.data && draft === null) setDraft(detail.data.destination);
  }, [detail.data, draft]);
  const dirty = Boolean(
    detail.data && draft && JSON.stringify(detail.data.destination) !== JSON.stringify(draft),
  );
  useUnsavedChanges(dirty);
  const mutation = useMutation({
    mutationFn: async ({ kind }: { kind: 'save' | 'open' | 'close' | 'archive' }) => {
      if (!detail.data || !draft) throw new Error('Destination unavailable');
      const key = crypto.randomUUID();
      const headers = {
        'X-CSRF-Token': getCsrfToken(),
        'Idempotency-Key': key,
        'If-Match': detail.data.etag,
      };
      const params = {
        path: { destinationId },
        header: { 'idempotency-key': key, 'if-match': detail.data.etag },
      };
      if (kind === 'save')
        return confirmed(
          api.PUT('/api/v1/destinations/{destinationId}', {
            params,
            headers,
            body: {
              locationId: draft.locationId,
              serviceType: draft.serviceType,
              displayName: draft.displayName,
              capacity: draft.capacity,
              queueEnabled: draft.queueEnabled,
              checkInMode: draft.checkInMode,
              defaultDurationSeconds: draft.defaultDurationSeconds,
              maxDurationSeconds: draft.maxDurationSeconds,
              readyClaimTimeoutSeconds: draft.readyClaimTimeoutSeconds,
              queueTimeoutSeconds: draft.queueTimeoutSeconds,
            },
          }),
        );
      if (kind === 'open')
        return confirmed(
          api.POST('/api/v1/destinations/{destinationId}/open', { params, headers }),
        );
      if (kind === 'close')
        return confirmed(
          api.POST('/api/v1/destinations/{destinationId}/close', { params, headers }),
        );
      return confirmed(
        api.POST('/api/v1/destinations/{destinationId}/archive', { params, headers }),
      );
    },
    onSuccess: () => {
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.destination(destinationId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.destinations(organizationId) });
    },
  });
  if (!draft) return <p role="status">Loading destination…</p>;
  const conflict = mutation.error instanceof ApiProblem && mutation.error.status === 412;
  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    mutation.mutate({ kind: 'save' });
  }
  return (
    <section className="workspace">
      <header className="workspace__header">
        <p className="auth-kicker">Destination</p>
        <h1 className="wf-type-page-title">{draft.displayName ?? draft.serviceType}</h1>
        <p>
          {draft.status === 'active' ? 'Open' : draft.status === 'closed' ? 'Closed' : 'Archived'}
        </p>
      </header>
      {conflict && <ConflictNotice onReview={() => void detail.refetch()} />}
      {mutation.isError && !conflict && (
        <Alert tone="danger" title="Changes not saved">
          <p>{productMessage(mutation.error)}</p>
        </Alert>
      )}
      <form className="editor" onSubmit={submit}>
        <fieldset>
          <legend>General</legend>
          <label>
            Display name
            <input
              className="wf-input"
              value={draft.displayName ?? ''}
              onChange={(event) => {
                setDraft({ ...draft, displayName: event.target.value || null });
              }}
            />
          </label>
          <label>
            Location
            <select
              className="wf-input"
              value={draft.locationId}
              onChange={(event) => {
                setDraft({ ...draft, locationId: event.target.value });
              }}
            >
              {locations.data?.locations.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Type
            <input
              className="wf-input"
              value={draft.serviceType}
              onChange={(event) => {
                setDraft({ ...draft, serviceType: event.target.value });
              }}
            />
          </label>
        </fieldset>
        <fieldset>
          <legend>Movement</legend>
          <label>
            Capacity
            <input
              className="wf-input"
              type="number"
              min="1"
              value={draft.capacity ?? ''}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  capacity: event.target.value ? Number(event.target.value) : null,
                });
              }}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={draft.queueEnabled}
              onChange={(event) => {
                setDraft({ ...draft, queueEnabled: event.target.checked });
              }}
            />{' '}
            Queue students when full
          </label>
          <label>
            Check-in
            <select
              className="wf-input"
              value={draft.checkInMode}
              onChange={(event) => {
                setDraft({ ...draft, checkInMode: event.target.value as typeof draft.checkInMode });
              }}
            >
              <option value="none">No check-in</option>
              <option value="optional">Optional check-in</option>
              <option value="required">Station check-in required</option>
            </select>
          </label>
        </fieldset>
        <fieldset>
          <legend>Timing</legend>
          <label>
            Expected minutes
            <input
              className="wf-input"
              type="number"
              value={(draft.defaultDurationSeconds ?? 0) / 60}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  defaultDurationSeconds: Number(event.target.value) * 60 || null,
                });
              }}
            />
          </label>
          <label>
            Maximum minutes
            <input
              className="wf-input"
              type="number"
              value={(draft.maxDurationSeconds ?? 0) / 60}
              onChange={(event) => {
                setDraft({ ...draft, maxDurationSeconds: Number(event.target.value) * 60 || null });
              }}
            />
          </label>
          {draft.queueEnabled && (
            <>
              <label>
                Ready window (minutes)
                <input
                  className="wf-input"
                  type="number"
                  value={draft.readyClaimTimeoutSeconds / 60}
                  onChange={(event) => {
                    setDraft({
                      ...draft,
                      readyClaimTimeoutSeconds: Number(event.target.value) * 60,
                    });
                  }}
                />
              </label>
              <label>
                Maximum queue wait (minutes)
                <input
                  className="wf-input"
                  type="number"
                  value={draft.queueTimeoutSeconds / 60}
                  onChange={(event) => {
                    setDraft({ ...draft, queueTimeoutSeconds: Number(event.target.value) * 60 });
                  }}
                />
              </label>
            </>
          )}
        </fieldset>
        <div className="editor__actions">
          <Button type="submit" pending={mutation.isPending}>
            Save changes
          </Button>
          <Button
            type="button"
            variant="quiet"
            onClick={() => {
              setDraft(detail.data?.destination ?? null);
            }}
          >
            Cancel
          </Button>
        </div>
      </form>
      <div className="semantic-actions">
        {draft.status === 'closed' && (
          <Button
            variant="secondary"
            onClick={() => {
              mutation.mutate({ kind: 'open' });
            }}
          >
            Open destination
          </Button>
        )}
        {draft.status === 'active' && (
          <Button
            variant="secondary"
            onClick={() => {
              mutation.mutate({ kind: 'close' });
            }}
          >
            Close destination
          </Button>
        )}
        {draft.status !== 'archived' && (
          <Button
            variant="danger"
            onClick={() => {
              mutation.mutate({ kind: 'archive' });
            }}
          >
            Archive destination
          </Button>
        )}
      </div>
    </section>
  );
}
