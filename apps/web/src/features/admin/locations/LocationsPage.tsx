import { useState, type SubmitEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, confirmed, requireData } from '../../../api/client';
import { queryKeys } from '../../../api/query-keys';
import { getCsrfToken } from '../../../api/session';
import { formString } from '../../../api/forms';
import { Button } from '../../../design-system/primitives/Button';
import { useSchool } from '../../../app/school/SchoolShell';

function command(ifMatch?: string) {
  const key = crypto.randomUUID();
  return {
    headers: {
      'X-CSRF-Token': getCsrfToken(),
      'Idempotency-Key': key,
      ...(ifMatch ? { 'If-Match': ifMatch } : {}),
    },
    header: { 'idempotency-key': key, ...(ifMatch ? { 'if-match': ifMatch } : {}) },
  };
}

export function Component() {
  const { organizationId } = useSchool();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const locations = useQuery({
    queryKey: queryKeys.locations(organizationId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/locations', {
          params: { path: { organizationId } },
        }),
      ),
  });
  const detail = useQuery({
    queryKey: ['location', selected],
    enabled: Boolean(selected),
    queryFn: async () => {
      const result = await api.GET('/api/v1/locations/{locationId}', {
        params: { path: { locationId: selected ?? '' } },
      });
      return {
        location: requireData(result).location,
        etag: result.response.headers.get('etag') ?? '',
      };
    },
  });
  const refresh = () => {
    setSelected(null);
    void queryClient.invalidateQueries({ queryKey: queryKeys.locations(organizationId) });
  };
  const create = useMutation({
    mutationFn: (body: {
      name: string;
      kind: string;
      parentLocationId: string | null;
      code: string | null;
      floorLabel: string | null;
    }) => {
      const request = command();
      return confirmed(
        api.POST('/api/v1/organizations/{organizationId}/locations', {
          params: { path: { organizationId }, header: request.header },
          headers: request.headers,
          body,
        }),
      );
    },
    onSuccess: refresh,
  });
  const save = useMutation({
    mutationFn: async ({ form, archive }: { form: FormData; archive: boolean }) => {
      if (!selected || !detail.data) throw new Error('Location unavailable');
      const request = command(detail.data.etag);
      if (archive)
        return confirmed(
          api.POST('/api/v1/locations/{locationId}/archive', {
            params: { path: { locationId: selected }, header: request.header },
            headers: request.headers,
          }),
        );
      return confirmed(
        api.PUT('/api/v1/locations/{locationId}', {
          params: { path: { locationId: selected }, header: request.header },
          headers: request.headers,
          body: {
            name: formString(form, 'name'),
            kind: formString(form, 'kind'),
            parentLocationId: formString(form, 'parentLocationId') || null,
            code: formString(form, 'code') || null,
            floorLabel: formString(form, 'floorLabel') || null,
          },
        }),
      );
    },
    onSuccess: refresh,
  });
  function submitCreate(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    create.mutate({
      name: formString(data, 'name'),
      kind: formString(data, 'kind'),
      parentLocationId: formString(data, 'parentLocationId') || null,
      code: formString(data, 'code') || null,
      floorLabel: formString(data, 'floorLabel') || null,
    });
    event.currentTarget.reset();
  }
  return (
    <section className="workspace">
      <header className="workspace__header">
        <p className="auth-kicker">Destination setup</p>
        <h1 className="wf-type-page-title">Locations</h1>
        <p>Organize rooms and shared spaces. Archiving preserves historical movement.</p>
      </header>
      <form className="inline-form" onSubmit={submitCreate}>
        <label>
          Name
          <input className="wf-input" name="name" required />
        </label>
        <label>
          Type
          <input className="wf-input" name="kind" defaultValue="room" required />
        </label>
        <label>
          Parent
          <select className="wf-input" name="parentLocationId">
            <option value="">No parent</option>
            {locations.data?.locations
              .filter((item) => item.status !== 'archived')
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Code
          <input className="wf-input" name="code" />
        </label>
        <label>
          Floor
          <input className="wf-input" name="floorLabel" />
        </label>
        <Button type="submit" pending={create.isPending}>
          Add location
        </Button>
      </form>
      <div className="data-table">
        <div className="data-table__head">
          <span>Location</span>
          <span>Type</span>
          <span>Floor</span>
          <span>Status</span>
          <span>Action</span>
        </div>
        {locations.data?.locations.map((location) => (
          <div className="data-table__row" key={location.id}>
            <strong>{location.name}</strong>
            <span>{location.kind}</span>
            <span>{location.floorLabel ?? '—'}</span>
            <span>{location.status === 'archived' ? 'Archived' : 'Active'}</span>
            <Button
              variant="quiet"
              onClick={() => {
                setSelected(location.id);
              }}
            >
              Edit
            </Button>
          </div>
        ))}
      </div>
      {selected && detail.data && (
        <form
          className="editor editor--compact"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate({ form: new FormData(event.currentTarget), archive: false });
          }}
        >
          <fieldset>
            <legend>Edit location</legend>
            <label>
              Name
              <input
                className="wf-input"
                name="name"
                defaultValue={detail.data.location.name}
                required
              />
            </label>
            <label>
              Type
              <input
                className="wf-input"
                name="kind"
                defaultValue={detail.data.location.kind}
                required
              />
            </label>
            <label>
              Parent
              <select
                className="wf-input"
                name="parentLocationId"
                defaultValue={detail.data.location.parentLocationId ?? ''}
              >
                <option value="">No parent</option>
                {locations.data?.locations
                  .filter((item) => item.id !== selected && item.status !== 'archived')
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Code
              <input
                className="wf-input"
                name="code"
                defaultValue={detail.data.location.code ?? ''}
              />
            </label>
            <label>
              Floor
              <input
                className="wf-input"
                name="floorLabel"
                defaultValue={detail.data.location.floorLabel ?? ''}
              />
            </label>
          </fieldset>
          <div className="editor__actions">
            <Button type="submit" pending={save.isPending}>
              Save changes
            </Button>
            <Button
              type="button"
              variant="quiet"
              onClick={() => {
                setSelected(null);
              }}
            >
              Cancel
            </Button>
            {detail.data.location.status !== 'archived' && (
              <Button
                type="button"
                variant="danger"
                onClick={() => {
                  save.mutate({ form: new FormData(), archive: true });
                }}
              >
                Archive
              </Button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
