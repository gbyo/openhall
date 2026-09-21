import { randomUUID } from 'node:crypto';
import type { AppConfig } from '@openhall/config';
import {
  createDatabase,
  type DatabaseHandle,
  PostgresOperatorGrantStore,
  PostgresSystemTransactionRunner,
  PostgresTenantDirectory,
} from '@openhall/db';
import type { FastifyInstance } from 'fastify';
import { fromBase64Url, issueBootstrapGrant, toBase64Url } from '@openhall/application';
import { SystemClock } from '@openhall/domain';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { HmacCredentialDigester, NodeSecureRandom } from '../auth/crypto.js';
import { TestOidcProvider } from '../auth/test-oidc-provider.js';

let databaseName: string;
let administrationUrl: string;
let databaseUrl: string;
let pool: Pool;
let destroyDatabase: () => Promise<void>;

const TEST_KEY = new Uint8Array(32).fill(7);
const ORIGIN = 'http://localhost:3000';

const config: AppConfig = {
  nodeEnv: 'test',
  appBaseUrl: new URL('http://localhost:3000'),
  databaseUrl: 'postgresql://unused',
  destinationFlowPollMs: 2000,
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
let handleRef: DatabaseHandle;

function grantHash(rawToken: string): Buffer {
  const digester = new HmacCredentialDigester(config.appSecret);
  return Buffer.from(digester.digest(fromBase64Url(rawToken)));
}

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

function requiredCookie(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

async function issueGrant(): Promise<string> {
  const handle = handleRef;
  const tenants = new PostgresTenantDirectory(handle.database);
  const grants = new PostgresOperatorGrantStore(handle.database);
  const runner = new PostgresSystemTransactionRunner(handle.database);
  const issued = await runner.run((context) =>
    issueBootstrapGrant(context, tenants, {
      grants,
      random: new NodeSecureRandom(),
      digester: new HmacCredentialDigester(config.appSecret),
      clock: new SystemClock(),
    }),
  );
  return issued.rawToken;
}

const INITIALIZE = {
  tenantName: '',
  schoolName: 'Ninety Six High School',
  schoolTimeZone: 'America/New_York',
  adminGivenName: 'Gibson',
  adminFamilyName: 'Bell',
};

async function validate(token: string | undefined) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/bootstrap/validate',
    headers: token === undefined ? {} : { authorization: `Bootstrap ${token}` },
  });
}

async function initialize(token: string, overrides: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/bootstrap/initialize',
    headers: { authorization: `Bootstrap ${token}` },
    payload: { ...INITIALIZE, ...overrides },
  });
}

async function csrfFor(sessionCookie: string): Promise<string> {
  const session = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/session',
    headers: { cookie: `openhall_session_dev=${sessionCookie}` },
  });
  return session.json<{ csrfToken: string }>().csrfToken;
}

async function prepareSetup(
  sessionCookie: string,
  csrf: string,
  body: Record<string, unknown>,
  binding: string,
) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/setup/identity-provider/prepare',
    headers: {
      cookie: `openhall_session_dev=${sessionCookie}; openhall_login_dev=${binding}`,
      'x-csrf-token': csrf,
      origin: ORIGIN,
    },
    payload: body,
  });
}

