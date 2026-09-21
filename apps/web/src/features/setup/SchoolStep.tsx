import { useEffect, useMemo, useState } from 'react';
import { Questionnaire } from '@shadcn/react/questionnaire';
import {
  ComboBox,
  FieldError,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Text,
  TextField,
} from 'react-aria-components';
import { useFocusField } from './SetupLayout';
import type { StepHandle } from './SetupLayout';
import { deriveSlugDefault, supportedTimeZones, timeZoneLabel, useSetup } from './setup-state';

export interface StepContentProps {
  handleRef: { current: StepHandle | null };
  onInvalidChange?: ((invalid: boolean) => void) | undefined;
}

/** School details. Time zone uses ComboBox (searchable IANA set); the server
 * remains authoritative. Advanced slugs stay collapsed by default. */
export function SchoolFields({ handleRef, onInvalidChange }: StepContentProps) {
  const { state, dispatch } = useSetup();
  const [name, setName] = useState(state.school.name);
  const [timeZoneKey, setTimeZoneKey] = useState<string | null>(state.school.timeZone || null);
  const [timeZoneInput, setTimeZoneInput] = useState(
    state.school.timeZone ? timeZoneLabel(state.school.timeZone) : '',
  );
  const [advancedOpen, setAdvancedOpen] = useState(state.school.advancedOpen);
  const [organizationName, setOrganizationName] = useState(state.school.organizationName);
  const [organizationSlug, setOrganizationSlug] = useState(state.school.organizationSlug);
  const [schoolSlug, setSchoolSlug] = useState(state.school.schoolSlug);
  const [attempted, setAttempted] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; timeZone?: string }>({});
  const zones = useMemo(() => supportedTimeZones(), []);
  const firstError = errors.name ? 'setup-school-name' : errors.timeZone ? 'setup-time-zone' : null;
  useFocusField(attempted ? firstError : null);

  const invalid = attempted && Object.keys(errors).length > 0;
  useEffect(() => {
    onInvalidChange?.(invalid);
  }, [invalid, onInvalidChange]);

  function resolveTimeZone(): string | null {
    if (timeZoneKey !== null && timeZoneLabel(timeZoneKey) === timeZoneInput) return timeZoneKey;
    const typed = timeZoneInput.trim();
    if (typed.length === 0) return null;
    const exact = zones.find((zone) => zone === typed || timeZoneLabel(zone) === typed);
    if (exact) return exact;
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
        timeZoneInput.trim().length === 0
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
      <Questionnaire.Title>
        <h1 className="maia-page-title" id="setup-school-title">
          Tell us about your school
        </h1>
      </Questionnaire.Title>
      <TextField
        className="maia-field"
        isInvalid={Boolean(errors.name)}
        isRequired
        value={name}
        onChange={setName}
      >
        <Label className="maia-label" htmlFor="setup-school-name">
          School name
        </Label>
        <Input className="maia-input" id="setup-school-name" autoComplete="off" />
        <FieldError className="maia-field__error">{errors.name}</FieldError>
      </TextField>
      <ComboBox
        className="maia-field"
        isInvalid={Boolean(errors.timeZone)}
        isRequired
        inputValue={timeZoneInput}
        onInputChange={(value) => {
          setTimeZoneInput(value);
          if (value === '') setTimeZoneKey(null);
        }}
        value={timeZoneKey}
        onChange={(key) => {
          if (typeof key === 'string') {
            setTimeZoneKey(key);
            setTimeZoneInput(timeZoneLabel(key));
          }
        }}
      >
        <Label className="maia-label" htmlFor="setup-time-zone">
          Time zone
        </Label>
        <Input className="maia-input" id="setup-time-zone" placeholder="Search time zones" />
        <Popover className="maia-popover">
          <ListBox className="maia-listbox">
            {zones.map((zone) => (
              <ListBoxItem
                key={zone}
                id={zone}
                className="maia-option"
                textValue={`${timeZoneLabel(zone)} ${zone}`}
              >
                {timeZoneLabel(zone)}
              </ListBoxItem>
            ))}
          </ListBox>
        </Popover>
        <FieldError className="maia-field__error">{errors.timeZone}</FieldError>
      </ComboBox>
      <details
        className="setup-details"
        open={advancedOpen}
        onToggle={(event) => {
          setAdvancedOpen((event.target as HTMLDetailsElement).open);
        }}
      >
        <summary>Advanced settings</summary>
        <p className="setup-details__copy">
          Most schools can skip this. Organization details default to the school name.
        </p>
        <TextField
          className="maia-field"
          value={organizationName}
          onChange={setOrganizationName}
          aria-label="Organization name"
        >
          <Label className="maia-label" htmlFor="setup-org-name">
            Organization name
          </Label>
          <Input
            className="maia-input"
            id="setup-org-name"
            autoComplete="off"
            placeholder={name.trim() || 'Defaults to the school name'}
          />
        </TextField>
        <TextField
          className="maia-field"
          value={organizationSlug}
          onChange={setOrganizationSlug}
          aria-label="Organization slug"
        >
          <Label className="maia-label" htmlFor="setup-org-slug">
            Organization slug
          </Label>
          <Input
            className="maia-input"
            id="setup-org-slug"
            autoComplete="off"
            placeholder={suggestedOrgSlug || 'lowercase-letters-and-dashes'}
          />
          <Text slot="description" className="maia-field__description">
            Lowercase letters, numbers, and dashes.
          </Text>
        </TextField>
        <TextField
          className="maia-field"
          value={schoolSlug}
          onChange={setSchoolSlug}
          aria-label="School slug"
        >
          <Label className="maia-label" htmlFor="setup-school-slug">
            School slug
          </Label>
          <Input
            className="maia-input"
            id="setup-school-slug"
            autoComplete="off"
            placeholder={suggestedSchoolSlug || 'lowercase-letters-and-dashes'}
          />
          <Text slot="description" className="maia-field__description">
            Lowercase letters, numbers, and dashes.
          </Text>
        </TextField>
      </details>
    </>
  );
}
