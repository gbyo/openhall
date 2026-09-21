/// <reference types="vite/client" />

import {
  StrictMode,
  useCallback,
  useEffect,
  useState,
  type ChangeEvent,
  type ReactNode,
  type SubmitEvent,
} from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/public-sans/wght.css';
import './design-system/tokens.css';
import './design-system/reset.css';
import './design-system/typography.css';
import './design-system/motion.css';
import './design-system/utilities.css';
import './design-system/components.css';
import './styles.css';
import { Button } from './design-system/primitives/Button';
import { TextField } from './design-system/primitives/TextField';
import { Alert } from './design-system/primitives/Alert';
import { RecoveryBanner } from './design-system/patterns/RecoveryBanner';

type Phase =
  | { kind: 'loading' }
  | { kind: 'setup' }
  | { kind: 'login'; error: string | undefined }
  | { kind: 'authenticated'; recovery: boolean }
  | { kind: 'logged-out' };

interface SessionInfo {
  authenticated: boolean;
  csrfToken?: string;
  authenticationMethod?: 'oidc' | 'recovery';
}

interface MeInfo {
  person: { id: string; givenName: string; familyName: string; displayName: string };
  tenant: { id: string; name: string; slug: string };
}

interface DiscoveryInfo {
  tenantSelectionRequired: boolean;
  tenant?: { id: string; name: string; slug: string };
  providers?: { key: string; displayName: string }[];
}

/** CSRF token lives in runtime memory only: never storage, never URL. */
let csrfTokenMemory: string | undefined;

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`Request failed: ${String(response.status)}`);
  }
  return (await response.json()) as T;
}

function errorFromQuery(): string | undefined {
  const params = new URLSearchParams(window.location.search);
  const error = params.get('error');
  return error && /^[a-z][a-z0-9_]*$/.test(error) ? error : undefined;
}

