import { useState, type SubmitEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, confirmed, requireData } from '../../../api/client';
import { productMessage } from '../../../api/problems';
import { queryKeys } from '../../../api/query-keys';
import { getCsrfToken } from '../../../api/session';
import { formString } from '../../../api/forms';
import { meQuery } from '../../../app/queries';
import { useSchool } from '../../../app/school/SchoolShell';
import { PageHeader } from '../../../components/workspace/PageHeader';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

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
  function closeSheet(open: boolean) {
    if (!open) {
      setSelected(null);
      setInvitation(null);
    }
  }
  const person = people.data?.people.find((item) => item.personId === selected);
  const providers =
    discovery.data && !discovery.data.tenantSelectionRequired ? discovery.data.providers : [];
  const entries = people.data?.people ?? [];
  const mutationError = issue.error ?? revoke.error;
  return (
    <section className="grid gap-6">
      <PageHeader
        title="People"
        description="Find people and manage sign-in invitations. School records remain read-only here."
      />
      <Card>
        <CardContent className="pt-6">
          <form className="grid gap-4 sm:grid-cols-[1fr_12rem_auto] sm:items-end" onSubmit={search}>
            <Field>
              <FieldLabel htmlFor="people-search">Search people</FieldLabel>
              <Input
                id="people-search"
                name="q"
                placeholder="Search by name"
                defaultValue={q}
                autoComplete="off"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="people-affiliation">Group</FieldLabel>
              <NativeSelect
                id="people-affiliation"
                value={affiliation}
                onChange={(event) => {
                  setAffiliation(event.target.value as typeof affiliation);
                }}
              >
                <option value="student">Students</option>
                <option value="staff">Staff</option>
              </NativeSelect>
            </Field>
            <Button type="submit">Search</Button>
          </form>
        </CardContent>
      </Card>
      {people.isPending ? (
        <div className="grid gap-2" role="status" aria-label="Loading people">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : entries.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No people found</EmptyTitle>
            <EmptyDescription>Try a different name or group.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table aria-label="People">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Affiliation</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Sign-in</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.personId}>
                  <TableCell className="font-medium">{entry.displayName}</TableCell>
                  <TableCell>
                    {entry.affiliation}
                    {entry.gradeLevel ? ` · grade ${entry.gradeLevel}` : ''}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{entry.personStatus}</Badge>
                  </TableCell>
                  <TableCell>
                    {entry.account.identityLinked ? 'Connected' : 'Not connected'}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setSelected(entry.personId);
                        setInvitation(null);
                      }}
                    >
                      Manage sign-in
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Sheet
        open={person !== undefined}
        onOpenChange={(open) => {
          closeSheet(open);
        }}
      >
        <SheetContent aria-label={`Manage sign-in for ${person?.displayName ?? ''}`}>
          <SheetHeader>
            <SheetTitle>{person?.displayName}</SheetTitle>
            <SheetDescription>
              School records stay read-only. You can only manage the sign-in invitation.
            </SheetDescription>
          </SheetHeader>
          <div className="grid gap-4 px-4">
            {mutationError && (
              <Alert variant="destructive">
                <AlertTitle>Sign-in change not confirmed</AlertTitle>
                <AlertDescription>{productMessage(mutationError)}</AlertDescription>
              </Alert>
            )}
            {person?.account.identityLinked ? (
              <p className="text-sm">Sign-in connected</p>
            ) : enrollment.data?.enrollment ? (
              <div className="grid gap-3">
                <p className="text-sm">
                  Invitation active until{' '}
                  <time>
                    {new Intl.DateTimeFormat([], {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }).format(new Date(enrollment.data.enrollment.expiresAt))}
                  </time>
                  .
                </p>
                <p className="text-sm text-muted-foreground">
                  The original link cannot be recovered after issuance.
                </p>
                <div>
                  <Button
                    variant="destructive"
                    disabled={revoke.isPending}
                    onClick={() => {
                      revoke.mutate();
                    }}
                  >
                    {revoke.isPending ? 'Revoking…' : 'Revoke invitation'}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="grid gap-3">
                <p className="text-sm">Sign-in not connected</p>
                <div className="flex flex-wrap gap-2">
                  {providers.map((provider) => (
                    <Button
                      key={provider.key}
                      disabled={issue.isPending}
                      onClick={() => {
                        issue.mutate(provider.key);
                      }}
                    >
                      {issue.isPending ? 'Creating…' : `Create ${provider.displayName} invitation`}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            {invitation && (
              <Alert>
                <AlertTitle>Invitation ready</AlertTitle>
                <AlertDescription>
                  Copy this link now. WayPass cannot recover it later. It expires{' '}
                  <time>
                    {new Intl.DateTimeFormat([], {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }).format(new Date(invitation.expiresAt))}
                  </time>
                  .
                </AlertDescription>
                <div className="pt-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void navigator.clipboard.writeText(invitation.url)}
                  >
                    Copy invitation link
                  </Button>
                </div>
              </Alert>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </section>
  );
}
