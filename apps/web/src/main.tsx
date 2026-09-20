import {
  StrictMode,
  useCallback,
  useEffect,
  useState,
  type ChangeEvent,
  type SubmitEvent,
} from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

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
    <section aria-labelledby="login-title">
      <p className="eyebrow">Sign in</p>
      <h1 id="login-title">OpenHall</h1>
      {initialError === 'identity_not_linked' ? (
        <p role="alert">
          Your account is not linked to this OpenHall installation. Contact your school
          administrator.
        </p>
      ) : (
        initialError && <p role="alert">Sign-in failed ({initialError}). Please try again.</p>
      )}
      {failed && <p role="alert">Could not load sign-in options. Please try again.</p>}
      {tenant && (
        <>
          <p>
            {tenant.name} ({tenant.slug})
          </p>
          <ul>
            {(discovery?.providers ?? []).map((provider) => (
              <li key={provider.key}>
                <a
                  href={`/api/v1/auth/oidc/${tenant.slug}/${provider.key}/start?return_path=${encodeURIComponent('/')}`}
                >
                  Continue with {provider.displayName}
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
      {discovery?.tenantSelectionRequired && (
        <p>Select your school organization to continue. (Multi-tenant selection coming soon.)</p>
      )}
    </section>
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
    <label>
      {label}
      <input
        type={secret ? 'password' : type}
        value={form[name as keyof typeof form]}
        onChange={set(name)}
        required
        autoComplete="off"
      />
    </label>
  );
  return (
    <section aria-labelledby="setup-title">
      <p className="eyebrow">First-time setup</p>
      <h1 id="setup-title">Initialize OpenHall</h1>
      <p>Paste the one-time operator token issued on the server. It is never stored.</p>
      {error && <p role="alert">{error}</p>}
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        {field('operatorToken', 'Operator token', 'text', true)}
        {field('tenantName', 'Organization name')}
        {field('tenantSlug', 'Organization slug (lowercase)')}
        {field('schoolName', 'School name')}
        {field('schoolSlug', 'School slug (lowercase)')}
        {field('schoolTimeZone', 'School time zone (e.g. America/Chicago)')}
        {field('adminGivenName', 'Administrator given name')}
        {field('adminFamilyName', 'Administrator family name')}
        {field('adminDisplayName', 'Administrator display name')}
        <label>
          Provider
          <select value={form.providerPreset} onChange={set('providerPreset')}>
            <option value="google">Google Workspace</option>
            <option value="generic">Generic OpenID Connect</option>
          </select>
        </label>
        {field('providerKey', 'Provider key (lowercase)')}
        {field('providerDisplayName', 'Provider display name')}
        {field('providerIssuer', 'Provider issuer URL')}
        {field('providerClientId', 'Client ID')}
        {field('providerClientSecret', 'Client secret', 'text', true)}
        <label>
          Client authentication
          <select value={form.providerAuthMethod} onChange={set('providerAuthMethod')}>
            <option value="client_secret_post">client_secret_post</option>
            <option value="client_secret_basic">client_secret_basic</option>
          </select>
        </label>
        {field('providerScopes', 'Scopes (space separated)')}
        <button type="submit">Validate and continue with the provider</button>
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
    <section aria-labelledby="account-title">
      {recovery && (
        <p role="alert" className="warning">
          Recovery session: short-lived break-glass access. Sign out when finished.
        </p>
      )}
      <p className="eyebrow">Signed in</p>
      <h1 id="account-title">{me ? me.person.displayName : 'OpenHall'}</h1>
      {me && (
        <p>
          {me.person.givenName} {me.person.familyName} · {me.tenant.name}
        </p>
      )}
      <button type="button" onClick={() => void logout(false)}>
        Sign out
      </button>{' '}
      <button type="button" onClick={() => void logout(true)}>
        Sign out everywhere
      </button>
    </section>
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
      <main>
        <p>Loading OpenHall…</p>
      </main>
    );
  }
  if (phase.kind === 'setup') {
    return (
      <main>
        <SetupView />
      </main>
    );
  }
  if (phase.kind === 'login') {
    return (
      <main>
        <LoginView initialError={phase.error} />
      </main>
    );
  }
  if (phase.kind === 'logged-out') {
    return (
      <main>
        <p>Signed out.</p>
        <a href="/">Sign in again</a>
      </main>
    );
  }
  return (
    <main>
      <AuthenticatedView recovery={phase.recovery} />
    </main>
  );
}

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Application root element is missing');
createRoot(rootElement).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
