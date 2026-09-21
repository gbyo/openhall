import { useEffect, useState, type SubmitEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { api, confirmed, requireData } from '../../../api/client';
import { ApiProblem, productMessage } from '../../../api/problems';
import { queryKeys } from '../../../api/query-keys';
import { getCsrfToken } from '../../../api/session';
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
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';

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

interface LocationOption {
  value: string;
  label: string;
}

type CommandKind = 'save' | 'open' | 'close' | 'archive';

export function DestinationDetailPage() {
  const { organizationId } = useSchool();
  const destinationId = useParams().destinationId ?? '';
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: queryKeys.destination(destinationId),
    queryFn: async () => {
      const result = await api.GET('/api/v1/destinations/{destinationId}', {
        params: { path: { destinationId } },
      });
      return {
        destination: requireData(result).destination,
        etag: result.response.headers.get('etag') ?? '',
      };
    },
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
  const [draft, setDraft] = useState<NonNullable<typeof detail.data>['destination'] | null>(null);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  useEffect(() => {
    if (detail.data && draft === null) setDraft(detail.data.destination);
  }, [detail.data, draft]);
  const dirty = Boolean(
    detail.data && draft && JSON.stringify(detail.data.destination) !== JSON.stringify(draft),
  );
  useUnsavedChanges(dirty);
  const mutation = useMutation({
    mutationFn: async ({ kind }: { kind: CommandKind }) => {
      if (!detail.data || !draft) throw new Error('Destination unavailable');
      const key = crypto.randomUUID();
      const headers = {
        'X-CSRF-Token': getCsrfToken(),
        'Idempotency-Key': key,
        'If-Match': detail.data.etag,
      };
      const params = {
        path: { destinationId },
        header: { 'idempotency-key': key, 'if-match': detail.data.etag },
      };
      if (kind === 'save')
        return confirmed(
          api.PUT('/api/v1/destinations/{destinationId}', {
            params,
            headers,
            body: {
              locationId: draft.locationId,
              serviceType: draft.serviceType,
              displayName: draft.displayName,
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
        return confirmed(
          api.POST('/api/v1/destinations/{destinationId}/open', { params, headers }),
        );
      if (kind === 'close')
        return confirmed(
          api.POST('/api/v1/destinations/{destinationId}/close', { params, headers }),
        );
      return confirmed(
        api.POST('/api/v1/destinations/{destinationId}/archive', { params, headers }),
      );
    },
    onSuccess: (_data, variables) => {
      if (variables.kind === 'archive') setConfirmingArchive(false);
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.destination(destinationId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.destinations(organizationId) });
    },
  });
  const activeKind = mutation.isPending ? mutation.variables.kind : null;
  const locationOptions: LocationOption[] = (locations.data?.locations ?? []).map((item) => ({
    value: item.id,
    label: item.name,
  }));
  if (!draft)
    return (
      <section aria-label="Destination" className="flex max-w-2xl flex-col gap-4">
        <div role="status" aria-label="Loading destination" className="flex flex-col gap-2">
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <span className="sr-only">Loading destination…</span>
        </div>
      </section>
    );
  const selectedLocation =
    locationOptions.find((option) => option.value === draft.locationId) ?? null;
  const conflict = mutation.error instanceof ApiProblem && mutation.error.status === 412;
  const name = draft.displayName ?? draft.serviceType;
  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    mutation.mutate({ kind: 'save' });
  }
  return (
    <section aria-labelledby="destination-title" className="flex max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink render={<Link to=".." />}>Destinations</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{name}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <PageHeader
          title={name}
          actions={<Badge variant="secondary">{statusLabel(draft.status)}</Badge>}
        />
      </div>
      {conflict && (
        <Alert>
          <AlertTitle>This destination changed while you were editing.</AlertTitle>
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
      <form onSubmit={submit} className="flex flex-col gap-6">
        <FieldSet>
          <FieldLegend>General</FieldLegend>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="destination-display-name">Display name</FieldLabel>
              <Input
                id="destination-display-name"
                value={draft.displayName ?? ''}
                onChange={(event) => {
                  setDraft({ ...draft, displayName: event.target.value || null });
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="destination-location">Location</FieldLabel>
              <Combobox
                items={locationOptions}
                value={selectedLocation}
                onValueChange={(option: LocationOption | null) => {
                  if (option) setDraft({ ...draft, locationId: option.value });
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
            </Field>
            <Field>
              <FieldLabel htmlFor="destination-type">Type</FieldLabel>
              <Input
                id="destination-type"
                value={draft.serviceType}
                onChange={(event) => {
                  setDraft({ ...draft, serviceType: event.target.value });
                }}
              />
            </Field>
          </FieldGroup>
        </FieldSet>
        <FieldSet>
          <FieldLegend>Movement</FieldLegend>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="destination-capacity">Capacity</FieldLabel>
              <FieldDescription>Empty means no limit.</FieldDescription>
              <Input
                id="destination-capacity"
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
                <Label htmlFor="destination-queue">Queue when full</Label>
                <FieldDescription>
                  Students wait in line instead of being turned away.
                </FieldDescription>
              </div>
              <Switch
                id="destination-queue"
                checked={draft.queueEnabled}
                onCheckedChange={(checked) => {
                  setDraft({ ...draft, queueEnabled: checked });
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="destination-check-in">Check-in</FieldLabel>
              <Select
                value={draft.checkInMode}
                onValueChange={(value) => {
                  if (value === 'none' || value === 'optional' || value === 'required')
                    setDraft({ ...draft, checkInMode: value });
                }}
              >
                <SelectTrigger id="destination-check-in">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No check-in</SelectItem>
                  <SelectItem value="optional">Optional check-in</SelectItem>
                  <SelectItem value="required">Station check-in required</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
        </FieldSet>
        <FieldSet>
          <FieldLegend>Timing</FieldLegend>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="destination-expected">Expected minutes</FieldLabel>
              <Input
                id="destination-expected"
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
              <FieldLabel htmlFor="destination-maximum">Maximum minutes</FieldLabel>
              <Input
                id="destination-maximum"
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
            {draft.queueEnabled && (
              <>
                <Field>
                  <FieldLabel htmlFor="destination-ready-window">Ready window (minutes)</FieldLabel>
                  <Input
                    id="destination-ready-window"
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
                  <FieldLabel htmlFor="destination-queue-wait">
                    Maximum queue wait (minutes)
                  </FieldLabel>
                  <Input
                    id="destination-queue-wait"
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
              </>
            )}
          </FieldGroup>
        </FieldSet>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={mutation.isPending} aria-busy={activeKind === 'save'}>
            {activeKind === 'save' ? <Spinner data-icon="inline-start" /> : null}
            {activeKind === 'save' ? 'Saving…' : 'Save changes'}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setDraft(detail.data?.destination ?? null);
            }}
          >
            Cancel
          </Button>
        </div>
      </form>
      <Separator />
      <section aria-labelledby="availability-title" className="flex flex-col gap-3">
        <h2 id="availability-title" className="font-heading text-sm font-medium">
          Availability
        </h2>
        <div className="flex flex-wrap gap-2">
          {draft.status === 'closed' && (
            <Button
              variant="secondary"
              disabled={mutation.isPending}
              aria-busy={activeKind === 'open'}
              onClick={() => {
                mutation.mutate({ kind: 'open' });
              }}
            >
              {activeKind === 'open' ? <Spinner data-icon="inline-start" /> : null}
              {activeKind === 'open' ? 'Opening…' : 'Open destination'}
            </Button>
          )}
          {draft.status === 'active' && (
            <Button
              variant="secondary"
              disabled={mutation.isPending}
              aria-busy={activeKind === 'close'}
              onClick={() => {
                mutation.mutate({ kind: 'close' });
              }}
            >
              {activeKind === 'close' ? <Spinner data-icon="inline-start" /> : null}
              {activeKind === 'close' ? 'Closing…' : 'Close destination'}
            </Button>
          )}
          {draft.status !== 'archived' && (
            <Button
              variant="destructive"
              disabled={mutation.isPending}
              onClick={() => {
                setConfirmingArchive(true);
              }}
            >
              Archive destination
            </Button>
          )}
        </div>
      </section>
      <AlertDialog
        open={confirmingArchive}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setConfirmingArchive(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Archived destinations stay in history but can no longer receive passes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep destination</AlertDialogCancel>
            <AlertDialogAction
              disabled={mutation.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (!mutation.isPending) mutation.mutate({ kind: 'archive' });
              }}
            >
              {activeKind === 'archive' ? <Spinner data-icon="inline-start" /> : null}
              {activeKind === 'archive' ? 'Archiving…' : 'Archive destination'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
