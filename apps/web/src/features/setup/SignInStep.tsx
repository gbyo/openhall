import { useEffect, useRef, useState } from 'react';
import {
  QuestionnaireDescription,
  QuestionnaireError,
  QuestionnaireTitle,
} from '@/components/ui/questionnaire';
import { useFocusField } from './SetupLayout';
import {
  ProviderDetailsForm,
  ProviderQuestionnaireChoices,
  type ProviderChoiceErrors,
} from './ProviderChoiceForm';
import { useSetup } from './setup-state';
import type { StepContentProps } from './SchoolStep';

/** Sign-in choice with conditional provider fields. The choice itself is a
 * canonical Questionnaire single-choice question, controlled by the single
 * setup-state selection; provider secrets stay in memory and the server owns
 * issuer, scopes, keys, and auth method for Google. */
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
        <h1 id="setup-signin-title">How should people sign in?</h1>
      </QuestionnaireTitle>
      <QuestionnaireDescription>
        Choose the sign-in your school will use every day. You can connect it now or finish setup
        first.
      </QuestionnaireDescription>
      <div ref={groupRef} tabIndex={-1}>
        <ProviderQuestionnaireChoices
          choice={state.choice}
          allowLater
          onChoice={(choice) => {
            dispatch({ type: 'setChoice', choice });
            setErrors({});
          }}
        />
        <ProviderDetailsForm
          idPrefix="setup-signin"
          choice={state.choice}
          provider={state.provider}
          errors={errors}
          allowLater
          onProvider={(patch) => {
            dispatch({ type: 'setProvider', provider: patch });
          }}
        />
      </div>
      <QuestionnaireError>
        {errors.choice ?? 'Fix the highlighted fields to continue.'}
      </QuestionnaireError>
    </>
  );
}
