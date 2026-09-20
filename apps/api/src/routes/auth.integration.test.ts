import { randomUUID } from 'node:crypto';
import type { OutgoingHttpHeaders } from 'node:http';
import type { AppConfig } from '@openhall/config';
import { createDatabase } from '@openhall/db';
import type { FastifyInstance } from 'fastify';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { Aes256GcmSecretProtector } from '../auth/crypto.js';
import { TestOidcProvider } from '../auth/test-oidc-provider.js';

let databaseName: string;
let administrationUrl: string;
let databaseUrl: string;
let pool: Pool;
let destroyDatabase: () => Promise<void>;

const TEST_KEY = new Uint8Array(32).fill(7);
const protector = new Aes256GcmSecretProtector(TEST_KEY, 'test-key-1');

const config: AppConfig = {
  nodeEnv: 'test',
  appBaseUrl: new URL('http://localhost:3000'),
  databaseUrl: 'postgresql://unused',
  appSecret: 'test-only-app-secret-32-characters!!',
  dataEncryptionKey: TEST_KEY,
  dataEncryptionKeyId: 'test-key-1',
  trustProxy: false,
  port: 3000,
};

function quotedIdentifier(value: string): string {
  if (!/^[a-z0-9_]+$/.test(value)) throw new Error('Unsafe database identifier');
  return `"${value}"`;
}

let app: FastifyInstance;
let provider: TestOidcProvider;

function required(value: string | undefined, message: string): string {
  if (value === undefined) throw new Error(message);
  return value;
}

function redirectLocation(headers: OutgoingHttpHeaders): string {
  const location = headers.location;
  if (!location) throw new Error('Missing redirect Location header');
  return location;
}
let tenantId = '';
let accountId = '';
let providerId = '';

function cookieValue(setCookie: string | string[] | undefined, name: string): string | undefined {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const header of headers) {
    const [pair] = header.split(';');
    if (pair?.trim().startsWith(`${name}=`)) {
      return pair.trim().slice(name.length + 1);
    }
  }
  return undefined;
}

async function seedIdentity(issuer: string, subject: string, email: string | null): Promise<void> {
  await pool.query(
    'INSERT INTO auth_identity (tenant_id, account_id, issuer, provider_subject, email_snapshot) VALUES ($1, $2, $3, $4, $5)',
    [tenantId, accountId, issuer, subject, email],
  );
}

async function seedProviderRow(issuer: string, key: string): Promise<string> {
  const inserted = (
    await pool.query<{ id: string }>(
      `INSERT INTO identity_provider
        (tenant_id, key, display_name, issuer, client_id, client_secret_ciphertext,
         client_secret_nonce, client_secret_tag, client_secret_key_id,
         token_endpoint_auth_method, scopes)
       VALUES ($1, $2, $3, $4, 'test-client', $5, $6, $7, 'test-key-1', 'client_secret_basic', '{openid,email}')
       RETURNING id`,
      [
        tenantId,
        key,
        `${key} display`,
        issuer,
        Buffer.alloc(16),
        Buffer.alloc(12),
        Buffer.alloc(16),
      ],
    )
  ).rows[0];
  if (!inserted) throw new Error('Provider seed failed');
  const sealed = protector.protect(
    'test-client-secret',
    `provider-secret:v1:${tenantId}:${inserted.id}`,
  );
  await pool.query(
    `UPDATE identity_provider SET client_secret_ciphertext = $1, client_secret_nonce = $2,
      client_secret_tag = $3, client_secret_key_id = $4 WHERE id = $5`,
    [
      Buffer.from(sealed.ciphertext),
      Buffer.from(sealed.nonce),
      Buffer.from(sealed.tag),
      sealed.keyId,
      inserted.id,
    ],
  );
  return inserted.id;
}

interface LoginResult {
  readonly sessionCookie: string;
  readonly location: string | undefined;
}

