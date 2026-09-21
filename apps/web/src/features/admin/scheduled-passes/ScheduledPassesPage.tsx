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

function instant(local: string, timeZone: string): string {
  return Temporal.PlainDateTime.from(local).toZonedDateTime(timeZone).toInstant().toString();
}

export function Component() {
  const { organizationId, context } = useSchool();
  const queryClient = useQueryClient();
  const [origin, setOrigin] = useState<'expected' | 'specific'>('expected');
  const appointments = useQuery({
    queryKey: queryKeys.scheduledAdmin(organizationId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/scheduled-authorizations', {
          params: { path: { organizationId } },
        }),
      ),
  });
  const students = useQuery({
    queryKey: ['scheduled-students', organizationId],
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/students', {
          params: { path: { organizationId }, query: { limit: 100 } },
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
  const locations = useQuery({
    queryKey: queryKeys.locations(organizationId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/locations', {
          params: { path: { organizationId } },
        }),
      ),
  });
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: queryKeys.scheduledAdmin(organizationId) });
  const create = useMutation({
    mutationFn: (input: {
      key: string;
      body: {
        studentId: string;
        destinationId: string;
        validFrom: string;
        validUntil: string;
        approvalMode: 'preapproved' | 'approval_required';
        origin: { strategy: 'expected' } | { strategy: 'specific'; locationId: string };
      };
    }) => {
      return confirmed(
        api.POST('/api/v1/organizations/{organizationId}/scheduled-authorizations', {
          params: { path: { organizationId }, header: { 'idempotency-key': input.key } },
          headers: { 'X-CSRF-Token': getCsrfToken(), 'Idempotency-Key': input.key },
          body: input.body,
        }),
      );
    },
    onSuccess: refresh,
  });
  const cancel = useMutation({
    mutationFn: async (input: { id: string; key: string }) => {
      const detail = await api.GET('/api/v1/scheduled-authorizations/{scheduledAuthorizationId}', {
        params: { path: { scheduledAuthorizationId: input.id } },
      });
      requireData(detail);
      const etag = detail.response.headers.get('etag') ?? '';
      return confirmed(
        api.POST('/api/v1/scheduled-authorizations/{scheduledAuthorizationId}/cancel', {
          params: {
            path: { scheduledAuthorizationId: input.id },
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
    create.mutate({
      key: crypto.randomUUID(),
      body: {
        studentId: formString(data, 'studentId'),
        destinationId: formString(data, 'destinationId'),
        validFrom: instant(formString(data, 'validFrom'), context.organization.timeZone),
        validUntil: instant(formString(data, 'validUntil'), context.organization.timeZone),
        approvalMode: formString(data, 'approvalMode') as 'preapproved' | 'approval_required',
        origin:
          origin === 'expected'
            ? { strategy: 'expected' }
            : { strategy: 'specific', locationId: formString(data, 'locationId') },
      },
    });
  }
  function beginCancel(id: string, studentName: string, destinationName: string) {
    if (!window.confirm(`Cancel ${studentName}'s scheduled pass to ${destinationName}?`)) return;
    cancel.mutate({ id, key: crypto.randomUUID() });
  }
  return (
    <section className="workspace">
      <header className="workspace__header">
        <p className="auth-kicker">Appointments · {context.organization.timeZone}</p>
        <h1 className="wf-type-page-title">Scheduled passes</h1>
        <p>Give a student a specific window to start an ordinary WayPass.</p>
      </header>
      {(create.isError || cancel.isError) && (
        <Alert tone="danger" title="Scheduled pass change not confirmed">
          <p>{productMessage(create.error ?? cancel.error)}</p>
          {create.error instanceof UncertainCommandError && create.variables && (
            <Button
              variant="secondary"
              onClick={() => {
                create.mutate(create.variables);
              }}
            >
              Check again
            </Button>
          )}
          {cancel.error instanceof UncertainCommandError && cancel.variables && (
            <Button
              variant="secondary"
              onClick={() => {
                cancel.mutate(cancel.variables);
              }}
            >
              Check again
            </Button>
          )}
        </Alert>
      )}
      <form className="editor" onSubmit={submit}>
        <fieldset>
          <legend>New scheduled pass</legend>
          <label>
            Student
            <select className="wf-input" name="studentId" required>
              {students.data?.students.map((student) => (
                <option key={student.id} value={student.id}>
                  {student.displayName}
                  {student.gradeLevel ? ` · grade ${student.gradeLevel}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            Destination
            <select className="wf-input" name="destinationId" required>
              {destinations.data?.destinations
                .filter((item) => item.status === 'active')
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.displayName ?? item.serviceType}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Available from
            <input className="wf-input" type="datetime-local" name="validFrom" required />
          </label>
          <label>
            Available until
            <input className="wf-input" type="datetime-local" name="validUntil" required />
          </label>
          <label>
            Origin
            <select
              className="wf-input"
              value={origin}
              onChange={(event) => {
                setOrigin(event.target.value as typeof origin);
              }}
            >
              <option value="expected">Use student's expected class or location</option>
              <option value="specific">Specific location</option>
            </select>
          </label>
          {origin === 'specific' && (
            <label>
              Location
              <select className="wf-input" name="locationId">
                {locations.data?.locations
                  .filter((item) => item.status !== 'archived')
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <label>
            Approval
            <select className="wf-input" name="approvalMode">
              <option value="preapproved">Already approved</option>
              <option value="approval_required">Teacher approval still required</option>
            </select>
          </label>
          <p className="form-help">
            Already approved skips only ordinary classroom approval for this appointment. Other
            school policies still apply.
          </p>
        </fieldset>
        <Button type="submit" pending={create.isPending}>
          Schedule pass
        </Button>
      </form>
      <ul className="plain-list">
        {appointments.data?.authorizations.map((item) => {
          const effectiveStatus =
            item.status === 'active' &&
            Temporal.Instant.compare(
              Temporal.Instant.from(item.validUntil),
              Temporal.Now.instant(),
            ) <= 0
              ? 'expired'
              : item.status;
          return (
            <li key={item.id}>
              <div>
                <strong>{item.student.displayName}</strong>
                <span>{item.destination.displayName}</span>
              </div>
              <span>
                <time>
                  {new Intl.DateTimeFormat([], {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                    timeZone: context.organization.timeZone,
                  }).format(new Date(item.validFrom))}
                </time>
              </span>
              <span>
                {effectiveStatus[0]?.toUpperCase()}
                {effectiveStatus.slice(1)}
              </span>
              {effectiveStatus === 'active' && (
                <Button
                  variant="danger"
                  onClick={() => {
                    beginCancel(item.id, item.student.displayName, item.destination.displayName);
                  }}
                >
                  Cancel
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
