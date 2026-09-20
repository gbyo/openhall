import type {} from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { fromBase64Url } from '@openhall/application';

/**
 * Session cookie names. Production uses __Host- semantics (Secure, no
 * Domain); plain-HTTP localhost development/test uses clearly separate
 * names because __Host- requires secure properties.
 */
export function sessionCookieName(isProduction: boolean): string {
  return isProduction ? '__Host-openhall_session' : 'openhall_session_dev';
}

export function loginBindingCookieName(isProduction: boolean): string {
  return isProduction ? '__Host-openhall_login' : 'openhall_login_dev';
}

const SESSION_PATH = '/';
const LOGIN_BINDING_PATH = '/api/v1/auth/oidc';

export function setSessionCookie(
  reply: FastifyReply,
  isProduction: boolean,
  token: string,
  maxAgeSeconds: number,
): void {
  void reply.setCookie(sessionCookieName(isProduction), token, {
    path: SESSION_PATH,
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    maxAge: maxAgeSeconds,
  });
}

export function setLoginBindingCookie(
  reply: FastifyReply,
  isProduction: boolean,
  token: string,
): void {
  // Short-lived binding: fifteen minutes covers the provider round trip.
  void reply.setCookie(loginBindingCookieName(isProduction), token, {
    path: LOGIN_BINDING_PATH,
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    maxAge: 15 * 60,
  });
}

export function clearSessionCookie(reply: FastifyReply, isProduction: boolean): void {
  void reply.clearCookie(sessionCookieName(isProduction), { path: SESSION_PATH });
}

/** Decodes a base64url cookie token, or undefined when malformed. */
export function decodeCookieToken(value: string | undefined): Uint8Array | undefined {
  if (value === undefined || value.length === 0 || value.length > 256) {
    return undefined;
  }
  try {
    return fromBase64Url(value);
  } catch {
    return undefined;
  }
}

export function sessionTokenFrom(request: FastifyRequest, isProduction: boolean): string | undefined {
  return request.cookies?.[sessionCookieName(isProduction)];
}

export function bindingTokenFrom(request: FastifyRequest, isProduction: boolean): string | undefined {
  return request.cookies?.[loginBindingCookieName(isProduction)];
}