/** Drives a full browser login: start → provider → callback. */
async function login(returnPath = '/dashboard'): Promise<LoginResult> {
  const start = await app.inject({
    method: 'GET',
    url: `/api/v1/auth/oidc/greenwood/workspace/start?return_path=${encodeURIComponent(returnPath)}`,
  });
  expect(start.statusCode).toBe(302);
  const authorizeUrl = start.headers.location;
  if (!authorizeUrl) throw new Error('Missing authorize redirect');
  const binding = cookieValue(start.headers['set-cookie'], 'openhall_login_dev');
  if (!binding) throw new Error('Missing binding cookie');
  const authorize = await fetch(authorizeUrl, { redirect: 'manual' });
  expect(authorize.status).toBe(302);
  const callbackUrl = authorize.headers.get('location');
  if (!callbackUrl) throw new Error('Missing callback redirect');
  const callback = new URL(callbackUrl);
  const callbackResponse = await app.inject({
    method: 'GET',
    url: `${callback.pathname}${callback.search}`,
    headers: { cookie: `openhall_login_dev=${binding}` },
  });
  const sessionCookie = cookieValue(callbackResponse.headers['set-cookie'], 'openhall_session_dev');
  if (!sessionCookie) {
    throw new Error(
      `Login failed: ${String(callbackResponse.headers.location)} ${callbackResponse.body}`,
    );
  }
  return { sessionCookie, location: callbackResponse.headers.location };
}

async function csrfFor(sessionCookie: string): Promise<string> {
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/session',
    headers: { cookie: `openhall_session_dev=${sessionCookie}` },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json<{ authenticated: boolean; csrfToken?: string }>();
  if (!body.authenticated || !body.csrfToken) throw new Error('Session not authenticated');
  return body.csrfToken;
}

const ORIGIN = 'http://localhost:3000';

