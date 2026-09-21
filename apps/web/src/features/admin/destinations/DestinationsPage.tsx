import { useState, type SubmitEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, confirmed } from '../../../api/client';
import { queryKeys } from '../../../api/query-keys';
import { getCsrfToken } from '../../../api/session';
import { formString } from '../../../api/forms';
import { Button } from '../../../design-system/primitives/Button';
import { useSchool } from '../../../app/school/SchoolShell';

export function DestinationsPage() {
  const { organizationId } = useSchool();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const destinations = useQuery({
    queryKey: queryKeys.destinations(organizationId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/destinations', {
          params: { path: { organizationId } },
        }),
      ),
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
  const create = useMutation({
    mutationFn: (body: { locationId: string; displayName: string | null; serviceType: string }) => {
      const key = crypto.randomUUID();
      return confirmed(
        api.POST('/api/v1/organizations/{organizationId}/destinations', {
          params: { path: { organizationId }, header: { 'idempotency-key': key } },
          headers: { 'X-CSRF-Token': getCsrfToken(), 'Idempotency-Key': key },
          body: {
            ...body,
            capacity: null,
            queueEnabled: false,
            checkInMode: 'none',
            defaultDurationSeconds: 600,
            maxDurationSeconds: 1200,
            readyClaimTimeoutSeconds: 120,
            queueTimeoutSeconds: 1800,
          },
        }),
      );
    },
    onSuccess: () => {
      setCreating(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.destinations(organizationId) });
    },
  });
  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    create.mutate({
      locationId: formString(data, 'locationId'),
      displayName: formString(data, 'displayName') || null,
      serviceType: formString(data, 'serviceType'),
    });
  }
  return (
    <section className="workspace">
      <header className="workspace__header workspace__header--actions">
        <div>
          <p className="auth-kicker">Configuration</p>
          <h1 className="wf-type-page-title">Destinations</h1>
          <p>New destinations start closed and open only after review.</p>
        </div>
        <Button
          onClick={() => {
            setCreating((value) => !value);
          }}
        >
          New destination
        </Button>
      </header>
      {creating && (
        <form className="inline-form" onSubmit={submit}>
          <label>
            Display name
            <input className="wf-input" name="displayName" required />
          </label>
          <label>
            Type
            <input className="wf-input" name="serviceType" required />
          </label>
          <label>
            Location
            <select className="wf-input" name="locationId" required>
              {locations.data?.locations
                .filter((item) => item.status !== 'archived')
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
          </label>
          <Button type="submit" pending={create.isPending}>
            Save closed destination
          </Button>
        </form>
      )}
      <div className="data-table data-table--destinations">
        <div className="data-table__head">
          <span>Destination</span>
          <span>Location</span>
          <span>Capacity</span>
          <span>Queue</span>
          <span>Check-in</span>
          <span>Status</span>
        </div>
        {destinations.data?.destinations.map((destination) => (
          <Link className="data-table__row" key={destination.id} to={destination.id}>
            <strong>{destination.displayName ?? destination.serviceType}</strong>
            <span>
              {locations.data?.locations.find((location) => location.id === destination.locationId)
                ?.name ?? '—'}
            </span>
            <span>{destination.capacity ?? 'No limit'}</span>
            <span>{destination.queueEnabled ? 'On' : 'Off'}</span>
            <span>
              {destination.checkInMode === 'required'
                ? 'Station required'
                : destination.checkInMode === 'optional'
                  ? 'Optional'
                  : 'None'}
            </span>
            <span>
              {destination.status === 'active'
                ? 'Open'
                : destination.status === 'closed'
                  ? 'Closed'
                  : 'Archived'}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
