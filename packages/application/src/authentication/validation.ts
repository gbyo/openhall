import { AuthenticationError } from './errors.js';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 63;

/** Lowercase slug validation shared by tenant slugs and provider keys. */
export function assertValidSlug(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_SLUG_LENGTH ||
    !SLUG_PATTERN.test(normalized)
  ) {
    throw new AuthenticationError(
      'auth_transaction_invalid',
      `Invalid ${field}: must be a lowercase slug`,
    );
  }
  return normalized;
}

/**
 * Allows only an internal path. Anything else falls back to '/'
 * so login can never become an open redirect.
 */
export function normalizeReturnPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    return '/';
  }
  if (!value.startsWith('/') || value.startsWith('//')) {
    return '/';
  }
  // eslint-disable-next-line no-control-regex
  if (/[\\\s\x00-\x1f\x7f]/.test(value)) {
    return '/';
  }
  return value;
}

export interface IssuerShape {
  readonly issuer: string;
  readonly insecureHttp: boolean;
}

/**
 * Static issuer shape checks: absolute URL, no credentials, no query or
 * fragment. HTTPS is required in production; plain HTTP is accepted only for
 * explicitly local development/test hostnames.
 */
export function assertIssuerShape(
  rawIssuer: string,
  options: { readonly allowInsecureHttp: boolean },
): IssuerShape {
  let parsed: URL;
  try {
    parsed = new URL(rawIssuer);
  } catch {
    throw new AuthenticationError('provider_configuration_unsupported', 'Issuer must be a URL');
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new AuthenticationError(
      'provider_configuration_unsupported',
      'Issuer must not embed credentials',
    );
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new AuthenticationError(
      'provider_configuration_unsupported',
      'Issuer must not carry a query or fragment',
    );
  }
  if (parsed.protocol === 'https:') {
    return { issuer: parsed.toString().replace(/\/$/, ''), insecureHttp: false };
  }
  if (
    parsed.protocol === 'http:' &&
    options.allowInsecureHttp &&
    isLocalHostname(parsed.hostname)
  ) {
    return { issuer: parsed.toString().replace(/\/$/, ''), insecureHttp: true };
  }
  throw new AuthenticationError(
    'provider_configuration_unsupported',
    'Issuer must use HTTPS outside explicitly local development providers',
  );
}

/** Loopback and explicitly local/test hostnames. */
export function isLocalHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === 'localhost' ||
    lower === '127.0.0.1' ||
    lower === '::1' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.test') ||
    lower.startsWith('127.') ||
    lower.startsWith('10.') ||
    lower.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(lower)
  );
}

const TOKEN_AUTH_METHODS = ['client_secret_post', 'client_secret_basic'] as const;
export type TokenEndpointAuthMethod = (typeof TOKEN_AUTH_METHODS)[number];

export function assertTokenAuthMethod(value: string): TokenEndpointAuthMethod {
  if ((TOKEN_AUTH_METHODS as readonly string[]).includes(value)) {
    return value as TokenEndpointAuthMethod;
  }
  throw new AuthenticationError(
    'provider_configuration_unsupported',
    'Unsupported token endpoint authentication method',
  );
}

/** Phase 3 needs openid and no refresh tokens, so offline_access is refused. */
export function assertOidcScopes(scopes: readonly string[]): readonly string[] {
  if (!scopes.includes('openid')) {
    throw new AuthenticationError(
      'provider_configuration_unsupported',
      'OIDC scopes must include openid',
    );
  }
  if (scopes.includes('offline_access')) {
    throw new AuthenticationError(
      'provider_configuration_unsupported',
      'Refresh tokens are not used in this phase',
    );
  }
  return scopes;
}

/**
 * Google Workspace is a configuration preset only: it prefills the Google
 * issuer and sensible scopes but flows through the exact generic OIDC
 * adapter and canonical issuer+subject identity model.
 */
export const GOOGLE_WORKSPACE_PRESET = {
  issuer: 'https://accounts.google.com',
  scopes: ['openid', 'email', 'profile'],
} as const;

/**
 * Server-owned canonical Google Workspace provider values. The browser
 * submits only genuine user input (client ID + secret); everything here is
 * derived/enforced server-side so the frontend can never smuggle alternate
 * issuers, scopes, keys, or auth methods through the Google choice.
 */
export const CANONICAL_GOOGLE_PROVIDER = {
  key: 'workspace',
  displayName: 'Google Workspace',
  issuer: 'https://accounts.google.com',
  scopes: ['openid', 'email', 'profile'],
  tokenEndpointAuthMethod: 'client_secret_post',
} as const;

/**
 * Authoritative IANA time-zone check shared by server-side bootstrap and
 * provider-setup validation. Never trust browser validation alone.
 */
export function assertValidTimeZone(value: string, field = 'school time zone'): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 100) {
    throw new AuthenticationError('invalid_bootstrap_draft', `Invalid ${field}`);
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
  } catch {
    throw new AuthenticationError('invalid_bootstrap_draft', `Invalid ${field}`);
  }
  return trimmed;
}

/** Deterministic slug derivation shared by client defaults and server enforcement. */
export function deriveSlug(name: string): string | undefined {
  const slug = name
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  if (slug.length === 0 || !SLUG_PATTERN.test(slug)) return undefined;
  return slug;
}

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Base64url without padding for cookies, state, and token material.
 * Implemented manually so the application package stays free of Node APIs.
 */
export function toBase64Url(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = index + 1 < bytes.length ? (bytes[index + 1] ?? 0) : 0;
    const third = index + 2 < bytes.length ? (bytes[index + 2] ?? 0) : 0;
    const group = (first << 16) | (second << 8) | third;
    output += BASE64URL_ALPHABET.charAt((group >> 18) & 63);
    output += BASE64URL_ALPHABET.charAt((group >> 12) & 63);
    if (index + 1 < bytes.length) {
      output += BASE64URL_ALPHABET.charAt((group >> 6) & 63);
    }
    if (index + 2 < bytes.length) {
      output += BASE64URL_ALPHABET.charAt(group & 63);
    }
  }
  return output;
}

function base64UrlValue(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 45) return 62;
  if (code === 95) return 63;
  return -1;
}

export function fromBase64Url(value: string): Uint8Array {
  if (value.length === 0 || value.length % 4 === 1) {
    throw new AuthenticationError('auth_transaction_invalid', 'Malformed credential encoding');
  }
  const bytes: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (let index = 0; index < value.length; index += 1) {
    const sextet = base64UrlValue(value.charCodeAt(index));
    if (sextet < 0) {
      throw new AuthenticationError('auth_transaction_invalid', 'Malformed credential encoding');
    }
    accumulator = (accumulator << 6) | sextet;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 255);
    }
  }
  return new Uint8Array(bytes);
}
