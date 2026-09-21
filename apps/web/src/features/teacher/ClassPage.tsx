import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { HugeiconsIcon } from '@hugeicons/react';
import { Search01Icon } from '@hugeicons/core-free-icons';
import { api, confirmed } from '../../api/client';
import { productMessage, UncertainCommandError } from '../../api/problems';
import { queryKeys } from '../../api/query-keys';
import { getCsrfToken } from '../../api/session';
import { useSchool } from '../../app/school/SchoolShell';
import { PageHeader } from '../../components/workspace/PageHeader';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
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
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

type Lifecycle = 'requested' | 'queued' | 'ready' | 'outbound' | 'at_destination' | 'returning';

function passStateLabel(state: Lifecycle): 'Ready' | 'Waiting' | 'Out' {
  if (state === 'ready') return 'Ready';
  if (state === 'requested' || state === 'queued') return 'Waiting';
  return 'Out';
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.slice(0, 1) ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.slice(0, 1) ?? '') : '';
  return (first + last).toUpperCase();
}

interface DestinationOption {
  value: string;
  label: string;
}

export function ClassPage() {
  const { organizationId, context } = useSchool();
  const sectionId = useParams().sectionId ?? context.teachingSections[0]?.id ?? '';
  const queryClient = useQueryClient();
  const section = context.teachingSections.find((entry) => entry.id === sectionId);
  const [search, setSearch] = useState('');
  const [createFor, setCreateFor] = useState<{ id: string; displayName: string } | null>(null);
  const [destinationId, setDestinationId] = useState<string | null>(null);
  const roster = useQuery({
    queryKey: queryKeys.sectionStudents(sectionId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/sections/{sectionId}/students', { params: { path: { sectionId } } }),
      ),
  });
  const live = useQuery({
    queryKey: queryKeys.sectionLive(sectionId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/sections/{sectionId}/passes/live', { params: { path: { sectionId } } }),
      ),
    staleTime: 5_000,
  });
  const destinations = useQuery({
    queryKey: queryKeys.destinations(organizationId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/me/organizations/{organizationId}/destinations', {
          params: { path: { organizationId } },
        }),
      ),
  });
  const create = useMutation({
    mutationFn: ({
      studentId,
      destination,
      key,
    }: {
      studentId: string;
      destination: string;
      key: string;
    }) => {
      return confirmed(
        api.POST('/api/v1/students/{studentId}/passes', {
          params: {
            path: { studentId },
            header: { 'idempotency-key': key },
          },
          headers: { 'X-CSRF-Token': getCsrfToken(), 'Idempotency-Key': key },
          body: { destinationId: destination },
        }),
      );
    },
    onSuccess: () => {
      setCreateFor(null);
      setDestinationId(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.sectionLive(sectionId) });
    },
  });
  const depart = useMutation({
    mutationFn: ({ passId, passEtag, key }: { passId: string; passEtag: string; key: string }) => {
      return confirmed(
        api.POST('/api/v1/passes/{passId}/depart', {
          params: {
            path: { passId },
            header: { 'idempotency-key': key, 'if-match': passEtag },
          },
          headers: {
            'X-CSRF-Token': getCsrfToken(),
            'Idempotency-Key': key,
            'If-Match': passEtag,
          },
        }),
      );
    },
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: queryKeys.sectionLive(sectionId) }),
  });
  const current = useMemo(
    () => new Map(live.data?.passes.map((pass) => [pass.student.id, pass]) ?? []),
    [live.data],
  );
  const students = useMemo(() => {
    const query = search.trim().toLowerCase();
    const all = roster.data?.students ?? [];
    if (query.length === 0) return all;
    return all.filter((student) => student.displayName.toLowerCase().includes(query));
  }, [roster.data, search]);
  const destinationOptions = useMemo<DestinationOption[]>(
    () =>
      destinations.data?.destinations.map((destination) => ({
        value: destination.id,
        label: destination.displayName,
      })) ?? [],
    [destinations.data],
  );
  const selectedDestination =
    destinationOptions.find((option) => option.value === destinationId) ?? null;
  const outNow = live.data?.passes ?? [];
  const departActive = depart.isPending ? depart.variables : null;

  function closeCreate() {
    if (create.isPending) return;
    setCreateFor(null);
    setDestinationId(null);
    create.reset();
  }

  return (
    <section aria-labelledby="class-title" className="flex flex-col gap-4">
      <PageHeader title={section?.title ?? 'Class'} description={section?.code ?? undefined} />
      {depart.isError && (
        <Alert variant="destructive">
          <AlertTitle>Pass action not confirmed</AlertTitle>
          <AlertDescription>{productMessage(depart.error)}</AlertDescription>
          {depart.error instanceof UncertainCommandError && (
            <AlertAction>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  depart.mutate(depart.variables);
                }}
              >
                Check again
              </Button>
            </AlertAction>
          )}
        </Alert>
      )}
      <Tabs defaultValue="roster">
        <TabsList aria-label="Class views">
          <TabsTrigger value="roster">Roster</TabsTrigger>
          <TabsTrigger value="out">
            Out now{outNow.length > 0 ? ` (${String(outNow.length)})` : ''}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="roster" className="flex flex-col gap-4">
          <InputGroup>
            <InputGroupAddon>
              <InputGroupText>
                <HugeiconsIcon icon={Search01Icon} strokeWidth={2} aria-hidden="true" />
              </InputGroupText>
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Search roster"
              placeholder="Search students"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
            />
          </InputGroup>
          {roster.isPending ? (
            <div role="status" aria-label="Loading roster" className="flex flex-col gap-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <span className="sr-only">Loading roster…</span>
            </div>
          ) : students.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>
                  {search.trim().length > 0 ? 'No students match this search.' : 'No students yet.'}
                </EmptyTitle>
                <EmptyDescription>
                  {search.trim().length > 0
                    ? 'Try a different name.'
                    : 'Students will appear here once enrollment is complete.'}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ItemGroup aria-label="Class roster">
              {students.map((student) => {
                const pass = current.get(student.id);
                const starting = departActive?.passId === pass?.passId;
                return (
                  <Item role="listitem" key={student.id}>
                    <Avatar className="size-9">
                      <AvatarFallback>{initials(student.displayName)}</AvatarFallback>
                    </Avatar>
                    <ItemContent>
                      <ItemTitle>{student.displayName}</ItemTitle>
                      {pass ? (
                        <ItemDescription>
                          {passStateLabel(pass.lifecycleState)} · {pass.destination.displayName}
                        </ItemDescription>
                      ) : null}
                    </ItemContent>
                    <ItemActions>
                      {pass ? (
                        <>
                          <Badge variant="secondary">{passStateLabel(pass.lifecycleState)}</Badge>
                          {pass.lifecycleState === 'ready' ? (
                            <Button
                              size="sm"
                              disabled={starting}
                              aria-busy={starting}
                              onClick={() => {
                                depart.mutate({
                                  passId: pass.passId,
                                  passEtag: pass.passEtag,
                                  key: crypto.randomUUID(),
                                });
                              }}
                            >
                              {starting ? <Spinner data-icon="inline-start" /> : null}
                              {starting ? 'Starting…' : 'Start pass'}
                            </Button>
                          ) : null}
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            create.reset();
                            setDestinationId(null);
                            setCreateFor({ id: student.id, displayName: student.displayName });
                          }}
                        >
                          Create pass
                        </Button>
                      )}
                    </ItemActions>
                  </Item>
                );
              })}
            </ItemGroup>
          )}
        </TabsContent>
        <TabsContent value="out" className="flex flex-col gap-4">
          {live.isPending ? (
            <div role="status" aria-label="Loading students out" className="flex flex-col gap-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <span className="sr-only">Loading students out…</span>
            </div>
          ) : outNow.length === 0 ? (
            <p className="text-sm text-muted-foreground">No one is out right now.</p>
          ) : (
            <ItemGroup aria-label="Students out">
              {outNow.map((pass) => (
                <Item role="listitem" key={pass.passId}>
                  <Avatar className="size-9">
                    <AvatarFallback>{initials(pass.student.displayName)}</AvatarFallback>
                  </Avatar>
                  <ItemContent>
                    <ItemTitle>{pass.student.displayName}</ItemTitle>
                    <ItemDescription>{pass.destination.displayName}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Badge variant="secondary">{pass.lifecycleState.replace('_', ' ')}</Badge>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          )}
        </TabsContent>
      </Tabs>
      <Dialog
        open={createFor !== null}
        onOpenChange={(open) => {
          if (!open) closeCreate();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {createFor ? `Create pass for ${createFor.displayName}` : 'Create pass'}
            </DialogTitle>
            <DialogDescription>
              {section?.title} · the student is already selected, choose a destination.
            </DialogDescription>
          </DialogHeader>
          {destinations.isPending ? (
            <div role="status" aria-label="Loading destinations" className="flex flex-col gap-2">
              <Skeleton className="h-9 w-full" />
              <span className="sr-only">Loading destinations…</span>
            </div>
          ) : (
            <Field>
              <FieldLabel htmlFor="create-pass-destination">Destination</FieldLabel>
              <Combobox
                items={destinationOptions}
                value={selectedDestination}
                onValueChange={(option: DestinationOption | null) => {
                  setDestinationId(option?.value ?? null);
                }}
                filter={(item: DestinationOption, query: string) =>
                  item.label.toLowerCase().includes(query.toLowerCase())
                }
              >
                <ComboboxInput id="create-pass-destination" placeholder="Search destinations" />
                <ComboboxContent>
                  <ComboboxList>
                    {(item: DestinationOption) => (
                      <ComboboxItem key={item.value} value={item}>
                        {item.label}
                      </ComboboxItem>
                    )}
                  </ComboboxList>
                  <ComboboxEmpty>No matching destination.</ComboboxEmpty>
                </ComboboxContent>
              </Combobox>
              {destinations.isError ? (
                <FieldError>Destinations could not be loaded. Try again.</FieldError>
              ) : null}
            </Field>
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
              disabled={create.isPending || destinationId === null || createFor === null}
              aria-busy={create.isPending}
              onClick={() => {
                if (createFor && destinationId) {
                  create.mutate({
                    studentId: createFor.id,
                    destination: destinationId,
                    key: crypto.randomUUID(),
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
