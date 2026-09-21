import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ChangeEvent, type SubmitEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, confirmed } from '../../api/client';
import { getCsrfToken, clearSessionMemory } from '../../api/session';
import { queryClient } from '../query-client';
import { meQuery } from '../queries';
import { Alert } from '../../design-system/primitives/Alert';
import { Button } from '../../design-system/primitives/Button';
import { TextField } from '../../design-system/primitives/TextField';
import { RecoveryBanner } from '../../design-system/patterns/RecoveryBanner';
import { AppFrame } from '../AppFrame';

const EMPTY_SETUP = {
  operatorToken: '',
  tenantName: '',
  tenantSlug: '',
  schoolName: '',
  schoolSlug: '',
  schoolTimeZone: '',
  adminGivenName: '',
  adminFamilyName: '',
  adminDisplayName: '',
  providerKey: 'workspace',
  providerDisplayName: 'Google Workspace',
  providerPreset: 'google',
  providerIssuer: 'https://accounts.google.com',
  providerClientId: '',
  providerClientSecret: '',
  providerAuthMethod: 'client_secret_post',
  providerScopes: 'openid email profile',
};

export function LoginPage() {
  const [search] = useSearchParams();
  const error = search.get('error');
  const returnPath = search.get('return_path')?.startsWith('/')
    ? (search.get('return_path') ?? '/')
    : '/';
  const discovery = useQuery({
    queryKey: ['auth-discovery'],
    queryFn: () => confirmed(api.GET('/api/v1/auth/discovery')),
    retry: 1,
  });
  const tenant =
    discovery.data && !discovery.data.tenantSelectionRequired ? discovery.data.tenant : undefined;
  const providers =
    discovery.data && !discovery.data.tenantSelectionRequired ? discovery.data.providers : [];
  return (
    <AppFrame>
      <div className="auth-layout">
        <section className="auth-intro" aria-labelledby="login-title">
          <div className="auth-waymark" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <p className="auth-kicker">WayPass</p>
          <h1 className="wf-type-page-title" id="login-title">
            Sign in to your school
          </h1>
          <p className="auth-intro__copy">Use the account your school provided.</p>
        </section>
        <section className="auth-action" aria-label="Sign-in options">
          {error && (
            <Alert
              tone="danger"
              role="alert"
              title={error === 'identity_not_linked' ? 'Sign-in not connected' : 'Sign-in failed'}
            >
              <p>
                {error === 'identity_not_linked'
                  ? 'Ask your school administrator for a sign-in invitation.'
                  : 'WayPass could not sign you in. Try again.'}
              </p>
            </Alert>
          )}
          {discovery.isPending && (
            <p className="auth-loading" role="status">
              Finding your school…
            </p>
          )}
          {discovery.isError && (
            <Alert tone="danger" title="Sign-in options unavailable">
              <p>Try again in a moment.</p>
            </Alert>
          )}
          {tenant && (
            <div className="auth-provider-list">
              <div>
                <p className="wf-type-heading">{tenant.name}</p>
                <p className="auth-school-slug">{tenant.slug}</p>
              </div>
              <ul>
                {providers.map((provider) => (
                  <li key={provider.key}>
                    <a
                      className="auth-provider-link"
                      href={`/api/v1/auth/oidc/${tenant.slug}/${provider.key}/start?return_path=${encodeURIComponent(returnPath)}`}
                    >
                      <span>Continue with {provider.displayName}</span>
                      <span aria-hidden="true">→</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {discovery.data?.tenantSelectionRequired && (
            <Alert title="Choose your school">
              <p>Use your school's WayPass address to sign in.</p>
            </Alert>
          )}
        </section>
      </div>
    </AppFrame>
  );
}

export function SetupPage() {
  const [form, setForm] = useState(EMPTY_SETUP);
  const [error, setError] = useState<string | null>(null);
  const set =
    (name: keyof typeof form) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const value = event.target.value;
      setForm((previous) => {
        if (name === 'providerPreset' && value === 'google')
          return {
            ...previous,
            providerPreset: value,
            providerIssuer: 'https://accounts.google.com',
            providerScopes: 'openid email profile',
          };
        if (name === 'providerPreset' && value === 'generic')
          return {
            ...previous,
            providerPreset: value,
            providerIssuer: '',
            providerScopes: 'openid',
          };
        return { ...previous, [name]: value };
      });
    };
  const field = (name: keyof typeof form, label: string, secret = false) => (
    <TextField
      id={`setup-${name}`}
      label={label}
      type={secret ? 'password' : 'text'}
      value={form[name]}
      onChange={set(name)}
      required
      autoComplete="off"
    />
  );
  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      const response = await fetch('/api/v1/bootstrap/prepare', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bootstrap ${form.operatorToken.trim()}`,
        },
        body: JSON.stringify({
          tenantName: form.tenantName,
          tenantSlug: form.tenantSlug,
          schoolName: form.schoolName,
          schoolSlug: form.schoolSlug,
          schoolTimeZone: form.schoolTimeZone,
          adminGivenName: form.adminGivenName,
          adminFamilyName: form.adminFamilyName,
          adminDisplayName: form.adminDisplayName,
          providerKey: form.providerKey,
          providerDisplayName: form.providerDisplayName,
          providerIssuer: form.providerIssuer,
          providerClientId: form.providerClientId,
          providerClientSecret: form.providerClientSecret,
          providerAuthMethod: form.providerAuthMethod,
          providerScopes: form.providerScopes.split(/[\s,]+/).filter(Boolean),
        }),
      });
      const payload = (await response.json()) as { authorizationUrl?: string };
      if (!response.ok || !payload.authorizationUrl)
        throw new Error('Check the setup details and try again.');
      window.location.assign(payload.authorizationUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Setup failed.');
    }
  }
  return (
    <AppFrame>
      <section className="setup-view" aria-labelledby="setup-title">
        <header className="setup-view__header">
          <p className="auth-kicker">First-time setup</p>
          <h1 className="wf-type-page-title" id="setup-title">
            Set up WayPass
          </h1>
          <p>
            Connect the school and its sign-in provider. The one-time operator token is never
            stored.
          </p>
        </header>
        {error && (
          <Alert tone="danger" role="alert" title="Setup could not continue">
            <p>{error}</p>
          </Alert>
        )}
        <form className="setup-form" onSubmit={(event) => void submit(event)}>
          <fieldset className="setup-form__section setup-form__section--token">
            <legend>Server access</legend>
            {field('operatorToken', 'Operator token', true)}
          </fieldset>
          <fieldset className="setup-form__section">
            <legend>School</legend>
            <div className="setup-form__grid">
              {field('tenantName', 'Organization name')}
              {field('tenantSlug', 'Organization slug (lowercase)')}
              {field('schoolName', 'School name')}
              {field('schoolSlug', 'School slug (lowercase)')}
              <div className="setup-form__wide">
                {field('schoolTimeZone', 'School time zone (e.g. America/Chicago)')}
              </div>
            </div>
          </fieldset>
          <fieldset className="setup-form__section">
            <legend>Administrator</legend>
            <div className="setup-form__grid">
              {field('adminGivenName', 'Administrator given name')}
              {field('adminFamilyName', 'Administrator family name')}
              <div className="setup-form__wide">
                {field('adminDisplayName', 'Administrator display name')}
              </div>
            </div>
          </fieldset>
          <fieldset className="setup-form__section">
            <legend>Sign-in provider</legend>
            <div className="setup-form__grid">
              <label className="wf-field">
                <span className="wf-field__label">Provider</span>
                <select
                  className="wf-input"
                  value={form.providerPreset}
                  onChange={set('providerPreset')}
                >
                  <option value="google">Google Workspace</option>
                  <option value="generic">Generic OpenID Connect</option>
                </select>
              </label>
              {field('providerKey', 'Provider key (lowercase)')}
              {field('providerDisplayName', 'Provider display name')}
              {field('providerIssuer', 'Provider issuer URL')}
              {field('providerClientId', 'Client ID')}
              {field('providerClientSecret', 'Client secret', true)}
              <label className="wf-field">
                <span className="wf-field__label">Client authentication</span>
                <select
                  className="wf-input"
                  value={form.providerAuthMethod}
                  onChange={set('providerAuthMethod')}
                >
                  <option value="client_secret_post">client_secret_post</option>
                  <option value="client_secret_basic">client_secret_basic</option>
                </select>
              </label>
              {field('providerScopes', 'Scopes (space separated)')}
            </div>
          </fieldset>
          <div className="setup-form__actions">
            <Button type="submit">Validate and continue with the provider</Button>
          </div>
        </form>
      </section>
    </AppFrame>
  );
}

async function logout(all: boolean): Promise<void> {
  const path = all ? '/api/v1/auth/logout-all' : '/api/v1/auth/logout';
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'X-CSRF-Token': getCsrfToken() },
    credentials: 'same-origin',
  });
  if (!response.ok) throw new Error('Sign out was not confirmed.');
  clearSessionMemory();
  queryClient.clear();
  window.location.assign('/login');
}

export function RecoveryPage() {
  const { data: me } = useQuery(meQuery);
  const [logoutError, setLogoutError] = useState(false);
  return (
    <AppFrame>
      <div className="account-view">
        <RecoveryBanner />
        <section className="account-view__content" aria-labelledby="recovery-title">
          <div className="account-view__identity">
            <p className="auth-kicker">Recovery access</p>
            <h1 className="wf-type-page-title" id="recovery-title">
              {me?.person.displayName ?? 'Recovery session'}
            </h1>
            <p>{me?.tenant.name}</p>
          </div>
          <div className="account-view__placeholder">
            <p className="wf-type-heading">Operational tools are unavailable.</p>
            <p>This temporary break-glass session can manage identity recovery only.</p>
          </div>
          {logoutError && (
            <Alert tone="danger" title="Sign out not confirmed">
              <p>WayPass could not reach the server. Try again.</p>
            </Alert>
          )}
          <div className="account-view__actions">
            <Button
              type="button"
              onClick={() =>
                void logout(false).catch(() => {
                  setLogoutError(true);
                })
              }
            >
              Sign out
            </Button>
            <Button
              type="button"
              variant="quiet"
              onClick={() =>
                void logout(true).catch(() => {
                  setLogoutError(true);
                })
              }
            >
              Sign out everywhere
            </Button>
          </div>
        </section>
      </div>
    </AppFrame>
  );
}

export function EnrollPage() {
  const [state, setState] = useState<
    'starting' | 'missing' | 'expired' | 'unavailable' | 'provider-unavailable'
  >('starting');
  const [token, setToken] = useState(() => window.location.hash.slice(1));
  async function startEnrollment(value: string): Promise<void> {
    setState('starting');
    try {
      const response = await fetch('/api/v1/auth/enrollment/start', {
        method: 'POST',
        headers: { Authorization: `Enrollment ${value}` },
      });
      const body = (await response.json()) as { authorizationUrl?: string; code?: string };
      if (!response.ok || !body.authorizationUrl) {
        if (body.code === 'auth_transaction_expired') setState('expired');
        else if (body.code === 'auth_provider_unavailable') setState('provider-unavailable');
        else setState('unavailable');
        return;
      }
      setToken('');
      window.location.assign(body.authorizationUrl);
    } catch {
      setState('provider-unavailable');
    }
  }
  useEffect(() => {
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    if (!token) {
      setState('missing');
      return;
    }
    void startEnrollment(token);
  }, [token]);
  const title =
    state === 'starting'
      ? 'Connecting your school sign-in…'
      : state === 'missing'
        ? 'Invitation link needed'
        : state === 'expired'
          ? 'Invitation expired'
          : state === 'provider-unavailable'
            ? "Couldn't connect to your school sign-in"
            : 'Invitation unavailable';
  return (
    <AppFrame>
      <section className="system-message">
        <div>
          <h1 className="wf-type-heading">{title}</h1>
          <p>
            {state === 'provider-unavailable'
              ? 'Your invitation is still available in this page. Try connecting again.'
              : state === 'unavailable'
                ? 'This invitation may have been used or revoked. Ask your school for a new link.'
                : state === 'expired'
                  ? 'Ask your school administrator for a new invitation.'
                  : 'WayPass keeps invitation tokens out of browser history.'}
          </p>
          {state === 'provider-unavailable' && token && (
            <Button variant="secondary" onClick={() => void startEnrollment(token)}>
              Try again
            </Button>
          )}
          {state !== 'starting' && <Link to="/login">Return to sign in</Link>}
        </div>
      </section>
    </AppFrame>
  );
}
