import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getGroupedRowModel,
  getSortedRowModel,
  useReactTable,
  type ExpandedState,
  type RowSelectionState,
  type SortingState,
} from '@tanstack/react-table';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowUpDownIcon, MoreHorizontalIcon, Search01Icon } from '@hugeicons/core-free-icons';
import { Link, useNavigate } from 'react-router';
import { api, confirmed, requireData } from '../../../api/client';
import { productMessage, UncertainCommandError } from '../../../api/problems';
import { queryKeys } from '../../../api/query-keys';
import { getCsrfToken } from '../../../api/session';
import type { Room, RoomCategory } from '../../../api/types.js';
import { useSchool } from '../../../app/school/SchoolShell';
import { PageHeader } from '../../../components/workspace/PageHeader';
import {
  iconForCategoryKey,
  matchesRoomSearch,
  normalizeRoomSearch,
  surfaceLabel,
} from '../../../lib/room-category-presentation.js';
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
import { Checkbox } from '@/components/ui/checkbox';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { RoomCategoryDialog, type RoomCategoryFormValue } from './RoomCategoryDialog.js';

const UNCATEGORIZED_KEY = 'uncategorized';

function statusLabel(status: string): string {
  switch (status) {
    case 'open':
      return 'Open';
    case 'closed':
      return 'Closed';
    default:
      return 'Archived';
  }
}

interface RoomRow {
  id: string;
  name: string;
  code: string | null;
  floorLabel: string | null;
  categoryId: string | null;
  groupKey: string;
  studentSelfRequestable: boolean;
  status: string;
  staffClassLabel: string;
  haystack: string;
}

const columnHelper = createColumnHelper<RoomRow>();

function authedHeaders(key: string, etag?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'X-CSRF-Token': getCsrfToken(),
    'Idempotency-Key': key,
  };
  if (etag !== undefined) headers['If-Match'] = etag;
  return headers;
}

async function fetchRoomEtag(roomId: string): Promise<{ room: Room; etag: string }> {
  const detail = await api.GET('/api/v1/rooms/{roomId}', {
    params: { path: { roomId } },
  });
  const data = requireData(detail);
  return { room: data.room, etag: detail.response.headers.get('etag') ?? '' };
}

