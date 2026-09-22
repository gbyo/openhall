import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, confirmed, requireData } from '../../../api/client';
import { productMessage } from '../../../api/problems';
import { queryKeys } from '../../../api/query-keys';
import { getCsrfToken } from '../../../api/session';
import type { Place } from '../../../api/types';
import { useSchool } from '../../../app/school/SchoolShell';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';

interface ClassroomSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}

interface CategoryOption {
  value: string;
  label: string;
}

function coveredIn(place: Place, categoryId: string): boolean {
  return place.destinationSummary.destinations.some((entry) => entry.categoryId === categoryId);
}

/**
 * Classroom-visit setup. Candidates come from current class schedules
 * (section meetings at active places); one ordinary closed destination is
 * created per selected place in the chosen pass category. Already-covered
 * places are skipped, never duplicated. Teachers never gain destination
 * grants here — their association stays derived from scheduling.
 */
export function ClassroomSetupDialog({ open, onOpenChange, onDone }: ClassroomSetupDialogProps) {
  const { organizationId } = useSchool();
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [initializedFor, setInitializedFor] = useState<string | null>(null);
  const [studentAccess, setStudentAccess] = useState(true);
  const [checkInMode, setCheckInMode] = useState('none');
  const [duration, setDuration] = useState('600');
  const [capacity, setCapacity] = useState('');
  const places = useQuery({
    queryKey: queryKeys.places(organizationId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/places', {
          params: { path: { organizationId } },
        }),
      ),
    enabled: open,
  });
  const categories = useQuery({
    queryKey: queryKeys.destinationCategories(organizationId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/destination-categories', {
          params: { path: { organizationId } },
        }),
      ),
    enabled: open,
  });
  const activeCategories = useMemo(
    () => (categories.data?.categories ?? []).filter((item) => item.status === 'active'),
    [categories.data],
  );
  const categoryOptions = useMemo<CategoryOption[]>(
    () => activeCategories.map((item) => ({ value: item.id, label: item.name })),
    [activeCategories],
  );
  const effectiveCategoryId = categoryId ?? activeCategories[0]?.id ?? null;
  const chosenCategory = activeCategories.find((item) => item.id === effectiveCategoryId) ?? null;
  const candidates = useMemo(
    () =>
      (places.data?.places ?? []).filter(
        (place) => place.status === 'active' && place.classUsage.sectionCount > 0,
      ),
    [places.data],
  );
  if (open && effectiveCategoryId && initializedFor !== effectiveCategoryId) {
    setInitializedFor(effectiveCategoryId);
    setSelected(
      candidates.filter((place) => !coveredIn(place, effectiveCategoryId)).map((place) => place.id),
    );
  }
  const selectedCategory = categoryOptions.find((option) => option.value === categoryId) ?? null;
  const toggle = (id: string) => {
    setSelected((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  };
  const setup = useMutation({
    mutationFn: async () => {
      if (!effectiveCategoryId) throw new Error('Choose a pass category');
      if (checkInMode !== 'none' && checkInMode !== 'optional' && checkInMode !== 'required')
        throw new Error('Choose a check-in mode');
      const durationSeconds = duration.trim() === '' ? null : Number(duration);
      if (durationSeconds !== null && (!Number.isInteger(durationSeconds) || durationSeconds <= 0))
        throw new Error('Duration must be a positive number of seconds');
      const capacityValue = capacity.trim() === '' ? null : Number(capacity);
      if (capacityValue !== null && (!Number.isInteger(capacityValue) || capacityValue <= 0))
        throw new Error('Capacity must be a positive whole number');
      const key = crypto.randomUUID();
      const result = await confirmed(
        api.POST('/api/v1/organizations/{organizationId}/destinations/bulk-create-from-locations', {
          params: { path: { organizationId }, header: { 'idempotency-key': key } },
          headers: { 'X-CSRF-Token': getCsrfToken(), 'Idempotency-Key': key },
          body: {
            locationIds: [...selected],
            categoryId: effectiveCategoryId,
            studentSelfRequestable: studentAccess,
            checkInMode,
            capacity: capacityValue,
            defaultDurationSeconds: durationSeconds,
          },
        }),
      );
      // The setup flow keeps the chosen category on search: with dozens of
      // classroom destinations a list picker would be unusable.
      if (chosenCategory && chosenCategory.pickerMode !== 'search') {
        const detail = await api.GET('/api/v1/destination-categories/{categoryId}', {
          params: { path: { categoryId: effectiveCategoryId } },
        });
        requireData(detail);
        const etag = detail.response.headers.get('etag') ?? '';
        const updateKey = crypto.randomUUID();
        await confirmed(
          api.PUT('/api/v1/destination-categories/{categoryId}', {
            params: {
              path: { categoryId: effectiveCategoryId },
              header: { 'idempotency-key': updateKey, 'if-match': etag },
            },
            headers: {
              'X-CSRF-Token': getCsrfToken(),
              'Idempotency-Key': updateKey,
              'If-Match': etag,
            },
            body: {
              name: chosenCategory.name,
              iconKey: chosenCategory.iconKey,
              toneKey: chosenCategory.toneKey,
              studentSurface: chosenCategory.studentSurface,
              pickerMode: 'search',
              sortOrder: chosenCategory.sortOrder,
            },
          }),
        );
      }
      return result;
    },
    onSuccess: () => {
      onDone();
      onOpenChange(false);
      setup.reset();
    },
  });
  const coveredCount = candidates.filter(
    (place) => effectiveCategoryId && coveredIn(place, effectiveCategoryId),
  ).length;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !setup.isPending) {
          setInitializedFor(null);
          setup.reset();
        }
        onOpenChange(next);
      }}
    >
      <DialogContent aria-label="Set up classroom visits" className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Set up classroom visits</DialogTitle>
          <DialogDescription>
            Create one ordinary closed destination per classroom in a pass category. Places already
            covered in that category are skipped, never duplicated.
          </DialogDescription>
        </DialogHeader>
        {places.isPending || categories.isPending ? (
          <div role="status" aria-label="Loading candidates" className="flex flex-col gap-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-12 w-full" />
            <span className="sr-only">Loading candidates…</span>
          </div>
        ) : activeCategories.length === 0 ? (
          <Alert>
            <AlertTitle>No pass categories</AlertTitle>
            <AlertDescription>
              Create a pass category first, then set up classroom visits into it.
            </AlertDescription>
          </Alert>
        ) : (
          <div className="flex flex-col gap-4">
            <Field>
              <FieldLabel htmlFor="setup-category">Pass category</FieldLabel>
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
                <ComboboxInput
                  id="setup-category"
                  placeholder={activeCategories[0]?.name ?? 'Choose a category'}
                />
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
              <FieldDescription>
                Picker mode is set to Search for the chosen category so students can find teachers
                and rooms.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel id="setup-candidates-label">Classrooms ({candidates.length})</FieldLabel>
              <FieldDescription>
                Suggested from current class schedules. Uncheck places to leave unchanged.
                {coveredCount > 0 && effectiveCategoryId
                  ? ` ${String(coveredCount)} already covered in ${chosenCategory?.name ?? 'this category'}.`
                  : ''}
              </FieldDescription>
              <div
                role="group"
                aria-labelledby="setup-candidates-label"
                className="flex max-h-64 flex-col gap-1 overflow-y-auto"
              >
                {candidates.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No active classrooms found in current schedules.
                  </p>
                ) : (
                  candidates.map((place) => {
                    const covered = effectiveCategoryId
                      ? coveredIn(place, effectiveCategoryId)
                      : false;
                    return (
                      <label key={place.id} className="flex items-start gap-2 text-sm">
                        <Checkbox
                          checked={selected.includes(place.id)}
                          onCheckedChange={() => {
                            toggle(place.id);
                          }}
                          aria-label={`Include ${place.name}`}
                        />
                        <span className="flex flex-col">
                          <span className="font-medium">
                            {place.name}
                            {covered ? ' · already covered' : ''}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {place.classUsage.teacherNames.length > 0
                              ? place.classUsage.teacherNames.join(', ')
                              : 'No assigned teacher'}
                            {' · '}
                            {String(place.classUsage.sectionCount)}{' '}
                            {place.classUsage.sectionCount === 1 ? 'class' : 'classes'}
                          </span>
                        </span>
                      </label>
                    );
                  })
                )}
              </div>
            </Field>
            <Field>
              <div className="flex items-center gap-2">
                <Switch
                  id="setup-requestable"
                  checked={studentAccess}
                  onCheckedChange={setStudentAccess}
                />
                <FieldLabel htmlFor="setup-requestable">Students can request</FieldLabel>
              </div>
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field>
                <FieldLabel htmlFor="setup-checkin">Check-in</FieldLabel>
                <Select value={checkInMode} onValueChange={setCheckInMode}>
                  <SelectTrigger id="setup-checkin">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    <SelectItem value="optional">Optional</SelectItem>
                    <SelectItem value="required">Station required</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="setup-duration">Duration (sec)</FieldLabel>
                <Input
                  id="setup-duration"
                  inputMode="numeric"
                  value={duration}
                  onChange={(event) => {
                    setDuration(event.target.value);
                  }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="setup-capacity">Capacity</FieldLabel>
                <Input
                  id="setup-capacity"
                  inputMode="numeric"
                  placeholder="No limit"
                  value={capacity}
                  onChange={(event) => {
                    setCapacity(event.target.value);
                  }}
                />
              </Field>
            </div>
            {setup.error && <FieldError>{productMessage(setup.error)}</FieldError>}
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            disabled={
              selected.length === 0 ||
              !effectiveCategoryId ||
              setup.isPending ||
              places.isPending ||
              categories.isPending
            }
            onClick={() => {
              setup.mutate();
            }}
          >
            {setup.isPending
              ? 'Setting up…'
              : `Create ${String(selected.length)} destination${selected.length === 1 ? '' : 's'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
