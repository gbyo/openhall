import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from '@tanstack/react-table';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowUpDownIcon, Search01Icon } from '@hugeicons/core-free-icons';
import { api, confirmed } from '../../api/client';
import { productMessage, UncertainCommandError } from '../../api/problems';
import { queryKeys } from '../../api/query-keys';
import { getCsrfToken } from '../../api/session';
import { useSchool } from '../../app/school/SchoolShell';
import { PageHeader } from '../../components/workspace/PageHeader';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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

interface LivePass {
  passId: string;
  student: { displayName: string };
  destination: { id: string; name: string };
  lifecycleState: string;
  requestedAt: string;
  movement: { expectedReturnAt: string | null };
}

function stateLabel(state: string): string {
  switch (state) {
    case 'requested':
      return 'Requested';
    case 'queued':
      return 'Queued';
    case 'ready':
      return 'Ready';
    case 'outbound':
      return 'Out';
    case 'at_destination':
      return 'At destination';
    case 'returning':
      return 'Returning';
    default:
      return state.replace('_', ' ');
  }
}

function time(value: string | null): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' }).format(
    new Date(value),
  );
}

const columnHelper = createColumnHelper<LivePass>();

interface Option {
  value: string;
  label: string;
}

export function LiveMovementPage() {
  const { organizationId, context } = useSchool();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('all');
  const [roomFilter, setRoomFilter] = useState('all');
  const [sorting, setSorting] = useState<SortingState>([]);
  const [creating, setCreating] = useState(false);
  const [studentId, setStudentId] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
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
  const passes = useMemo(() => live.data?.passes ?? [], [live.data]);
  const states = useMemo(
    () => [...new Set(passes.map((pass) => pass.lifecycleState))].sort(),
    [passes],
  );
  const roomOptions = useMemo(
    () =>
      [...new Map(passes.map((pass) => [pass.destination.id, pass.destination])).values()].sort(
        (a, b) => a.name.localeCompare(b.name),
      ),
    [passes],
  );
  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return passes.filter((pass) => {
      if (
        query.length > 0 &&
        !`${pass.student.displayName} ${pass.destination.name}`.toLowerCase().includes(query)
      )
        return false;
      if (stateFilter !== 'all' && pass.lifecycleState !== stateFilter) return false;
      if (roomFilter !== 'all' && pass.destination.id !== roomFilter) return false;
      return true;
    });
  }, [passes, search, stateFilter, roomFilter]);
  const columns = useMemo(
    () => [
      columnHelper.accessor('student.displayName', {
        id: 'student',
        header: 'Student',
        cell: (info) => info.getValue(),
      }),
      columnHelper.accessor('destination.name', {
        id: 'destination',
        header: 'Destination',
        cell: (info) => info.getValue(),
      }),
      columnHelper.accessor('lifecycleState', {
        id: 'state',
        header: 'State',
        enableSorting: false,
        cell: (info) => <Badge variant="secondary">{stateLabel(info.getValue())}</Badge>,
      }),
      columnHelper.accessor('requestedAt', {
        id: 'outSince',
        header: 'Out since',
        meta: { className: 'hidden md:table-cell' },
        cell: (info) => time(info.getValue()),
      }),
      columnHelper.accessor((row) => row.movement.expectedReturnAt ?? '', {
        id: 'expectedReturn',
        header: 'Expected return',
        meta: { className: 'hidden sm:table-cell' },
        cell: (info) => time(info.getValue() === '' ? null : info.getValue()),
      }),
    ],
    [],
  );
  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => row.passId,
  });
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
  // Staff pick from the flat safe catalog of open rooms. Staff are NOT
  // limited by studentSelfRequestable — that flag is student-only.
  const rooms = useQuery({
    queryKey: queryKeys.rooms(organizationId),
    enabled: creating && canCreate,
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/me/organizations/{organizationId}/rooms', {
          params: { path: { organizationId } },
        }),
      ),
  });
  const studentOptions = useMemo<Option[]>(
    () =>
      students.data?.students.map((student) => ({
        value: student.id,
        label: student.displayName,
      })) ?? [],
    [students.data],
  );
  const createRoomOptions = useMemo<Option[]>(
    () =>
      rooms.data?.rooms.map((room) => ({
        value: room.id,
        label: [room.name, room.code].filter((part) => part).join(' · '),
      })) ?? [],
    [rooms.data],
  );
  const selectedStudent = studentOptions.find((option) => option.value === studentId) ?? null;
  const selectedRoom = createRoomOptions.find((option) => option.value === roomId) ?? null;
  const create = useMutation({
    mutationFn: (input: { studentId: string; roomId: string; idempotencyKey: string }) =>
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
          body: { destinationRoomId: input.roomId },
        }),
      ),
    onSuccess: () => {
      setCreating(false);
      setStudentId(null);
      setRoomId(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.schoolLive(organizationId) });
    },
  });

  function closeCreate() {
    if (create.isPending) return;
    setCreating(false);
    setStudentId(null);
    setRoomId(null);
    create.reset();
  }

  return (
    <section aria-labelledby="movement-title" className="flex flex-col gap-4">
      <PageHeader
        title="Live movement"
        description="Only server-confirmed movement appears here."
        actions={
          canCreate ? (
            <Button
              onClick={() => {
                create.reset();
                setStudentId(null);
                setRoomId(null);
                setCreating(true);
              }}
            >
              Create pass
            </Button>
          ) : undefined
        }
      />
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-52 flex-1">
          <InputGroup>
            <InputGroupAddon>
              <InputGroupText>
                <HugeiconsIcon icon={Search01Icon} strokeWidth={2} aria-hidden="true" />
              </InputGroupText>
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Search live movement"
              placeholder="Search students or rooms"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
            />
          </InputGroup>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="movement-state-filter">State</Label>
          <Select
            value={stateFilter}
            onValueChange={(value) => {
              setStateFilter(value ?? 'all');
            }}
          >
            <SelectTrigger id="movement-state-filter" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All states</SelectItem>
              {states.map((state) => (
                <SelectItem key={state} value={state}>
                  {stateLabel(state)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="movement-room-filter">Room</Label>
          <Select
            value={roomFilter}
            onValueChange={(value) => {
              setRoomFilter(value ?? 'all');
            }}
          >
            <SelectTrigger id="movement-room-filter" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All rooms</SelectItem>
              {roomOptions.map((room) => (
                <SelectItem key={room.id} value={room.id}>
                  {room.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {live.isPending ? (
        <div role="status" aria-label="Loading live movement" className="flex flex-col gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <span className="sr-only">Loading live movement…</span>
        </div>
      ) : rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No live movement right now.</EmptyTitle>
            <EmptyDescription>
              {search.trim().length > 0 || stateFilter !== 'all' || roomFilter !== 'all'
                ? 'Try a different search or filter.'
                : 'Confirmed passes will appear here as students move.'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table aria-label="Live movement">
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const sortable = header.column.getCanSort();
                  const sorted = header.column.getIsSorted();
                  const className =
                    (header.column.columnDef.meta as { className?: string } | undefined)
                      ?.className ?? '';
                  return (
                    <TableHead
                      key={header.id}
                      aria-sort={
                        sorted === 'asc'
                          ? 'ascending'
                          : sorted === 'desc'
                            ? 'descending'
                            : undefined
                      }
                      className={className}
                    >
                      {sortable ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1"
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          <HugeiconsIcon
                            icon={ArrowUpDownIcon}
                            strokeWidth={2}
                            aria-hidden="true"
                            className="size-3.5"
                          />
                          <span className="sr-only">
                            {sorted === 'asc'
                              ? ' (sorted ascending, activate to sort descending)'
                              : sorted === 'desc'
                                ? ' (sorted descending, activate to clear sorting)'
                                : ' (activate to sort ascending)'}
                          </span>
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => {
                  const className =
                    (cell.column.columnDef.meta as { className?: string } | undefined)?.className ??
                    '';
                  return (
                    <TableCell key={cell.id} className={className}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Dialog
        open={creating}
        onOpenChange={(open) => {
          if (!open) closeCreate();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create pass</DialogTitle>
            <DialogDescription>
              Start a pass for a student. The movement list updates after confirmation.
            </DialogDescription>
          </DialogHeader>
          {rooms.isPending || students.isPending ? (
            <div role="status" aria-label="Loading pass options" className="flex flex-col gap-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <span className="sr-only">Loading students and rooms…</span>
            </div>
          ) : (
            <>
              <Field>
                <FieldLabel htmlFor="movement-student">Student</FieldLabel>
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
                  <ComboboxInput id="movement-student" placeholder="Search students" />
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
                <FieldLabel htmlFor="movement-room">Room</FieldLabel>
                <Combobox
                  items={createRoomOptions}
                  value={selectedRoom}
                  onValueChange={(option: Option | null) => {
                    setRoomId(option?.value ?? null);
                  }}
                  filter={(item: Option, query: string) =>
                    item.label.toLowerCase().includes(query.toLowerCase())
                  }
                >
                  <ComboboxInput id="movement-room" placeholder="Search open rooms" />
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
                {(students.isError || rooms.isError) && (
                  <FieldError>Students or rooms could not be loaded. Try again.</FieldError>
                )}
              </Field>
            </>
          )}
          {create.isError && (
            <Alert variant="destructive">
              <AlertTitle>Pass not created</AlertTitle>
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
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              disabled={create.isPending || studentId === null || roomId === null}
              aria-busy={create.isPending}
              onClick={() => {
                if (studentId && roomId) {
                  create.mutate({
                    studentId,
                    roomId,
                    idempotencyKey: crypto.randomUUID(),
                  });
                }
              }}
            >
              {create.isPending ? <Spinner data-icon="inline-start" /> : null}
              {create.isPending ? 'Creating…' : 'Create pass'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