function LoginView({ initialError }: { initialError: string | undefined }) {
  const [discovery, setDiscovery] = useState<DiscoveryInfo | null>(null);
  const [failed, setFailed] = useState(false);
  // A const binding keeps the tenant narrowed inside the provider-link
  // closure below, where the inline guard would otherwise be lost.
  const tenant = discovery && !discovery.tenantSelectionRequired ? discovery.tenant : undefined;
  useEffect(() => {
    fetch('/api/v1/auth/discovery')
      .then((response) => json<DiscoveryInfo>(response))
      .then(setDiscovery)
      .catch(() => {
        setFailed(true);
      });
  }, []);
  return (
    <div className="auth-layout">
      <section className="auth-intro" aria-labelledby="login-title">
        <div className="auth-waymark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <p className="auth-kicker">Welcome to OpenHall</p>
        <h1 className="wf-type-page-title" id="login-title">
          Sign in to your school
        </h1>
        <p className="auth-intro__copy">
          Use the account your school provided. OpenHall keeps the next step clear without asking
          for another password.
        </p>
      </section>
      <section className="auth-action" aria-label="Sign-in options">
        {initialError === 'identity_not_linked' ? (
          <Alert tone="danger" role="alert" title="Account not linked">
            <p>
              Your account is not linked to this OpenHall installation. Contact your school
              administrator.
            </p>
          </Alert>
        ) : (
          initialError && (
            <Alert tone="danger" role="alert" title="Sign-in failed">
              <p>Sign-in failed ({initialError}). Please try again.</p>
            </Alert>
          )
        )}
        {failed && (
          <Alert tone="danger" role="alert" title="Sign-in options unavailable">
            <p>Could not load sign-in options. Please try again.</p>
          </Alert>
        )}
        {!discovery && !failed && (
          <p className="auth-loading" role="status">
            Finding your school…
          </p>
        )}
        {tenant && (
          <div className="auth-provider-list">
            <div>
              <p className="wf-type-heading">{tenant.name}</p>
              <p className="auth-school-slug">{tenant.slug}</p>
            </div>
            <ul>
              {(discovery?.providers ?? []).map((provider) => (
                <li key={provider.key}>
                  <a
                    className="auth-provider-link"
                    href={`/api/v1/auth/oidc/${tenant.slug}/${provider.key}/start?return_path=${encodeURIComponent('/')}`}
                  >
                    <span>Continue with {provider.displayName}</span>
                    <span aria-hidden="true">→</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
        {discovery?.tenantSelectionRequired && (
          <Alert title="Choose your school">
            <p>
              Select your school organization to continue. (Multi-tenant selection coming soon.)
            </p>
          </Alert>
        )}
      </section>
    </div>
  );
}

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

function SetupView() {
  const [form, setForm] = useState(EMPTY_SETUP);
  const [error, setError] = useState<string | null>(null);
  const set = useCallback(
    (name: string) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const value = event.target.value;
      setForm((previous) => {
        if (name === 'providerPreset' && value === 'google') {
          return {
            ...previous,
            providerPreset: value,
            providerIssuer: 'https://accounts.google.com',
            providerScopes: 'openid email profile',
          };
        }
        if (name === 'providerPreset' && value === 'generic') {
          return {
            ...previous,
            providerPreset: value,
            providerIssuer: '',
            providerScopes: 'openid',
          };
        }
        return { ...previous, [name]: value };
      });
    },
    [],
  );
  const submit = useCallback(
    async (event: SubmitEvent<HTMLFormElement>) => {
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
        if (!response.ok || !payload.authorizationUrl) {
          throw new Error('Setup validation failed. Check the details and try again.');
        }
        window.location.href = payload.authorizationUrl;
      } catch (submitError) {
        setError(submitError instanceof Error ? submitError.message : 'Setup failed.');
      }
    },
    [form],
  );
  const field = (name: string, label: string, type = 'text', secret = false) => (
    <TextField
      id={`setup-${name}`}
      label={label}
      type={secret ? 'password' : type}
      value={form[name as keyof typeof form]}
      onChange={set(name)}
      required
      autoComplete="off"
    />
  );
  return (
    <section className="setup-view" aria-labelledby="setup-title">
      <header className="setup-view__header">
        <p className="auth-kicker">First-time setup</p>
        <h1 className="wf-type-page-title" id="setup-title">
          Initialize OpenHall
        </h1>
        <p>
          Connect the school and its sign-in provider. The one-time operator token is used for this
          request and is never stored.
        </p>
      </header>
      {error && (
        <Alert tone="danger" role="alert" title="Setup could not continue">
          <p>{error}</p>
        </Alert>
      )}
      <form
        className="setup-form"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <fieldset className="setup-form__section setup-form__section--token">
          <legend>Server access</legend>
          {field('operatorToken', 'Operator token', 'text', true)}
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
            <div className="wf-field">
              <label className="wf-field__label" htmlFor="setup-provider-preset">
                Provider
              </label>
              <select
                id="setup-provider-preset"
                className="wf-input"
                value={form.providerPreset}
                onChange={set('providerPreset')}
              >
                <option value="google">Google Workspace</option>
                <option value="generic">Generic OpenID Connect</option>
              </select>
            </div>
            {field('providerKey', 'Provider key (lowercase)')}
            {field('providerDisplayName', 'Provider display name')}
            {field('providerIssuer', 'Provider issuer URL')}
            {field('providerClientId', 'Client ID')}
            {field('providerClientSecret', 'Client secret', 'text', true)}
            <div className="wf-field">
              <label className="wf-field__label" htmlFor="setup-provider-auth-method">
                Client authentication
              </label>
              <select
                id="setup-provider-auth-method"
                className="wf-input"
                value={form.providerAuthMethod}
                onChange={set('providerAuthMethod')}
              >
                <option value="client_secret_post">client_secret_post</option>
                <option value="client_secret_basic">client_secret_basic</option>
              </select>
            </div>
            {field('providerScopes', 'Scopes (space separated)')}
          </div>
        </fieldset>
        <div className="setup-form__actions">
          <Button type="submit">Validate and continue with the provider</Button>
        </div>
      </form>
    </section>
  );
}

function AuthenticatedView({ recovery }: { recovery: boolean }) {
  const [me, setMe] = useState<MeInfo | null>(null);
  useEffect(() => {
    fetch('/api/v1/me')
      .then((response) => json<MeInfo>(response))
      .then(setMe)
      .catch(() => undefined);
  }, []);
  const logout = useCallback(async (all: boolean) => {
    if (!csrfTokenMemory) {
      const session = await fetch('/api/v1/auth/session').then((response) =>
        json<SessionInfo>(response),
      );
      csrfTokenMemory = session.csrfToken;
    }
    const response = await fetch(all ? '/api/v1/auth/logout-all' : '/api/v1/auth/logout', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrfTokenMemory ?? '' },
    });
    csrfTokenMemory = undefined;
    if (!response.ok) {
      return;
    }
    window.location.href = '/';
  }, []);
  return (
    <div className="account-view">
      {recovery && <RecoveryBanner compact />}
      <section className="account-view__content" aria-labelledby="account-title">
        <div className="account-view__marker" aria-hidden="true">
          <span />
        </div>
        <div className="account-view__identity">
          <p className="auth-kicker">Signed in</p>
          <h1 className="wf-type-page-title" id="account-title">
            {me ? me.person.displayName : 'OpenHall'}
          </h1>
          {me ? (
            <p>
              {me.person.givenName} {me.person.familyName} · {me.tenant.name}
            </p>
          ) : (
            <p className="auth-loading" role="status">
              Loading account details…
            </p>
          )}
        </div>
        <div className="account-view__placeholder">
          <p className="wf-type-heading">Your OpenHall workspace is ready.</p>
          <p>
            The student, teacher, station, and administrator experiences arrive in the next product
            phase.
          </p>
        </div>
        <div className="account-view__actions" aria-label="Account actions">
          <Button type="button" variant="primary" onClick={() => void logout(false)}>
            Sign out
          </Button>
          <Button type="button" variant="quiet" onClick={() => void logout(true)}>
            Sign out everywhere
          </Button>
        </div>
      </section>
    </div>
  );
}

function AppFrame({ children }: { children: ReactNode }) {
  return (
    <main className="app-frame">
      <header className="app-frame__header">
        <a className="app-wordmark" href="/" aria-label="OpenHall home">
          <span className="app-wordmark__route" aria-hidden="true">
            <i />
            <i />
          </span>
          <span>OpenHall</span>
        </a>
        <span className="app-frame__descriptor">School movement, clearly understood</span>
      </header>
      <div className="app-frame__body">{children}</div>
      <footer className="app-frame__footer">
        <span>OpenHall</span>
        <span>Private to your school</span>
      </footer>
    </main>
  );
}

function Shell() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  useEffect(() => {
    let cancelled = false;
    const isCancelled = (): boolean => cancelled;
    void (async () => {
      try {
        const status = await fetch('/api/v1/bootstrap/status').then((response) =>
          json<{ initialized: boolean }>(response),
        );
        if (isCancelled()) return;
        if (!status.initialized) {
          setPhase({ kind: 'setup' });
          return;
        }
        const session = await fetch('/api/v1/auth/session').then((response) =>
          json<SessionInfo>(response),
        );
        if (isCancelled()) return;
        if (!session.authenticated) {
          setPhase({ kind: 'login', error: errorFromQuery() });
          return;
        }
        csrfTokenMemory = session.csrfToken;
        setPhase({ kind: 'authenticated', recovery: session.authenticationMethod === 'recovery' });
      } catch {
        if (!isCancelled()) setPhase({ kind: 'login', error: errorFromQuery() });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  if (phase.kind === 'loading') {
    return (
      <AppFrame>
        <section className="system-message" aria-labelledby="loading-title">
          <span className="system-message__route" aria-hidden="true">
            <i />
            <i />
          </span>
          <div>
            <h1 className="wf-type-heading" id="loading-title">
              Opening OpenHall
            </h1>
            <p role="status">Checking your school and sign-in session…</p>
          </div>
        </section>
      </AppFrame>
    );
  }
  if (phase.kind === 'setup') {
    return (
      <AppFrame>
        <SetupView />
      </AppFrame>
    );
  }
  if (phase.kind === 'login') {
    return (
      <AppFrame>
        <LoginView initialError={phase.error} />
      </AppFrame>
    );
  }
  if (phase.kind === 'logged-out') {
    return (
      <AppFrame>
        <section className="system-message" aria-labelledby="signed-out-title">
          <span
            className="system-message__route system-message__route--complete"
            aria-hidden="true"
          >
            <i />
            <i />
          </span>
          <div>
            <h1 className="wf-type-heading" id="signed-out-title">
              Signed out.
            </h1>
            <a className="auth-text-link" href="/">
              Sign in again
            </a>
          </div>
        </section>
      </AppFrame>
    );
  }
  return (
    <AppFrame>
      <AuthenticatedView recovery={phase.recovery} />
    </AppFrame>
  );
}

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Application root element is missing');
const root = createRoot(rootElement);

async function renderApplication() {
  if (import.meta.env.DEV && window.location.pathname === '/__wayfinder') {
    const { WayfinderReferencePage } =
      await import('./design-system/reference/WayfinderReferencePage');
    root.render(
      <StrictMode>
        <WayfinderReferencePage />
      </StrictMode>,
    );
    return;
  }
  root.render(
    <StrictMode>
      <Shell />
    </StrictMode>,
  );
}

void renderApplication();
