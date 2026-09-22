import { useState } from 'react';
import { Button } from '@/components/ui/button';
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
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  CATEGORY_TONE_OPTIONS,
  iconForCategoryKey,
  tileTone,
} from '../../../lib/room-category-presentation.js';
import { cn } from 'cn';
import type { RoomCategory } from '../../../api/types.js';
import { RoomCategoryIconPicker } from './RoomCategoryIconPicker.js';

export interface RoomCategoryFormValue {
  name: string;
  iconKey: string;
  toneKey: string;
  studentSurface: 'primary' | 'secondary' | 'hidden';
  pickerMode: 'auto' | 'list' | 'search';
  sortOrder: number;
}

export function roomCategoryFormValue(category: RoomCategory | null): RoomCategoryFormValue {
  return {
    name: category?.name ?? '',
    iconKey: category?.iconKey ?? 'generic',
    toneKey: category?.toneKey ?? 'neutral',
    studentSurface:
      category?.studentSurface === 'primary' || category?.studentSurface === 'hidden'
        ? category.studentSurface
        : 'secondary',
    pickerMode:
      category?.pickerMode === 'list' || category?.pickerMode === 'search'
        ? category.pickerMode
        : 'auto',
    sortOrder: category?.sortOrder ?? 0,
  };
}

interface RoomCategoryDialogProps {
  open: boolean;
  category: RoomCategory | null;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (value: RoomCategoryFormValue) => void;
}

const SURFACES = [
  {
    value: 'primary',
    label: 'Primary',
    description: "Show directly on the student's WayPass home.",
  },
  { value: 'secondary', label: 'More', description: 'Available to students under More.' },
  {
    value: 'hidden',
    label: 'Hidden',
    description: 'Do not allow spontaneous student self-requests from the launcher.',
  },
] as const;

const PICKER_MODES = [
  {
    value: 'auto',
    label: 'Automatic',
    description: 'List for small categories, search once the room count grows.',
  },
  { value: 'list', label: 'List', description: 'Always show every room as a tappable list.' },
  { value: 'search', label: 'Search', description: 'Always search by teacher, room, or class.' },
] as const;

export function RoomCategoryDialog({
  open,
  category,
  pending,
  error,
  onClose,
  onSubmit,
}: RoomCategoryDialogProps) {
  const [form, setForm] = useState<RoomCategoryFormValue>(() => roomCategoryFormValue(category));
  const [touched, setTouched] = useState(false);
  const editing = category !== null;
  const nameError = touched && form.name.trim() === '' ? 'Name is required.' : null;
  const sortError =
    touched && (!Number.isInteger(form.sortOrder) || form.sortOrder < 0)
      ? 'Display order must be a non-negative whole number.'
      : null;
  const valid = nameError === null && sortError === null;
  const previewTone =
    form.toneKey === 'aqua' ||
    form.toneKey === 'rose' ||
    form.toneKey === 'violet' ||
    form.toneKey === 'amber' ||
    form.toneKey === 'blue' ||
    form.toneKey === 'green' ||
    form.toneKey === 'slate'
      ? form.toneKey
      : 'neutral';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) {
          setTouched(false);
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit category' : 'New category'}</DialogTitle>
          <DialogDescription>
            Categories group rooms on the student WayPass home. Renaming never changes room
            internals.
          </DialogDescription>
        </DialogHeader>
        <FieldSet>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="room-category-name">Name</FieldLabel>
              <Input
                id="room-category-name"
                value={form.name}
                placeholder="Counselor"
                onChange={(event) => {
                  setForm({ ...form, name: event.target.value });
                }}
              />
              {nameError && <FieldError>{nameError}</FieldError>}
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="room-category-icon">Icon</FieldLabel>
                <RoomCategoryIconPicker
                  id="room-category-icon"
                  value={form.iconKey}
                  onChange={(iconKey) => {
                    setForm({ ...form, iconKey });
                  }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="room-category-tone">Color</FieldLabel>
                <Select
                  value={form.toneKey}
                  onValueChange={(value: string | null) => {
                    if (value) setForm({ ...form, toneKey: value });
                  }}
                >
                  <SelectTrigger id="room-category-tone">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORY_TONE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <div className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className={cn(
                  tileTone({ tone: previewTone }),
                  'flex min-h-0 items-center gap-2 rounded-2xl px-3 py-2 text-sm',
                )}
              >
                <HugeiconsIcon
                  icon={iconForCategoryKey(form.iconKey)}
                  strokeWidth={2}
                  className="size-5"
                />
                {form.name.trim() === '' ? 'Preview' : form.name.trim()}
              </span>
              <span className="text-xs text-muted-foreground">
                Preview uses the same presentation as student tiles.
              </span>
            </div>
            <Field>
              <FieldLabel id="room-category-surface-label">Student launcher</FieldLabel>
              <RadioGroup
                aria-labelledby="room-category-surface-label"
                value={form.studentSurface}
                onValueChange={(value: string) => {
                  if (value === 'primary' || value === 'secondary' || value === 'hidden')
                    setForm({ ...form, studentSurface: value });
                }}
              >
                {SURFACES.map((surface) => (
                  <div key={surface.value} className="flex items-start gap-2">
                    <RadioGroupItem
                      value={surface.value}
                      id={`room-category-surface-${surface.value}`}
                    />
                    <div className="flex flex-col gap-0.5">
                      <label
                        htmlFor={`room-category-surface-${surface.value}`}
                        className="text-sm font-medium"
                      >
                        {surface.label}
                      </label>
                      <FieldDescription>{surface.description}</FieldDescription>
                    </div>
                  </div>
                ))}
              </RadioGroup>
            </Field>
            <Field>
              <FieldLabel id="room-category-picker-label">Picker behavior</FieldLabel>
              <RadioGroup
                aria-labelledby="room-category-picker-label"
                value={form.pickerMode}
                onValueChange={(value: string) => {
                  if (value === 'auto' || value === 'list' || value === 'search')
                    setForm({ ...form, pickerMode: value });
                }}
              >
                {PICKER_MODES.map((mode) => (
                  <div key={mode.value} className="flex items-start gap-2">
                    <RadioGroupItem value={mode.value} id={`room-category-picker-${mode.value}`} />
                    <div className="flex flex-col gap-0.5">
                      <label
                        htmlFor={`room-category-picker-${mode.value}`}
                        className="text-sm font-medium"
                      >
                        {mode.label}
                      </label>
                      <FieldDescription>{mode.description}</FieldDescription>
                    </div>
                  </div>
                ))}
              </RadioGroup>
            </Field>
            <Field>
              <FieldLabel htmlFor="room-category-order">Display order</FieldLabel>
              <FieldDescription>
                Lower numbers appear first. Ties fall back to name order.
              </FieldDescription>
              <Input
                id="room-category-order"
                type="number"
                min="0"
                value={form.sortOrder}
                onChange={(event) => {
                  setForm({ ...form, sortOrder: Number(event.currentTarget.value) });
                }}
              />
              {sortError && <FieldError>{sortError}</FieldError>}
            </Field>
          </FieldGroup>
        </FieldSet>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button
            disabled={pending || !valid}
            aria-busy={pending}
            onClick={() => {
              setTouched(true);
              if (valid) onSubmit({ ...form, name: form.name.trim() });
            }}
          >
            {pending ? <Spinner data-icon="inline-start" /> : null}
            {pending ? 'Saving…' : editing ? 'Save changes' : 'Create category'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
