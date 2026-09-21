import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '@/components/ui/input-group';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
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

function command(ifMatch?: string) {
  const key = crypto.randomUUID();
  return {
    headers: {
      'X-CSRF-Token': getCsrfToken(),
      'Idempotency-Key': key,
      ...(ifMatch ? { 'If-Match': ifMatch } : {}),
    },
    header: { 'idempotency-key': key, ...(ifMatch ? { 'if-match': ifMatch } : {}) },
  };
}

interface LocationOption {
  value: string;
  label: string;
}

const NO_PARENT = '';

interface LocationForm {
  name: string;
  kind: string;
  parentLocationId: string | null;
  code: string;
  floorLabel: string;
}

function NewLocationDialog({
  open,
  locations,
  pending,
  failed,
  uncertain,
  onSubmit,
  onClose,
  onRetry,
}: {
  open: boolean;
  locations: LocationOption[];
  pending: boolean;
  failed: string | null;
  uncertain: boolean;
  onSubmit: (form: LocationForm) => void;
  onClose: () => void;
  onRetry: () => void;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('room');
  const [parent, setParent] = useState<LocationOption | null>(null);
  const [code, setCode] = useState('');
  const [floorLabel, setFloorLabel] = useState('');
  const valid = name.trim() !== '' && kind.trim() !== '';
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New location</DialogTitle>
          <DialogDescription>Rooms and shared spaces students can be sent from.</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="location-name">Name</FieldLabel>
            <Input
              id="location-name"
              value={name}
              required
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="location-kind">Type</FieldLabel>
            <Input
              id="location-kind"
              value={kind}
              required
              onChange={(event) => {
                setKind(event.target.value);
              }}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="location-parent">Parent</FieldLabel>
            <Combobox
              items={[{ value: NO_PARENT, label: 'No parent' }, ...locations]}
              value={parent}
              onValueChange={(option: LocationOption | null) => {
                setParent(option);
              }}
              filter={(item: LocationOption, query: string) =>
                item.label.toLowerCase().includes(query.toLowerCase())
              }
            >
              <ComboboxInput id="location-parent" placeholder="Search locations" />
              <ComboboxContent>
                <ComboboxList>
                  {(item: LocationOption) => (
                    <ComboboxItem key={item.value || 'none'} value={item}>
                      {item.label}
                    </ComboboxItem>
                  )}
                </ComboboxList>
                <ComboboxEmpty>No matching location.</ComboboxEmpty>
              </ComboboxContent>
            </Combobox>
          </Field>
          <Field>
            <FieldLabel htmlFor="location-code">Code</FieldLabel>
            <Input
              id="location-code"
              value={code}
              onChange={(event) => {
                setCode(event.target.value);
              }}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="location-floor">Floor</FieldLabel>
            <Input
              id="location-floor"
              value={floorLabel}
              onChange={(event) => {
                setFloorLabel(event.target.value);
              }}
            />
          </Field>
        </FieldGroup>
        {failed && (
          <Alert variant="destructive">
            <AlertTitle>Location not created</AlertTitle>
            <AlertDescription>{failed}</AlertDescription>
            {uncertain && (
              <AlertAction>
                <Button variant="outline" size="sm" onClick={onRetry}>
                  Check again
                </Button>
              </AlertAction>
            )}
          </Alert>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button
            disabled={pending || !valid}
            aria-busy={pending}
            onClick={() => {
              if (valid) {
                onSubmit({
                  name: name.trim(),
                  kind: kind.trim(),
                  parentLocationId: parent && parent.value !== NO_PARENT ? parent.value : null,
                  code: code.trim(),
                  floorLabel: floorLabel.trim(),
                });
              }
            }}
          >
            {pending ? <Spinner data-icon="inline-start" /> : null}
            {pending ? 'Creating…' : 'Create location'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function Component() {
  const { organizationId } = useSchool();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [archiving, setArchiving] = useState<{ id: string; name: string } | null>(null);
  const [draft, setDraft] = useState<LocationForm | null>(null);
  const locations = useQuery({
    queryKey: queryKeys.locations(organizationId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/locations', {
          params: { path: { organizationId } },
        }),
      ),
  });
  const targetId = editingId ?? archiving?.id ?? null;
  const detail = useQuery({
    queryKey: ['location', targetId],
    enabled: targetId !== null,
    queryFn: async () => {
      const result = await api.GET('/api/v1/locations/{locationId}', {
        params: { path: { locationId: targetId ?? '' } },
      });
      return {
        location: requireData(result).location,
        etag: result.response.headers.get('etag') ?? '',
      };
    },
  });
  useEffect(() => {
    if (detail.data && editingId) {
      const location = detail.data.location;
      setDraft({
        name: location.name,
        kind: location.kind,
        parentLocationId: location.parentLocationId,
        code: location.code ?? '',
        floorLabel: location.floorLabel ?? '',
      });
    } else if (!editingId) {
      setDraft(null);
    }
  }, [detail.data, editingId]);
  const refresh = () => {
    setEditingId(null);
    void queryClient.invalidateQueries({ queryKey: queryKeys.locations(organizationId) });
  };
  const create = useMutation({
    mutationFn: (body: {
      name: string;
      kind: string;
      parentLocationId: string | null;
      code: string | null;
      floorLabel: string | null;
    }) => {
      const request = command();
      return confirmed(
        api.POST('/api/v1/organizations/{organizationId}/locations', {
          params: { path: { organizationId }, header: request.header },
          headers: request.headers,
          body,
        }),
      );
    },
    onSuccess: () => {
      setCreating(false);
      refresh();
    },
  });
  const save = useMutation({
    mutationFn: async ({ archive, form }: { form: LocationForm | null; archive: boolean }) => {
      if (!targetId || !detail.data) throw new Error('Location unavailable');
      const request = command(detail.data.etag);
      if (archive)
        return confirmed(
          api.POST('/api/v1/locations/{locationId}/archive', {
            params: { path: { locationId: targetId }, header: request.header },
            headers: request.headers,
          }),
        );
      if (!form) throw new Error('Location details unavailable');
      return confirmed(
        api.PUT('/api/v1/locations/{locationId}', {
          params: { path: { locationId: targetId }, header: request.header },
          headers: request.headers,
          body: {
            name: form.name,
            kind: form.kind,
            parentLocationId: form.parentLocationId,
            code: form.code.trim() === '' ? null : form.code.trim(),
            floorLabel: form.floorLabel.trim() === '' ? null : form.floorLabel.trim(),
          },
        }),
      );
    },
    onSuccess: (_data, variables) => {
      if (variables.archive) setArchiving(null);
      refresh();
    },
  });
  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    const all = locations.data?.locations ?? [];
    if (query.length === 0) return all;
    return all.filter((location) =>
      `${location.name} ${location.kind}`.toLowerCase().includes(query),
    );
  }, [locations.data, search]);
  const parentOptions = useMemo<LocationOption[]>(
    () =>
      (locations.data?.locations ?? [])
        .filter((item) => item.id !== editingId && item.status !== 'archived')
        .map((item) => ({ value: item.id, label: item.name })),
    [locations.data, editingId],
  );
  const draftParent =
    parentOptions.find((option) => option.value === (draft?.parentLocationId ?? '')) ?? null;
  const saveError = save.error ? productMessage(save.error) : null;
  const saveUncertain = save.error instanceof UncertainCommandError;
  const archived = detail.data?.location.status === 'archived';

  function closeSheet() {
    if (save.isPending) return;
    setEditingId(null);
  }

  return (
    <section aria-labelledby="locations-title" className="flex flex-col gap-4">
      <PageHeader
        title="Locations"
        description="Organize rooms and shared spaces. Archiving preserves historical movement."
        actions={
          <Button
            onClick={() => {
              create.reset();
              setCreating(true);
            }}
          >
            New location
          </Button>
        }
      />
      {save.isError && !editingId && (
        <Alert variant="destructive">
          <AlertTitle>Location change not confirmed</AlertTitle>
          <AlertDescription>{saveError}</AlertDescription>
          {saveUncertain && (
            <AlertAction>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  save.mutate(save.variables);
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
            aria-label="Search locations"
            placeholder="Search locations"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </InputGroup>
      </div>
      {locations.isPending ? (
        <div role="status" aria-label="Loading locations" className="flex flex-col gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <span className="sr-only">Loading locations…</span>
        </div>
      ) : rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No locations found.</EmptyTitle>
            <EmptyDescription>
              {search.trim().length > 0
                ? 'Try a different search.'
                : 'Create the first location with New location.'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table aria-label="Locations">
          <TableHeader>
            <TableRow>
              <TableHead>Location</TableHead>
              <TableHead className="hidden sm:table-cell">Type</TableHead>
              <TableHead className="hidden md:table-cell">Floor</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((location) => (
              <TableRow key={location.id}>
                <TableCell className="font-medium">{location.name}</TableCell>
                <TableCell className="hidden sm:table-cell">{location.kind}</TableCell>
                <TableCell className="hidden md:table-cell">{location.floorLabel ?? '—'}</TableCell>
                <TableCell>
                  <Badge variant="secondary">
                    {location.status === 'archived' ? 'Archived' : 'Active'}
                  </Badge>
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={<Button variant="ghost" size="icon-sm" />}
                      aria-label={`Actions for ${location.name}`}
                    >
                      <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => {
                          save.reset();
                          setEditingId(location.id);
                        }}
                      >
                        Edit location
                      </DropdownMenuItem>
                      {location.status !== 'archived' && (
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => {
                            setArchiving({ id: location.id, name: location.name });
                          }}
                        >
                          Archive location
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <NewLocationDialog
        open={creating}
        locations={parentOptions}
        pending={create.isPending}
        failed={create.isError ? productMessage(create.error) : null}
        uncertain={create.error instanceof UncertainCommandError}
        onSubmit={(form) => {
          create.mutate({
            name: form.name,
            kind: form.kind,
            parentLocationId: form.parentLocationId,
            code: form.code === '' ? null : form.code,
            floorLabel: form.floorLabel === '' ? null : form.floorLabel,
          });
        }}
        onClose={() => {
          if (!create.isPending) setCreating(false);
        }}
        onRetry={() => {
          if (create.variables) create.mutate(create.variables);
        }}
      />
      <Sheet
        open={editingId !== null}
        onOpenChange={(open) => {
          if (!open) closeSheet();
        }}
      >
        <SheetContent>
          <SheetHeader>
            <SheetTitle>
              {detail.data ? `Edit ${detail.data.location.name}` : 'Edit location'}
            </SheetTitle>
            <SheetDescription>The table stays behind this panel.</SheetDescription>
          </SheetHeader>
          {!detail.data || !draft ? (
            <div role="status" aria-label="Loading location" className="flex flex-col gap-2 py-4">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <span className="sr-only">Loading location…</span>
            </div>
          ) : (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="edit-location-name">Name</FieldLabel>
                <Input
                  id="edit-location-name"
                  value={draft.name}
                  required
                  onChange={(event) => {
                    setDraft({ ...draft, name: event.target.value });
                  }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="edit-location-kind">Type</FieldLabel>
                <Input
                  id="edit-location-kind"
                  value={draft.kind}
                  required
                  onChange={(event) => {
                    setDraft({ ...draft, kind: event.target.value });
                  }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="edit-location-parent">Parent</FieldLabel>
                <Combobox
                  items={[{ value: NO_PARENT, label: 'No parent' }, ...parentOptions]}
                  value={draftParent}
                  onValueChange={(option: LocationOption | null) => {
                    setDraft({
                      ...draft,
                      parentLocationId: option && option.value !== NO_PARENT ? option.value : null,
                    });
                  }}
                  filter={(item: LocationOption, query: string) =>
                    item.label.toLowerCase().includes(query.toLowerCase())
                  }
                >
                  <ComboboxInput id="edit-location-parent" placeholder="Search locations" />
                  <ComboboxContent>
                    <ComboboxList>
                      {(item: LocationOption) => (
                        <ComboboxItem key={item.value || 'none'} value={item}>
                          {item.label}
                        </ComboboxItem>
                      )}
                    </ComboboxList>
                    <ComboboxEmpty>No matching location.</ComboboxEmpty>
                  </ComboboxContent>
                </Combobox>
              </Field>
              <Field>
                <FieldLabel htmlFor="edit-location-code">Code</FieldLabel>
                <Input
                  id="edit-location-code"
                  value={draft.code}
                  onChange={(event) => {
                    setDraft({ ...draft, code: event.target.value });
                  }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="edit-location-floor">Floor</FieldLabel>
                <Input
                  id="edit-location-floor"
                  value={draft.floorLabel}
                  onChange={(event) => {
                    setDraft({ ...draft, floorLabel: event.target.value });
                  }}
                />
              </Field>
              {save.isError && (
                <Alert variant="destructive">
                  <AlertTitle>Location not saved</AlertTitle>
                  <AlertDescription>{saveError}</AlertDescription>
                  {saveUncertain && (
                    <AlertAction>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          save.mutate(save.variables);
                        }}
                      >
                        Check again
                      </Button>
                    </AlertAction>
                  )}
                </Alert>
              )}
            </FieldGroup>
          )}
          <SheetFooter>
            {!archived && draft && (
              <Button
                variant="destructive"
                disabled={save.isPending}
                onClick={() => {
                  if (editingId && detail.data)
                    setArchiving({ id: editingId, name: detail.data.location.name });
                }}
              >
                Archive
              </Button>
            )}
            <SheetClose render={<Button variant="outline" />}>Cancel</SheetClose>
            <Button
              disabled={
                save.isPending || !draft || draft.name.trim() === '' || draft.kind.trim() === ''
              }
              aria-busy={save.isPending}
              onClick={() => {
                if (draft) save.mutate({ form: draft, archive: false });
              }}
            >
              {save.isPending ? <Spinner data-icon="inline-start" /> : null}
              {save.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
      <AlertDialog
        open={archiving !== null}
        onOpenChange={(open) => {
          if (!open && !save.isPending) setArchiving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {archiving ? `Archive ${archiving.name}?` : 'Archive location?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Archiving preserves historical movement. Destinations in this location stay as they
              are.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep location</AlertDialogCancel>
            <AlertDialogAction
              disabled={save.isPending || !detail.data}
              onClick={(event) => {
                event.preventDefault();
                if (archiving && !save.isPending) save.mutate({ form: null, archive: true });
              }}
            >
              {save.isPending ? <Spinner data-icon="inline-start" /> : null}
              {save.isPending ? 'Archiving…' : 'Archive location'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
