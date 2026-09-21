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
import {
  AuthenticationError,
  fromBase64Url,
  issueBootstrapGrant,
  issueRecoveryGrant,
  toBase64Url,
} from '@openhall/application';
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

function requiredCookie(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

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
    rateLimitDisabled: true,
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
    // Provider validation failure creates no canonical tenant.
    expect(
      (await pool.query<{ count: string }>('SELECT count(*) AS count FROM tenant')).rows[0]?.count,
    ).toBe('0');
  });

  it('stores bootstrap tokens as digests only', async () => {
    const rawToken = await issueGrant();
    const row = (
      await pool.query<{ token_hash: Buffer }>(
        'SELECT token_hash FROM local_operator_grant WHERE token_hash = $1',
        [grantHash(rawToken)],
      )
    ).rows[0];
    if (!row) throw new Error('Bootstrap grant missing');
    expect(row.token_hash.equals(grantHash(rawToken))).toBe(true);
    const dump = JSON.stringify(row);
    expect(dump).not.toContain(rawToken);
  });

  it('refuses expired bootstrap grants', async () => {
    const rawToken = await issueGrant();
    // CHECK (expires_at > created_at) forbids naive backdating: age the row
    // past the one-hour grant TTL the way real time passage would.
    await pool.query(
      `UPDATE local_operator_grant
       SET created_at = statement_timestamp() - interval '61 minutes',
           expires_at = statement_timestamp() - interval '1 minute'
       WHERE token_hash = $1`,
      [grantHash(rawToken)],
    );
    const { response } = await prepare(rawToken, {});
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'bootstrap_token_invalid' });
  });

  it('keeps one setup draft per grant while allowing corrections', async () => {
    const token = await issueGrant();
    const first = await prepare(token, {});
    expect(first.response.statusCode).toBe(200);
    // Correcting the draft with the same grant updates the single draft
    // instead of creating an unrelated second one.
    const corrected = await prepare(token, {
      tenantName: 'Greenwood Corrected',
      tenantSlug: 'greenwood-corrected',
    });
    expect(corrected.response.statusCode).toBe(200);
    const grantId = (
      await pool.query<{ id: string }>(
        'SELECT id FROM local_operator_grant WHERE token_hash = $1',
        [grantHash(token)],
      )
    ).rows[0]?.id;
    if (!grantId) throw new Error('Bootstrap grant missing');
    const drafts = (
      await pool.query<{ count: string; tenant_slug: string }>(
        'SELECT count(*) AS count, max(tenant_slug) AS tenant_slug FROM bootstrap_setup WHERE operator_grant_id = $1',
        [grantId],
      )
    ).rows[0];
    expect(drafts?.count).toBe('1');
    expect(drafts?.tenant_slug).toBe('greenwood-corrected');
  });

  it('rolls back canonical records when the provider fails at token time', async () => {
    const token = await issueGrant();
    const { response, binding } = await prepare(token, {});
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
    for (const table of ['tenant', 'account', 'auth_session']) {
      const count = (await pool.query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`))
        .rows[0]?.count;
      expect(count).toBe('0');
    }
    // The grant is not consumed by the failed attempt: the operator can retry
    // the same flow once the provider recovers.
    const retry = await prepare(token, {});
    expect(retry.response.statusCode).toBe(200);
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
    const callbackUrl = `${callback.pathname}${callback.search}`;
    const callbackHeaders = { cookie: `openhall_login_dev=${binding}` };
    // Two concurrent callbacks race the one-time transaction claim: exactly
    // one must install, the other must fail closed — never two installations.
    const [first, second] = await Promise.all([
      app.inject({ method: 'GET', url: callbackUrl, headers: callbackHeaders }),
      app.inject({ method: 'GET', url: callbackUrl, headers: callbackHeaders }),
    ]);
    expect(first.statusCode).toBe(302);
    expect(second.statusCode).toBe(302);
    const locations = [first.headers.location, second.headers.location].sort();
    expect(locations).toEqual(['/', '/?error=auth_transaction_invalid']);
    const completed = [first, second].find((r) => r.headers.location === '/');
    if (!completed) throw new Error('Concurrent bootstrap produced no installation');
    const sessionCookie = requiredCookie(
      cookieValue(completed.headers['set-cookie'], 'openhall_session_dev'),
      'Bootstrap session cookie missing',
    );
    expect(
      (await pool.query<{ count: string }>('SELECT count(*) AS count FROM tenant')).rows[0]?.count,
    ).toBe('1');
    expect(
      (await pool.query<{ count: string }>('SELECT count(*) AS count FROM account')).rows[0]?.count,
    ).toBe('1');
    expect(
      (
        await pool.query<{ count: string }>(
          'SELECT count(*) AS count FROM school_schedule_configuration',
        )
      ).rows[0]?.count,
    ).toBe('1');
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
    // The OIDC transaction is consumed: replaying the callback fails closed.
    const replayCallback = await app.inject({
      method: 'GET',
      url: callbackUrl,
      headers: callbackHeaders,
    });
    expect(replayCallback.statusCode).toBe(302);
    expect(String(replayCallback.headers.location).startsWith('/?error=')).toBe(true);
    expect(replayCallback.headers.location).not.toBe('/');
    // A fresh grant cannot bootstrap over an existing installation.
    const statusCheck = await app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap/status',
    });
    expect(statusCheck.json()).toEqual({ initialized: true });
  });

  it('never email-matches bootstrap to an existing account', async () => {
    // After installation, bootstrap prepare is unavailable even with theories
    // about matching emails: the presenter must prove the operator grant.
    const status = await app.inject({ method: 'GET', url: '/api/v1/bootstrap/status' });
    expect(status.json()).toEqual({ initialized: true });
    // The installed administrator is linked by issuer and subject only: the
    // provider-reported email is a snapshot, never a lookup key, and no
    // second person was merged in.
    const identity = (
      await pool.query<{ issuer: string; provider_subject: string; email_snapshot: string | null }>(
        'SELECT issuer, provider_subject, email_snapshot FROM auth_identity LIMIT 1',
      )
    ).rows[0];
    expect(identity?.issuer).toBe(provider.issuer);
    expect(identity?.provider_subject).toBe('founder-subject');
    expect(identity?.email_snapshot).toBe('ada@example.com');
    expect(
      (await pool.query<{ count: string }>('SELECT count(*) AS count FROM person')).rows[0]?.count,
    ).toBe('1');
  });
});

describe('recovery', () => {
  async function installationIds(): Promise<{ tenant: string; account: string }> {
    const tenant = (await pool.query<{ id: string }>('SELECT id FROM tenant')).rows[0]?.id;
    const account = (await pool.query<{ id: string }>('SELECT id FROM account LIMIT 1')).rows[0]
      ?.id;
    if (!tenant || !account) throw new Error('Bootstrap fixture missing');
    return { tenant, account };
  }

  async function consumeRecovery(rawToken: string): Promise<number> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/recovery',
      headers: { authorization: `Recovery ${rawToken}` },
    });
    return response.statusCode;
  }

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
    // Recovery sessions are short-lived: 15-minute idle and 30-minute
    // absolute lifetimes from authentication.
    const digester = new HmacCredentialDigester(config.appSecret);
    const sessionHash = Buffer.from(digester.digestSessionToken(fromBase64Url(sessionCookie)));
    const lifetimes = (
      await pool.query<{
        authenticated_at: string;
        idle_expires_at: string;
        absolute_expires_at: string;
      }>(
        'SELECT authenticated_at, idle_expires_at, absolute_expires_at FROM auth_session WHERE token_hash = $1',
        [sessionHash],
      )
    ).rows[0];
    if (!lifetimes) throw new Error('Recovery session missing');
    const authenticated = new Date(lifetimes.authenticated_at).getTime();
    expect(new Date(lifetimes.idle_expires_at).getTime() - authenticated).toBe(15 * 60 * 1000);
    expect(new Date(lifetimes.absolute_expires_at).getTime() - authenticated).toBe(30 * 60 * 1000);
  });

  it('stores recovery tokens as digests only', async () => {
    const { tenant, account } = await installationIds();
    const rawToken = await issueRecoveryToken(tenant, account);
    const row = (
      await pool.query<{ token_hash: Buffer }>(
        'SELECT token_hash FROM local_operator_grant WHERE token_hash = $1',
        [grantHash(rawToken)],
      )
    ).rows[0];
    if (!row) throw new Error('Recovery grant missing');
    expect(row.token_hash.equals(grantHash(rawToken))).toBe(true);
    expect(JSON.stringify(row)).not.toContain(rawToken);
  });

  it('refuses expired recovery grants', async () => {
    const { tenant, account } = await installationIds();
    const rawToken = await issueRecoveryToken(tenant, account);
    await pool.query(
      `UPDATE local_operator_grant
       SET created_at = statement_timestamp() - interval '31 minutes',
           expires_at = statement_timestamp() - interval '1 minute'
       WHERE token_hash = $1`,
      [grantHash(rawToken)],
    );
    expect(await consumeRecovery(rawToken)).toBe(401);
  });

  it('refuses recovery when the account loses eligibility', async () => {
    const { tenant, account } = await installationIds();
    // Disabled account.
    let token = await issueRecoveryToken(tenant, account);
    await pool.query("UPDATE account SET status = 'disabled' WHERE id = $1", [account]);
    expect(await consumeRecovery(token)).toBe(401);
    await pool.query("UPDATE account SET status = 'active' WHERE id = $1", [account]);
    // Inactive person.
    token = await issueRecoveryToken(tenant, account);
    await pool.query(
      "UPDATE person SET status = 'inactive' WHERE id = (SELECT person_id FROM account WHERE id = $1)",
      [account],
    );
    expect(await consumeRecovery(token)).toBe(401);
    await pool.query(
      "UPDATE person SET status = 'active' WHERE id = (SELECT person_id FROM account WHERE id = $1)",
      [account],
    );
    // Suspended tenant.
    token = await issueRecoveryToken(tenant, account);
    await pool.query("UPDATE tenant SET status = 'suspended' WHERE id = $1", [tenant]);
    expect(await consumeRecovery(token)).toBe(401);
    await pool.query("UPDATE tenant SET status = 'active' WHERE id = $1", [tenant]);
    // The consumed-while-ineligible grants stay consumed: a fresh eligible
    // grant still works afterwards.
    token = await issueRecoveryToken(tenant, account);
    expect(await consumeRecovery(token)).toBe(200);
  });

  it('refuses recovery grants for accounts without system_admin', async () => {
    const { tenant, account } = await installationIds();
    const person = (
      await pool.query<{ id: string }>(
        "INSERT INTO person (tenant_id, given_name, family_name, display_name) VALUES ($1, 'Sam', 'Staff', 'Sam Staff') RETURNING id",
        [tenant],
      )
    ).rows[0]?.id;
    if (!person) throw new Error('Person fixture failed');
    const plainAccount = (
      await pool.query<{ id: string }>(
        'INSERT INTO account (tenant_id, person_id) VALUES ($1, $2) RETURNING id',
        [tenant, person],
      )
    ).rows[0]?.id;
    if (!plainAccount) throw new Error('Account fixture failed');
    let code: string | undefined;
    try {
      await issueRecoveryToken(tenant, plainAccount);
    } catch (error) {
      if (error instanceof AuthenticationError) code = error.code;
    }
    expect(code).toBe('recovery_token_invalid');
    // The eligible administrator is unaffected.
    expect(await consumeRecovery(await issueRecoveryToken(tenant, account))).toBe(200);
  });
});
