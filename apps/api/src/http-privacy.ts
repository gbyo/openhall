/**
 * Query-safe HTTP privacy helpers.
 *
 * OIDC callbacks carry authorization codes, state values, and provider errors
 * in the query string (for example
 * `/api/v1/auth/oidc/callback?code=...&state=...`). Raw URLs must therefore
 * never reach logs or Problem Details responses. These helpers are applied
 * globally in the Fastify composition root, not per route.
 */

/** Returns only the pathname portion of an origin-form request URL. */
export function safeRequestPath(url: string | undefined): string {
  if (url === undefined || url.length === 0) {
    return '/';
  }
  let end = url.length;
  const queryIndex = url.indexOf('?');
  if (queryIndex !== -1) {
    end = Math.min(end, queryIndex);
  }
  const hashIndex = url.indexOf('#');
  if (hashIndex !== -1) {
    end = Math.min(end, hashIndex);
  }
  const path = url.slice(0, end);
  return path.length > 0 ? path : '/';
}

/**
 * Best-effort scrubber used before emitting free-form values to logs.
 * Prefer structured, allowlisted logging at call sites; this is a backstop
 * for `key=value` fragments carrying protocol secrets.
 */
export function scrubForLog(value: string): string {
  return value.replace(
    /((?:code|state|nonce|id_token|access_token|refresh_token|csrf[_-]?token|session[_-]?token|client_secret|bootstrap[_-]?token|recovery[_-]?token)\s*[:=]\s*)([^\s&;"']+)/gi,
    '$1[REDACTED]',
  );
}