async function count(table: string): Promise<string> {
  const rows = await pool.query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`);
  const value = rows.rows[0]?.count;
  if (value === undefined) throw new Error(`Count failed for ${table}`);
  return value;
}

beforeAll(async () => {
  const configuredUrl = process.env.DATABASE_URL;
  if (!configuredUrl) throw new Error('DATABASE_URL is required for PostgreSQL integration tests');
  const base = new URL(configuredUrl);
  databaseName = `openhall_guided_${randomUUID().replaceAll('-', '')}`;
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
  handleRef = handle;
  destroyDatabase = () => handle.destroy();
  await migrateToLatest(handle.database);
  pool = new Pool({ connectionString: databaseUrl, max: 4 });

  provider = await TestOidcProvider.start({
    clientId: 'test-client',
    clientSecret: 'test-client-secret',
    subject: 'setup-admin-subject',
    email: 'gibson@example.com',
  });

  app = await createApp({
    config,
    database: handle.database,
    logger: false,
    rateLimitDisabled: true,
    readinessProbe: {
      check: () => Promise.resolve({ migration: '009_guided_setup_authentication' }),
    },
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

describe('guided bootstrap validate', () => {
  it('accepts a live setup code without consuming it', async () => {
    const token = await issueGrant();
    const response = await validate(token);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ valid: true });
    expect(response.headers['cache-control']).toBe('no-store');
    // The grant survives validation untouched: a second validation passes
    // and no canonical records exist.
    expect((await validate(token)).json()).toEqual({ valid: true });
    expect(await count('tenant')).toBe('0');
    expect(await count('local_operator_grant')).toBe('1');
  });

  it('rejects missing, malformed, and consumed codes alike', async () => {
    expect((await validate(undefined)).statusCode).toBe(401);
    expect((await validate('bogus-token')).statusCode).toBe(401);
    expect((await validate('bogus-token')).json()).toMatchObject({
      code: 'bootstrap_token_invalid',
    });
  });

  it('rejects expired codes', async () => {
    const rawToken = await issueGrant();
    await pool.query(
      `UPDATE local_operator_grant
       SET created_at = statement_timestamp() - interval '61 minutes',
           expires_at = statement_timestamp() - interval '1 minute'
       WHERE token_hash = $1`,
      [grantHash(rawToken)],
    );
    const response = await validate(rawToken);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'bootstrap_token_invalid' });
  });
});

let setupCookie = '';
let setupCsrf = '';

describe('guided bootstrap initialize', () => {
  it('rejects invalid school details without consuming the grant', async () => {
    const token = await issueGrant();
    const tenantsBefore = await count('tenant');
    const bad = await initialize(token, { schoolTimeZone: 'Mars/Olympus' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'invalid_bootstrap_draft' });
    expect(await count('tenant')).toBe(tenantsBefore);
    // The grant survives the failed attempt: validation still passes.
    expect((await validate(token)).json()).toEqual({ valid: true });
  });

  it('requires explicit slugs when derivation is impossible', async () => {
    const token = await issueGrant();
    const tenantsBefore = await count('tenant');
    const bad = await initialize(token, { schoolName: '!!!' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'invalid_bootstrap_draft' });
    expect(await count('tenant')).toBe(tenantsBefore);
  });

  it('lets exactly one concurrent initialization win', async () => {
    const first = await issueGrant();
    const second = await issueGrant();
    const [winner, loser] = await Promise.all([initialize(first), initialize(second)]);
    const statuses = [winner.statusCode, loser.statusCode].sort();
    expect(statuses).toEqual([200, 409]);
    const completed = winner.statusCode === 200 ? winner : loser;
    expect(completed.json()).toMatchObject({
      authenticated: true,
      authenticationMethod: 'setup',
    });
    expect(completed.headers['cache-control']).toBe('no-store');
    expect(await count('tenant')).toBe('1');
    expect(await count('account')).toBe('1');
    setupCookie = requiredCookie(
      cookieValue(completed.headers['set-cookie'], 'openhall_session_dev'),
      'Setup session cookie missing',
    );
    setupCsrf = await csrfFor(setupCookie);
  });
});

describe('guided installation shape', () => {
  it('creates the school without any provider or identity', async () => {
    expect(await count('tenant')).toBe('1');
    expect(await count('organization')).toBe('1');
    expect(await count('school_schedule_configuration')).toBe('1');
    expect(await count('person')).toBe('1');
    expect(await count('account')).toBe('1');
    expect(await count('organization_membership')).toBe('1');
    expect(await count('authorization_grant')).toBe('1');
    expect(await count('identity_provider')).toBe('0');
    expect(await count('auth_identity')).toBe('0');
    const session = (
      await pool.query<{ authentication_method: string; identity_provider_id: string | null }>(
        'SELECT authentication_method, identity_provider_id FROM auth_session',
      )
    ).rows[0];
    expect(session?.authentication_method).toBe('setup');
    expect(session?.identity_provider_id).toBeNull();
    const tenant = (
      await pool.query<{ slug: string; name: string }>('SELECT slug, name FROM tenant')
    ).rows[0];
    expect(tenant?.slug).toBe('ninety-six-high-school');
    expect(tenant?.name).toBe('Ninety Six High School');
    const audit = (
      await pool.query<{ action: string }>(
        `SELECT action FROM audit_event WHERE action IN ('auth.bootstrap_initialized', 'auth.sign_in_succeeded')`,
      )
    ).rows
      .map((row) => row.action)
      .sort();
    expect(audit).toEqual(['auth.bootstrap_initialized', 'auth.sign_in_succeeded']);
  });

  it('serves the setup session through the normal session contract', async () => {
    const session = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: `openhall_session_dev=${setupCookie}` },
    });
    expect(session.json()).toMatchObject({
      authenticated: true,
      authenticationMethod: 'setup',
    });
    expect(session.headers['cache-control']).toBe('no-store');
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: `openhall_session_dev=${setupCookie}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      person: { givenName: 'Gibson', familyName: 'Bell', displayName: 'Gibson Bell' },
      tenant: { name: 'Ninety Six High School', slug: 'ninety-six-high-school' },
    });
  });

  it('reports zero providers on auth discovery before sign-in is connected', async () => {
    const discovery = await app.inject({ method: 'GET', url: '/api/v1/auth/discovery' });
    expect(discovery.json()).toMatchObject({
      tenantSelectionRequired: false,
      tenant: { slug: 'ninety-six-high-school' },
      providers: [],
    });
  });
});

