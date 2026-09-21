import { useState, type SubmitEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Alert } from '../../design-system/primitives/Alert';
import { Button } from '../../design-system/primitives/Button';
import { AppFrame } from '../../app/AppFrame';
import { meQuery, sessionQuery } from '../../app/queries';
import { ApiProblem } from '../../api/problems';
import { ProviderChoiceForm, type ProviderChoiceErrors } from '../setup/ProviderChoiceForm';
import { prepareSchoolSignIn } from '../setup/setup-api';
import type { ProviderDraft, SignInChoice } from '../setup/setup-state';

const EMPTY_PROVIDER: ProviderDraft = {
  clientId: '',
  clientSecret: '',
  providerName: '',
  issuerUrl: '',
  providerKey: '',
  authMethod: 'client_secret_post',
  scopes: 'openid',
  advancedOpen: false,
};

export function ConnectSignInPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { data: session } = useQuery(sessionQuery);
  const { data: me } = useQuery(meQuery);
  const [choice, setChoice] = useState<SignInChoice | null>(null);
  const [provider, setProvider] = useState<ProviderDraft>(EMPTY_PROVIDER);
  const [errors, setErrors] = useState<ProviderChoiceErrors>({});
  const [failure, setFailure] = useState<string | null>(
    typeof location.state === 'object' && location.state !== null && 'setupFailed' in location.state
      ? 'Your sign-in provider didn\u2019t respond during setup. Check the details below and try again.'
      : null,
  );
  const [pending, setPending] = useState(false);

  const method = session?.authenticated ? session.authenticationMethod : null;

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const next: ProviderChoiceErrors = {};
    if (choice === null || choice === 'later') {
      next.choice = 'Choose a sign-in option to connect.';
    } else if (choice === 'google') {
      if (provider.clientId.trim().length === 0) next.clientId = 'Enter the client ID.';
      if (provider.clientSecret.length === 0) next.clientSecret = 'Enter the client secret.';
    } else {
      if (provider.providerName.trim().length === 0) next.providerName = 'Enter the provider name.';
      if (provider.issuerUrl.trim().length === 0) next.issuerUrl = 'Enter the issuer URL.';
      if (provider.clientId.trim().length === 0) next.clientId = 'Enter the client ID.';
      if (provider.clientSecret.length === 0) next.clientSecret = 'Enter the client secret.';
    }
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    setErrors({});
    setFailure(null);
    setPending(true);
    try {
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
      if (cause instanceof ApiProblem && cause.code === 'provider_setup_conflict') {
        setFailure('School sign-in is already connected. Sign in instead.');
      } else if (
        cause instanceof ApiProblem &&
        (cause.code === 'provider_configuration_unsupported' ||
          cause.code === 'auth_provider_unavailable')
      ) {
        setFailure(
          'Your sign-in provider didn\u2019t respond. Check the details below and try again.',
        );
      } else {
        setFailure('WayPass could not reach your sign-in provider. Try again.');
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <AppFrame>
      <section className="setup-view setup-view--narrow" aria-labelledby="connect-signin-title">
        <p className="auth-kicker">WayPass setup</p>
        <h1 className="wf-type-page-title" id="connect-signin-title">
          Connect school sign-in
        </h1>
        <p className="setup-lede">
          {method === 'recovery'
            ? `Finishing setup for ${me?.tenant.name ?? 'your school'} with a recovery code.`
            : 'Connect the sign-in your school will use every day.'}
        </p>
        {failure ? (
          <Alert tone="danger" role="alert" title="Sign-in could not connect">
            <p>{failure}</p>
          </Alert>
        ) : null}
        <form onSubmit={(event) => void submit(event)} noValidate>
          <ProviderChoiceForm
            idPrefix="connect-signin"
            choice={choice}
            provider={provider}
            errors={errors}
            allowLater={false}
            onChoice={(value) => {
              setChoice(value);
              setErrors({});
            }}
            onProvider={(patch) => {
              setProvider((previous) => ({ ...previous, ...patch }));
            }}
          />
          <div className="setup-actions">
            <div className="setup-actions__buttons">
              <Button type="button" variant="secondary" onClick={() => void navigate('/')}>
                I&apos;ll do this later
              </Button>
              <Button type="submit" pending={pending} pendingLabel="Connecting…">
                Connect and continue
              </Button>
            </div>
          </div>
        </form>
      </section>
    </AppFrame>
  );
}
