import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item';
import { QuestionnaireTitle } from '@/components/ui/questionnaire';
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
      <QuestionnaireTitle>
        <h1 className="setup-title" id="setup-review-title">
          Ready to set up WayPass
        </h1>
      </QuestionnaireTitle>
      {error ? (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Setup could not finish</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <ItemGroup aria-label="Setup answers" role="list">
        <Item variant="outline" role="listitem">
          <ItemContent>
            <ItemTitle>School</ItemTitle>
            <ItemDescription>
              {state.school.name || '—'} · {timeZoneLabel(state.school.timeZone)}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button
              variant="link"
              type="button"
              onClick={() => {
                onEdit('school');
              }}
            >
              Edit
            </Button>
          </ItemActions>
        </Item>
        <Item variant="outline" role="listitem">
          <ItemContent>
            <ItemTitle>Administrator</ItemTitle>
            <ItemDescription>{state.administrator.displayName || '—'}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button
              variant="link"
              type="button"
              onClick={() => {
                onEdit('administrator');
              }}
            >
              Edit
            </Button>
          </ItemActions>
        </Item>
        <Item variant="outline" role="listitem">
          <ItemContent>
            <ItemTitle>Sign-in</ItemTitle>

            <ItemDescription>
              {signInLabel(state.choice, state.provider.providerName)}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button
              variant="link"
              type="button"
              onClick={() => {
                onEdit('sign-in');
              }}
            >
              Edit
            </Button>
          </ItemActions>
        </Item>
      </ItemGroup>
    </>
  );
}
