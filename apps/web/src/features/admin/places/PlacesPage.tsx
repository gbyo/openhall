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
import { MoreHorizontalIcon, Search01Icon } from '@hugeicons/core-free-icons';
import { Link } from 'react-router';
import { api, confirmed } from '../../../api/client';
import { productMessage } from '../../../api/problems';
import { queryKeys } from '../../../api/query-keys';
import { getCsrfToken } from '../../../api/session';
import type { Place } from '../../../api/types';
import { useSchool } from '../../../app/school/SchoolShell';
import { PageHeader } from '../../../components/workspace/PageHeader';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
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
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '@/components/ui/input-group';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ClassroomSetupDialog } from './ClassroomSetupDialog.js';

function statusLabel(status: string): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'inactive':
      return 'Inactive';
    default:
      return 'Archived';
  }
}

function classesLabel(place: Place): string {
  if (place.classUsage.sectionCount === 0) return '—';
  const teachers = place.classUsage.teacherNames;
  if (teachers.length === 0) return `${String(place.classUsage.sectionCount)} classes`;
  if (teachers.length === 1) return teachers[0] ?? '';
  return `${teachers[0] ?? ''} +${String(teachers.length - 1)}`;
}

function destinationsLabel(place: Place): string {
  const count = place.destinationSummary.count;
  if (count === 0) return 'None';
  if (count === 1) return place.destinationSummary.destinations[0]?.displayName ?? '1 destination';
  return `${String(count)} destinations`;
}

const columnHelper = createColumnHelper<Place>();

