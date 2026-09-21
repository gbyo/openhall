import { useState, type SubmitEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Temporal } from '@js-temporal/polyfill';
import { api, confirmed, requireData } from '../../../api/client';
import { productMessage, UncertainCommandError } from '../../../api/problems';
import { queryKeys } from '../../../api/query-keys';
import { getCsrfToken } from '../../../api/session';
import { formString } from '../../../api/forms';
import { useSchool } from '../../../app/school/SchoolShell';
import { PageHeader } from '../../../components/workspace/PageHeader';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const roleLabel = {
  destination_staff: 'Destination staff',
  counselor: 'Counselor',
  office_staff: 'Office staff',
  school_admin: 'School administrator',
} as const;

interface Grant {
  id: string;
  role: keyof typeof roleLabel;
  person: { displayName: string | null };
  destination: { displayName: string | null } | null;
  status: string;
}

function optionalInstant(local: string, timeZone: string): string | null {
  return local
    ? Temporal.PlainDateTime.from(local).toZonedDateTime(timeZone).toInstant().toString()
    : null;
}

export function Component() {
  const { organizationId, context } = useSchool();
  const queryClient = useQueryClient();
  const [role, setRole] = useState<keyof typeof roleLabel>('destination_staff');
  const [confirmingRevoke, setConfirmingRevoke] = useState<Grant | null>(null);
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
    onSuccess: () => {
      setConfirmingRevoke(null);
      refresh();
    },
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
  const list = (grants.data?.grants ?? []) as Grant[];
  const revokeScope = confirmingRevoke?.destination?.displayName ?? context.organization.name;
  return (
    <section className="grid gap-6">
      <PageHeader
        title="Staff access"
        description="Assign a specific school duty. Teacher and student access comes from school records, not this page."
      />
      {(issue.isError || revoke.isError) && (
        <Alert variant="destructive">
          <AlertTitle>Access change not confirmed</AlertTitle>
          <AlertDescription>{productMessage(issue.error ?? revoke.error)}</AlertDescription>
          {issue.error instanceof UncertainCommandError && (
            <AlertAction>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (issue.variables) issue.mutate(issue.variables);
                }}
              >
                Check again
              </Button>
            </AlertAction>
          )}
          {revoke.error instanceof UncertainCommandError && (
            <AlertAction>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (revoke.variables) revoke.mutate(revoke.variables);
                }}
              >
                Check again
              </Button>
            </AlertAction>
          )}
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Grant access</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={submit}>
            <Field>
              <FieldLabel htmlFor="grant-person">Staff member</FieldLabel>
              <NativeSelect id="grant-person" name="personId" required>
                {people.data?.people.map((person) => (
                  <NativeSelectOption key={person.personId} value={person.personId}>
                    {person.displayName}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="grant-duty">Duty</FieldLabel>
              <NativeSelect
                id="grant-duty"
                name="role"
                value={role}
                onChange={(event) => {
                  setRole(event.target.value as keyof typeof roleLabel);
                }}
              >
                {Object.entries(roleLabel).map(([value, label]) => (
                  <NativeSelectOption key={value} value={value}>
                    {label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            {role === 'destination_staff' && (
              <Field>
                <FieldLabel htmlFor="grant-destination">Destination</FieldLabel>
                <NativeSelect id="grant-destination" name="destinationId" required>
                  {destinations.data?.destinations
                    .filter((destination) => destination.status !== 'archived')
                    .map((destination) => (
                      <NativeSelectOption key={destination.id} value={destination.id}>
                        {destination.displayName ?? destination.serviceType}
                      </NativeSelectOption>
                    ))}
                </NativeSelect>
              </Field>
            )}
            <div className="grid grid-cols-2 gap-4">
              <Field>
                <FieldLabel htmlFor="grant-from">Starts (optional)</FieldLabel>
                <Input id="grant-from" type="datetime-local" name="validFrom" />
              </Field>
              <Field>
                <FieldLabel htmlFor="grant-until">Ends (optional)</FieldLabel>
                <Input id="grant-until" type="datetime-local" name="validUntil" />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Button type="submit" disabled={issue.isPending}>
                {issue.isPending ? <Spinner data-icon="inline-start" /> : null}
                {issue.isPending ? 'Granting…' : 'Grant access'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
      {grants.isPending ? (
        <div className="grid gap-2" role="status" aria-label="Loading access grants">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : list.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No extra duties assigned</EmptyTitle>
            <EmptyDescription>
              Grant destination or office duties to staff who need them.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table aria-label="Staff access grants">
            <TableHeader>
              <TableRow>
                <TableHead>Person</TableHead>
                <TableHead>Duty</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((grant) => (
                <TableRow key={grant.id}>
                  <TableCell className="font-medium">{grant.person.displayName}</TableCell>
                  <TableCell>{roleLabel[grant.role]}</TableCell>
                  <TableCell>{grant.destination?.displayName ?? 'Whole school'}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">
                      {grant.status === 'active' ? 'Active' : 'Revoked'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {grant.status === 'active' && (
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={revoke.isPending}
                        onClick={() => {
                          setConfirmingRevoke(grant);
                        }}
                      >
                        Remove access
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <AlertDialog
        open={confirmingRevoke !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmingRevoke(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove access?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmingRevoke &&
                `Remove ${roleLabel[confirmingRevoke.role]} access for ${confirmingRevoke.person.displayName ?? 'this person'}? They will no longer be able to use ${revokeScope} tools.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep access</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmingRevoke)
                  revoke.mutate({ grantId: confirmingRevoke.id, key: crypto.randomUUID() });
              }}
            >
              Remove access
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
