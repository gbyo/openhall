import { useEffect, useState, type SubmitEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HugeiconsIcon } from '@hugeicons/react';
import { MoreHorizontalIcon } from '@hugeicons/core-free-icons';
import { Link, useParams } from 'react-router';
import { api, confirmed, requireData } from '../../../api/client';
import { ApiProblem, productMessage } from '../../../api/problems';
import { queryKeys } from '../../../api/query-keys';
import { getCsrfToken } from '../../../api/session';
import type { Room } from '../../../api/types.js';
import { useSchool } from '../../../app/school/SchoolShell';
import { useUnsavedChanges } from '../../../app/useUnsavedChanges';
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
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
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RoomAssignedStaff } from './RoomAssignedStaff.js';

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

type CommandKind = 'save' | 'open' | 'close' | 'archive';

export function RoomDetailPage() {
  const { organizationId, context } = useSchool();
  const roomId = useParams().roomId ?? '';
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: queryKeys.room(roomId),
    queryFn: async () => {
      const result = await api.GET('/api/v1/rooms/{roomId}', {
        params: { path: { roomId } },
      });
      return {
        room: requireData(result).room,
        etag: result.response.headers.get('etag') ?? '',
      };
    },
  });
  const categories = useQuery({
    queryKey: queryKeys.roomCategories(organizationId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/room-categories', {
          params: { path: { organizationId } },
        }),
      ),
  });
  const canReadStudentCatalog = context.capabilities.includes('pass.request.self');
  const studentCatalog = useQuery({
    queryKey: queryKeys.studentRoomCatalog(organizationId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/me/organizations/{organizationId}/student-room-catalog', {
          params: { path: { organizationId } },
        }),
      ),
    enabled: canReadStudentCatalog,
  });
  const activeCategories = (categories.data?.categories ?? []).filter(
    (item) => item.status === 'active',
  );
  const categoryName =
    detail.data?.room.categoryId !== null && detail.data?.room.categoryId !== undefined
      ? ((categories.data?.categories ?? []).find(
          (item) => item.id === detail.data?.room.categoryId,
        )?.name ?? null)
      : null;
  const [draft, setDraft] = useState<Room | null>(null);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  useEffect(() => {
    if (detail.data && draft === null) setDraft(detail.data.room);
  }, [detail.data, draft]);
  const dirty = Boolean(
    detail.data && draft && JSON.stringify(detail.data.room) !== JSON.stringify(draft),
  );
  useUnsavedChanges(dirty);
  const mutation = useMutation({
    mutationFn: async ({ kind }: { kind: CommandKind }) => {
      if (!detail.data || !draft) throw new Error('Room unavailable');
      const key = crypto.randomUUID();
      const headers = {
        'X-CSRF-Token': getCsrfToken(),
        'Idempotency-Key': key,
        'If-Match': detail.data.etag,
      };
      const params = {
        path: { roomId },
        header: { 'idempotency-key': key, 'if-match': detail.data.etag },
      };
      if (kind === 'save')
        return confirmed(
          api.PUT('/api/v1/rooms/{roomId}', {
            params,
            headers,
            body: {
              categoryId: draft.categoryId,
              name: draft.name,
              code: draft.code,
              floorLabel: draft.floorLabel,
              studentSelfRequestable: draft.studentSelfRequestable,
              originSelectable: draft.originSelectable,
              capacity: draft.capacity,
              queueEnabled: draft.queueEnabled,
              checkInMode: draft.checkInMode,
              defaultDurationSeconds: draft.defaultDurationSeconds,
              maxDurationSeconds: draft.maxDurationSeconds,
              readyClaimTimeoutSeconds: draft.readyClaimTimeoutSeconds,
              queueTimeoutSeconds: draft.queueTimeoutSeconds,
            },
          }),
        );
      if (kind === 'open')
        return confirmed(api.POST('/api/v1/rooms/{roomId}/open', { params, headers }));
      if (kind === 'close')
        return confirmed(api.POST('/api/v1/rooms/{roomId}/close', { params, headers }));
      return confirmed(api.POST('/api/v1/rooms/{roomId}/archive', { params, headers }));
    },
    onSuccess: (_data, variables) => {
      if (variables.kind === 'archive') setConfirmingArchive(false);
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.room(roomId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.rooms(organizationId) });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.studentRoomCatalog(organizationId),
      });
    },
  });
  const activeKind = mutation.isPending ? mutation.variables.kind : null;
  if (!draft)
    return (
      <section aria-label="Room" className="flex max-w-2xl flex-col gap-4">
        <div role="status" aria-label="Loading room" className="flex flex-col gap-2">
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <span className="sr-only">Loading room…</span>
        </div>
      </section>
    );
  const conflict = mutation.error instanceof ApiProblem && mutation.error.status === 412;
  const codeFloor = [draft.code, draft.floorLabel]
    .filter((part) => part !== null && part.length > 0)
    .join(' · ');
  const subtitle = codeFloor.length > 0 ? codeFloor : (categoryName ?? 'Uncategorized');
  const saveError =
    draft.studentSelfRequestable && draft.categoryId === null
      ? 'Rooms students can request must belong to a category.'
      : null;
  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!saveError) mutation.mutate({ kind: 'save' });
  }
  const catalogRoom = (() => {
    for (const category of studentCatalog.data?.categories ?? []) {
      const found = category.rooms.find((room) => room.id === roomId);
      if (found) return found;
    }
    return null;
  })();
  return (
    <section aria-labelledby="room-title" className="flex max-w-2xl flex-col gap-6">
      <PageHeader
        title={draft.name}
        description={subtitle}
        actions={
          <span className="flex items-center gap-2">
            <Badge variant="secondary">{statusLabel(draft.status)}</Badge>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon-sm" />}
                aria-label={`Actions for ${draft.name}`}
              >
                <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {draft.status !== 'open' && draft.status !== 'archived' && (
                  <DropdownMenuItem
                    onClick={() => {
                      mutation.mutate({ kind: 'open' });
                    }}
                  >
                    Open room
                  </DropdownMenuItem>
                )}
                {draft.status === 'open' && (
                  <DropdownMenuItem
                    onClick={() => {
                      mutation.mutate({ kind: 'close' });
                    }}
                  >
                    Close room
                  </DropdownMenuItem>
                )}
                {draft.status !== 'archived' && (
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => {
                      setConfirmingArchive(true);
                    }}
                  >
                    Archive room
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        }
      />
      {conflict && (
        <Alert>
          <AlertTitle>This room changed while you were editing.</AlertTitle>
          <AlertDescription>
            Someone else saved a newer version. Your unsaved changes are still here.
          </AlertDescription>
          <AlertAction>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setDraft(null);
                void detail.refetch();
              }}
            >
              Review latest version
            </Button>
          </AlertAction>
        </Alert>
      )}
      {mutation.isError && !conflict && (
        <Alert variant="destructive">
          <AlertTitle>Changes not saved</AlertTitle>
          <AlertDescription>{productMessage(mutation.error)}</AlertDescription>
        </Alert>
      )}
      <Tabs defaultValue="basics">
        <TabsList variant="line" aria-label="Room sections">
          <TabsTrigger value="basics">Basics</TabsTrigger>
          <TabsTrigger value="pass-settings">Pass settings</TabsTrigger>
          <TabsTrigger value="staff">Staff &amp; classes</TabsTrigger>
        </TabsList>
        <TabsContent value="basics">
          <form onSubmit={submit} className="flex flex-col gap-6">
            <FieldSet>
              <FieldLegend>Basics</FieldLegend>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="room-name">Name</FieldLabel>
                  <Input
                    id="room-name"
                    value={draft.name}
                    onChange={(event) => {
                      setDraft({ ...draft, name: event.target.value });
                    }}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field>
                    <FieldLabel htmlFor="room-code">Room number/code</FieldLabel>
                    <Input
                      id="room-code"
                      value={draft.code ?? ''}
                      onChange={(event) => {
                        setDraft({ ...draft, code: event.target.value || null });
                      }}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="room-floor">Floor</FieldLabel>
                    <Input
                      id="room-floor"
                      value={draft.floorLabel ?? ''}
                      onChange={(event) => {
                        setDraft({ ...draft, floorLabel: event.target.value || null });
                      }}
                    />
                  </Field>
                </div>
                <Field>
                  <FieldLabel htmlFor="room-category">Category</FieldLabel>
                  <Select
                    value={draft.categoryId}
                    onValueChange={(value: string | null) => {
                      setDraft({ ...draft, categoryId: value });
                    }}
                  >
                    <SelectTrigger id="room-category">
                      <SelectValue placeholder="Uncategorized" />
                    </SelectTrigger>
                    <SelectContent>
                      {activeCategories.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {saveError && <p className="text-sm text-destructive">{saveError}</p>}
                </Field>
              </FieldGroup>
            </FieldSet>
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                disabled={mutation.isPending || saveError !== null}
                aria-busy={activeKind === 'save'}
              >
                {activeKind === 'save' ? <Spinner data-icon="inline-start" /> : null}
                {activeKind === 'save' ? 'Saving…' : 'Save changes'}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setDraft(detail.data?.room ?? null);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        </TabsContent>
        <TabsContent value="pass-settings">
          <form onSubmit={submit} className="flex flex-col gap-6">
            <FieldSet>
              <FieldLegend>Pass settings</FieldLegend>
              <FieldGroup>
                <Field orientation="horizontal">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="room-requestable">Students can create passes here</Label>
                    <FieldDescription>
                      When off, staff and scheduled passes can still use this room.
                    </FieldDescription>
                  </div>
                  <Switch
                    id="room-requestable"
                    checked={draft.studentSelfRequestable}
                    onCheckedChange={(checked) => {
                      setDraft({ ...draft, studentSelfRequestable: checked });
                    }}
                  />
                </Field>
                <Field orientation="horizontal">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="room-origin">Show as manually selectable origin</Label>
                    <FieldDescription>
                      Controls manual origin choice only — a scheduled class can still establish
                      this room as the origin.
                    </FieldDescription>
                  </div>
                  <Switch
                    id="room-origin"
                    checked={draft.originSelectable}
                    onCheckedChange={(checked) => {
                      setDraft({ ...draft, originSelectable: checked });
                    }}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="room-capacity">Capacity</FieldLabel>
                  <FieldDescription>Empty means no limit.</FieldDescription>
                  <Input
                    id="room-capacity"
                    type="number"
                    min="1"
                    value={draft.capacity ?? ''}
                    onChange={(event) => {
                      setDraft({
                        ...draft,
                        capacity: event.target.value ? Number(event.target.value) : null,
                      });
                    }}
                  />
                </Field>
                <Field orientation="horizontal">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="room-queue">Queue when full</Label>
                    <FieldDescription>
                      Students wait in line instead of being turned away.
                    </FieldDescription>
                  </div>
                  <Switch
                    id="room-queue"
                    checked={draft.queueEnabled}
                    onCheckedChange={(checked) => {
                      setDraft({ ...draft, queueEnabled: checked });
                    }}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="room-check-in">Check-in</FieldLabel>
                  <Select
                    value={draft.checkInMode}
                    onValueChange={(value) => {
                      if (value === 'none' || value === 'optional' || value === 'required')
                        setDraft({ ...draft, checkInMode: value });
                    }}
                  >
                    <SelectTrigger id="room-check-in">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No check-in</SelectItem>
                      <SelectItem value="optional">Optional check-in</SelectItem>
                      <SelectItem value="required">Station check-in required</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="room-expected">Expected visit minutes</FieldLabel>
                  <Input
                    id="room-expected"
                    type="number"
                    min="0"
                    value={(draft.defaultDurationSeconds ?? 0) / 60}
                    onChange={(event) => {
                      setDraft({
                        ...draft,
                        defaultDurationSeconds: Number(event.target.value) * 60 || null,
                      });
                    }}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="room-maximum">Maximum visit minutes</FieldLabel>
                  <Input
                    id="room-maximum"
                    type="number"
                    min="0"
                    value={(draft.maxDurationSeconds ?? 0) / 60}
                    onChange={(event) => {
                      setDraft({
                        ...draft,
                        maxDurationSeconds: Number(event.target.value) * 60 || null,
                      });
                    }}
                  />
                </Field>
                <Collapsible>
                  <CollapsibleTrigger className="text-sm font-medium underline-offset-4 hover:underline">
                    Advanced
                  </CollapsibleTrigger>
                  <CollapsibleContent className="flex flex-col gap-4 pt-3">
                    <Field>
                      <FieldLabel htmlFor="room-ready-window">
                        Ready claim timeout (minutes)
                      </FieldLabel>
                      <Input
                        id="room-ready-window"
                        type="number"
                        min="0"
                        value={draft.readyClaimTimeoutSeconds / 60}
                        onChange={(event) => {
                          setDraft({
                            ...draft,
                            readyClaimTimeoutSeconds: Number(event.target.value) * 60,
                          });
                        }}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="room-queue-wait">
                        Maximum queue wait (minutes)
                      </FieldLabel>
                      <Input
                        id="room-queue-wait"
                        type="number"
                        min="0"
                        value={draft.queueTimeoutSeconds / 60}
                        onChange={(event) => {
                          setDraft({
                            ...draft,
                            queueTimeoutSeconds: Number(event.target.value) * 60,
                          });
                        }}
                      />
                    </Field>
                  </CollapsibleContent>
                </Collapsible>
              </FieldGroup>
            </FieldSet>
            {saveError && <p className="text-sm text-destructive">{saveError}</p>}
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                disabled={mutation.isPending || saveError !== null}
                aria-busy={activeKind === 'save'}
              >
                {activeKind === 'save' ? <Spinner data-icon="inline-start" /> : null}
                {activeKind === 'save' ? 'Saving…' : 'Save changes'}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setDraft(detail.data?.room ?? null);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        </TabsContent>
        <TabsContent value="staff">
          <div className="flex flex-col gap-6">
            <FieldSet>
              <FieldLegend>Classes &amp; teachers</FieldLegend>
              <p className="text-sm text-muted-foreground">
                Derived from the schedule. Read-only here — change the schedule to change this list.
              </p>
              {!canReadStudentCatalog || studentCatalog.isPending ? (
                <div
                  role="status"
                  aria-label="Loading schedule classes"
                  className="flex flex-col gap-2"
                >
                  <Skeleton className="h-14 w-full" />
                  <span className="sr-only">Loading schedule classes…</span>
                </div>
              ) : (catalogRoom?.searchContext.teacherNames.length ?? 0) === 0 &&
                (catalogRoom?.searchContext.sectionLabels.length ?? 0) === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>No scheduled classes here</EmptyTitle>
                    <EmptyDescription>
                      {catalogRoom === null
                        ? 'Schedule-derived classes are visible once this room appears in the student catalog.'
                        : 'No classes are currently scheduled in this room.'}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <ItemGroup aria-label="Scheduled classes and teachers">
                  {(catalogRoom?.searchContext.sectionLabels ?? []).map((section) => (
                    <Item key={section} variant="outline">
                      <ItemContent>
                        <ItemTitle>{section}</ItemTitle>
                        {(catalogRoom?.searchContext.teacherNames ?? []).length > 0 && (
                          <ItemDescription>
                            {(catalogRoom?.searchContext.teacherNames ?? []).join(' · ')}
                          </ItemDescription>
                        )}
                      </ItemContent>
                    </Item>
                  ))}
                  {(catalogRoom?.searchContext.sectionLabels.length ?? 0) === 0 &&
                    (catalogRoom?.searchContext.teacherNames ?? []).map((teacher) => (
                      <Item key={teacher} variant="outline">
                        <ItemMedia variant="icon">
                          <span aria-hidden="true" className="size-4" />
                        </ItemMedia>
                        <ItemContent>
                          <ItemTitle>{teacher}</ItemTitle>
                        </ItemContent>
                      </Item>
                    ))}
                </ItemGroup>
              )}
            </FieldSet>
            <RoomAssignedStaff roomId={roomId} />
            <p className="text-sm text-muted-foreground">
              <Link to=".." className="underline underline-offset-4">
                Back to Rooms
              </Link>
            </p>
          </div>
        </TabsContent>
      </Tabs>
      <AlertDialog
        open={confirmingArchive}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setConfirmingArchive(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {draft.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Archived rooms stay in history but can no longer receive passes. The server refuses
              while live dependencies remain.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep room</AlertDialogCancel>
            <AlertDialogAction
              disabled={mutation.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (!mutation.isPending) mutation.mutate({ kind: 'archive' });
              }}
            >
              {activeKind === 'archive' ? <Spinner data-icon="inline-start" /> : null}
              {activeKind === 'archive' ? 'Archiving…' : 'Archive room'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
