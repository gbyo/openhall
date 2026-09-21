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
import { ArrowUpDownIcon, MoreHorizontalIcon, Search01Icon } from '@hugeicons/core-free-icons';
import { Link, useNavigate } from 'react-router';
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

function statusLabel(status: string): string {
  switch (status) {
    case 'active':
      return 'Open';
    case 'closed':
      return 'Closed';
    default:
      return 'Archived';
  }
}

function checkInLabel(mode: string): string {
  switch (mode) {
    case 'required':
      return 'Station required';
    case 'optional':
      return 'Optional';
    default:
      return 'None';
  }
}

interface DestinationRow {
  id: string;
  displayName: string | null;
  serviceType: string;
  locationId: string;
  capacity: number | null;
  queueEnabled: boolean;
  checkInMode: string;
  status: string;
}

interface LocationOption {
  value: string;
  label: string;
}

const columnHelper = createColumnHelper<DestinationRow>();

export function DestinationsPage() {
  const { organizationId } = useSchool();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [sorting, setSorting] = useState<SortingState>([]);
  const [creating, setCreating] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [serviceType, setServiceType] = useState('');
  const [locationId, setLocationId] = useState<string | null>(null);
  const [confirmingArchive, setConfirmingArchive] = useState<{
    id: string;
    name: string;
  } | null>(null);
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
  const locationName = useMemo(() => {
    const names = new Map(
      (locations.data?.locations ?? []).map((location) => [location.id, location.name]),
    );
    return (id: string) => names.get(id) ?? '—';
  }, [locations.data]);
  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    const all = (destinations.data?.destinations ?? []) as DestinationRow[];
    if (query.length === 0) return all;
    return all.filter((destination) =>
      `${destination.displayName ?? ''} ${destination.serviceType} ${locationName(destination.locationId)}`
        .toLowerCase()
        .includes(query),
    );
  }, [destinations.data, search, locationName]);
  const columns = [
    columnHelper.accessor((row) => row.displayName ?? row.serviceType, {
      id: 'destination',
      header: 'Destination',
      cell: (info) => (
        <span className="flex flex-col">
          <Link
            to={info.row.original.id}
            className="font-medium underline-offset-4 hover:underline"
          >
            {info.getValue()}
          </Link>
          <span className="text-xs text-muted-foreground">
            {locationName(info.row.original.locationId)}
          </span>
        </span>
      ),
    }),
    columnHelper.accessor((row) => row.capacity ?? -1, {
      id: 'capacity',
      header: 'Capacity',
      enableSorting: false,
      meta: { className: 'hidden lg:table-cell' },
      cell: (info) => (info.row.original.capacity === null ? 'No limit' : info.getValue()),
    }),
    columnHelper.accessor('queueEnabled', {
      id: 'queue',
      header: 'Queue',
      enableSorting: false,
      meta: { className: 'hidden md:table-cell' },
      cell: (info) => (info.getValue() ? 'On' : 'Off'),
    }),
    columnHelper.accessor('checkInMode', {
      id: 'checkIn',
      header: 'Check-in',
      enableSorting: false,
      meta: { className: 'hidden md:table-cell' },
      cell: (info) => checkInLabel(info.getValue()),
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
        <RowActions
          name={info.row.original.displayName ?? info.row.original.serviceType}
          status={info.row.original.status}
          onView={() => {
            void navigate(info.row.original.id);
          }}
          onToggle={() => {
            toggle.mutate({
              id: info.row.original.id,
              open: info.row.original.status !== 'active',
            });
          }}
          toggling={toggle.isPending && toggle.variables.id === info.row.original.id}
          onArchive={() => {
            setConfirmingArchive({
              id: info.row.original.id,
              name: info.row.original.displayName ?? info.row.original.serviceType,
            });
          }}
        />
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
  const locationOptions = useMemo<LocationOption[]>(
    () =>
      (locations.data?.locations ?? [])
        .filter((item) => item.status !== 'archived')
        .map((item) => ({ value: item.id, label: item.name })),
    [locations.data],
  );
  const selectedLocation = locationOptions.find((option) => option.value === locationId) ?? null;
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: queryKeys.destinations(organizationId) });
  const create = useMutation({
    mutationFn: (body: { locationId: string; displayName: string | null; serviceType: string }) => {
      const key = crypto.randomUUID();
      return confirmed(
        api.POST('/api/v1/organizations/{organizationId}/destinations', {
          params: { path: { organizationId }, header: { 'idempotency-key': key } },
          headers: { 'X-CSRF-Token': getCsrfToken(), 'Idempotency-Key': key },
          body: {
            ...body,
            capacity: null,
            queueEnabled: false,
            checkInMode: 'none',
            defaultDurationSeconds: 600,
            maxDurationSeconds: 1200,
            readyClaimTimeoutSeconds: 120,
            queueTimeoutSeconds: 1800,
          },
        }),
      );
    },
    onSuccess: (result) => {
      setCreating(false);
      setDisplayName('');
      setServiceType('');
      setLocationId(null);
      refresh();
      void navigate(result.destination.id);
    },
  });
  async function toggleState(id: string, open: boolean) {
    const detail = await api.GET('/api/v1/destinations/{destinationId}', {
      params: { path: { destinationId: id } },
    });
    requireData(detail);
    const etag = detail.response.headers.get('etag') ?? '';
    const key = crypto.randomUUID();
    const params = {
      path: { destinationId: id },
      header: { 'idempotency-key': key, 'if-match': etag },
    };
    const headers = {
      'X-CSRF-Token': getCsrfToken(),
      'Idempotency-Key': key,
      'If-Match': etag,
    };
    if (open)
      return confirmed(api.POST('/api/v1/destinations/{destinationId}/open', { params, headers }));
    return confirmed(api.POST('/api/v1/destinations/{destinationId}/close', { params, headers }));
  }
  const toggle = useMutation({
    mutationFn: (input: { id: string; open: boolean }) => toggleState(input.id, input.open),
    onSuccess: refresh,
    onError: refresh,
  });
  const archive = useMutation({
    mutationFn: async ({ id, key }: { id: string; key: string }) => {
      const detail = await api.GET('/api/v1/destinations/{destinationId}', {
        params: { path: { destinationId: id } },
      });
      requireData(detail);
      const etag = detail.response.headers.get('etag') ?? '';
      return confirmed(
        api.POST('/api/v1/destinations/{destinationId}/archive', {
          params: {
            path: { destinationId: id },
            header: { 'idempotency-key': key, 'if-match': etag },
          },
          headers: {
            'X-CSRF-Token': getCsrfToken(),
            'Idempotency-Key': key,
            'If-Match': etag,
          },
        }),
      );
    },
    onSuccess: () => {
      setConfirmingArchive(null);
      refresh();
    },
  });

  function closeCreate() {
    if (create.isPending) return;
    setCreating(false);
    setDisplayName('');
    setServiceType('');
    setLocationId(null);
    create.reset();
  }

  const createValid = serviceType.trim() !== '' && locationId !== null && !locations.isPending;
  const error = create.error ?? toggle.error ?? archive.error;

  return (
    <section aria-labelledby="destinations-title" className="flex flex-col gap-4">
      <PageHeader
        title="Destinations"
        description="New destinations start closed and open only after review."
        actions={
          <Button
            onClick={() => {
              create.reset();
              setDisplayName('');
              setServiceType('');
              setLocationId(null);
              setCreating(true);
            }}
          >
            New destination
          </Button>
        }
      />
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Destination change not confirmed</AlertTitle>
          <AlertDescription>{productMessage(error)}</AlertDescription>
          {error instanceof UncertainCommandError && (
            <AlertAction>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (create.error) create.mutate(create.variables);
                  else if (toggle.error) toggle.mutate(toggle.variables);
                  else if (archive.error) archive.mutate(archive.variables);
                }}
              >
                Check again
              </Button>
            </AlertAction>
          )}
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
            aria-label="Search destinations"
            placeholder="Search destinations"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </InputGroup>
      </div>
      {destinations.isPending ? (
        <div role="status" aria-label="Loading destinations" className="flex flex-col gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <span className="sr-only">Loading destinations…</span>
        </div>
      ) : rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No destinations found.</EmptyTitle>
            <EmptyDescription>
              {search.trim().length > 0
                ? 'Try a different search.'
                : 'Create the first destination with New destination.'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table aria-label="Destinations">
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
            <DialogTitle>New destination</DialogTitle>
            <DialogDescription>
              Only the essentials. New destinations start closed and open only after review.
            </DialogDescription>
          </DialogHeader>
          {locations.isPending ? (
            <div role="status" aria-label="Loading locations" className="flex flex-col gap-2">
              <Skeleton className="h-9 w-full" />
              <span className="sr-only">Loading locations…</span>
            </div>
          ) : (
            <>
              <Field>
                <FieldLabel htmlFor="destination-name">Display name</FieldLabel>
                <Input
                  id="destination-name"
                  value={displayName}
                  placeholder="Optional — shown to students"
                  onChange={(event) => {
                    setDisplayName(event.target.value);
                  }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="destination-type">Type</FieldLabel>
                <Input
                  id="destination-type"
                  value={serviceType}
                  required
                  placeholder="e.g. nurse"
                  onChange={(event) => {
                    setServiceType(event.target.value);
                  }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="destination-location">Location</FieldLabel>
                <Combobox
                  items={locationOptions}
                  value={selectedLocation}
                  onValueChange={(option: LocationOption | null) => {
                    setLocationId(option?.value ?? null);
                  }}
                  filter={(item: LocationOption, query: string) =>
                    item.label.toLowerCase().includes(query.toLowerCase())
                  }
                >
                  <ComboboxInput id="destination-location" placeholder="Search locations" />
                  <ComboboxContent>
                    <ComboboxList>
                      {(item: LocationOption) => (
                        <ComboboxItem key={item.value} value={item}>
                          {item.label}
                        </ComboboxItem>
                      )}
                    </ComboboxList>
                    <ComboboxEmpty>No matching location.</ComboboxEmpty>
                  </ComboboxContent>
                </Combobox>
                {locations.isError ? (
                  <FieldError>Locations could not be loaded. Try again.</FieldError>
                ) : null}
              </Field>
            </>
          )}
          {create.isError && (
            <Alert variant="destructive">
              <AlertTitle>Destination not created</AlertTitle>
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
              disabled={create.isPending || !createValid}
              aria-busy={create.isPending}
              onClick={() => {
                if (createValid && locationId) {
                  create.mutate({
                    locationId,
                    displayName: displayName.trim() === '' ? null : displayName.trim(),
                    serviceType: serviceType.trim(),
                  });
                }
              }}
            >
              {create.isPending ? <Spinner data-icon="inline-start" /> : null}
              {create.isPending ? 'Creating…' : 'Create closed destination'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={confirmingArchive !== null}
        onOpenChange={(open) => {
          if (!open && !archive.isPending) setConfirmingArchive(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmingArchive ? `Archive ${confirmingArchive.name}?` : 'Archive destination?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Archived destinations stay in history but can no longer receive passes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep destination</AlertDialogCancel>
            <AlertDialogAction
              disabled={archive.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (confirmingArchive && !archive.isPending)
                  archive.mutate({ id: confirmingArchive.id, key: crypto.randomUUID() });
              }}
            >
              {archive.isPending ? <Spinner data-icon="inline-start" /> : null}
              {archive.isPending ? 'Archiving…' : 'Archive destination'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function RowActions({
  name,
  status,
  onView,
  onToggle,
  toggling,
  onArchive,
}: {
  name: string;
  status: string;
  onView: () => void;
  onToggle: () => void;
  toggling: boolean;
  onArchive: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-sm" />}
        aria-label={`Actions for ${name}`}
      >
        <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={() => {
            onView();
          }}
        >
          View details
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={toggling}
          onClick={() => {
            onToggle();
          }}
        >
          {toggling ? 'Working…' : status === 'active' ? 'Close destination' : 'Open destination'}
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onClick={() => {
            onArchive();
          }}
        >
          Archive destination
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
