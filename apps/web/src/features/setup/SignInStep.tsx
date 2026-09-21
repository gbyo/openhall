import { useEffect, useRef, useState } from 'react';
import { QuestionnaireTitle } from '@/components/ui/questionnaire';
import { useFocusField } from './SetupLayout';
import { ProviderChoiceForm, type ProviderChoiceErrors } from './ProviderChoiceForm';
import { useSetup } from './setup-state';
import type { StepContentProps } from './SchoolStep';

/** Sign-in choice with conditional provider fields. Provider secrets stay in
 * memory; the server owns issuer, scopes, keys, and auth method for Google. */
export function SignInFields({ handleRef, onInvalidChange }: StepContentProps) {
  const { state, dispatch } = useSetup();
  const [attempted, setAttempted] = useState(false);
  const [errors, setErrors] = useState<ProviderChoiceErrors>({});
  const groupRef = useRef<HTMLDivElement | null>(null);

  const firstFieldError = errors.providerName
    ? 'setup-signin-provider-name'
    : errors.issuerUrl
      ? 'setup-signin-issuer-url'
      : errors.clientId
        ? state.choice === 'generic'
          ? 'setup-signin-generic-client-id'
          : 'setup-signin-google-client-id'
        : errors.clientSecret
          ? state.choice === 'generic'
            ? 'setup-signin-generic-client-secret'
            : 'setup-signin-google-client-secret'
          : null;
  useFocusField(attempted ? firstFieldError : null);
  useEffect(() => {
    if (attempted && errors.choice && !firstFieldError) {
      groupRef.current?.focus({ preventScroll: true });
    }
  }, [attempted, errors.choice, firstFieldError]);

  const invalid = attempted && Object.keys(errors).length > 0;
  useEffect(() => {
    onInvalidChange?.(invalid);
  }, [invalid, onInvalidChange]);

  function validateAndCommit(): boolean {
    setAttempted(true);
    const next: ProviderChoiceErrors = {};
    if (state.choice === null) {
      next.choice = 'Choose how people will sign in.';
    } else if (state.choice === 'google') {
      if (state.provider.clientId.trim().length === 0) next.clientId = 'Enter the client ID.';
      if (state.provider.clientSecret.length === 0) next.clientSecret = 'Enter the client secret.';
    } else if (state.choice === 'generic') {
      if (state.provider.providerName.trim().length === 0)
        next.providerName = 'Enter the provider name.';
      if (state.provider.issuerUrl.trim().length === 0) next.issuerUrl = 'Enter the issuer URL.';
      if (state.provider.clientId.trim().length === 0) next.clientId = 'Enter the client ID.';
      if (state.provider.clientSecret.length === 0) next.clientSecret = 'Enter the client secret.';
    }
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return false;
    }
    setErrors({});
    return true;
  }

  useEffect(() => {
    handleRef.current = { validateAndCommit };
  });

  return (
    <>
      <QuestionnaireTitle>
        <h1 className="setup-title" id="setup-signin-title">
          How should people sign in?
        </h1>
      </QuestionnaireTitle>
      <div ref={groupRef} tabIndex={-1}>
        <ProviderChoiceForm
          idPrefix="setup-signin"
          choice={state.choice}
          provider={state.provider}
          errors={errors}
          allowLater
          onChoice={(choice) => {
            dispatch({ type: 'setChoice', choice });
            setErrors({});
          }}
          onProvider={(patch) => {
            dispatch({ type: 'setProvider', provider: patch });
          }}
        />
      </div>
    </>
  );
}