beforeAll(async () => {
  const configuredUrl = process.env.DATABASE_URL;
  if (!configuredUrl) throw new Error('DATABASE_URL is required for PostgreSQL integration tests');
  const base = new URL(configuredUrl);
  databaseName = `openhall_test_${randomUUID().replaceAll('-', '')}`;
  const administration = new URL(base);
  administration.pathname = '/postgres';
  administrationUrl = administration.toString();
  const client = new Client({ connectionString: administrationUrl });
  await client.connect();
  await client.query(`CREATE DATABASE ${quotedIdentifier(databaseName)}`);
  await client.end();

  const target = new URL(base);
  target.pathname = `/${databaseName}`;
  databaseUrl = target.toString();
  const { migrateToLatest } = await import('@openhall/db');
  const handle = createDatabase(databaseUrl, { max: 4 });
  destroyDatabase = () => handle.destroy();
  await migrateToLatest(handle.database);
  pool = new Pool({ connectionString: databaseUrl, max: 4 });

  provider = await TestOidcProvider.start({
    clientId: 'test-client',
    clientSecret: 'test-client-secret',
    subject: 'subject-1',
    email: 'ada@example.com',
  });

  tenantId = required(
    (
      await pool.query<{ id: string }>(
        "INSERT INTO tenant (name, slug) VALUES ('Greenwood', 'greenwood') RETURNING id",
      )
    ).rows[0]?.id,
    'Tenant fixture failed',
  );
  const person = required(
    (
      await pool.query<{ id: string }>(
        "INSERT INTO person (tenant_id, given_name, family_name, display_name) VALUES ($1, 'Ada', 'Admin', 'Ada Admin') RETURNING id",
        [tenantId],
      )
    ).rows[0]?.id,
    'Person fixture failed',
  );
  accountId = required(
    (
      await pool.query<{ id: string }>(
        'INSERT INTO account (tenant_id, person_id) VALUES ($1, $2) RETURNING id',
        [tenantId, person],
      )
    ).rows[0]?.id,
    'Account fixture failed',
  );
  providerId = await seedProviderRow(provider.issuer, 'workspace');
  await seedIdentity(provider.issuer, 'subject-1', 'ada@example.com');

  app = await createApp({
    config,
    database: handle.database,
    logger: false,
    readinessProbe: { check: () => Promise.resolve({ migration: '003_identity_secure_sessions' }) },
  });
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await destroyDatabase();
  await provider.close();
  const client = new Client({ connectionString: administrationUrl });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS ${quotedIdentifier(databaseName)} WITH (FORCE)`);
  await client.end();
});

describe('auth discovery and session', () => {
  it('discovers the single tenant without enumerating slugs', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/discovery' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      tenantSelectionRequired: false,
      tenant: { id: tenantId, name: 'Greenwood', slug: 'greenwood' },
      providers: [{ key: 'workspace', displayName: 'workspace display' }],
    });
    expect(response.body).not.toContain('client-1');
    expect(response.body).not.toContain('test-client-secret');
  });

  it('returns anonymous session state without cookies', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/session' });
    expect(response.json()).toEqual({ authenticated: false });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('rejects /me without a session and omits internal fields', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ code: 'unauthenticated' });
    const { sessionCookie } = await login();
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: `openhall_session_dev=${sessionCookie}` },
    });
    expect(me.statusCode).toBe(200);
    const personMatcher: unknown = expect.objectContaining({
      givenName: 'Ada',
      familyName: 'Admin',
    });
    expect(me.json()).toEqual({
      person: personMatcher,
      tenant: { id: tenantId, name: 'Greenwood', slug: 'greenwood' },
    });
    for (const forbidden of [
      'session_revision',
      'sessionRevision',
      'authorization_grant',
      'client_secret',
      'roles',
    ]) {
      expect(me.body).not.toContain(forbidden);
    }
    expect(me.headers['cache-control']).toBe('no-store');
  });
});

describe('OIDC login flow', () => {
  it('completes Authorization Code + PKCE with safe redirects', async () => {
    const start = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/oidc/greenwood/workspace/start?return_path=/dashboard',
    });
    expect(start.statusCode).toBe(302);
    const location = start.headers.location ?? '';
    expect(location.startsWith(`${provider.issuer}/authorize`)).toBe(true);
    expect(location).toContain('code_challenge_method=S256');
    expect(location).toContain('state=');
    expect(location).toContain('nonce=');
    const { location: callbackLocation } = await login();
    expect(callbackLocation).toBe('/dashboard');
  });

  it('falls back to / for hostile return paths', async () => {
    const { location } = await login('https://evil.example/phish');
    expect(location).toBe('/');
    const { location: second } = await login('//evil.example');
    expect(second).toBe('/');
  });

  it('does not persist provider tokens or raw credentials', async () => {
    await login();
    const accessToken = provider.lastAccessToken;
    const idToken = provider.lastIdToken;
    expect(accessToken.length).toBeGreaterThan(0);
    const tables = ['auth_session', 'audit_event', 'oidc_login_transaction', 'auth_identity'];
    for (const table of tables) {
      const text = await pool.query(`SELECT row_to_json(t) AS row FROM ${table} t`);
      const dump = JSON.stringify(text.rows);
      expect(dump).not.toContain(accessToken);
      expect(dump).not.toContain(idToken);
      expect(dump).not.toContain('test-client-secret');
    }
    const sessions = await pool.query<{ token_hash: Buffer; csrf_token_hash: Buffer }>(
      'SELECT token_hash, csrf_token_hash FROM auth_session',
    );
    for (const row of sessions.rows) {
      expect(row.token_hash.length).toBe(32);
    }
  });

  it('rejects tampered state and missing browser binding', async () => {
    const start = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/oidc/greenwood/workspace/start',
    });
    const binding = cookieValue(start.headers['set-cookie'], 'openhall_login_dev') ?? '';
    const authorize = await fetch(redirectLocation(start.headers), { redirect: 'manual' });
    const callback = new URL(authorize.headers.get('location') ?? '');
    const code = callback.searchParams.get('code');
    if (code === null) throw new Error('Provider callback missing code');
    const tampered = await app.inject({
      method: 'GET',
      url: `${callback.pathname}?code=${code}&state=tampered`,
      headers: { cookie: `openhall_login_dev=${binding}` },
    });
    expect(tampered.headers.location).toBe('/?error=auth_transaction_invalid');
    const noBinding = await app.inject({
      method: 'GET',
      url: `${callback.pathname}${callback.search}`,
    });
    expect(noBinding.headers.location).toBe('/?error=auth_transaction_invalid');
  });

  it('rejects nonce mismatch, expired, malformed, and unknown-key tokens', async () => {
    provider.rig.wrongNonce = true;
    const nonceFail = await login().catch((error: unknown) => error);
    expect(nonceFail).toBeInstanceOf(Error);
    provider.rig.expired = true;
    await expect(login()).rejects.toThrow();
    provider.rig.malformedIdToken = true;
    await expect(login()).rejects.toThrow();
    provider.rig.unknownKid = true;
    await expect(login()).rejects.toThrow();
  });

  it('rejects callback replay, including concurrent double submission', async () => {
    const start = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/oidc/greenwood/workspace/start',
    });
    const binding = cookieValue(start.headers['set-cookie'], 'openhall_login_dev') ?? '';
    const authorize = await fetch(redirectLocation(start.headers), { redirect: 'manual' });
    const callback = new URL(authorize.headers.get('location') ?? '');
    const path = `${callback.pathname}${callback.search}`;
    const headers = { cookie: `openhall_login_dev=${binding}` };
    const [first, second] = await Promise.all([
      app.inject({ method: 'GET', url: path, headers }),
      app.inject({ method: 'GET', url: path, headers }),
    ]);
    const locations = [first.headers.location, second.headers.location].sort();
    expect(locations[0]).toBe('/');
    expect(locations[1]).toBe('/?error=auth_transaction_invalid');
    const replay = await app.inject({ method: 'GET', url: path, headers });
    expect(replay.headers.location).toBe('/?error=auth_transaction_invalid');
  });

  it('rejects issuer mismatch, revision drift, and disabled providers', async () => {
    provider.rig.issuerOverride = 'https://evil.example';
    await expect(login()).rejects.toThrow();
    // Revision drift between start and callback: the transaction recorded
    // revision N, but the provider is now at N+1.
    const drifted = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/oidc/greenwood/workspace/start',
    });
    expect(drifted.statusCode).toBe(302);
    const driftBinding = cookieValue(drifted.headers['set-cookie'], 'openhall_login_dev') ?? '';
    const driftAuthorize = await fetch(redirectLocation(drifted.headers), { redirect: 'manual' });
    const driftCallback = new URL(driftAuthorize.headers.get('location') ?? '');
    await pool.query('UPDATE identity_provider SET revision = revision + 1 WHERE id = $1', [
      providerId,
    ]);
    const driftResponse = await app.inject({
      method: 'GET',
      url: `${driftCallback.pathname}${driftCallback.search}`,
      headers: { cookie: `openhall_login_dev=${driftBinding}` },
    });
    expect(driftResponse.headers.location).toBe('/?error=auth_provider_unavailable');
    await pool.query('UPDATE identity_provider SET revision = revision - 1 WHERE id = $1', [
      providerId,
    ]);
    await pool.query("UPDATE identity_provider SET status = 'disabled' WHERE id = $1", [
      providerId,
    ]);
    const start = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/oidc/greenwood/workspace/start',
    });
    expect(start.statusCode).toBe(502);
    await pool.query("UPDATE identity_provider SET status = 'active' WHERE id = $1", [providerId]);
  });

  it('refuses unknown identities without creating accounts', async () => {
    const before = await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM account WHERE tenant_id = $1',
      [tenantId],
    );
    provider.rig.subjectOverride = 'stranger-subject';
    const start = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/oidc/greenwood/workspace/start',
    });
    const binding = cookieValue(start.headers['set-cookie'], 'openhall_login_dev') ?? '';
    const authorize = await fetch(redirectLocation(start.headers), { redirect: 'manual' });
    const callback = new URL(authorize.headers.get('location') ?? '');
    const response = await app.inject({
      method: 'GET',
      url: `${callback.pathname}${callback.search}`,
      headers: { cookie: `openhall_login_dev=${binding}` },
    });
    expect(response.headers.location).toBe('/?error=identity_not_linked');
    expect(response.body).not.toContain('stranger');
    const after = await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM account WHERE tenant_id = $1',
      [tenantId],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it('keeps identity stable across email changes', async () => {
    provider.email = 'ada.new@example.com';
    const { sessionCookie } = await login();
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: `openhall_session_dev=${sessionCookie}` },
    });
    expect(me.statusCode).toBe(200);
    const snapshot = await pool.query<{ email_snapshot: string }>(
      'SELECT email_snapshot FROM auth_identity WHERE tenant_id = $1 AND provider_subject = $2',
      [tenantId, 'subject-1'],
    );
    expect(snapshot.rows[0]?.email_snapshot).toBe('ada.new@example.com');
    provider.email = 'ada@example.com';
  });
});

describe('sessions, CSRF, and logout', () => {
  it('rotates the CSRF token on every session read', async () => {
    const { sessionCookie } = await login();
    const first = await csrfFor(sessionCookie);
    const second = await csrfFor(sessionCookie);
    expect(first).not.toBe(second);
  });

  it('enforces CSRF, origin, and cross-session binding on logout', async () => {
    const { sessionCookie } = await login();
    const csrf = await csrfFor(sessionCookie);
    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: `openhall_session_dev=${sessionCookie}`, origin: ORIGIN },
    });
    expect(missing.statusCode).toBe(403);
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        cookie: `openhall_session_dev=${sessionCookie}`,
        'x-csrf-token': 'bogus',
        origin: ORIGIN,
      },
    });
    expect(wrong.statusCode).toBe(403);
    const badOrigin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        cookie: `openhall_session_dev=${sessionCookie}`,
        'x-csrf-token': csrf,
        origin: 'https://evil.example',
      },
    });
    expect(badOrigin.statusCode).toBe(403);
    const { sessionCookie: otherCookie } = await login();
    const otherCsrf = await csrfFor(otherCookie);
    const crossSession = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        cookie: `openhall_session_dev=${sessionCookie}`,
        'x-csrf-token': otherCsrf,
        origin: ORIGIN,
      },
    });
    expect(crossSession.statusCode).toBe(403);
    const refererFallback = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        cookie: `openhall_session_dev=${sessionCookie}`,
        'x-csrf-token': await csrfFor(sessionCookie),
        referer: `${ORIGIN}/dashboard`,
      },
    });
    expect(refererFallback.statusCode).toBe(200);
  });

  it('logs out and rejects the old cookie afterwards', async () => {
    const { sessionCookie } = await login();
    const csrf = await csrfFor(sessionCookie);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        cookie: `openhall_session_dev=${sessionCookie}`,
        'x-csrf-token': csrf,
        origin: ORIGIN,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    const cleared = cookieValue(response.headers['set-cookie'], 'openhall_session_dev');
    expect(cleared).toBe('');
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: `openhall_session_dev=${sessionCookie}` },
    });
    expect(me.statusCode).toBe(401);
  });

  it('invalidates every device on logout-all, then allows fresh login', async () => {
    const first = await login();
    const second = await login();
    const csrf = await csrfFor(first.sessionCookie);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout-all',
      headers: {
        cookie: `openhall_session_dev=${first.sessionCookie}`,
        'x-csrf-token': csrf,
        origin: ORIGIN,
      },
    });
    expect(response.statusCode).toBe(200);
    for (const stale of [first.sessionCookie, second.sessionCookie]) {
      const me = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { cookie: `openhall_session_dev=${stale}` },
      });
      expect(me.statusCode).toBe(401);
    }
    const fresh = await login();
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: `openhall_session_dev=${fresh.sessionCookie}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it('replaces a prior browser session on fresh login (fixation resistance)', async () => {
    const { sessionCookie: prior } = await login();
    const start = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/oidc/greenwood/workspace/start',
    });
    const binding = cookieValue(start.headers['set-cookie'], 'openhall_login_dev') ?? '';
    const authorize = await fetch(redirectLocation(start.headers), { redirect: 'manual' });
    const callback = new URL(authorize.headers.get('location') ?? '');
    const response = await app.inject({
      method: 'GET',
      url: `${callback.pathname}${callback.search}`,
      headers: { cookie: `openhall_login_dev=${binding}; openhall_session_dev=${prior}` },
    });
    const next = cookieValue(response.headers['set-cookie'], 'openhall_session_dev');
    expect(next).toBeDefined();
    expect(next).not.toBe(prior);
    const stale = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: `openhall_session_dev=${prior}` },
    });
    expect(stale.statusCode).toBe(401);
  });
});

