import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { api, confirmed } from '../../api/client';
import { productMessage, UncertainCommandError } from '../../api/problems';
import { queryKeys } from '../../api/query-keys';
import { getCsrfToken } from '../../api/session';
import { Button } from '../../design-system/primitives/Button';
import { Alert } from '../../design-system/primitives/Alert';
import { useSchool } from '../../app/school/SchoolShell';

export function ClassPage() {
  const { organizationId, context } = useSchool();
  const sectionId = useParams().sectionId ?? context.teachingSections[0]?.id ?? '';
  const queryClient = useQueryClient();
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
  const roster = useQuery({
    queryKey: queryKeys.sectionStudents(sectionId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/sections/{sectionId}/students', { params: { path: { sectionId } } }),
      ),
  });
  const live = useQuery({
    queryKey: queryKeys.sectionLive(sectionId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/sections/{sectionId}/passes/live', { params: { path: { sectionId } } }),
      ),
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
  const create = useMutation({
    mutationFn: ({
      studentId,
      destinationId,
      key,
    }: {
      studentId: string;
      destinationId: string;
      key: string;
    }) => {
      return confirmed(
        api.POST('/api/v1/students/{studentId}/passes', {
          params: {
            path: { studentId },
            header: { 'idempotency-key': key },
          },
          headers: { 'X-CSRF-Token': getCsrfToken(), 'Idempotency-Key': key },
          body: { destinationId },
        }),
      );
    },
    onSuccess: () => {
      setCreatingFor(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.sectionLive(sectionId) });
    },
  });
  const depart = useMutation({
    mutationFn: ({ passId, passEtag, key }: { passId: string; passEtag: string; key: string }) => {
      return confirmed(
        api.POST('/api/v1/passes/{passId}/depart', {
          params: {
            path: { passId },
            header: { 'idempotency-key': key, 'if-match': passEtag },
          },
          headers: {
            'X-CSRF-Token': getCsrfToken(),
            'Idempotency-Key': key,
            'If-Match': passEtag,
          },
        }),
      );
    },
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: queryKeys.sectionLive(sectionId) }),
  });
  const current = new Map(live.data?.passes.map((pass) => [pass.student.id, pass]) ?? []);
  return (
    <section className="workspace" aria-labelledby="class-title">
      <header className="workspace__header">
        <p className="auth-kicker">My class</p>
        <h1 className="wf-type-page-title" id="class-title">
          {context.teachingSections.find((section) => section.id === sectionId)?.title ?? 'Class'}
        </h1>
      </header>
      {(create.isError || depart.isError) && (
        <Alert tone="danger" title="Pass action not confirmed">
          <p>{productMessage(create.error ?? depart.error)}</p>
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
          {depart.error instanceof UncertainCommandError && depart.variables && (
            <Button
              variant="secondary"
              onClick={() => {
                depart.mutate(depart.variables);
              }}
            >
              Check again
            </Button>
          )}
        </Alert>
      )}
      <div className="roster">
        {roster.data?.students.map((student) => {
          const pass = current.get(student.id);
          return (
            <article className="roster-row" key={student.id}>
              <div>
                <strong>{student.displayName}</strong>
                {pass && (
                  <span>
                    {pass.lifecycleState === 'ready'
                      ? 'Ready'
                      : pass.lifecycleState === 'requested' || pass.lifecycleState === 'queued'
                        ? 'Waiting'
                        : 'Out'}{' '}
                    · {pass.destination.displayName}
                  </span>
                )}
              </div>
              {pass?.lifecycleState === 'ready' ? (
                <Button
                  size="compact"
                  pending={depart.isPending && depart.variables.passId === pass.passId}
                  pendingLabel="Starting…"
                  onClick={() => {
                    depart.mutate({
                      passId: pass.passId,
                      passEtag: pass.passEtag,
                      key: crypto.randomUUID(),
                    });
                  }}
                >
                  Start pass
                </Button>
              ) : creatingFor === student.id ? (
                <div className="roster-row__destinations">
                  {destinations.data?.destinations.map((destination) => (
                    <Button
                      key={destination.id}
                      size="compact"
                      variant="secondary"
                      pending={
                        create.isPending && create.variables.destinationId === destination.id
                      }
                      onClick={() => {
                        create.mutate({
                          studentId: student.id,
                          destinationId: destination.id,
                          key: crypto.randomUUID(),
                        });
                      }}
                    >
                      {destination.displayName}
                    </Button>
                  ))}
                  <Button
                    size="compact"
                    variant="quiet"
                    onClick={() => {
                      setCreatingFor(null);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                !pass && (
                  <Button
                    size="compact"
                    variant="quiet"
                    onClick={() => {
                      setCreatingFor(student.id);
                    }}
                  >
                    Create pass
                  </Button>
                )
              )}
            </article>
          );
        })}
      </div>
      <section className="students-out">
        <h2>Students out</h2>
        {live.data?.passes.length === 0 ? (
          <p>No one is out right now.</p>
        ) : (
          live.data?.passes.map((pass) => (
            <div key={pass.passId}>
              <strong>{pass.student.displayName}</strong>
              <span>{pass.destination.displayName}</span>
              <span>{pass.lifecycleState.replace('_', ' ')}</span>
            </div>
          ))
        )}
      </section>
    </section>
  );
}
