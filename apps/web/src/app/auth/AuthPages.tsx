import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, confirmed } from '../../api/client';
import { getCsrfToken, clearSessionMemory } from '../../api/session';
import { queryClient } from '../query-client';
import { meQuery } from '../queries';
import { Alert } from '../../design-system/primitives/Alert';
import { Button } from '../../design-system/primitives/Button';
import { RecoveryBanner } from '../../design-system/patterns/RecoveryBanner';
import { AppFrame } from '../AppFrame';

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
          {tenant && providers.length > 0 && (
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
          {tenant && providers.length === 0 && (
            <Alert title="School sign-in hasn't been connected yet">
              <p>An administrator needs to finish WayPass setup for {tenant.name}.</p>
              <p>
                <Link to="/recovery/access">Continue with recovery access</Link>
              </p>
            </Alert>
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
