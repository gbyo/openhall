import { useEffect, useState } from 'react';
import { Questionnaire } from '@shadcn/react/questionnaire';
import { useNavigate } from 'react-router';
import { ApiProblem } from '../../api/problems';
import { queryClient } from '../../app/query-client';
import { useFocusField } from './SetupLayout';
import { timeZoneLabel, useSetup } from './setup-state';
import { initializeInstallation, prepareSchoolSignIn } from './setup-api';
import type { SetupItemName } from './GuidedSetupFlow';

export interface ReviewHandle {
  validateAndCommit: () => boolean;
  submit: () => Promise<void>;
}

export interface ReviewFieldsProps {
  handleRef: { current: ReviewHandle | null };
  onInvalidChange?: ((invalid: boolean) => void) | undefined;
  onEdit: (item: SetupItemName) => void;
}

function signInLabel(choice: string | null, providerName: string): string {
  if (choice === 'google') return 'Google Workspace';
  if (choice === 'generic') return providerName.trim() || 'Sign-in provider';
  return 'Set up later';
}

/** Review uses entered values only: never the setup token, client secret,
 * raw scopes, issuer, or internal IDs. Edit returns to the matching
 * Questionnaire item with in-memory answers intact. */
export function ReviewFields({ handleRef, onInvalidChange, onEdit }: ReviewFieldsProps) {
  const { state, dispatch } = useSetup();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  useFocusField(error ? 'setup-review-title' : null);

  useEffect(() => {
    onInvalidChange?.(error !== null);
  }, [error, onInvalidChange]);

  function validateAndCommit(): boolean {
    return state.choice !== null;
  }

  async function submit(): Promise<void> {
    if (state.choice === null) {
      onEdit('sign-in');
      return;
    }
    setError(null);
    try {
      await initializeInstallation(state.operatorToken, {
        tenantName: state.school.organizationName,
        tenantSlug: state.school.organizationSlug || undefined,
        schoolName: state.school.name,
        schoolSlug: state.school.schoolSlug || undefined,
        schoolTimeZone: state.school.timeZone,
        adminGivenName: state.administrator.givenName,
        adminFamilyName: state.administrator.familyName,
        adminDisplayName: state.administrator.displayName || undefined,
      });
      // Secrets leave memory the moment they are no longer needed.
      const choice = state.choice;
      const provider = state.provider;
      dispatch({ type: 'reset' });
      await queryClient.invalidateQueries();
      if (choice === 'later') {
        await navigate('/');
        return;
      }
      const authorizationUrl = await prepareSchoolSignIn(
        choice === 'google'
          ? {
              providerPreset: 'google',
              clientId: provider.clientId.trim(),
              clientSecret: provider.clientSecret,
            }
          : {
              providerPreset: 'generic',
              clientId: provider.clientId.trim(),
              clientSecret: provider.clientSecret,
              providerName: provider.providerName.trim(),
              issuerUrl: provider.issuerUrl.trim(),
              providerKey: provider.providerKey.trim() || undefined,
              authMethod: provider.authMethod,
              scopes: provider.scopes.split(/[\s,]+/).filter((scope) => scope.length > 0),
            },
      );
      window.location.assign(authorizationUrl);
    } catch (cause) {
      if (cause instanceof ApiProblem) {
        if (cause.code === 'bootstrap_token_invalid') {
          dispatch({ type: 'lock' });
          await navigate('/setup', { state: { lockedOut: true } });
          return;
        }
        if (cause.code === 'bootstrap_unavailable') {
          setError('WayPass is already set up on this server. Sign in instead.');
        } else if (
          cause.code === 'provider_configuration_unsupported' ||
          cause.code === 'auth_provider_unavailable'
        ) {
          await navigate('/connect-sign-in', {
            state: { setupFailed: true, reason: cause.code },
          });
          return;
        } else if (cause.code === 'provider_setup_conflict') {
          setError('School sign-in is already connected. Sign in instead.');
        } else if (cause.code === 'invalid_bootstrap_draft') {
          setError('Check the school details and try again.');
          onEdit('school');
          return;
        } else {
          setError('WayPass could not finish setup. Try again.');
        }
      } else {
        setError('WayPass could not connect. Check your connection and try again.');
      }
    }
  }

  useEffect(() => {
    handleRef.current = { validateAndCommit, submit };
  });

  return (
    <>
      <Questionnaire.Title>
        <h1 className="maia-page-title" id="setup-review-title">
          Ready to set up WayPass
        </h1>
      </Questionnaire.Title>
      {error ? (
        <div className="maia-alert maia-alert--destructive" role="alert">
          <p className="maia-alert__title">Setup could not finish</p>
          <p>{error}</p>
        </div>
      ) : null}
      <ul className="setup-summary" aria-label="Setup answers">
        <li className="setup-summary__row">
          <span className="setup-summary__term">School</span>
          <p className="setup-summary__value">
            {state.school.name || '—'}
            <br />
            <span className="setup-summary__muted">{timeZoneLabel(state.school.timeZone)}</span>
          </p>
          <p className="setup-summary__edit">
            <button
              type="button"
              className="maia-link"
              onClick={() => {
                onEdit('school');
              }}
            >
              Edit
            </button>
          </p>
        </li>
        <li className="setup-summary__row">
          <span className="setup-summary__term">Administrator</span>
          <p className="setup-summary__value">{state.administrator.displayName || '—'}</p>
          <p className="setup-summary__edit">
            <button
              type="button"
              className="maia-link"
              onClick={() => {
                onEdit('administrator');
              }}
            >
              Edit
            </button>
          </p>
        </li>
        <li className="setup-summary__row">
          <span className="setup-summary__term">Sign-in</span>
          <p className="setup-summary__value">
            {signInLabel(state.choice, state.provider.providerName)}
          </p>
          <p className="setup-summary__edit">
            <button
              type="button"
              className="maia-link"
              onClick={() => {
                onEdit('sign-in');
              }}
            >
              Edit
            </button>
          </p>
        </li>
      </ul>
    </>
  );
}
