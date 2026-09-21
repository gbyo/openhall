import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, confirmed } from '../../api/client';
import { getCsrfToken, clearSessionMemory } from '../../api/session';
import { queryClient } from '../query-client';
import { meQuery } from '../queries';
import { RecoveryBanner } from '../../design-system/patterns/RecoveryBanner';
import { AppFrame } from '../AppFrame';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';

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
      <div className="mx-auto grid w-full max-w-md gap-4 py-10">
        <Card>
          <CardHeader>
            <h1 className="text-xl font-semibold tracking-tight">Sign in to your school</h1>
            <CardDescription>Use the account your school provided.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {error && (
              <Alert variant="destructive" role="alert">
                <AlertTitle>
                  {error === 'identity_not_linked' ? 'Sign-in not connected' : 'Sign-in failed'}
                </AlertTitle>
                <AlertDescription>
                  {error === 'identity_not_linked'
                    ? 'Ask your school administrator for a sign-in invitation.'
                    : 'WayPass could not sign you in. Try again.'}
                </AlertDescription>
              </Alert>
            )}
            {discovery.isPending && (
              <div className="grid gap-2" role="status" aria-label="Finding your school">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            )}
            {discovery.isError && (
              <Alert variant="destructive">
                <AlertTitle>Sign-in options unavailable</AlertTitle>
                <AlertDescription>Try again in a moment.</AlertDescription>
              </Alert>
            )}
            {tenant && providers.length > 0 && (
              <div className="grid gap-3">
                <div className="grid gap-0.5">
                  <p className="text-sm font-semibold">{tenant.name}</p>
                  <p className="text-xs text-muted-foreground">{tenant.slug}</p>
                </div>
                <ul className="grid gap-2">
                  {providers.map((provider) => (
                    <li key={provider.key}>
                      <Button
                        className="w-full justify-between"
                        render={
                          <a
                            href={`/api/v1/auth/oidc/${tenant.slug}/${provider.key}/start?return_path=${encodeURIComponent(returnPath)}`}
                          />
                        }
                      >
                        <span>Continue with {provider.displayName}</span>
                        <span aria-hidden="true">→</span>
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {tenant && providers.length === 0 && (
              <Alert>
                <AlertTitle>School sign-in hasn&apos;t been connected yet</AlertTitle>
                <AlertDescription>
                  An administrator needs to finish WayPass setup for {tenant.name}.
                </AlertDescription>
                <div className="pt-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    nativeButton={false}
                    render={<Link to="/recovery/access" />}
                  >
                    Continue with recovery access
                  </Button>
                </div>
              </Alert>
            )}
            {discovery.data?.tenantSelectionRequired && (
              <Alert>
                <AlertTitle>Choose your school</AlertTitle>
                <AlertDescription>
                  Use your school&apos;s WayPass address to sign in.
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
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
  const [signingOut, setSigningOut] = useState<'one' | 'all' | null>(null);
  function signOut(all: boolean) {
    setLogoutError(false);
    setSigningOut(all ? 'all' : 'one');
    void logout(all)
      .catch(() => {
        setLogoutError(true);
      })
      .finally(() => {
        setSigningOut(null);
      });
  }
  return (
    <AppFrame>
      <div className="mx-auto grid w-full max-w-md gap-4 py-10">
        <RecoveryBanner />
        <Card>
          <CardHeader>
            <h1 className="text-xl font-semibold tracking-tight">
              {me?.person.displayName ?? 'Recovery session'}
            </h1>
            <CardDescription>
              Recovery access{me?.tenant.name ? ` · ${me.tenant.name}` : ''}. Operational tools are
              unavailable; this temporary break-glass session can manage identity recovery only.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {logoutError && (
              <Alert variant="destructive">
                <AlertTitle>Sign out not confirmed</AlertTitle>
                <AlertDescription>WayPass could not reach the server. Try again.</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={signingOut !== null}
                onClick={() => {
                  signOut(false);
                }}
              >
                {signingOut === 'one' && <Spinner data-icon="inline-start" />}
                Sign out
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={signingOut !== null}
                onClick={() => {
                  signOut(true);
                }}
              >
                {signingOut === 'all' && <Spinner data-icon="inline-start" />}
                Sign out everywhere
              </Button>
            </div>
          </CardContent>
        </Card>
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
  const copy =
    state === 'provider-unavailable'
      ? 'Your invitation is still available in this page. Try connecting again.'
      : state === 'unavailable'
        ? 'This invitation may have been used or revoked. Ask your school for a new link.'
        : state === 'expired'
          ? 'Ask your school administrator for a new invitation.'
          : 'WayPass keeps invitation tokens out of browser history.';
  return (
    <AppFrame>
      <div className="mx-auto grid w-full max-w-md gap-4 py-10">
        {state === 'starting' ? (
          <Card>
            <CardContent className="flex items-center gap-3 pt-6">
              <Spinner data-icon="inline-start" />
              <p className="text-sm font-medium" role="status">
                {title}
              </p>
            </CardContent>
          </Card>
        ) : state === 'missing' ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{title}</EmptyTitle>
              <EmptyDescription>{copy}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Card>
            <CardHeader>
              <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
              <CardDescription>{copy}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-2">
              {state === 'provider-unavailable' && token && (
                <Button onClick={() => void startEnrollment(token)}>Try again</Button>
              )}
              <Button variant="link" nativeButton={false} render={<Link to="/login" />}>
                Return to sign in
              </Button>
            </CardContent>
          </Card>
        )}
        {state !== 'starting' && state !== 'missing' && (
          <Alert
            variant={state === 'expired' || state === 'unavailable' ? 'destructive' : 'default'}
          >
            <AlertTitle>
              {state === 'expired' || state === 'unavailable'
                ? 'This invitation can no longer be used'
                : 'Connection interrupted'}
            </AlertTitle>
            <AlertDescription>{copy}</AlertDescription>
          </Alert>
        )}
      </div>
    </AppFrame>
  );
}
