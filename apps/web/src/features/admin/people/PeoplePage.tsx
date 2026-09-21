import { useState, type SubmitEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, confirmed, requireData } from '../../../api/client';
import { queryKeys } from '../../../api/query-keys';
import { getCsrfToken } from '../../../api/session';
import { formString } from '../../../api/forms';
import { meQuery } from '../../../app/queries';
import { Button } from '../../../design-system/primitives/Button';
import { Alert } from '../../../design-system/primitives/Alert';
import { useSchool } from '../../../app/school/SchoolShell';

export function Component() {
  const { organizationId } = useSchool();
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [affiliation, setAffiliation] = useState<'student' | 'staff'>('student');
  const [selected, setSelected] = useState<string | null>(null);
  const [invitation, setInvitation] = useState<{ url: string; expiresAt: string } | null>(null);
  const { data: me } = useQuery(meQuery);
  const tenantSlug = me?.tenant.slug;
  const people = useQuery({
    queryKey: queryKeys.people(organizationId, q, affiliation),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/people', {
          params: {
            path: { organizationId },
            query: { ...(q ? { q } : {}), affiliation, limit: 100 },
          },
        }),
      ),
  });
  const discovery = useQuery({
    queryKey: ['provider-catalog', tenantSlug],
    enabled: tenantSlug !== undefined,
    queryFn: () =>
      tenantSlug === undefined
        ? Promise.reject(new Error('Tenant unavailable'))
        : confirmed(
            api.GET('/api/v1/auth/discovery', { params: { query: { tenant: tenantSlug } } }),
          ),
  });
  const enrollment = useQuery({
    queryKey: queryKeys.enrollment(organizationId, selected ?? ''),
    enabled: Boolean(selected),
    queryFn: async () => {
      const result = await api.GET(
        '/api/v1/organizations/{organizationId}/people/{personId}/enrollment',
        { params: { path: { organizationId, personId: selected ?? '' } } },
      );
      return {
        enrollment: requireData(result).enrollment,
        etag: result.response.headers.get('etag') ?? '',
      };
    },
  });
  const issue = useMutation({
    mutationFn: (providerKey: string) => {
      const key = crypto.randomUUID();
      return confirmed(
        api.POST('/api/v1/organizations/{organizationId}/people/{personId}/enrollments', {
          params: {
            path: { organizationId, personId: selected ?? '' },
            header: { 'idempotency-key': key },
          },
          headers: { 'X-CSRF-Token': getCsrfToken(), 'Idempotency-Key': key },
          body: { providerKey },
        }),
      );
    },
    onSuccess: (data) => {
      setInvitation(
        data.enrollmentToken
          ? {
              url: `${window.location.origin}/enroll#${data.enrollmentToken}`,
              expiresAt: data.expiresAt,
            }
          : null,
      );
      void queryClient.invalidateQueries({
        queryKey: queryKeys.enrollment(organizationId, selected ?? ''),
      });
    },
  });
  const revoke = useMutation({
    mutationFn: () => {
      if (!enrollment.data?.enrollment) throw new Error('Invitation unavailable');
      const key = crypto.randomUUID();
      return confirmed(
        api.POST('/api/v1/identity-enrollments/{enrollmentId}/revoke', {
          params: {
            path: { enrollmentId: enrollment.data.enrollment.id },
            header: { 'idempotency-key': key, 'if-match': enrollment.data.etag },
          },
          headers: {
            'X-CSRF-Token': getCsrfToken(),
            'Idempotency-Key': key,
            'If-Match': enrollment.data.etag,
          },
        }),
      );
    },
    onSuccess: () => {
      setInvitation(null);
      void enrollment.refetch();
    },
  });
  function search(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setQ(formString(data, 'q'));
  }
  const person = people.data?.people.find((item) => item.personId === selected);
  const providers =
    discovery.data && !discovery.data.tenantSelectionRequired ? discovery.data.providers : [];
  return (
    <section className="workspace">
      <header className="workspace__header">
        <p className="auth-kicker">Directory & sign-in</p>
        <h1 className="wf-type-page-title">People</h1>
        <p>Find people and manage sign-in invitations. School records remain read-only here.</p>
      </header>
      <form className="search-row" onSubmit={search}>
        <input
          className="wf-input"
          name="q"
          aria-label="Search people"
          placeholder="Search by name"
        />
        <select
          className="wf-input"
          value={affiliation}
          onChange={(event) => {
            setAffiliation(event.target.value as typeof affiliation);
          }}
        >
          <option value="student">Students</option>
          <option value="staff">Staff</option>
        </select>
        <Button type="submit">Search</Button>
      </form>
      <div className="data-table">
        <div className="data-table__head">
          <span>Name</span>
          <span>Affiliation</span>
          <span>Status</span>
          <span>Sign-in</span>
          <span>Action</span>
        </div>
        {people.data?.people.map((entry) => (
          <div className="data-table__row" key={entry.personId}>
            <strong>{entry.displayName}</strong>
            <span>
              {entry.affiliation}
              {entry.gradeLevel ? ` · grade ${entry.gradeLevel}` : ''}
            </span>
            <span>{entry.personStatus}</span>
            <span>{entry.account.identityLinked ? 'Connected' : 'Not connected'}</span>
            <Button
              variant="quiet"
              onClick={() => {
                setSelected(entry.personId);
                setInvitation(null);
              }}
            >
              Manage sign-in
            </Button>
          </div>
        ))}
      </div>
      {person && (
        <section className="person-panel">
          <h2>{person.displayName}</h2>
          {person.account.identityLinked ? (
            <p>Sign-in connected</p>
          ) : enrollment.data?.enrollment ? (
            <>
              <p>
                Invitation active until{' '}
                <time>
                  {new Intl.DateTimeFormat([], { dateStyle: 'medium', timeStyle: 'short' }).format(
                    new Date(enrollment.data.enrollment.expiresAt),
                  )}
                </time>
                .
              </p>
              <p>The original link cannot be recovered after issuance.</p>
              <Button
                variant="danger"
                pending={revoke.isPending}
                onClick={() => {
                  revoke.mutate();
                }}
              >
                Revoke invitation
              </Button>
            </>
          ) : (
            <>
              <p>Sign-in not connected</p>
              <div className="button-row">
                {providers.map((provider) => (
                  <Button
                    key={provider.key}
                    pending={issue.isPending}
                    onClick={() => {
                      issue.mutate(provider.key);
                    }}
                  >
                    Create {provider.displayName} invitation
                  </Button>
                ))}
              </div>
            </>
          )}
          {invitation && (
            <Alert title="Invitation ready">
              <p>
                Copy this link now. WayPass cannot recover it later. It expires{' '}
                <time>
                  {new Intl.DateTimeFormat([], { dateStyle: 'medium', timeStyle: 'short' }).format(
                    new Date(invitation.expiresAt),
                  )}
                </time>
                .
              </p>
              <Button
                variant="secondary"
                onClick={() => void navigator.clipboard.writeText(invitation.url)}
              >
                Copy invitation link
              </Button>
            </Alert>
          )}
          <Button
            variant="quiet"
            onClick={() => {
              setSelected(null);
            }}
          >
            Close
          </Button>
        </section>
      )}
    </section>
  );
}