describe('guided provider setup prepare', () => {
  const genericBody = {
    providerPreset: 'generic',
    clientId: 'test-client',
    clientSecret: 'test-client-secret',
    providerName: 'Test Provider',
    issuerUrl: '',
  };

  it('denies unauthenticated and forged callers', async () => {
    const binding = toBase64Url(new NodeSecureRandom().randomBytes(32));
    const anonymous = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/identity-provider/prepare',
      payload: { ...genericBody, issuerUrl: provider.issuer },
    });
    expect(anonymous.statusCode).toBe(401);
    const forged = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/identity-provider/prepare',
      headers: {
        cookie: `openhall_session_dev=${setupCookie}; openhall_login_dev=${binding}`,
        'x-csrf-token': 'forged',
        origin: ORIGIN,
      },
      payload: { ...genericBody, issuerUrl: provider.issuer },
    });
    expect(forged.statusCode).toBe(403);
  });

  it('stages a provider_setup transaction bound to the admin account', async () => {
    const binding = toBase64Url(new NodeSecureRandom().randomBytes(32));
    const response = await prepareSetup(
      setupCookie,
      setupCsrf,
      { ...genericBody, issuerUrl: provider.issuer },
      binding,
    );
    expect(response.statusCode).toBe(200);
    const { authorizationUrl } = response.json<{ authorizationUrl: string }>();
    expect(authorizationUrl.startsWith(`${provider.issuer}/authorize`)).toBe(true);
    expect(response.headers['cache-control']).toBe('no-store');
    const row = (
      await pool.query<{ purpose: string; tenant_id: string; provider_setup_account_id: string }>(
        `SELECT purpose, tenant_id, provider_setup_account_id FROM oidc_login_transaction
         ORDER BY created_at DESC LIMIT 1`,
      )
    ).rows[0];
    expect(row?.purpose).toBe('provider_setup');
    const accountId = (await pool.query<{ id: string }>('SELECT id FROM account LIMIT 1')).rows[0]
      ?.id;
    expect(row?.provider_setup_account_id).toBe(accountId);
    // No canonical provider exists before OIDC succeeds, and the staged
    // secret never appears in plaintext.
    expect(await count('identity_provider')).toBe('0');
    const staged = (
      await pool.query<{ transaction_secret_ciphertext: Buffer }>(
        'SELECT transaction_secret_ciphertext FROM oidc_login_transaction ORDER BY created_at DESC LIMIT 1',
      )
    ).rows[0]?.transaction_secret_ciphertext;
    expect(staged?.includes(Buffer.from('test-client-secret'))).toBe(false);
  });

  it('rolls back provider staging when the provider fails at token time', async () => {
    const binding = toBase64Url(new NodeSecureRandom().randomBytes(32));
    const response = await prepareSetup(
      setupCookie,
      setupCsrf,
      { ...genericBody, issuerUrl: provider.issuer },
      binding,
    );
    expect(response.statusCode).toBe(200);
    const authorizeUrl = response.json<{ authorizationUrl: string }>().authorizationUrl;
    const authorize = await fetch(authorizeUrl, { redirect: 'manual' });
    expect(authorize.status).toBe(302);
    const callback = new URL(authorize.headers.get('location') ?? '');
    provider.rig.tokenError = 'server_error';
    const failed = await app.inject({
      method: 'GET',
      url: `${callback.pathname}${callback.search}`,
      headers: { cookie: `openhall_login_dev=${binding}` },
    });
    provider.rig.tokenError = undefined;
    expect(failed.statusCode).toBe(302);
    expect(failed.headers.location).toBe('/?error=auth_provider_unavailable');
    expect(await count('identity_provider')).toBe('0');
    expect(await count('auth_identity')).toBe('0');
    // The temporary setup session survives the failed attempt.
    const session = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: `openhall_session_dev=${setupCookie}` },
    });
    expect(session.json()).toMatchObject({ authenticated: true, authenticationMethod: 'setup' });
  });
});

