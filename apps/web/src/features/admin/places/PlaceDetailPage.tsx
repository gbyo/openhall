import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { api, confirmed, requireData } from '../../../api/client';
import { productMessage } from '../../../api/problems';
import { queryKeys } from '../../../api/query-keys';
import { getCsrfToken } from '../../../api/session';
import type { Place } from '../../../api/types';
import { useSchool } from '../../../app/school/SchoolShell';
import { PageHeader } from '../../../components/workspace/PageHeader';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
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
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';

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

function destinationStatusLabel(status: string): string {
  switch (status) {
    case 'active':
      return 'Open';
    case 'closed':
      return 'Closed';
    default:
      return 'Archived';
  }
}

interface CategoryOption {
  value: string;
  label: string;
}

export function PlaceDetailPage() {
  const { organizationId } = useSchool();
  const { locationId } = useParams();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editName, setEditName] = useState('');
  const [editKind, setEditKind] = useState('');
  const [editCode, setEditCode] = useState('');
  const [editFloor, setEditFloor] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [studentAccess, setStudentAccess] = useState(true);
  const [checkInMode, setCheckInMode] = useState('none');
  const place = useQuery({
    queryKey: queryKeys.place(locationId ?? ''),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/places/{locationId}', {
          params: { path: { locationId: locationId ?? '' } },
        }),
      ),
    enabled: (locationId ?? '').length > 0,
  });
  const categories = useQuery({
    queryKey: queryKeys.destinationCategories(organizationId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/destination-categories', {
          params: { path: { organizationId } },
        }),
      ),
  });
  const detail: Place | undefined = place.data?.place;
  const activeCategories = useMemo(
    () => (categories.data?.categories ?? []).filter((item) => item.status === 'active'),
    [categories.data],
  );
  const categoryOptions = useMemo<CategoryOption[]>(
    () => activeCategories.map((item) => ({ value: item.id, label: item.name })),
    [activeCategories],
  );
  const selectedCategory = categoryOptions.find((option) => option.value === categoryId) ?? null;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.place(locationId ?? '') });
    void queryClient.invalidateQueries({ queryKey: queryKeys.places(organizationId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.destinations(organizationId) });
  };
  const save = useMutation({
    mutationFn: async (body: {
      name: string;
      kind: string;
      code: string | null;
      floor: string | null;
    }) => {
      if (!locationId) throw new Error('Place unavailable');
      const current = await api.GET('/api/v1/locations/{locationId}', {
        params: { path: { locationId } },
      });
      requireData(current);
      const etag = current.response.headers.get('etag') ?? '';
      const key = crypto.randomUUID();
      return confirmed(
        api.PUT('/api/v1/locations/{locationId}', {
          params: {
            path: { locationId },
            header: { 'idempotency-key': key, 'if-match': etag },
          },
          headers: {
            'X-CSRF-Token': getCsrfToken(),
            'Idempotency-Key': key,
            'If-Match': etag,
          },
          body: {
            name: body.name,
            kind: body.kind,
            parentLocationId: detail?.parentLocationId ?? null,
            code: body.code,
            floorLabel: body.floor,
          },
        }),
      );
    },
    onSuccess: () => {
      setEditing(false);
      save.reset();
      refresh();
    },
  });
  const add = useMutation({
    mutationFn: (body: {
      categoryId: string;
      studentSelfRequestable: boolean;
      displayName: string | null;
      checkInMode: 'none' | 'optional' | 'required';
    }) => {
      const key = crypto.randomUUID();
      return confirmed(
        api.POST('/api/v1/organizations/{organizationId}/destinations', {
          params: { path: { organizationId }, header: { 'idempotency-key': key } },
          headers: { 'X-CSRF-Token': getCsrfToken(), 'Idempotency-Key': key },
          body: {
            ...body,
            locationId: locationId ?? '',
            serviceType: (detail?.classUsage.sectionCount ?? 0) > 0 ? 'room_visit' : 'general',
            capacity: null,
            queueEnabled: false,
            defaultDurationSeconds: 600,
            maxDurationSeconds: 1200,
            readyClaimTimeoutSeconds: 120,
            queueTimeoutSeconds: 1800,
          },
        }),
      );
    },
    onSuccess: () => {
      setAdding(false);
      setDisplayName('');
      setCategoryId(null);
      setStudentAccess(true);
      setCheckInMode('none');
      add.reset();
      refresh();
    },
  });
  const error = save.error ?? add.error;
  const name = detail?.name ?? 'Place';

  return (
    <section aria-labelledby="place-title" className="flex max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink render={<Link to=".." />}>Places</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{name}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <PageHeader
          title={name}
          description="A place is a physical location. Pass destinations live at places; classes meet at places."
          actions={
            detail && (
              <Button
                variant="outline"
                onClick={() => {
                  setEditName(detail.name);
                  setEditKind(detail.kind);
                  setEditCode(detail.code ?? '');
                  setEditFloor(detail.floorLabel ?? '');
                  save.reset();
                  setEditing(true);
                }}
              >
                Edit place
              </Button>
            )
          }
        />
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Place change not confirmed</AlertTitle>
          <AlertDescription>{productMessage(error)}</AlertDescription>
        </Alert>
      )}
      {place.isPending ? (
        <div role="status" aria-label="Loading place" className="flex flex-col gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-24 w-full" />
          <span className="sr-only">Loading place…</span>
        </div>
      ) : !detail ? (
        <Alert variant="destructive">
          <AlertTitle>Place not found</AlertTitle>
          <AlertDescription>This place does not exist in this school.</AlertDescription>
        </Alert>
      ) : (
        <>
          <FieldSet>
            <FieldLegend>Place details</FieldLegend>
            <FieldGroup>
              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel>Type</FieldLabel>
                  <p className="text-sm">{detail.kind}</p>
                </Field>
                <Field>
                  <FieldLabel>Status</FieldLabel>
                  <p className="text-sm">
                    <Badge variant="secondary">{statusLabel(detail.status)}</Badge>
                  </p>
                </Field>
                <Field>
                  <FieldLabel>Room code</FieldLabel>
                  <p className="text-sm">{detail.code ?? '—'}</p>
                </Field>
                <Field>
                  <FieldLabel>Floor</FieldLabel>
                  <p className="text-sm">{detail.floorLabel ?? '—'}</p>
                </Field>
                {detail.parentName && (
                  <Field>
                    <FieldLabel>Inside</FieldLabel>
                    <p className="text-sm">{detail.parentName}</p>
                  </Field>
                )}
              </div>
            </FieldGroup>
          </FieldSet>
          <FieldSet>
            <FieldLegend>Classes using this place</FieldLegend>
            <FieldDescription>
              Derived from current class schedules. Teacher names come from those records, not from
              the place itself.
            </FieldDescription>
            {detail.classUsage.classes.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No classes currently meet here. Any current teacher association would appear
                automatically from the schedule.
              </p>
            ) : (
              <ItemGroup aria-label="Classes using this place">
                {detail.classUsage.classes.map((entry) => (
                  <Item key={`${entry.title}-${entry.code ?? ''}`}>
                    <ItemContent>
                      <ItemTitle>
                        {entry.title}
                        {entry.code ? ` · ${entry.code}` : ''}
                      </ItemTitle>
                      <ItemDescription>
                        {entry.teacherNames.length > 0
                          ? entry.teacherNames.join(', ')
                          : 'No assigned teacher'}
                      </ItemDescription>
                    </ItemContent>
                  </Item>
                ))}
              </ItemGroup>
            )}
          </FieldSet>
          <FieldSet>
            <FieldLegend>Pass destinations at this place</FieldLegend>
            <FieldDescription>
              Students can request these destinations. New destinations start closed and open only
              after review.
            </FieldDescription>
            {detail.destinationSummary.destinations.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No pass destinations yet. Add one to let students request this place.
              </p>
            ) : (
              <ItemGroup aria-label="Pass destinations at this place">
                {detail.destinationSummary.destinations.map((entry) => (
                  <Item key={entry.id}>
                    <ItemContent>
                      <ItemTitle>{entry.displayName}</ItemTitle>
                      <ItemDescription>
                        {destinationStatusLabel(entry.status)}
                        {entry.studentSelfRequestable ? ' · Students can request' : ''}
                      </ItemDescription>
                    </ItemContent>
                  </Item>
                ))}
              </ItemGroup>
            )}
            <div>
              <Button
                variant="outline"
                onClick={() => {
                  setDisplayName(detail.name);
                  setCategoryId(null);
                  setStudentAccess(true);
                  setCheckInMode('none');
                  add.reset();
                  setAdding(true);
                }}
              >
                Add pass destination
              </Button>
            </div>
          </FieldSet>
        </>
      )}
      <Dialog
        open={editing}
        onOpenChange={(open) => {
          if (!open && !save.isPending) {
            setEditing(false);
            save.reset();
          }
        }}
      >
        <DialogContent aria-label="Edit place">
          <DialogHeader>
            <DialogTitle>Edit place</DialogTitle>
            <DialogDescription>
              Place metadata. The schedule still owns class usage.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Field>
              <FieldLabel htmlFor="edit-place-name">Name</FieldLabel>
              <Input
                id="edit-place-name"
                value={editName}
                onChange={(event) => {
                  setEditName(event.target.value);
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="edit-place-kind">Type</FieldLabel>
              <Input
                id="edit-place-kind"
                value={editKind}
                onChange={(event) => {
                  setEditKind(event.target.value);
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="edit-place-code">Room code (optional)</FieldLabel>
              <Input
                id="edit-place-code"
                value={editCode}
                onChange={(event) => {
                  setEditCode(event.target.value);
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="edit-place-floor">Floor (optional)</FieldLabel>
              <Input
                id="edit-place-floor"
                value={editFloor}
                onChange={(event) => {
                  setEditFloor(event.target.value);
                }}
              />
            </Field>
            {save.error && <FieldError>{productMessage(save.error)}</FieldError>}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setEditing(false);
                save.reset();
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={editName.trim() === '' || editKind.trim() === '' || save.isPending}
              onClick={() => {
                save.mutate({
                  name: editName.trim(),
                  kind: editKind.trim(),
                  code: editCode.trim() === '' ? null : editCode.trim(),
                  floor: editFloor.trim() === '' ? null : editFloor.trim(),
                });
              }}
            >
              {save.isPending ? 'Saving…' : 'Save place'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={adding}
        onOpenChange={(open) => {
          if (!open && !add.isPending) {
            setAdding(false);
            add.reset();
          }
        }}
      >
        <DialogContent aria-label="Add pass destination">
          <DialogHeader>
            <DialogTitle>Add pass destination</DialogTitle>
            <DialogDescription>
              The destination lives at {name}. It starts closed and opens only after review.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Field>
              <FieldLabel htmlFor="destination-name">Name</FieldLabel>
              <Input
                id="destination-name"
                value={displayName}
                onChange={(event) => {
                  setDisplayName(event.target.value);
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="destination-category">Pass category</FieldLabel>
              <Combobox
                items={categoryOptions}
                value={selectedCategory}
                onValueChange={(option: CategoryOption | null) => {
                  setCategoryId(option?.value ?? null);
                }}
                filter={(item: CategoryOption, query: string) =>
                  item.label.toLowerCase().includes(query.trim().toLowerCase())
                }
              >
                <ComboboxInput id="destination-category" placeholder="Choose a category" />
                <ComboboxContent>
                  <ComboboxList>
                    {(item: CategoryOption) => (
                      <ComboboxItem key={item.value} value={item}>
                        {item.label}
                      </ComboboxItem>
                    )}
                  </ComboboxList>
                  <ComboboxEmpty>No matching category.</ComboboxEmpty>
                </ComboboxContent>
              </Combobox>
            </Field>
            <Field>
              <div className="flex items-center gap-2">
                <Switch
                  id="destination-requestable"
                  checked={studentAccess}
                  onCheckedChange={setStudentAccess}
                />
                <FieldLabel htmlFor="destination-requestable">Students can request</FieldLabel>
              </div>
            </Field>
            <Field>
              <FieldLabel htmlFor="destination-checkin">Check-in</FieldLabel>
              <Select value={checkInMode} onValueChange={setCheckInMode}>
                <SelectTrigger id="destination-checkin">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="optional">Optional</SelectItem>
                  <SelectItem value="required">Station required</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {add.error && <FieldError>{productMessage(add.error)}</FieldError>}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setAdding(false);
                add.reset();
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={
                displayName.trim() === '' ||
                categoryId === null ||
                categories.isPending ||
                add.isPending
              }
              onClick={() => {
                if (!categoryId) return;
                if (
                  checkInMode !== 'none' &&
                  checkInMode !== 'optional' &&
                  checkInMode !== 'required'
                )
                  return;
                add.mutate({
                  categoryId,
                  studentSelfRequestable: studentAccess,
                  displayName: displayName.trim(),
                  checkInMode,
                });
              }}
            >
              {add.isPending ? 'Saving…' : 'Add destination'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
