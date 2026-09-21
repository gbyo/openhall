import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { QuestionnaireDescription, QuestionnaireTitle } from '@/components/ui/questionnaire';
import { useFocusField } from './SetupLayout';
import type { StepHandle } from './SetupLayout';
import { deriveSlugDefault, supportedTimeZones, timeZoneLabel, useSetup } from './setup-state';

export interface StepContentProps {
  handleRef: { current: StepHandle | null };
  onInvalidChange?: ((invalid: boolean) => void) | undefined;
}

interface TimeZoneOption {
  value: string;
  label: string;
}

/** School details. Time zone uses the shadcn Combobox over the IANA set with
 * friendly labels; the server remains authoritative. Advanced slugs stay
 * collapsed by default. */
export function SchoolFields({ handleRef, onInvalidChange }: StepContentProps) {
  const { state, dispatch } = useSetup();
  const [name, setName] = useState(state.school.name);
  const zones = useMemo(() => supportedTimeZones(), []);
  const options = useMemo<TimeZoneOption[]>(
    () => zones.map((zone) => ({ value: zone, label: timeZoneLabel(zone) })),
    [zones],
  );
  const [selected, setSelected] = useState<TimeZoneOption | null>(
    () => options.find((option) => option.value === state.school.timeZone) ?? null,
  );
  const [inputText, setInputText] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(state.school.advancedOpen);
  const [organizationName, setOrganizationName] = useState(state.school.organizationName);
  const [organizationSlug, setOrganizationSlug] = useState(state.school.organizationSlug);
  const [schoolSlug, setSchoolSlug] = useState(state.school.schoolSlug);
  const [attempted, setAttempted] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; timeZone?: string }>({});
  const firstError = errors.name ? 'setup-school-name' : errors.timeZone ? 'setup-time-zone' : null;
  useFocusField(attempted ? firstError : null);

  const invalid = attempted && Object.keys(errors).length > 0;
  useEffect(() => {
    onInvalidChange?.(invalid);
  }, [invalid, onInvalidChange]);

  function resolveTimeZone(): string | null {
    if (selected !== null) return selected.value;
    const typed = inputText.trim();
    if (typed.length === 0) return null;
    const exact = options.find((option) => option.value === typed || option.label === typed);
    if (exact) return exact.value;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: typed });
      return typed;
    } catch {
      return null;
    }
  }

  function validateAndCommit(): boolean {
    setAttempted(true);
    const next: typeof errors = {};
    if (name.trim().length === 0) next.name = 'Enter the school name.';
    const resolved = resolveTimeZone();
    if (resolved === null) {
      next.timeZone =
        inputText.trim().length === 0 && selected === null
          ? 'Choose the school time zone.'
          : 'Choose a valid time zone from the list.';
    }
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return false;
    }
    setErrors({});
    dispatch({
      type: 'setSchool',
      school: {
        name: name.trim(),
        timeZone: resolved ?? '',
        advancedOpen,
        organizationName: organizationName.trim(),
        organizationSlug: organizationSlug.trim(),
        schoolSlug: schoolSlug.trim(),
      },
    });
    return true;
  }

  useEffect(() => {
    handleRef.current = { validateAndCommit };
  });

  const derivedOrg = organizationName.trim().length > 0 ? organizationName.trim() : name.trim();
  const suggestedOrgSlug = deriveSlugDefault(organizationSlug.trim() || derivedOrg);
  const suggestedSchoolSlug = deriveSlugDefault(schoolSlug.trim() || name.trim());

  return (
    <>
      <QuestionnaireTitle>
        <h1 id="setup-school-title">Tell us about your school</h1>
      </QuestionnaireTitle>
      <QuestionnaireDescription>
        We’ll use this information to configure WayPass.
      </QuestionnaireDescription>
      <Field data-invalid={errors.name !== undefined}>
        <FieldLabel htmlFor="setup-school-name">School name</FieldLabel>
        <Input
          id="setup-school-name"
          autoComplete="off"
          required
          value={name}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            setName(event.target.value);
          }}
          aria-invalid={errors.name !== undefined}
          aria-describedby={errors.name ? 'setup-school-name-error' : undefined}
        />
        {errors.name ? <FieldError id="setup-school-name-error">{errors.name}</FieldError> : null}
      </Field>
      <Field data-invalid={errors.timeZone !== undefined}>
        <FieldLabel htmlFor="setup-time-zone">Time zone</FieldLabel>
        <Combobox
          items={options}
          value={selected}
          onValueChange={(option: TimeZoneOption | null) => {
            setSelected(option);
          }}
          onInputValueChange={(text: string) => {
            setInputText(text);
            if (text === '') setSelected(null);
          }}
          filter={(item: TimeZoneOption, query: string) =>
            `${item.label} ${item.value}`.toLowerCase().includes(query.toLowerCase())
          }
        >
          <ComboboxInput
            id="setup-time-zone"
            placeholder="Search time zones"
            aria-invalid={errors.timeZone !== undefined}
            aria-describedby={errors.timeZone ? 'setup-time-zone-error' : undefined}
          />
          <ComboboxContent>
            <ComboboxList>
              {(item: TimeZoneOption) => (
                <ComboboxItem key={item.value} value={item}>
                  {item.label}
                </ComboboxItem>
              )}
            </ComboboxList>
            <ComboboxEmpty>No matching time zone.</ComboboxEmpty>
          </ComboboxContent>
        </Combobox>
        {errors.timeZone ? (
          <FieldError id="setup-time-zone-error">{errors.timeZone}</FieldError>
        ) : null}
      </Field>
      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger className="text-sm font-medium text-primary underline underline-offset-4 hover:text-primary/80">
          Advanced settings
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3">
          <p className="mb-4 text-sm text-muted-foreground">
            Most schools can skip this. Organization details default to the school name.
          </p>
          <Field>
            <FieldLabel htmlFor="setup-org-name">Organization name</FieldLabel>
            <Input
              id="setup-org-name"
              autoComplete="off"
              value={organizationName}
              placeholder={name.trim() || 'Defaults to the school name'}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                setOrganizationName(event.target.value);
              }}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="setup-org-slug">Organization slug</FieldLabel>
            <Input
              id="setup-org-slug"
              autoComplete="off"
              value={organizationSlug}
              placeholder={suggestedOrgSlug || 'lowercase-letters-and-dashes'}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                setOrganizationSlug(event.target.value);
              }}
            />
            <FieldDescription>Lowercase letters, numbers, and dashes.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="setup-school-slug">School slug</FieldLabel>
            <Input
              id="setup-school-slug"
              autoComplete="off"
              value={schoolSlug}
              placeholder={suggestedSchoolSlug || 'lowercase-letters-and-dashes'}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                setSchoolSlug(event.target.value);
              }}
            />
            <FieldDescription>Lowercase letters, numbers, and dashes.</FieldDescription>
          </Field>
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}
