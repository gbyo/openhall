import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Temporal } from '@js-temporal/polyfill';
import { HugeiconsIcon } from '@hugeicons/react';
import { MoreHorizontalIcon, Search01Icon } from '@hugeicons/core-free-icons';
import { api, confirmed, requireData } from '../../../api/client';
import { productMessage, UncertainCommandError } from '../../../api/problems';
import { queryKeys } from '../../../api/query-keys';
import { getCsrfToken } from '../../../api/session';
import { useSchool } from '../../../app/school/SchoolShell';
import { PageHeader } from '../../../components/workspace/PageHeader';
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
import { Badge } from '@/components/ui/badge';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '@/components/ui/input-group';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';

function instant(local: string, timeZone: string): string {
  return Temporal.PlainDateTime.from(local).toZonedDateTime(timeZone).toInstant().toString();
}

function zoneName(timeZone: string): string {
  const part = new Intl.DateTimeFormat([], { timeZone, timeZoneName: 'long' })
    .formatToParts()
    .find((entry) => entry.type === 'timeZoneName');
  return part?.value ?? timeZone;
}

function windowLabel(validFrom: string, timeZone: string): string {
  return new Intl.DateTimeFormat([], {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(validFrom));
}

type EffectiveStatus = 'upcoming' | 'used' | 'cancelled' | 'expired';

function effectiveStatus(status: string, validUntil: string): EffectiveStatus {
  if (
    status === 'active' &&
    Temporal.Instant.compare(Temporal.Instant.from(validUntil), Temporal.Now.instant()) <= 0
  )
    return 'expired';
  if (status === 'active') return 'upcoming';
  if (status === 'used') return 'used';
  return 'cancelled';
}

function statusLabel(status: EffectiveStatus): string {
  switch (status) {
    case 'upcoming':
      return 'Upcoming';
    case 'used':
      return 'Used';
    case 'cancelled':
      return 'Cancelled';
    case 'expired':
      return 'Expired';
  }
}

interface Option {
  value: string;
  label: string;
}

export function Component() {
  const { organizationId, context } = useSchool();
  const queryClient = useQueryClient();
  const timeZone = context.organization.timeZone;
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [creating, setCreating] = useState(false);
  const [studentId, setStudentId] = useState<string | null>(null);
  const [destinationRoomId, setDestinationRoomId] = useState<string | null>(null);
  const [validFrom, setValidFrom] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [origin, setOrigin] = useState<'expected' | 'specific'>('expected');
  const [originRoomId, setOriginRoomId] = useState<string | null>(null);
  const [approvalMode, setApprovalMode] = useState<'preapproved' | 'approval_required'>(
    'preapproved',
  );
  const [cancelling, setCancelling] = useState<{ id: string; studentName: string } | null>(null);
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
    enabled: creating,
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/students', {
          params: { path: { organizationId }, query: { limit: 100 } },
        }),
      ),
  });
  // Staff pick from the flat safe catalog of open rooms. Staff are NOT
  // limited by studentSelfRequestable — that flag is student-only.
  const rooms = useQuery({
    queryKey: queryKeys.rooms(organizationId),
    enabled: creating,
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/me/organizations/{organizationId}/rooms', {
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
        destinationRoomId: string;
        validFrom: string;
        validUntil: string;
        approvalMode: 'preapproved' | 'approval_required';
        origin: { strategy: 'expected' } | { strategy: 'specific'; roomId: string };
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
    onSuccess: () => {
      setCreating(false);
      resetCreate();
      refresh();
    },
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
    onSuccess: () => {
      setCancelling(null);
      refresh();
    },
  });

  function resetCreate() {
    setStudentId(null);
    setDestinationRoomId(null);
    setValidFrom('');
    setValidUntil('');
    setOrigin('expected');
    setOriginRoomId(null);
    setApprovalMode('preapproved');
    create.reset();
  }

  function closeCreate() {
    if (create.isPending) return;
    setCreating(false);
    resetCreate();
  }

  const studentOptions = useMemo<Option[]>(
    () =>
      students.data?.students.map((student) => ({
        value: student.id,
        label: student.gradeLevel
          ? `${student.displayName} · Grade ${student.gradeLevel}`
          : student.displayName,
      })) ?? [],
    [students.data],
  );
  const destinationRoomOptions = useMemo<Option[]>(
    () =>
      rooms.data?.rooms.map((item) => ({
        value: item.id,
        label: [item.name, item.code].filter((part) => part).join(' · '),
      })) ?? [],
    [rooms.data],
  );
  // Only rooms the school marked origin-selectable can be picked manually;
  // the `expected` strategy keeps using the schedule regardless.
  const originRoomOptions = useMemo<Option[]>(
    () =>
      rooms.data?.rooms
        .filter((item) => item.originSelectable)
        .map((item) => ({
          value: item.id,
          label: [item.name, item.code].filter((part) => part).join(' · '),
        })) ?? [],
    [rooms.data],
  );
  const selectedStudent = studentOptions.find((option) => option.value === studentId) ?? null;
  const selectedDestination =
    destinationRoomOptions.find((option) => option.value === destinationRoomId) ?? null;
  const selectedOriginRoom =
    originRoomOptions.find((option) => option.value === originRoomId) ?? null;

  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (appointments.data?.authorizations ?? [])
      .map((item) => ({ item, status: effectiveStatus(item.status, item.validUntil) }))
      .filter(({ item, status }) => {
        if (
          query.length > 0 &&
          !`${item.student.displayName} ${item.destination.name}`.toLowerCase().includes(query)
        )
          return false;
        if (statusFilter !== 'all' && status !== statusFilter) return false;
        return true;
      })
      .sort((a, b) => {
        const aUp = a.status === 'upcoming' ? 0 : 1;
        const bUp = b.status === 'upcoming' ? 0 : 1;
        if (aUp !== bUp) return aUp - bUp;
        return aUp === 0
          ? a.item.validFrom.localeCompare(b.item.validFrom)
          : b.item.validFrom.localeCompare(a.item.validFrom);
      });
  }, [appointments.data, search, statusFilter]);

  const createValid =
    studentId !== null &&
    destinationRoomId !== null &&
    validFrom !== '' &&
    validUntil !== '' &&
    (origin === 'expected' || originRoomId !== null);

  function submitCreate() {
    if (!createValid) return;
    const originBody =
      origin === 'expected'
        ? { strategy: 'expected' as const }
        : originRoomId === null
          ? null
          : { strategy: 'specific' as const, roomId: originRoomId };
    if (originBody === null) return;
    create.mutate({
      key: crypto.randomUUID(),
      body: {
        studentId,
        destinationRoomId,
        validFrom: instant(validFrom, timeZone),
        validUntil: instant(validUntil, timeZone),
        approvalMode,
        origin: originBody,
      },
    });
  }

  const cancellingRow = cancelling
    ? (rows.find(({ item }) => item.id === cancelling.id)?.item ?? null)
    : null;
  const cancelPending = cancel.isPending;

  return (
    <section aria-labelledby="scheduled-title" className="flex flex-col gap-4">
      <PageHeader
        title="Scheduled passes"
        description="Appointments that let students start a WayPass during a set window."
        actions={
          <Button
            onClick={() => {
              resetCreate();
              setCreating(true);
            }}
          >
            New scheduled pass
          </Button>
        }
      />
      <p className="text-sm text-muted-foreground">Times shown in {zoneName(timeZone)}.</p>
      {(create.isError || cancel.isError) && (
        <Alert variant="destructive">
          <AlertTitle>Scheduled pass change not confirmed</AlertTitle>
          <AlertDescription>{productMessage(create.error ?? cancel.error)}</AlertDescription>
          {create.error instanceof UncertainCommandError && (
            <AlertAction>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (create.variables) create.mutate(create.variables);
                }}
              >
                Check again
              </Button>
            </AlertAction>
          )}
          {cancel.error instanceof UncertainCommandError && (
            <AlertAction>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (cancel.variables) cancel.mutate(cancel.variables);
                }}
              >
                Check again
              </Button>
            </AlertAction>
          )}
        </Alert>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-52 flex-1">
          <InputGroup>
            <InputGroupAddon>
              <InputGroupText>
                <HugeiconsIcon icon={Search01Icon} strokeWidth={2} aria-hidden="true" />
              </InputGroupText>
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Search scheduled passes"
              placeholder="Search students or rooms"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
            />
          </InputGroup>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="scheduled-status-filter">Status</Label>
          <Select
            value={statusFilter}
            onValueChange={(value) => {
              setStatusFilter(value ?? 'all');
            }}
          >
            <SelectTrigger id="scheduled-status-filter" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="upcoming">Upcoming</SelectItem>
              <SelectItem value="used">Used</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
              <SelectItem value="expired">Expired</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {appointments.isPending ? (
        <div role="status" aria-label="Loading scheduled passes" className="flex flex-col gap-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <span className="sr-only">Loading scheduled passes…</span>
        </div>
      ) : rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No scheduled passes found.</EmptyTitle>
            <EmptyDescription>
              {search.trim().length > 0 || statusFilter !== 'all'
                ? 'Try a different search or filter.'
                : 'Create an appointment window with New scheduled pass.'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup aria-label="Scheduled passes">
          {rows.map(({ item, status }) => {
            const cancellingThis = cancel.isPending && cancel.variables.id === item.id;
            return (
              <Item role="listitem" key={item.id}>
                <ItemContent>
                  <div className="flex flex-wrap items-center gap-2">
                    <ItemTitle>{item.student.displayName}</ItemTitle>
                    <Badge variant="secondary">{statusLabel(status)}</Badge>
                  </div>
                  <ItemDescription>
                    {item.destination.name} · <time>{windowLabel(item.validFrom, timeZone)}</time>
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  {status === 'upcoming' || item.status === 'active' ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={<Button variant="ghost" size="icon-sm" />}
                        aria-label={`Actions for ${item.student.displayName}'s scheduled pass`}
                      >
                        <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          variant="destructive"
                          disabled={cancellingThis}
                          onClick={() => {
                            setCancelling({ id: item.id, studentName: item.student.displayName });
                          }}
                        >
                          Cancel scheduled pass
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </ItemActions>
              </Item>
            );
          })}
        </ItemGroup>
      )}
      <Dialog
        open={creating}
        onOpenChange={(open) => {
          if (!open) closeCreate();
        }}
      >
        <DialogContent className="grid max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New scheduled pass</DialogTitle>
            <DialogDescription>
              Set an appointment window. Times use {zoneName(timeZone)}.
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 flex-col gap-6 overflow-y-auto pr-1">
            {students.isPending || rooms.isPending ? (
              <div role="status" aria-label="Loading pass options" className="flex flex-col gap-2">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
                <span className="sr-only">Loading students and rooms…</span>
              </div>
            ) : (
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="scheduled-student">Student</FieldLabel>
                  <Combobox
                    items={studentOptions}
                    value={selectedStudent}
                    onValueChange={(option: Option | null) => {
                      setStudentId(option?.value ?? null);
                    }}
                    filter={(item: Option, query: string) =>
                      item.label.toLowerCase().includes(query.toLowerCase())
                    }
                  >
                    <ComboboxInput id="scheduled-student" placeholder="Search students" />
                    <ComboboxContent>
                      <ComboboxList>
                        {(item: Option) => (
                          <ComboboxItem key={item.value} value={item}>
                            {item.label}
                          </ComboboxItem>
                        )}
                      </ComboboxList>
                      <ComboboxEmpty>No matching student.</ComboboxEmpty>
                    </ComboboxContent>
                  </Combobox>
                </Field>
                <Field>
                  <FieldLabel htmlFor="scheduled-room">Destination room</FieldLabel>
                  <Combobox
                    items={destinationRoomOptions}
                    value={selectedDestination}
                    onValueChange={(option: Option | null) => {
                      setDestinationRoomId(option?.value ?? null);
                    }}
                    filter={(item: Option, query: string) =>
                      item.label.toLowerCase().includes(query.toLowerCase())
                    }
                  >
                    <ComboboxInput id="scheduled-room" placeholder="Search open rooms" />
                    <ComboboxContent>
                      <ComboboxList>
                        {(item: Option) => (
                          <ComboboxItem key={item.value} value={item}>
                            {item.label}
                          </ComboboxItem>
                        )}
                      </ComboboxList>
                      <ComboboxEmpty>No matching room.</ComboboxEmpty>
                    </ComboboxContent>
                  </Combobox>
                </Field>
                <FieldSet>
                  <FieldLegend>Available</FieldLegend>
                  <FieldDescription>Times shown in {zoneName(timeZone)}.</FieldDescription>
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="scheduled-from">From</FieldLabel>
                      <Input
                        id="scheduled-from"
                        type="datetime-local"
                        required
                        value={validFrom}
                        onChange={(event) => {
                          setValidFrom(event.target.value);
                        }}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="scheduled-until">Until</FieldLabel>
                      <Input
                        id="scheduled-until"
                        type="datetime-local"
                        required
                        value={validUntil}
                        onChange={(event) => {
                          setValidUntil(event.target.value);
                        }}
                      />
                    </Field>
                  </FieldGroup>
                </FieldSet>
                <FieldSet>
                  <FieldLegend>Origin</FieldLegend>
                  <RadioGroup
                    aria-label="Origin"
                    value={origin}
                    onValueChange={(value) => {
                      setOrigin(value as 'expected' | 'specific');
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <RadioGroupItem value="expected" id="origin-expected" />
                      <Label htmlFor="origin-expected">Use student&apos;s expected room</Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <RadioGroupItem value="specific" id="origin-specific" />
                      <Label htmlFor="origin-specific">Specific room</Label>
                    </div>
                  </RadioGroup>
                  {origin === 'specific' && (
                    <Field>
                      <FieldLabel htmlFor="scheduled-origin-room">Origin room</FieldLabel>
                      <Combobox
                        items={originRoomOptions}
                        value={selectedOriginRoom}
                        onValueChange={(option: Option | null) => {
                          setOriginRoomId(option?.value ?? null);
                        }}
                        filter={(item: Option, query: string) =>
                          item.label.toLowerCase().includes(query.toLowerCase())
                        }
                      >
                        <ComboboxInput
                          id="scheduled-origin-room"
                          placeholder="Search selectable origin rooms"
                        />
                        <ComboboxContent>
                          <ComboboxList>
                            {(item: Option) => (
                              <ComboboxItem key={item.value} value={item}>
                                {item.label}
                              </ComboboxItem>
                            )}
                          </ComboboxList>
                          <ComboboxEmpty>No matching room.</ComboboxEmpty>
                        </ComboboxContent>
                      </Combobox>
                      <FieldDescription>
                        Only rooms marked &ldquo;Show as manually selectable origin&rdquo; appear
                        here.
                      </FieldDescription>
                    </Field>
                  )}
                </FieldSet>
                <FieldSet>
                  <FieldLegend>Approval</FieldLegend>
                  <RadioGroup
                    aria-label="Approval"
                    value={approvalMode}
                    onValueChange={(value) => {
                      setApprovalMode(value as 'preapproved' | 'approval_required');
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <RadioGroupItem value="preapproved" id="approval-preapproved" />
                      <Label htmlFor="approval-preapproved">Already approved</Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <RadioGroupItem value="approval_required" id="approval-required" />
                      <Label htmlFor="approval-required">Teacher approval still required</Label>
                    </div>
                  </RadioGroup>
                  <FieldDescription>
                    Already approved skips only ordinary classroom approval for this appointment.
                    Other school policies still apply.
                  </FieldDescription>
                </FieldSet>
                {(students.isError || rooms.isError) && (
                  <FieldError>Students or rooms could not be loaded. Try again.</FieldError>
                )}
              </FieldGroup>
            )}
            {create.isError && (
              <Alert variant="destructive">
                <AlertTitle>Scheduled pass not created</AlertTitle>
                <AlertDescription>{productMessage(create.error)}</AlertDescription>
                {create.error instanceof UncertainCommandError && (
                  <AlertAction>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        create.mutate(create.variables);
                      }}
                    >
                      Check again
                    </Button>
                  </AlertAction>
                )}
              </Alert>
            )}
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              disabled={create.isPending || !createValid}
              aria-busy={create.isPending}
              onClick={submitCreate}
            >
              {create.isPending ? <Spinner data-icon="inline-start" /> : null}
              {create.isPending ? 'Scheduling…' : 'Schedule pass'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={cancelling !== null}
        onOpenChange={(open) => {
          if (!open && !cancel.isPending) setCancelling(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {cancelling ? `Cancel ${cancelling.studentName}'s scheduled pass?` : 'Cancel pass?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {cancellingRow
                ? `${cancellingRow.student.displayName} won't be able to start this appointment afterward.`
                : 'This appointment will no longer be available.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep pass</AlertDialogCancel>
            <AlertDialogAction
              disabled={cancelPending}
              onClick={(event) => {
                event.preventDefault();
                if (cancelling && !cancel.isPending)
                  cancel.mutate({ id: cancelling.id, key: crypto.randomUUID() });
              }}
            >
              {cancelPending ? <Spinner data-icon="inline-start" /> : null}
              {cancelPending ? 'Cancelling…' : 'Cancel scheduled pass'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
