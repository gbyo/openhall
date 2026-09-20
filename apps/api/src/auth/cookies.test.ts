import { describe, expect, it } from 'vitest';
import {
  clearSessionCookie,
  loginBindingCookieName,
  sessionCookieName,
  setLoginBindingCookie,
  setSessionCookie,
} from './cookies.js';

describe('session cookie names', () => {
  it('uses __Host- names in production and separate dev names otherwise', () => {
    expect(sessionCookieName(true)).toBe('__Host-openhall_session');
    expect(sessionCookieName(false)).toBe('openhall_session_dev');
    expect(loginBindingCookieName(true)).toBe('__Host-openhall_login');
    expect(loginBindingCookieName(false)).toBe('openhall_login_dev');
  });
});

describe('cookie attributes', () => {
  it('sets Secure only in production, always HttpOnly + Lax', () => {
    const seen: { name: string; value: string; options: Record<string, unknown> }[] = [];
    const reply = {
      setCookie: (name: string, value: string, options: Record<string, unknown>) => {
        seen.push({ name, value, options });
      },
      clearCookie: () => undefined,
    };
    setSessionCookie(reply as never, true, 'token', 3600);
    expect(seen[0]).toMatchObject({
      name: '__Host-openhall_session',
      options: { path: '/', httpOnly: true, sameSite: 'lax', secure: true, maxAge: 3600 },
    });
    setSessionCookie(reply as never, false, 'token', 3600);
    expect(seen[1]).toMatchObject({
      name: 'openhall_session_dev',
      options: { path: '/', httpOnly: true, sameSite: 'lax', secure: false },
    });
    setLoginBindingCookie(reply as never, false, 'binding');
    expect(seen[2]).toMatchObject({
      name: 'openhall_login_dev',
      options: { path: '/api/v1/auth/oidc', httpOnly: true, sameSite: 'lax' },
    });
    clearSessionCookie(reply as never, true);
  });
});