export function RoomsPage() {
  const { organizationId, context } = useSchool();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [sorting, setSorting] = useState<SortingState>([]);
  const [expandedState, setExpandedState] = useState<ExpandedState>(true);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [roomFloor, setRoomFloor] = useState('');
  const [roomCategoryId, setRoomCategoryId] = useState<string | null>(null);
  const [roomRequestable, setRoomRequestable] = useState(false);
  const [roomTouched, setRoomTouched] = useState(false);
  const [categoryDialog, setCategoryDialog] = useState<{ category: RoomCategory | null } | null>(
    null,
  );
  const [confirmingArchiveCategory, setConfirmingArchiveCategory] = useState<RoomCategory | null>(
    null,
  );
  const [confirmingArchiveRoom, setConfirmingArchiveRoom] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [bulkCategoryId, setBulkCategoryId] = useState<string | null>(null);

  const roomsQuery = useQuery({
    queryKey: queryKeys.rooms(organizationId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/rooms', {
          params: { path: { organizationId } },
        }),
      ),
  });
  const categoriesQuery = useQuery({
    queryKey: queryKeys.roomCategories(organizationId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/room-categories', {
          params: { path: { organizationId } },
        }),
      ),
  });
  const canReadGrants = context.capabilities.includes('authorization.manage');
  const grantsQuery = useQuery({
    queryKey: queryKeys.grants(organizationId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/authorization-grants', {
          params: { path: { organizationId } },
        }),
      ),
    enabled: canReadGrants,
  });
  // Teacher/class search context for *every* room, from the admin-authorized
  // source rather than the student catalog (which only returns open,
  // student-requestable rooms and needs `pass.request.self`).
  const roomContextsQuery = useQuery({
    queryKey: queryKeys.roomContexts(organizationId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/room-contexts', {
          params: { path: { organizationId } },
        }),
      ),
  });

  const categories = useMemo(
    () =>
      [...(categoriesQuery.data?.categories ?? [])].sort(
        (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
      ),
    [categoriesQuery.data],
  );
  const activeCategories = useMemo(
    () => categories.filter((item) => item.status === 'active'),
    [categories],
  );
  const categoryById = useMemo(
    () => new Map(categories.map((category) => [category.id, category])),
    [categories],
  );
  const staffNamesByRoom = useMemo(() => {
    const names = new Map<string, string[]>();
    for (const grant of grantsQuery.data?.grants ?? []) {
      if (grant.role !== 'room_staff' || grant.status !== 'active' || !grant.roomId) continue;
      const list = names.get(grant.roomId) ?? [];
      list.push(grant.person.displayName);
      names.set(grant.roomId, list);
    }
    return names;
  }, [grantsQuery.data]);
  const scheduleContextByRoom = useMemo(
    () =>
      new Map(
        (roomContextsQuery.data?.rooms ?? []).map((entry) => [
          entry.roomId,
          { teachers: entry.teacherNames, sections: entry.sectionLabels },
        ]),
      ),
    [roomContextsQuery.data],
  );

  const rows = useMemo<RoomRow[]>(() => {
    const rooms = [...(roomsQuery.data?.rooms ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    const categoryOrder = new Map(activeCategories.map((category, index) => [category.id, index]));
    rooms.sort((a, b) => {
      const orderA = a.categoryId
        ? (categoryOrder.get(a.categoryId) ?? activeCategories.length)
        : activeCategories.length + 1;
      const orderB = b.categoryId
        ? (categoryOrder.get(b.categoryId) ?? activeCategories.length)
        : activeCategories.length + 1;
      if (orderA !== orderB) return orderA - orderB;
      return a.name.localeCompare(b.name);
    });
    const query = normalizeRoomSearch(search);
    return rooms
      .map((room): RoomRow => {
        const category = room.categoryId !== null ? categoryById.get(room.categoryId) : undefined;
        const groupKey = category?.status === 'active' ? category.id : UNCATEGORIZED_KEY;
        const staffNames = staffNamesByRoom.get(room.id) ?? [];
        const scheduleContext = scheduleContextByRoom.get(room.id);
        const teacherNames = scheduleContext?.teachers ?? [];
        const sectionLabels = scheduleContext?.sections ?? [];
        const staffClassNames = [...staffNames, ...teacherNames];
        const haystack = [
          room.name,
          room.code ?? '',
          room.floorLabel ?? '',
          category?.name ?? '',
          ...staffNames,
          ...teacherNames,
          ...sectionLabels,
        ].join(' ');
        const staffClassLabel =
          staffClassNames.length > 0
            ? staffClassNames.slice(0, 2).join(' · ') +
              (staffClassNames.length > 2 ? ` +${String(staffClassNames.length - 2)}` : '')
            : '—';
        return {
          id: room.id,
          name: room.name,
          code: room.code,
          floorLabel: room.floorLabel,
          categoryId: room.categoryId,
          groupKey,
          studentSelfRequestable: room.studentSelfRequestable,
          status: room.status,
          staffClassLabel,
          haystack,
        };
      })
      .filter((row) => query.length === 0 || matchesRoomSearch(row.haystack, query));
  }, [
    roomsQuery.data,
    search,
    categoryById,
    activeCategories,
    staffNamesByRoom,
    scheduleContextByRoom,
  ]);

  const groupMeta = useMemo(() => {
    const meta = new Map<string, { name: string; iconKey: string; surface: string | null }>();
    for (const category of activeCategories) {
      meta.set(category.id, {
        name: category.name,
        iconKey: category.iconKey,
        surface: category.studentSurface,
      });
    }
    meta.set(UNCATEGORIZED_KEY, { name: 'Uncategorized', iconKey: 'generic', surface: null });
    return meta;
  }, [activeCategories]);

  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const room of roomsQuery.data?.rooms ?? []) {
      if (room.status === 'archived') continue;
      const category = room.categoryId !== null ? categoryById.get(room.categoryId) : undefined;
      const key = category?.status === 'active' ? category.id : UNCATEGORIZED_KEY;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [roomsQuery.data, categoryById]);

  const searching = normalizeRoomSearch(search).length > 0;

  const columns = useMemo(
    () => [
      columnHelper.display({
        id: 'select',
        header: ({ table }) => (
          <Checkbox
            aria-label="Select all rooms"
            checked={table.getIsAllPageRowsSelected()}
            indeterminate={table.getIsSomePageRowsSelected()}
            onCheckedChange={(value) => {
              table.toggleAllPageRowsSelected(value);
            }}
          />
        ),
        cell: ({ row }) =>
          row.getIsGrouped() ? null : (
            <Checkbox
              aria-label={`Select ${row.original.name}`}
              checked={row.getIsSelected()}
              disabled={!row.getCanSelect()}
              onCheckedChange={(value) => {
                row.toggleSelected(value);
              }}
            />
          ),
        enableSorting: false,
      }),
      columnHelper.accessor('groupKey', {
        id: 'room',
        header: 'Room',
        cell: ({ row }) => {
          if (row.getIsGrouped()) {
            const key =
              typeof row.groupingValue === 'string' ? row.groupingValue : UNCATEGORIZED_KEY;
            const meta = groupMeta.get(key);
            const count = groupCounts.get(key) ?? row.getLeafRows().length;
            return (
              <span className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-expanded={row.getIsExpanded()}
                  aria-label={`${row.getIsExpanded() ? 'Collapse' : 'Expand'} ${meta?.name ?? key}`}
                  onClick={row.getToggleExpandedHandler()}
                >
                  <span aria-hidden="true">{row.getIsExpanded() ? '▾' : '▸'}</span>
                </Button>
                <HugeiconsIcon
                  icon={iconForCategoryKey(meta?.iconKey ?? 'generic')}
                  strokeWidth={2}
                  aria-hidden="true"
                  className="size-4 text-muted-foreground"
                />
                <span className="font-medium">{meta?.name ?? key}</span>
                <span className="text-xs text-muted-foreground">
                  {count === 1 ? '1 room' : `${String(count)} rooms`}
                </span>
                {meta?.surface ? (
                  <Badge variant="secondary">{surfaceLabel(meta.surface)}</Badge>
                ) : null}
              </span>
            );
          }
          const room = row.original;
          const sub =
            [room.code, room.floorLabel].filter((part) => part && part.length > 0).join(' · ') ||
            null;
          return (
            <span className="flex flex-col">
              <Link to={room.id} className="font-medium underline-offset-4 hover:underline">
                {room.name}
              </Link>
              {sub ? <span className="text-xs text-muted-foreground">{sub}</span> : null}
            </span>
          );
        },
      }),
      columnHelper.accessor('staffClassLabel', {
        id: 'staff',
        header: 'Staff / classes',
        enableSorting: false,
        meta: { className: 'hidden md:table-cell' },
        cell: (info) =>
          info.row.getIsGrouped() ? null : (
            <span className="text-sm text-muted-foreground">{info.getValue()}</span>
          ),
      }),
      columnHelper.accessor('studentSelfRequestable', {
        id: 'access',
        header: 'Student access',
        enableSorting: false,
        meta: { className: 'hidden md:table-cell' },
        cell: (info) =>
          info.row.getIsGrouped() ? null : info.getValue() ? (
            <Badge variant="secondary">Students can request</Badge>
          ) : (
            <span className="text-sm text-muted-foreground">Staff only</span>
          ),
      }),
      columnHelper.accessor('status', {
        id: 'status',
        header: 'Status',
        cell: (info) =>
          info.row.getIsGrouped() ? null : (
            <Badge variant="secondary">{statusLabel(info.getValue())}</Badge>
          ),
      }),
      columnHelper.display({
        id: 'actions',
        header: 'Actions',
        enableSorting: false,
        cell: ({ row }) => {
          if (row.getIsGrouped()) {
            const key =
              typeof row.groupingValue === 'string' ? row.groupingValue : UNCATEGORIZED_KEY;
            if (key === UNCATEGORIZED_KEY) return null;
            const category = categoryById.get(key);
            if (!category) return null;
            return (
              <CategoryMenu
                category={category}
                onEdit={() => {
                  saveCategory.reset();
                  setCategoryDialog({ category });
                }}
                onArchive={() => {
                  archiveCategory.reset();
                  setConfirmingArchiveCategory(category);
                }}
              />
            );
          }
          const room = row.original;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon-sm" />}
                aria-label={`Actions for ${room.name}`}
              >
                <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => {
                    void navigate(room.id);
                  }}
                >
                  View details
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    toggleRoom.mutate({ id: room.id, open: room.status !== 'open' });
                  }}
                >
                  {room.status !== 'open' ? 'Open room' : 'Close room'}
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => {
                    setConfirmingArchiveRoom({ id: room.id, name: room.name });
                  }}
                >
                  Archive room
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      }),
    ],
    [groupMeta, groupCounts, categoryById, navigate],
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: {
      sorting,
      expanded: searching ? true : expandedState,
      rowSelection,
      grouping: ['room'],
    },
    // Refetches (realtime resync) must never collapse the user's groups.
    autoResetExpanded: false,
    onSortingChange: setSorting,
    onExpandedChange: setExpandedState,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getGroupedRowModel: getGroupedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getRowId: (row) => row.id,
    enableRowSelection: (row) => !row.getIsGrouped(),
  });

  const selectedIds = useMemo(
    () => table.getSelectedRowModel().flatRows.map((row) => row.original.id),
    [rowSelection, rows, table],
  );

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.rooms(organizationId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.roomCategories(organizationId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.roomContexts(organizationId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.studentRoomCatalog(organizationId) });
  };

  const createRoom = useMutation({
    mutationFn: (body: {
      categoryId: string | null;
      name: string;
      code: string | null;
      floorLabel: string | null;
      studentSelfRequestable: boolean;
    }) => {
      const key = crypto.randomUUID();
      return confirmed(
        api.POST('/api/v1/organizations/{organizationId}/rooms', {
          params: { path: { organizationId }, header: { 'idempotency-key': key } },
          headers: authedHeaders(key),
          body: {
            ...body,
            originSelectable: true,
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
      resetCreateRoomForm();
      setCreatingRoom(false);
      refresh();
      void navigate(result.room.id);
    },
  });

  async function setRoomState(id: string, open: boolean) {
    const { etag } = await fetchRoomEtag(id);
    const key = crypto.randomUUID();
    const params = {
      path: { roomId: id },
      header: { 'idempotency-key': key, 'if-match': etag },
    };
    if (open)
      return confirmed(
        api.POST('/api/v1/rooms/{roomId}/open', { params, headers: authedHeaders(key, etag) }),
      );
    return confirmed(
      api.POST('/api/v1/rooms/{roomId}/close', { params, headers: authedHeaders(key, etag) }),
    );
  }

  const toggleRoom = useMutation({
    mutationFn: (input: { id: string; open: boolean }) => setRoomState(input.id, input.open),
    onSuccess: refresh,
    onError: refresh,
  });

  const archiveRoom = useMutation({
    mutationFn: async ({ id, key }: { id: string; key: string }) => {
      const { etag } = await fetchRoomEtag(id);
      return confirmed(
        api.POST('/api/v1/rooms/{roomId}/archive', {
          params: { path: { roomId: id }, header: { 'idempotency-key': key, 'if-match': etag } },
          headers: authedHeaders(key, etag),
        }),
      );
    },
    onSuccess: () => {
      setConfirmingArchiveRoom(null);
      refresh();
    },
  });

  // One transactional server command: the whole selection lands or none of
  // it does, so a mid-run failure can never leave the school half
  // reconfigured.
  const bulk = useMutation({
    mutationFn: (
      input:
        | { kind: 'category'; categoryId: string }
        | { kind: 'request'; on: boolean }
        | { kind: 'state'; open: boolean },
    ) => {
      const key = crypto.randomUUID();
      const change =
        input.kind === 'category'
          ? ({ kind: 'category', categoryId: input.categoryId } as const)
          : input.kind === 'request'
            ? ({ kind: 'student_requestable', studentSelfRequestable: input.on } as const)
            : ({ kind: 'status', status: input.open ? 'open' : 'closed' } as const);
      return confirmed(
        api.POST('/api/v1/organizations/{organizationId}/rooms/bulk', {
          params: { path: { organizationId }, header: { 'idempotency-key': key } },
          headers: authedHeaders(key),
          body: { roomIds: selectedIds, change },
        }),
      );
    },
    onSuccess: () => {
      setRowSelection({});
      setBulkCategoryId(null);
      refresh();
    },
    onSettled: refresh,
  });

  const saveCategory = useMutation({
    mutationFn: async ({ value, key }: { value: RoomCategoryFormValue; key: string }) => {
      const editing = categoryDialog?.category ?? null;
      if (!editing) {
        return confirmed(
          api.POST('/api/v1/organizations/{organizationId}/room-categories', {
            params: { path: { organizationId }, header: { 'idempotency-key': key } },
            headers: authedHeaders(key),
            body: { ...value },
          }),
        );
      }
      const detail = await api.GET('/api/v1/room-categories/{categoryId}', {
        params: { path: { categoryId: editing.id } },
      });
      requireData(detail);
      const etag = detail.response.headers.get('etag') ?? '';
      return confirmed(
        api.PUT('/api/v1/room-categories/{categoryId}', {
          params: {
            path: { categoryId: editing.id },
            header: { 'idempotency-key': key, 'if-match': etag },
          },
          headers: authedHeaders(key, etag),
          body: { ...value },
        }),
      );
    },
    onSuccess: () => {
      setCategoryDialog(null);
      refresh();
    },
  });

  const archiveCategory = useMutation({
    mutationFn: async ({ id, key }: { id: string; key: string }) => {
      const detail = await api.GET('/api/v1/room-categories/{categoryId}', {
        params: { path: { categoryId: id } },
      });
      requireData(detail);
      const etag = detail.response.headers.get('etag') ?? '';
      return confirmed(
        api.POST('/api/v1/room-categories/{categoryId}/archive', {
          params: {
            path: { categoryId: id },
            header: { 'idempotency-key': key, 'if-match': etag },
          },
          headers: authedHeaders(key, etag),
        }),
      );
    },
    onSuccess: () => {
      setConfirmingArchiveCategory(null);
      refresh();
    },
  });

  function resetCreateRoomForm() {
    setRoomName('');
    setRoomCode('');
    setRoomFloor('');
    setRoomCategoryId(null);
    setRoomRequestable(false);
    setRoomTouched(false);
    createRoom.reset();
  }

  function closeCreateRoom() {
    if (createRoom.isPending) return;
    setCreatingRoom(false);
    resetCreateRoomForm();
  }

  const roomNameError = roomTouched && roomName.trim() === '' ? 'Name is required.' : null;
  const roomCategoryError =
    roomTouched && roomRequestable && roomCategoryId === null
      ? 'Rooms students can request must belong to a category.'
      : null;
  const roomValid = roomNameError === null && roomCategoryError === null;

  const error =
    createRoom.error ??
    toggleRoom.error ??
    archiveRoom.error ??
    bulk.error ??
    saveCategory.error ??
    archiveCategory.error;
  const archiveCategoryInUse =
    archiveCategory.error && productMessage(archiveCategory.error).toLowerCase().includes('room');

  return (
    <section aria-labelledby="rooms-title" className="flex flex-col gap-4">
      <PageHeader
        title="Rooms"
        description="Categories and rooms live here. New rooms start closed and open only after review."
        actions={
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button />}>Add ▾</DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => {
                  resetCreateRoomForm();
                  setCreatingRoom(true);
                }}
              >
                New room
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  saveCategory.reset();
                  setCategoryDialog({ category: null });
                }}
              >
                New category
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />
      {error && !(archiveCategory.error && archiveCategoryInUse) && (
        <Alert variant="destructive">
          <AlertTitle>Room change not confirmed</AlertTitle>
          <AlertDescription>{productMessage(error)}</AlertDescription>
          {error instanceof UncertainCommandError && (
            <AlertAction>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (toggleRoom.error) toggleRoom.mutate(toggleRoom.variables);
                  else if (archiveRoom.error) archiveRoom.mutate(archiveRoom.variables);
                  else if (bulk.error) bulk.mutate(bulk.variables);
                }}
              >
                Check again
              </Button>
            </AlertAction>
          )}
        </Alert>
      )}
      {archiveCategory.error && archiveCategoryInUse && (
        <Alert>
          <AlertTitle>Category still in use</AlertTitle>
          <AlertDescription>
            This category still contains rooms. Move or archive those rooms first.
          </AlertDescription>
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
            aria-label="Search room, number, teacher, category"
            placeholder="Search room, number, teacher, category…"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </InputGroup>
      </div>
      {selectedIds.length > 0 && (
        <div
          aria-label="Bulk actions"
          className="flex flex-wrap items-center gap-2 rounded-2xl border p-3"
        >
          <span className="text-sm font-medium">
            {selectedIds.length === 1
              ? '1 room selected'
              : `${String(selectedIds.length)} rooms selected`}
          </span>
          <Select
            value={bulkCategoryId}
            onValueChange={(value: string | null) => {
              if (value) setBulkCategoryId(value);
            }}
          >
            <SelectTrigger aria-label="Set category" className="w-44">
              <SelectValue placeholder="Set category" />
            </SelectTrigger>
            <SelectContent>
              {activeCategories.map((category) => (
                <SelectItem key={category.id} value={category.id}>
                  {category.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            disabled={bulk.isPending || bulkCategoryId === null}
            aria-busy={bulk.isPending}
            onClick={() => {
              if (bulkCategoryId) bulk.mutate({ kind: 'category', categoryId: bulkCategoryId });
            }}
          >
            Apply category
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={bulk.isPending}
            aria-busy={bulk.isPending}
            onClick={() => {
              bulk.mutate({ kind: 'request', on: true });
            }}
          >
            Request: On
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={bulk.isPending}
            aria-busy={bulk.isPending}
            onClick={() => {
              bulk.mutate({ kind: 'request', on: false });
            }}
          >
            Request: Off
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={bulk.isPending}
            aria-busy={bulk.isPending}
            onClick={() => {
              bulk.mutate({ kind: 'state', open: true });
            }}
          >
            Open
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={bulk.isPending}
            aria-busy={bulk.isPending}
            onClick={() => {
              bulk.mutate({ kind: 'state', open: false });
            }}
          >
            Close
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={bulk.isPending}
            onClick={() => {
              setRowSelection({});
              setBulkCategoryId(null);
            }}
          >
            Clear
          </Button>
          {bulk.isPending && <Spinner data-icon="inline-start" aria-label="Applying bulk change" />}
        </div>
      )}
      {roomsQuery.isPending || categoriesQuery.isPending ? (
        <div role="status" aria-label="Loading rooms" className="flex flex-col gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <span className="sr-only">Loading rooms…</span>
        </div>
      ) : roomsQuery.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Rooms not loaded</AlertTitle>
          <AlertDescription>{productMessage(roomsQuery.error)}</AlertDescription>
          <AlertAction>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void roomsQuery.refetch();
              }}
            >
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No rooms found.</EmptyTitle>
            <EmptyDescription>
              {searching ? 'Try a different search.' : 'Create the first room with Add › New room.'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table aria-label="Rooms grouped by category">
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
              <TableRow key={row.id} data-grouped={row.getIsGrouped() ? 'true' : undefined}>
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
        open={creatingRoom}
        onOpenChange={(open) => {
          if (!open) closeCreateRoom();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New room</DialogTitle>
            <DialogDescription>
              Only the essentials. New rooms start closed and open only after review — advanced
              settings live on the room detail page.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <Field>
              <FieldLabel htmlFor="room-name">Name</FieldLabel>
              <Input
                id="room-name"
                value={roomName}
                placeholder="Science Lab 214"
                onChange={(event) => {
                  setRoomName(event.target.value);
                }}
              />
              {roomNameError && <FieldError>{roomNameError}</FieldError>}
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="room-code">Room number/code</FieldLabel>
                <Input
                  id="room-code"
                  value={roomCode}
                  placeholder="214"
                  onChange={(event) => {
                    setRoomCode(event.target.value);
                  }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="room-floor">Floor</FieldLabel>
                <Input
                  id="room-floor"
                  value={roomFloor}
                  placeholder="Floor 2"
                  onChange={(event) => {
                    setRoomFloor(event.target.value);
                  }}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="room-category">Category (optional)</FieldLabel>
              <Select
                value={roomCategoryId}
                onValueChange={(value: string | null) => {
                  setRoomCategoryId(value);
                }}
              >
                <SelectTrigger id="room-category">
                  <SelectValue placeholder="Uncategorized" />
                </SelectTrigger>
                <SelectContent>
                  {activeCategories.map((category) => (
                    <SelectItem key={category.id} value={category.id}>
                      {category.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {roomCategoryError && <FieldError>{roomCategoryError}</FieldError>}
            </Field>
            <Field>
              <div className="flex items-center justify-between gap-3">
                <FieldLabel htmlFor="room-requestable">Students can request</FieldLabel>
                <Switch
                  id="room-requestable"
                  checked={roomRequestable}
                  onCheckedChange={setRoomRequestable}
                />
              </div>
            </Field>
          </div>
          {createRoom.isError && (
            <p className="text-sm text-destructive">{productMessage(createRoom.error)}</p>
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              disabled={createRoom.isPending || !roomValid}
              aria-busy={createRoom.isPending}
              onClick={() => {
                setRoomTouched(true);
                if (!roomValid || createRoom.isPending) return;
                createRoom.mutate({
                  categoryId: roomCategoryId,
                  name: roomName.trim(),
                  code: roomCode.trim() === '' ? null : roomCode.trim(),
                  floorLabel: roomFloor.trim() === '' ? null : roomFloor.trim(),
                  studentSelfRequestable: roomRequestable,
                });
              }}
            >
              {createRoom.isPending ? <Spinner data-icon="inline-start" /> : null}
              {createRoom.isPending ? 'Creating…' : 'Create room'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {categoryDialog && (
        <RoomCategoryDialog
          key={categoryDialog.category?.id ?? 'new'}
          open
          category={categoryDialog.category}
          pending={saveCategory.isPending}
          error={saveCategory.error ? productMessage(saveCategory.error) : null}
          onClose={() => {
            if (!saveCategory.isPending) setCategoryDialog(null);
          }}
          onSubmit={(value) => {
            saveCategory.mutate({ value, key: crypto.randomUUID() });
          }}
        />
      )}
      <AlertDialog
        open={confirmingArchiveCategory !== null}
        onOpenChange={(open) => {
          if (!open && !archiveCategory.isPending) setConfirmingArchiveCategory(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmingArchiveCategory
                ? `Archive ${confirmingArchiveCategory.name}?`
                : 'Archive category?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Rooms in this category keep working, but students will no longer see this grouping.
              Move or archive its rooms first if the server reports it is still in use.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep category</AlertDialogCancel>
            <AlertDialogAction
              disabled={archiveCategory.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (confirmingArchiveCategory && !archiveCategory.isPending)
                  archiveCategory.mutate({
                    id: confirmingArchiveCategory.id,
                    key: crypto.randomUUID(),
                  });
              }}
            >
              {archiveCategory.isPending ? <Spinner data-icon="inline-start" /> : null}
              {archiveCategory.isPending ? 'Archiving…' : 'Archive category'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={confirmingArchiveRoom !== null}
        onOpenChange={(open) => {
          if (!open && !archiveRoom.isPending) setConfirmingArchiveRoom(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmingArchiveRoom ? `Archive ${confirmingArchiveRoom.name}?` : 'Archive room?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Archived rooms are historical only and cannot receive new passes. The server refuses
              while live dependencies remain.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep room</AlertDialogCancel>
            <AlertDialogAction
              disabled={archiveRoom.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (confirmingArchiveRoom && !archiveRoom.isPending)
                  archiveRoom.mutate({ id: confirmingArchiveRoom.id, key: crypto.randomUUID() });
              }}
            >
              {archiveRoom.isPending ? <Spinner data-icon="inline-start" /> : null}
              {archiveRoom.isPending ? 'Archiving…' : 'Archive room'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function CategoryMenu({
  category,
  onEdit,
  onArchive,
}: {
  category: RoomCategory;
  onEdit: () => void;
  onArchive: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-sm" />}
        aria-label={`Actions for ${category.name}`}
      >
        <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onEdit}>Edit</DropdownMenuItem>
        {category.status !== 'archived' ? (
          <DropdownMenuItem variant="destructive" onClick={onArchive}>
            Archive
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