describe('HTTP hardening', () => {
  it('sets development cookie behavior, security headers, and no-store', async () => {
    const start = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/oidc/greenwood/workspace/start',
    });
    expect(start.statusCode).toBe(302);
    const binding = cookieValue(start.headers['set-cookie'], 'openhall_login_dev') ?? '';
    const authorize = await fetch(redirectLocation(start.headers), { redirect: 'manual' });
    const callback = new URL(authorize.headers.get('location') ?? '');
    const callbackResponse = await app.inject({
      method: 'GET',
      url: `${callback.pathname}${callback.search}`,
      headers: { cookie: `openhall_login_dev=${binding}` },
    });
    const setCookies = callbackResponse.headers['set-cookie'];
    const serialized = JSON.stringify(setCookies);
    // Development cookie name (never __Host- on plain HTTP), HttpOnly,
    // SameSite=Lax, no Secure flag, no Domain attribute.
    expect(serialized).toContain('openhall_session_dev=');
    expect(serialized).not.toContain('__Host-');
    expect(serialized).toContain('HttpOnly');
    expect(serialized).toContain('SameSite=Lax');
    expect(serialized).not.toContain('Secure');
    expect(serialized).not.toContain('Domain=');
    const sessionCookie = cookieValue(setCookies, 'openhall_session_dev') ?? '';
    const session = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: `openhall_session_dev=${sessionCookie}` },
    });
    expect(session.statusCode).toBe(200);
    expect(session.headers['content-security-policy']).toContain("default-src 'self'");
    expect(session.headers['referrer-policy']).toBe('no-referrer');
    expect(session.headers['strict-transport-security']).toBeUndefined();
    expect(session.headers['cache-control']).toBe('no-store');
    expect(session.headers['x-content-type-options']).toBe('nosniff');
  });

  it('uses generic unauthenticated responses without state details', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: 'openhall_session_dev=bogus' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'unauthenticated' });
    expect(response.body).not.toContain('revoked');
    expect(response.body).not.toContain('expired');
  });
});
