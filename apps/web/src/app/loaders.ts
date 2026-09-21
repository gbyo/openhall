/* React Router redirects are Response objects intentionally thrown from Data Mode loaders. */
/* eslint-disable @typescript-eslint/only-throw-error */
import { redirect, type LoaderFunctionArgs } from 'react-router';
import { queryClient } from './query-client';
import {
  bootstrapQuery,
  meQuery,
  organizationContextQuery,
  organizationsQuery,
  sessionQuery,
} from './queries';

function safeReturnPath(request: Request): string {
  const url = new URL(request.url);
  return url.pathname.startsWith('/') && !url.pathname.startsWith('//')
    ? `${url.pathname}${url.search}`
    : '/';
}

export async function indexLoader() {
  const bootstrap = await queryClient.query(bootstrapQuery);
  if (!bootstrap.initialized) throw redirect('/setup');
  const session = await queryClient.query(sessionQuery);
  if (!session.authenticated) throw redirect('/login');
  if (session.authenticationMethod === 'recovery') throw redirect('/recovery');
  const organizations = await queryClient.query(organizationsQuery);
  if (organizations.organizations.length === 1) {
    throw redirect(`/schools/${organizations.organizations[0]?.id ?? ''}`);
  }
  throw redirect('/schools');
}

export async function setupLoader() {
  const bootstrap = await queryClient.query(bootstrapQuery);
  if (bootstrap.initialized) throw redirect('/');
  return null;
}

export async function connectSignInLoader({ request }: LoaderFunctionArgs) {
  const bootstrap = await queryClient.query(bootstrapQuery);
  if (!bootstrap.initialized) throw redirect('/setup');
  const session = await queryClient.query(sessionQuery);
  if (!session.authenticated) {
    throw redirect(`/login?return_path=${encodeURIComponent(safeReturnPath(request))}`);
  }
  if (session.authenticationMethod === 'oidc') throw redirect('/');
  await queryClient.query(meQuery);
  return null;
}

export async function recoveryAccessLoader() {
  const bootstrap = await queryClient.query(bootstrapQuery);
  if (!bootstrap.initialized) throw redirect('/setup');
  const session = await queryClient.query(sessionQuery);
  if (!session.authenticated) return null;
  if (session.authenticationMethod === 'oidc') throw redirect('/');
  throw redirect('/connect-sign-in');
}

export async function loginLoader() {
  const bootstrap = await queryClient.query(bootstrapQuery);
  if (!bootstrap.initialized) throw redirect('/setup');
  const session = await queryClient.query(sessionQuery);
  if (session.authenticated)
    throw redirect(session.authenticationMethod === 'recovery' ? '/recovery' : '/');
  return null;
}

export async function protectedLoader({ request }: LoaderFunctionArgs) {
  const session = await queryClient.query(sessionQuery);
  if (!session.authenticated) {
    throw redirect(`/login?return_path=${encodeURIComponent(safeReturnPath(request))}`);
  }
  if (session.authenticationMethod === 'recovery') throw redirect('/recovery');
  await Promise.all([queryClient.query(meQuery), queryClient.query(organizationsQuery)]);
  return null;
}

export async function recoveryLoader() {
  const session = await queryClient.query(sessionQuery);
  if (!session.authenticated) throw redirect('/login');
  if (session.authenticationMethod !== 'recovery') throw redirect('/');
  await queryClient.query(meQuery);
  return null;
}

export async function schoolLoader({ params }: LoaderFunctionArgs) {
  const organizationId = params.organizationId;
  if (!organizationId) throw redirect('/schools');
  const context = await queryClient.query(organizationContextQuery(organizationId));
  return { context };
}
