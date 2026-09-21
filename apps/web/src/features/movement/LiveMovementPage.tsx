import { useState, type SubmitEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, confirmed } from '../../api/client';
import { formString } from '../../api/forms';
import { productMessage, UncertainCommandError } from '../../api/problems';
import { queryKeys } from '../../api/query-keys';
import { getCsrfToken } from '../../api/session';
import { Alert } from '../../design-system/primitives/Alert';
import { Button } from '../../design-system/primitives/Button';
import { SearchField } from '../../design-system/primitives/SearchField';
import { useSchool } from '../../app/school/SchoolShell';

export function LiveMovementPage() {
  const { organizationId, context } = useSchool();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const canCreate =
    context.capabilities.includes('pass.create.student') &&
    context.capabilities.includes('scheduled_authorization.manage');
  const live = useQuery({
    queryKey: queryKeys.schoolLive(organizationId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/passes/live', {
          params: { path: { organizationId } },
        }),
      ),
    staleTime: 5_000,
  });
  const rows =
    live.data?.passes.filter((pass) =>
      `${pass.student.displayName} ${pass.destination.displayName}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    ) ?? [];
  const students = useQuery({
    queryKey: ['operational-students', organizationId],
    enabled: creating && canCreate,
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/students', {
          params: { path: { organizationId }, query: { limit: 100 } },
        }),
      ),
  });
  const destinations = useQuery({
    queryKey: queryKeys.destinations(organizationId),
    enabled: creating && canCreate,
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/me/organizations/{organizationId}/destinations', {
          params: { path: { organizationId } },
        }),
      ),
  });
  const create = useMutation({
    mutationFn: (input: { studentId: string; destinationId: string; idempotencyKey: string }) =>
      confirmed(
        api.POST('/api/v1/students/{studentId}/passes', {
          params: {
            path: { studentId: input.studentId },
            header: { 'idempotency-key': input.idempotencyKey },
          },
          headers: {
            'X-CSRF-Token': getCsrfToken(),
            'Idempotency-Key': input.idempotencyKey,
          },
          body: { destinationId: input.destinationId },
        }),
      ),
    onSuccess: () => {
      setCreating(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.schoolLive(organizationId) });
    },
  });
  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    create.mutate({
      studentId: formString(data, 'studentId'),
      destinationId: formString(data, 'destinationId'),
      idempotencyKey: crypto.randomUUID(),
    });
  }
  return (
    <section className="workspace" aria-labelledby="movement-title">
      <header className="workspace__header">
        <p className="auth-kicker">School operations</p>
        <h1 className="wf-type-page-title" id="movement-title">
          Live movement
        </h1>
        <p>Only server-confirmed movement appears here.</p>
      </header>
      {canCreate && (
        <div className="workspace__actions">
          <Button
            variant="secondary"
            onClick={() => {
              setCreating((value) => !value);
            }}
          >
            Create pass
          </Button>
        </div>
      )}
      {creating && (
        <form className="inline-form" onSubmit={submit}>
          <label>
            Student
            <select className="wf-input" name="studentId" required>
              {students.data?.students.map((student) => (
                <option key={student.id} value={student.id}>
                  {student.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Destination
            <select className="wf-input" name="destinationId" required>
              {destinations.data?.destinations.map((destination) => (
                <option key={destination.id} value={destination.id}>
                  {destination.displayName}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" pending={create.isPending}>
            Create pass
          </Button>
          <Button
            type="button"
            variant="quiet"
            onClick={() => {
              setCreating(false);
            }}
          >
            Cancel
          </Button>
        </form>
      )}
      {create.isError && (
        <Alert tone="danger" title="Pass not confirmed">
          <p>{productMessage(create.error)}</p>
          {create.error instanceof UncertainCommandError && (
            <Button
              variant="secondary"
              onClick={() => {
                create.mutate(create.variables);
              }}
            >
              Check again
            </Button>
          )}
        </Alert>
      )}
      <SearchField label="Search live movement" value={search} onChange={setSearch} />
      <div className="data-list">
        {rows.map((pass) => (
          <article key={pass.passId}>
            <div>
              <strong>{pass.student.displayName}</strong>
              <span>{pass.destination.displayName}</span>
            </div>
            <span className="state-label">{pass.lifecycleState.replace('_', ' ')}</span>
            <div>
              {pass.movement.expectedReturnAt && (
                <>
                  Expected back{' '}
                  {new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' }).format(
                    new Date(pass.movement.expectedReturnAt),
                  )}
                </>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