export function PlacesPage() {
  const { organizationId } = useSchool();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [sorting, setSorting] = useState<SortingState>([]);
  const [creating, setCreating] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('classroom');
  const [code, setCode] = useState('');
  const [floor, setFloor] = useState('');
  const places = useQuery({
    queryKey: queryKeys.places(organizationId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/places', {
          params: { path: { organizationId } },
        }),
      ),
  });
  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    const all = places.data?.places ?? [];
    if (query.length === 0) return all;
    return all.filter((place) =>
      [
        place.name,
        place.kind,
        place.code ?? '',
        place.floorLabel ?? '',
        ...place.classUsage.teacherNames,
        ...place.destinationSummary.destinations.map((entry) => entry.displayName),
      ]
        .join(' ')
        .toLowerCase()
        .includes(query),
    );
  }, [places.data, search]);
  const columns = [
    columnHelper.accessor('name', {
      id: 'place',
      header: 'Place',
      cell: (info) => (
        <Link to={info.row.original.id} className="font-medium underline-offset-4 hover:underline">
          {info.getValue()}
        </Link>
      ),
    }),
    columnHelper.accessor('kind', {
      id: 'type',
      header: 'Type',
      enableSorting: false,
      meta: { className: 'hidden md:table-cell' },
      cell: (info) => info.getValue(),
    }),
    columnHelper.accessor(classesLabel, {
      id: 'classes',
      header: 'Classes',
      enableSorting: false,
      meta: { className: 'hidden md:table-cell' },
      cell: (info) => info.getValue(),
    }),
    columnHelper.accessor(destinationsLabel, {
      id: 'destinations',
      header: 'Pass destinations',
      enableSorting: false,
      meta: { className: 'hidden lg:table-cell' },
      cell: (info) => info.getValue(),
    }),
    columnHelper.accessor('status', {
      id: 'status',
      header: 'Status',
      cell: (info) => <Badge variant="secondary">{statusLabel(info.getValue())}</Badge>,
    }),
    columnHelper.display({
      id: 'actions',
      header: 'Actions',
      enableSorting: false,
      cell: (info) => (
        <Button variant="ghost" size="sm" asChild>
          <Link to={info.row.original.id}>Open</Link>
        </Button>
      ),
    }),
  ];
  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => row.id,
  });
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: queryKeys.places(organizationId) });
  const create = useMutation({
    mutationFn: (body: {
      name: string;
      kind: string;
      code: string | null;
      floorLabel: string | null;
    }) => {
      const key = crypto.randomUUID();
      return confirmed(
        api.POST('/api/v1/organizations/{organizationId}/locations', {
          params: { path: { organizationId }, header: { 'idempotency-key': key } },
          headers: { 'X-CSRF-Token': getCsrfToken(), 'Idempotency-Key': key },
          body: {
            ...body,
            parentLocationId: null,
          },
        }),
      );
    },
    onSuccess: () => {
      setCreating(false);
      setName('');
      setKind('classroom');
      setCode('');
      setFloor('');
      create.reset();
      refresh();
    },
  });
  const createValid = name.trim() !== '' && kind.trim() !== '';
  const error = create.error;

  return (
    <section aria-labelledby="places-title" className="flex flex-col gap-4">
      <PageHeader
        title="Places"
        description="Physical places in this school. Open a place to manage the classes that meet there and the pass destinations students can request."
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="categories">Pass categories</Link>
            </Button>
            <Button
              onClick={() => {
                create.reset();
                setName('');
                setKind('classroom');
                setCode('');
                setFloor('');
                setCreating(true);
              }}
            >
              New place
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="ghost" size="icon-sm" aria-label="More place actions">
                    <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} aria-hidden="true" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => {
                    setSetupOpen(true);
                  }}
                >
                  Set up classroom visits
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Place not saved</AlertTitle>
          <AlertDescription>{productMessage(error)}</AlertDescription>
        </Alert>
      )}
      <div className="min-w-52 max-w-md">
        <InputGroup>
          <InputGroupAddon>
            <InputGroupText>
              <HugeiconsIcon icon={Search01Icon} strokeWidth={2} aria-hidden="true" />
            </InputGroupText>
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search places"
            placeholder="Search name, room, teacher, destination"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </InputGroup>
      </div>
      {places.isPending ? (
        <div role="status" aria-label="Loading places" className="flex flex-col gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <span className="sr-only">Loading places…</span>
        </div>
      ) : rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No places found.</EmptyTitle>
            <EmptyDescription>
              {search.trim().length > 0
                ? 'Try a different search.'
                : 'Create the first place with New place.'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table aria-label="Places">
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
          if (!open && !create.isPending) {
            setCreating(false);
            create.reset();
          }
        }}
      >
        <DialogContent aria-label="New place">
          <DialogHeader>
            <DialogTitle>New place</DialogTitle>
            <DialogDescription>
              Add a physical place. Pass destinations are added from the place itself.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Field>
              <FieldLabel htmlFor="place-name">Name</FieldLabel>
              <Input
                id="place-name"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
                placeholder="Room 214"
              />
              {!createValid && name.trim() === '' && <FieldError>Name is required.</FieldError>}
            </Field>
            <Field>
              <FieldLabel htmlFor="place-kind">Type</FieldLabel>
              <Input
                id="place-kind"
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value);
                }}
                placeholder="classroom"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="place-code">Room code (optional)</FieldLabel>
              <Input
                id="place-code"
                value={code}
                onChange={(event) => {
                  setCode(event.target.value);
                }}
                placeholder="214"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="place-floor">Floor (optional)</FieldLabel>
              <Input
                id="place-floor"
                value={floor}
                onChange={(event) => {
                  setFloor(event.target.value);
                }}
                placeholder="2nd floor"
              />
            </Field>
            {create.error && <FieldError>{productMessage(create.error)}</FieldError>}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCreating(false);
                create.reset();
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={!createValid || create.isPending}
              onClick={() => {
                create.mutate({
                  name: name.trim(),
                  kind: kind.trim(),
                  code: code.trim() === '' ? null : code.trim(),
                  floorLabel: floor.trim() === '' ? null : floor.trim(),
                });
              }}
            >
              {create.isPending ? 'Saving…' : 'Save place'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ClassroomSetupDialog
        open={setupOpen}
        onOpenChange={setSetupOpen}
        onDone={() => {
          refresh();
          void queryClient.invalidateQueries({
            queryKey: queryKeys.destinations(organizationId),
          });
          void queryClient.invalidateQueries({
            queryKey: queryKeys.destinationCategories(organizationId),
          });
        }}
      />
    </section>
  );
}
