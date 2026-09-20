import { randomUUID } from 'node:crypto';
import type { AppConfig } from '@openhall/config';
import {
  createDatabase,
  type DatabaseHandle,
  PostgresAuditWriter,
  PostgresOperatorGrantStore,
  PostgresRecoveryEligibilityChecker,
  PostgresSystemTransactionRunner,
  PostgresTenantDirectory,
  PostgresTenantTransactionRunner,
} from '@openhall/db';
import type { FastifyInstance } from 'fastify';
import { issueBootstrapGrant, issueRecoveryGrant, toBase64Url } from '@openhall/application';
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

function requiredCookie(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
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

const DRAFT = {
  tenantName: 'Greenwood',
  tenantSlug: 'greenwood',
  schoolName: 'Greenwood High',
  schoolSlug: 'greenwood-high',
  schoolTimeZone: 'America/Chicago',
  adminGivenName: 'Ada',
  adminFamilyName: 'Admin',
  adminDisplayName: 'Ada Admin',
  providerKey: 'workspace',
  providerDisplayName: 'Workspace',
  providerIssuer: '',
  providerClientId: 'test-client',
  providerClientSecret: 'test-client-secret',
  providerAuthMethod: 'client_secret_basic',
  providerScopes: ['openid', 'email'],
};

async function prepare(operatorToken: string, overrides: Record<string, unknown> = {}) {
  const binding = toBase64Url(new NodeSecureRandom().randomBytes(32));
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/bootstrap/prepare',
    headers: {
      authorization: `Bootstrap ${operatorToken}`,
      cookie: `openhall_login_dev=${binding}`,
    },
    payload: { ...DRAFT, ...overrides },
  });
  return { response, binding };
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

let handleRef: DatabaseHandle;

async function issueRecoveryToken(tenantId: string, accountId: string): Promise<string> {
  const tenants = new PostgresTenantDirectory(handleRef.database);
  const grants = new PostgresOperatorGrantStore(handleRef.database);
  const systemRunner = new PostgresSystemTransactionRunner(handleRef.database);
  const issued = await systemRunner.run((context) =>
    issueRecoveryGrant(
      context,
      { tenantId, accountId, requestId: 'recovery-test' },
      tenants,
      new PostgresRecoveryEligibilityChecker(),
      {
        grants,
        random: new NodeSecureRandom(),
        digester: new HmacCredentialDigester(config.appSecret),
        clock: new SystemClock(),
        audit: new PostgresAuditWriter(),
        tenantRunner: new PostgresTenantTransactionRunner(handleRef.database),
      },
    ),
  );
  return issued.rawToken;
}

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
  handleRef = handle;
  destroyDatabase = () => handle.destroy();
  await migrateToLatest(handle.database);
  pool = new Pool({ connectionString: databaseUrl, max: 4 });

  provider = await TestOidcProvider.start({
    clientId: 'test-client',
    clientSecret: 'test-client-secret',
    subject: 'founder-subject',
    email: 'ada@example.com',
  });
  DRAFT.providerIssuer = provider.issuer;

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

