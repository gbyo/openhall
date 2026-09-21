import { useState, type SubmitEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Temporal } from '@js-temporal/polyfill';
import { api, confirmed, requireData } from '../../../api/client';
import { productMessage, UncertainCommandError } from '../../../api/problems';
import { queryKeys } from '../../../api/query-keys';
import { getCsrfToken } from '../../../api/session';
import { formString } from '../../../api/forms';
import { Button } from '../../../design-system/primitives/Button';
import { Alert } from '../../../design-system/primitives/Alert';
import { useSchool } from '../../../app/school/SchoolShell';

const roleLabel = {
  destination_staff: 'Destination staff',
  counselor: 'Counselor',
  office_staff: 'Office staff',
  school_admin: 'School administrator',
} as const;

function optionalInstant(local: string, timeZone: string): string | null {
  return local
    ? Temporal.PlainDateTime.from(local).toZonedDateTime(timeZone).toInstant().toString()
    : null;
}

export function Component() {
  const { organizationId, context } = useSchool();
  const queryClient = useQueryClient();
  const [role, setRole] = useState<keyof typeof roleLabel>('destination_staff');
  const grants = useQuery({
    queryKey: queryKeys.grants(organizationId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/authorization-grants', {
          params: { path: { organizationId } },
        }),
      ),
  });
  const people = useQuery({
    queryKey: queryKeys.people(organizationId, '', 'staff'),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/people', {
          params: { path: { organizationId }, query: { affiliation: 'staff', limit: 100 } },
        }),
      ),
  });
  const destinations = useQuery({
    queryKey: queryKeys.destinations(organizationId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/destinations', {
          params: { path: { organizationId } },
        }),
      ),
  });
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: queryKeys.grants(organizationId) });
  const issue = useMutation({
    mutationFn: (input: {
      key: string;
      body: {
        personId: string;
        role: keyof typeof roleLabel;
        destinationId: string | null;
        validFrom: string | null;
        validUntil: string | null;
      };
    }) => {
      return confirmed(
        api.POST('/api/v1/organizations/{organizationId}/authorization-grants', {
          params: { path: { organizationId }, header: { 'idempotency-key': input.key } },
          headers: { 'X-CSRF-Token': getCsrfToken(), 'Idempotency-Key': input.key },
          body: input.body,
        }),
      );
    },
    onSuccess: refresh,
  });
  const revoke = useMutation({
    mutationFn: async (input: { grantId: string; key: string }) => {
      const detail = await api.GET('/api/v1/authorization-grants/{grantId}', {
        params: { path: { grantId: input.grantId } },
      });
      requireData(detail);
      const etag = detail.response.headers.get('etag') ?? '';
      return confirmed(
        api.POST('/api/v1/authorization-grants/{grantId}/revoke', {
          params: {
            path: { grantId: input.grantId },
            header: { 'idempotency-key': input.key, 'if-match': etag },
          },
          headers: {
            'X-CSRF-Token': getCsrfToken(),
            'Idempotency-Key': input.key,
            'If-Match': etag,
          },
        }),
      );
    },
    onSuccess: refresh,
  });
  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    issue.mutate({
      key: crypto.randomUUID(),
      body: {
        personId: formString(data, 'personId'),
        role,
        destinationId: role === 'destination_staff' ? formString(data, 'destinationId') : null,
        validFrom: optionalInstant(formString(data, 'validFrom'), context.organization.timeZone),
        validUntil: optionalInstant(formString(data, 'validUntil'), context.organization.timeZone),
      },
    });
  }
  function beginRevoke(grant: NonNullable<typeof grants.data>['grants'][number]) {
    const scope = grant.destination?.displayName ?? context.organization.name;
    if (
      !window.confirm(
        `Remove ${roleLabel[grant.role]} access for ${grant.person.displayName}? They will no longer be able to use ${scope} tools.`,
      )
    )
      return;
    revoke.mutate({ grantId: grant.id, key: crypto.randomUUID() });
  }
  return (
    <section className="workspace">
      <header className="workspace__header">
        <p className="auth-kicker">Permissions</p>
        <h1 className="wf-type-page-title">Staff access</h1>
        <p>
          Assign a specific school duty. Teacher and student access comes from school records, not
          this page.
        </p>
      </header>
      {(issue.isError || revoke.isError) && (
        <Alert tone="danger" title="Access change not confirmed">
          <p>{productMessage(issue.error ?? revoke.error)}</p>
          {issue.error instanceof UncertainCommandError && issue.variables && (
            <Button
              variant="secondary"
              onClick={() => {
                issue.mutate(issue.variables);
              }}
            >
              Check again
            </Button>
          )}
          {revoke.error instanceof UncertainCommandError && revoke.variables && (
            <Button
              variant="secondary"
              onClick={() => {
                revoke.mutate(revoke.variables);
              }}
            >
              Check again
            </Button>
          )}
        </Alert>
      )}
      <form className="inline-form" onSubmit={submit}>
        <label>
          Staff member
          <select className="wf-input" name="personId" required>
            {people.data?.people.map((person) => (
              <option key={person.personId} value={person.personId}>
                {person.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Duty
          <select
            className="wf-input"
            name="role"
            value={role}
            onChange={(event) => {
              setRole(event.target.value as keyof typeof roleLabel);
            }}
          >
            {Object.entries(roleLabel).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {role === 'destination_staff' && (
          <label>
            Destination
            <select className="wf-input" name="destinationId" required>
              {destinations.data?.destinations
                .filter((destination) => destination.status !== 'archived')
                .map((destination) => (
                  <option key={destination.id} value={destination.id}>
                    {destination.displayName ?? destination.serviceType}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label>
          Starts (optional)
          <input className="wf-input" type="datetime-local" name="validFrom" />
        </label>
        <label>
          Ends (optional)
          <input className="wf-input" type="datetime-local" name="validUntil" />
        </label>
        <Button type="submit" pending={issue.isPending}>
          Grant access
        </Button>
      </form>
      <div className="data-table">
        <div className="data-table__head">
          <span>Person</span>
          <span>Duty</span>
          <span>Scope</span>
          <span>Status</span>
          <span>Action</span>
        </div>
        {grants.data?.grants.map((grant) => (
          <div className="data-table__row" key={grant.id}>
            <strong>{grant.person.displayName}</strong>
            <span>{roleLabel[grant.role]}</span>
            <span>{grant.destination?.displayName ?? 'Whole school'}</span>
            <span>{grant.status === 'active' ? 'Active' : 'Revoked'}</span>
            <span>
              {grant.status === 'active' && (
                <Button
                  variant="danger"
                  pending={revoke.isPending && revoke.variables.grantId === grant.id}
                  onClick={() => {
                    beginRevoke(grant);
                  }}
                >
                  Remove access
                </Button>
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
