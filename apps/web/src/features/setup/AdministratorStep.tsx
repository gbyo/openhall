import { useEffect, useState, type ChangeEvent } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { QuestionnaireDescription, QuestionnaireTitle } from '@/components/ui/questionnaire';
import { useFocusField } from './SetupLayout';
import { useSetup } from './setup-state';
import type { StepContentProps } from './SchoolStep';

/** Administrator details. The display name derives from first + last unless
 * the override block is opened; identity fields are never asked for here. */
export function AdministratorFields({ handleRef, onInvalidChange }: StepContentProps) {
  const { state, dispatch } = useSetup();
  const [givenName, setGivenName] = useState(state.administrator.givenName);
  const [familyName, setFamilyName] = useState(state.administrator.familyName);
  const [customOpen, setCustomOpen] = useState(state.administrator.customDisplayName);
  const [displayName, setDisplayName] = useState(state.administrator.displayName);
  const [attempted, setAttempted] = useState(false);
  const [errors, setErrors] = useState<{ givenName?: string; familyName?: string }>({});
  const firstError = errors.givenName
    ? 'setup-admin-given'
    : errors.familyName
      ? 'setup-admin-family'
      : null;
  useFocusField(attempted ? firstError : null);

  const invalid = attempted && Object.keys(errors).length > 0;
  useEffect(() => {
    onInvalidChange?.(invalid);
  }, [invalid, onInvalidChange]);

  const preview =
    customOpen && displayName.trim().length > 0
      ? displayName.trim()
      : `${givenName} ${familyName}`.trim().replace(/\s+/g, ' ');

  function validateAndCommit(): boolean {
    setAttempted(true);
    const next: typeof errors = {};
    if (givenName.trim().length === 0) next.givenName = 'Enter a first name.';
    if (familyName.trim().length === 0) next.familyName = 'Enter a last name.';
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return false;
    }
    setErrors({});
    dispatch({
      type: 'setAdministrator',
      administrator: {
        givenName: givenName.trim(),
        familyName: familyName.trim(),
        displayName: customOpen ? displayName.trim() : '',
        customDisplayName: customOpen,
      },
    });
    return true;
  }

  useEffect(() => {
    handleRef.current = { validateAndCommit };
  });

  return (
    <>
      <QuestionnaireTitle>
        <h1 id="setup-admin-title">Who will manage WayPass?</h1>
      </QuestionnaireTitle>
      <QuestionnaireDescription>
        This person’s account will manage WayPass for your school.
      </QuestionnaireDescription>
      <Field data-invalid={errors.givenName !== undefined}>
        <FieldLabel htmlFor="setup-admin-given">First name</FieldLabel>
        <Input
          id="setup-admin-given"
          autoComplete="given-name"
          required
          value={givenName}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            setGivenName(event.target.value);
          }}
          aria-invalid={errors.givenName !== undefined}
          aria-describedby={errors.givenName ? 'setup-admin-given-error' : undefined}
        />
        {errors.givenName ? (
          <FieldError id="setup-admin-given-error">{errors.givenName}</FieldError>
        ) : null}
      </Field>
      <Field data-invalid={errors.familyName !== undefined}>
        <FieldLabel htmlFor="setup-admin-family">Last name</FieldLabel>
        <Input
          id="setup-admin-family"
          autoComplete="family-name"
          required
          value={familyName}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            setFamilyName(event.target.value);
          }}
          aria-invalid={errors.familyName !== undefined}
          aria-describedby={errors.familyName ? 'setup-admin-family-error' : undefined}
        />
        {errors.familyName ? (
          <FieldError id="setup-admin-family-error">{errors.familyName}</FieldError>
        ) : null}
      </Field>
      <Collapsible open={customOpen} onOpenChange={setCustomOpen}>
        <CollapsibleTrigger className="text-sm font-medium text-primary underline underline-offset-4 hover:text-primary/80">
          Customize display name
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3">
          <Field>
            <FieldLabel htmlFor="setup-admin-display">Display name</FieldLabel>
            <Input
              id="setup-admin-display"
              autoComplete="off"
              value={displayName}
              placeholder={preview || 'First Last'}
              aria-describedby="setup-admin-display-description"
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                setDisplayName(event.target.value);
              }}
            />
            <FieldDescription id="setup-admin-display-description">
              {preview
                ? `Shown as \u201C${preview}\u201D unless you change it.`
                : 'Shown across WayPass wherever your name appears.'}
            </FieldDescription>
          </Field>
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}