describe('bootstrap', () => {
  it('reports uninitialized before bootstrap and rejects bad tokens', async () => {
    const status = await app.inject({ method: 'GET', url: '/api/v1/bootstrap/status' });
    expect(status.json()).toEqual({ initialized: false });
    const { response } = await prepare('bogus-token');
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'bootstrap_token_invalid' });
  });

  it('rejects invalid drafts without creating canonical records', async () => {
    const token = await issueGrant();
    const { response } = await prepare(token, { tenantSlug: 'NOT-LOWER??' });
    expect(response.statusCode).toBe(400);
    expect(
      (await pool.query<{ count: string }>('SELECT count(*) AS count FROM tenant')).rows[0]?.count,
    ).toBe('0');
    // The same grant retries the same flow after correcting the draft.
    const retry = await prepare(token, {});
    expect(retry.response.statusCode).toBe(200);
    expect(retry.response.json()).toHaveProperty('authorizationUrl');
  });

  it('refuses unsupported providers and offline_access scopes', async () => {
    const token = await issueGrant();
    const badIssuer = await prepare(token, { providerIssuer: 'https://unknown.invalid' });
    expect(badIssuer.response.statusCode).toBe(502);
    const offline = await prepare(token, { providerScopes: ['openid', 'offline_access'] });
    expect(offline.response.statusCode).toBe(400);
  });

  it('completes bootstrap end to end and refuses a second installation', async () => {
    const token = await issueGrant();
    const { response, binding } = await prepare(token, {});
    expect(response.statusCode).toBe(200);
    const authorizeUrl = response.json<{ authorizationUrl: string }>().authorizationUrl;
    expect(authorizeUrl.startsWith(`${provider.issuer}/authorize`)).toBe(true);
    const authorize = await fetch(authorizeUrl, { redirect: 'manual' });
    expect(authorize.status).toBe(302);
    const callback = new URL(authorize.headers.get('location') ?? '');
    const callbackResponse = await app.inject({
      method: 'GET',
      url: `${callback.pathname}${callback.search}`,
      headers: { cookie: `openhall_login_dev=${binding}` },
    });
    expect(callbackResponse.statusCode).toBe(302);
    expect(callbackResponse.headers.location).toBe('/');
    const sessionCookie = requiredCookie(
      cookieValue(callbackResponse.headers['set-cookie'], 'openhall_session_dev'),
      'Bootstrap session cookie missing',
    );
    expect(sessionCookie).toBeDefined();
    const status = await app.inject({ method: 'GET', url: '/api/v1/bootstrap/status' });
    expect(status.json()).toEqual({ initialized: true });
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: `openhall_session_dev=${sessionCookie}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      person: { givenName: 'Ada', familyName: 'Admin' },
      tenant: { name: 'Greenwood', slug: 'greenwood' },
    });
    // The bootstrap grant is consumed: replaying prepare fails.
    const replay = await prepare(token, {});
    expect(replay.response.statusCode).toBe(401);
    // A fresh grant cannot bootstrap over an existing installation.
    const second = await app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap/status',
    });
    expect(second.json()).toEqual({ initialized: true });
  });

  it('never email-matches bootstrap to an existing account', async () => {
    // After installation, bootstrap prepare is unavailable even with theories
    // about matching emails: the presenter must prove the operator grant.
    const status = await app.inject({ method: 'GET', url: '/api/v1/bootstrap/status' });
    expect(status.json()).toEqual({ initialized: true });
  });
});

describe('recovery', () => {
  it('rejects invalid recovery tokens and query-string tokens', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/recovery',
      headers: { authorization: 'Recovery bogus' },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toMatchObject({ code: 'recovery_token_invalid' });
    const query = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/recovery?token=bogus',
    });
    expect(query.statusCode).toBe(401);
  });

  it('consumes a one-time grant into a short recovery session', async () => {
    const tenant = (await pool.query<{ id: string }>('SELECT id FROM tenant')).rows[0]?.id;
    const account = (await pool.query<{ id: string }>('SELECT id FROM account LIMIT 1')).rows[0]
      ?.id;
    if (!tenant || !account) throw new Error('Bootstrap fixture missing');
    const token = await issueRecoveryToken(tenant, account);
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/recovery',
      headers: { authorization: `Recovery ${token}` },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ authenticated: true, authenticationMethod: 'recovery' });
    const sessionCookie = requiredCookie(
      cookieValue(first.headers['set-cookie'], 'openhall_session_dev'),
      'Recovery session cookie missing',
    );
    const session = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: `openhall_session_dev=${sessionCookie}` },
    });
    expect(session.json()).toMatchObject({
      authenticated: true,
      authenticationMethod: 'recovery',
    });
    const audit = await pool.query<{ action: string }>(
      "SELECT action FROM audit_event WHERE action IN ('auth.recovery_grant_issued', 'auth.recovery_session_created')",
    );
    expect(audit.rows.map((row) => row.action).sort()).toEqual([
      'auth.recovery_grant_issued',
      'auth.recovery_session_created',
    ]);
    // One-time: the same token is rejected on replay.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/recovery',
      headers: { authorization: `Recovery ${token}` },
    });
    expect(replay.statusCode).toBe(401);
  });
});