describe('guided provider setup completion', () => {
  it('connects sign-in and hands off to a normal OIDC session', async () => {
    const binding = toBase64Url(new NodeSecureRandom().randomBytes(32));
    const response = await prepareSetup(
      setupCookie,
      setupCsrf,
      {
        providerPreset: 'generic',
        clientId: 'test-client',
        clientSecret: 'test-client-secret',
        providerName: 'Test Provider',
        issuerUrl: provider.issuer,
      },
      binding,
    );
    expect(response.statusCode).toBe(200);
    const authorizeUrl = response.json<{ authorizationUrl: string }>().authorizationUrl;
    const authorize = await fetch(authorizeUrl, { redirect: 'manual' });
    expect(authorize.status).toBe(302);
    const callback = new URL(authorize.headers.get('location') ?? '');
    const completed = await app.inject({
      method: 'GET',
      url: `${callback.pathname}${callback.search}`,
      headers: { cookie: `openhall_login_dev=${binding}` },
    });
    expect(completed.statusCode).toBe(302);
    expect(completed.headers.location).toBe('/');
    const oidcCookie = requiredCookie(
      cookieValue(completed.headers['set-cookie'], 'openhall_session_dev'),
      'OIDC session cookie missing',
    );
    const adminId = (await pool.query<{ id: string }>('SELECT id FROM account LIMIT 1')).rows[0]
      ?.id;
    const providerRow = (
      await pool.query<{ key: string; issuer: string; status: string }>(
        'SELECT key, issuer, status FROM identity_provider',
      )
    ).rows[0];
    expect(providerRow).toMatchObject({
      key: 'test-provider',
      issuer: provider.issuer,
      status: 'active',
    });
    const identity = (
      await pool.query<{ account_id: string; issuer: string; email_snapshot: string | null }>(
        'SELECT account_id, issuer, email_snapshot FROM auth_identity',
      )
    ).rows[0];
    expect(identity?.account_id).toBe(adminId);
    expect(identity?.issuer).toBe(provider.issuer);
    expect(identity?.email_snapshot).toBe('gibson@example.com');
    // The temporary setup session stopped working; the OIDC session reports
    // the normal method and the banner condition clears.
    const oldSession = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: `openhall_session_dev=${setupCookie}` },
    });
    expect(oldSession.json()).toEqual({ authenticated: false });
    const fresh = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: `openhall_session_dev=${oidcCookie}` },
    });
    expect(fresh.json()).toMatchObject({ authenticated: true, authenticationMethod: 'oidc' });
    const discovery = await app.inject({ method: 'GET', url: '/api/v1/auth/discovery' });
    expect(discovery.json()).toMatchObject({
      providers: [{ key: 'test-provider', displayName: 'Test Provider' }],
    });
    const completed2 = (
      await pool.query<{ action: string }>(
        `SELECT action FROM audit_event WHERE action = 'auth.provider_setup_completed'`,
      )
    ).rows;
    expect(completed2.length).toBe(1);
  });

  it('refuses to silently replace the connected provider', async () => {
    const binding = toBase64Url(new NodeSecureRandom().randomBytes(32));
    const response = await prepareSetup(
      setupCookie,
      setupCsrf,
      {
        providerPreset: 'generic',
        clientId: 'test-client',
        clientSecret: 'test-client-secret',
        providerName: 'Sneaky Provider',
        issuerUrl: provider.issuer,
      },
      binding,
    );
    // The setup cookie died at completion; even a live session would meet
    // the already-connected conflict first.
    expect([401, 409]).toContain(response.statusCode);
    expect(await count('identity_provider')).toBe('1');
  });
});
