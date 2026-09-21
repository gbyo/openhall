import { useEffect, useState } from 'react';
import { Questionnaire } from '@shadcn/react/questionnaire';
import { FieldError, Input, Label, Text, TextField } from 'react-aria-components';
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
      <Questionnaire.Title>
        <h1 className="maia-page-title" id="setup-admin-title">
          Who will manage WayPass?
        </h1>
      </Questionnaire.Title>
      <TextField
        className="maia-field"
        isInvalid={Boolean(errors.givenName)}
        isRequired
        value={givenName}
        onChange={setGivenName}
      >
        <Label className="maia-label" htmlFor="setup-admin-given">
          First name
        </Label>
        <Input className="maia-input" id="setup-admin-given" autoComplete="given-name" />
        <FieldError className="maia-field__error">{errors.givenName}</FieldError>
      </TextField>
      <TextField
        className="maia-field"
        isInvalid={Boolean(errors.familyName)}
        isRequired
        value={familyName}
        onChange={setFamilyName}
      >
        <Label className="maia-label" htmlFor="setup-admin-family">
          Last name
        </Label>
        <Input className="maia-input" id="setup-admin-family" autoComplete="family-name" />
        <FieldError className="maia-field__error">{errors.familyName}</FieldError>
      </TextField>
      <details
        className="setup-details"
        open={customOpen}
        onToggle={(event) => {
          setCustomOpen((event.target as HTMLDetailsElement).open);
        }}
      >
        <summary>Customize display name</summary>
        <TextField
          className="maia-field"
          value={displayName}
          onChange={setDisplayName}
          aria-label="Display name"
        >
          <Label className="maia-label" htmlFor="setup-admin-display">
            Display name
          </Label>
          <Input
            className="maia-input"
            id="setup-admin-display"
            autoComplete="off"
            placeholder={preview || 'First Last'}
          />
          <Text slot="description" className="maia-field__description">
            {preview
              ? `Shown as \u201C${preview}\u201D unless you change it.`
              : 'Shown across WayPass wherever your name appears.'}
          </Text>
        </TextField>
      </details>
    </>
  );
}
