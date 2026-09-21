import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, confirmed, requireData } from '../../../api/client';
import { productMessage, UncertainCommandError } from '../../../api/problems';
import { queryKeys } from '../../../api/query-keys';
import { getCsrfToken } from '../../../api/session';
import { useSchool } from '../../../app/school/SchoolShell';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { FieldLegend, FieldSet } from '@/components/ui/field';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';

interface PersonOption {
  value: string;
  label: string;
}

/**
 * Assigned staff section for a destination. Renders existing
 * `destination_staff` authorization grants as the only source of truth —
 * nothing is copied onto the destination row. Assignment controls appear
 * only for accounts with the existing `authorization.manage` capability;
 * the server stays authoritative on every mutation.
 */
export function DestinationAssignedStaff({ destinationId }: { destinationId: string }) {
  const { organizationId, context } = useSchool();
  const queryClient = useQueryClient();
  const [assigning, setAssigning] = useState(false);
  const [personId, setPersonId] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState<{
    grantId: string;
    personName: string;
  } | null>(null);
  const canManage = context.capabilities.includes('authorization.manage');
  const grants = useQuery({
    queryKey: queryKeys.grants(organizationId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/authorization-grants', {
          params: { path: { organizationId } },
        }),
      ),
    enabled: canManage,
  });
  const people = useQuery({
    queryKey: queryKeys.people(organizationId, '', 'staff'),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/people', {
          params: { path: { organizationId }, query: { affiliation: 'staff', limit: 100 } },
        }),
      ),
    enabled: canManage && assigning,
  });
  const assigned = (grants.data?.grants ?? []).filter(
    (grant) =>
      grant.role === 'destination_staff' &&
      grant.destinationId === destinationId &&
      grant.status === 'active',
  );
  const assignedPersonIds = new Set(assigned.map((grant) => grant.personId));
  const personOptions: PersonOption[] = (people.data?.people ?? [])
    .filter((person) => !assignedPersonIds.has(person.personId))
    .map((person) => ({ value: person.personId, label: person.displayName }));
  const selectedPerson = personOptions.find((option) => option.value === personId) ?? null;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.grants(organizationId) });
  };
  const assign = useMutation({
    mutationFn: (input: { person: string; key: string }) =>
      confirmed(
        api.POST('/api/v1/organizations/{organizationId}/authorization-grants', {
          params: { path: { organizationId }, header: { 'idempotency-key': input.key } },
          headers: { 'X-CSRF-Token': getCsrfToken(), 'Idempotency-Key': input.key },
          body: {
            personId: input.person,
            role: 'destination_staff',
            destinationId,
            validFrom: null,
            validUntil: null,
          },
        }),
      ),
    onSuccess: () => {
      setAssigning(false);
      setPersonId(null);
      refresh();
    },
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
      setConfirmingRemove(null);
      refresh();
    },
  });
  const error = assign.error ?? revoke.error;
  const initials = (name: string) =>
    name
      .split(/\s+/)
      .map((part) => part.charAt(0))
      .slice(0, 2)
      .join('')
      .toUpperCase();

  return (
    <FieldSet>
      <div className="flex items-center justify-between gap-2">
        <FieldLegend>Assigned staff</FieldLegend>
        {canManage ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              assign.reset();
              setPersonId(null);
              setAssigning(true);
            }}
          >
            Assign staff
          </Button>
        ) : null}
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Staff assignment not confirmed</AlertTitle>
          <AlertDescription>{productMessage(error)}</AlertDescription>
          {error instanceof UncertainCommandError && (
            <AlertAction>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (assign.error) assign.mutate(assign.variables);
                  else if (revoke.error) revoke.mutate(revoke.variables);
                }}
              >
                Check again
              </Button>
            </AlertAction>
          )}
        </Alert>
      )}
      {!canManage ? (
        <p className="text-sm text-muted-foreground">
          Staff assignment requires authorization management access.
        </p>
      ) : grants.isPending ? (
        <div role="status" aria-label="Loading assigned staff" className="flex flex-col gap-2">
          <Skeleton className="h-14 w-full" />
          <span className="sr-only">Loading assigned staff…</span>
        </div>
      ) : assigned.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No staff assigned</EmptyTitle>
            <EmptyDescription>
              Not every destination needs staff — a restroom with none is completely valid.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup aria-label="Assigned staff">
          {assigned.map((grant) => (
            <Item key={grant.id} variant="outline">
              <ItemMedia>
                <Avatar>
                  <AvatarFallback>{initials(grant.person.displayName)}</AvatarFallback>
                </Avatar>
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{grant.person.displayName}</ItemTitle>
                <ItemDescription>Destination staff</ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    revoke.reset();
                    setConfirmingRemove({
                      grantId: grant.id,
                      personName: grant.person.displayName,
                    });
                  }}
                >
                  Remove
                </Button>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      )}
      <Dialog
        open={assigning}
        onOpenChange={(open) => {
          if (!open && !assign.isPending) {
            setAssigning(false);
            setPersonId(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign staff</DialogTitle>
            <DialogDescription>
              They will receive destination staff access for this destination in Station.
            </DialogDescription>
          </DialogHeader>
          {people.isPending ? (
            <div role="status" aria-label="Loading staff" className="flex flex-col gap-2">
              <Skeleton className="h-9 w-full" />
              <span className="sr-only">Loading staff…</span>
            </div>
          ) : (
            <Combobox
              items={personOptions}
              value={selectedPerson}
              onValueChange={(option: PersonOption | null) => {
                setPersonId(option?.value ?? null);
              }}
              filter={(item: PersonOption, query: string) =>
                item.label.toLowerCase().includes(query.toLowerCase())
              }
            >
              <ComboboxInput id="assign-staff-person" placeholder="Search staff" />
              <ComboboxContent>
                <ComboboxList>
                  {(item: PersonOption) => (
                    <ComboboxItem key={item.value} value={item}>
                      {item.label}
                    </ComboboxItem>
                  )}
                </ComboboxList>
                <ComboboxEmpty>No matching staff.</ComboboxEmpty>
              </ComboboxContent>
            </Combobox>
          )}
          {assign.isError && (
            <Alert variant="destructive">
              <AlertTitle>Staff not assigned</AlertTitle>
              <AlertDescription>{productMessage(assign.error)}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              disabled={assign.isPending || personId === null}
              aria-busy={assign.isPending}
              onClick={() => {
                if (personId) assign.mutate({ person: personId, key: crypto.randomUUID() });
              }}
            >
              {assign.isPending ? <Spinner data-icon="inline-start" /> : null}
              {assign.isPending ? 'Assigning…' : 'Assign staff'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={confirmingRemove !== null}
        onOpenChange={(open) => {
          if (!open && !revoke.isPending) setConfirmingRemove(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmingRemove
                ? `Remove ${confirmingRemove.personName} from this destination?`
                : 'Remove assigned staff?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              They will no longer have destination staff access to this destination.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={revoke.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (confirmingRemove && !revoke.isPending)
                  revoke.mutate({ grantId: confirmingRemove.grantId, key: crypto.randomUUID() });
              }}
            >
              {revoke.isPending ? <Spinner data-icon="inline-start" /> : null}
              {revoke.isPending ? 'Removing…' : 'Remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </FieldSet>
  );
}
