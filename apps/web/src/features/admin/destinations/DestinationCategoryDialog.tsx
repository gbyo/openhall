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
  CATEGORY_ICON_OPTIONS,
  CATEGORY_TONE_OPTIONS,
  iconForCategoryKey,
  surfaceLabel,
  tileTone,
} from '../../../lib/destination-category-presentation.js';
import { cn } from 'cn';
import type { DestinationCategory } from '../../../api/types.js';

export interface CategoryFormValue {
  name: string;
  iconKey: string;
  toneKey: string;
  studentSurface: 'primary' | 'secondary' | 'hidden';
  sortOrder: number;
}

export function categoryFormValue(category: DestinationCategory | null): CategoryFormValue {
  return {
    name: category?.name ?? '',
    iconKey: category?.iconKey ?? 'generic',
    toneKey: category?.toneKey ?? 'neutral',
    studentSurface:
      category?.studentSurface === 'primary' || category?.studentSurface === 'hidden'
        ? category.studentSurface
        : 'secondary',
    sortOrder: category?.sortOrder ?? 0,
  };
}

interface DestinationCategoryDialogProps {
  open: boolean;
  category: DestinationCategory | null;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (value: CategoryFormValue) => void;
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

export function DestinationCategoryDialog({
  open,
  category,
  pending,
  error,
  onClose,
  onSubmit,
}: DestinationCategoryDialogProps) {
  const [form, setForm] = useState<CategoryFormValue>(() => categoryFormValue(category));
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
            Categories group destinations on the student WayPass home. Renaming never changes
            destination internals.
          </DialogDescription>
        </DialogHeader>
        <FieldSet>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="category-name">Name</FieldLabel>
              <Input
                id="category-name"
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
                <FieldLabel htmlFor="category-icon">Icon</FieldLabel>
                <Select
                  value={form.iconKey}
                  onValueChange={(value: string | null) => {
                    if (value) setForm({ ...form, iconKey: value });
                  }}
                >
                  <SelectTrigger id="category-icon">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORY_ICON_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="category-tone">Color</FieldLabel>
                <Select
                  value={form.toneKey}
                  onValueChange={(value: string | null) => {
                    if (value) setForm({ ...form, toneKey: value });
                  }}
                >
                  <SelectTrigger id="category-tone">
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
              <FieldLabel id="category-surface-label">Student launcher</FieldLabel>
              <RadioGroup
                aria-labelledby="category-surface-label"
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
                      id={`category-surface-${surface.value}`}
                    />
                    <div className="flex flex-col gap-0.5">
                      <label
                        htmlFor={`category-surface-${surface.value}`}
                        className="text-sm font-medium"
                      >
                        {surface.value === 'secondary' ? surfaceLabel('secondary') : surface.label}
                      </label>
                      <FieldDescription>{surface.description}</FieldDescription>
                    </div>
                  </div>
                ))}
              </RadioGroup>
            </Field>
            <Field>
              <FieldLabel htmlFor="category-order">Display order</FieldLabel>
              <FieldDescription>
                Lower numbers appear first. Ties fall back to name order.
              </FieldDescription>
              <Input
                id="category-order"
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
