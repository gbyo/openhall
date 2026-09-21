import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { AppConfig } from '@openhall/config';
import { createDatabase } from '@openhall/db';
import { Aes256GcmSecretProtector, HmacCredentialDigester } from '../auth/crypto.js';
import type { FastifyInstance } from 'fastify';
import { Client, Pool } from 'pg';
import type { OutgoingHttpHeaders } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { TestOidcProvider } from '../auth/test-oidc-provider.js';

const APP_SECRET = 'test-only-app-secret-32-characters!!';
const TEST_KEY = new Uint8Array(32).fill(7);
const ORIGIN = 'http://localhost:3000';
const protector = new Aes256GcmSecretProtector(TEST_KEY, 'test-key-1');

const config: AppConfig = {
  nodeEnv: 'test',
  appBaseUrl: new URL(ORIGIN),
  databaseUrl: 'postgresql://unused',
  destinationFlowPollMs: 2000,
  appSecret: APP_SECRET,
  dataEncryptionKey: TEST_KEY,
  dataEncryptionKeyId: 'test-key-1',
  trustProxy: false,
  port: 3000,
};

let databaseName: string;
let administrationUrl: string;
let pool: Pool;
let destroyDatabase: () => Promise<void>;
let app: FastifyInstance;
let provider: TestOidcProvider;

let tenantA = '';
let schoolA = '';
let tenantB = '';
let schoolB = '';
let providerIssuer = '';

function quotedIdentifier(value: string): string {
  if (!/^[a-z0-9_]+$/.test(value)) throw new Error('Unsafe database identifier');
  return `"${value}"`;
}

function domainHmac(domain: string, credential: Uint8Array): Uint8Array {
  const hmac = createHmac('sha256', APP_SECRET);
  hmac.update(domain, 'utf8');
  hmac.update(Buffer.from([0]));
  hmac.update(
    Buffer.from(credential.buffer as ArrayBuffer, credential.byteOffset, credential.byteLength),
  );
  return new Uint8Array(hmac.digest());
}

async function mintSession(
  tenantId: string,
  accountId: string,
  method: 'oidc' | 'recovery' = 'oidc',
): Promise<{ cookie: string; csrf: string }> {
  const raw = randomBytes(32);
  const tokenDigest = domainHmac('session-digest:v1', raw);
  const csrfRaw = domainHmac('csrf-token:v1', raw);
  const csrfDigest = createHmac('sha256', APP_SECRET).update(Buffer.from(csrfRaw)).digest();
  await pool.query(
    `INSERT INTO auth_session
      (tenant_id, account_id, token_hash, csrf_token_hash, account_session_revision,
       authentication_method, idle_expires_at, absolute_expires_at)
     VALUES ($1, $2, $3, $4, 0, $5, now() + interval '12 hours', now() + interval '7 days')`,
    [tenantId, accountId, Buffer.from(tokenDigest), csrfDigest, method],
  );
  return {
    cookie: Buffer.from(raw).toString('base64url'),
    csrf: Buffer.from(csrfRaw).toString('base64url'),
  };
}

async function insertReturningId(text: string, params: unknown[] = []): Promise<string> {
  const id = (await pool.query<{ id: string }>(text, params)).rows[0]?.id;
  if (id === undefined) throw new Error('Fixture insert failed');
  return id;
}

interface SessionFixture {
  personId: string;
  accountId: string;
  cookie: string;
  csrf: string;
}

async function makeMember(
  tenantId: string,
  schoolId: string,
  affiliation: 'student' | 'staff',
  given: string,
): Promise<{ personId: string; accountId: string | null }> {
  const personId = await insertReturningId(
    `INSERT INTO person (tenant_id, given_name, family_name, display_name) VALUES ($1, $2, $3, $4) RETURNING id`,
    [tenantId, given, 'Test', `${given} Test`],
  );
  const accountId = await insertReturningId(
    `INSERT INTO account (tenant_id, person_id) VALUES ($1, $2) RETURNING id`,
    [tenantId, personId],
  );
  await pool.query(
    `INSERT INTO organization_membership (tenant_id, organization_id, person_id, affiliation) VALUES ($1, $2, $3, $4)`,
    [tenantId, schoolId, personId, affiliation],
  );
  return { personId, accountId };
}

async function makeAdmin(
  tenantId: string,
  schoolId: string,
  given: string,
): Promise<SessionFixture> {
  const member = await makeMember(tenantId, schoolId, 'staff', given);
  if (member.accountId === null) throw new Error('admin needs an account');
  await pool.query(
    `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind, organization_id) VALUES ($1, $2, 'school_admin', 'organization', $3)`,
    [tenantId, member.accountId, schoolId],
  );
  const { cookie, csrf } = await mintSession(tenantId, member.accountId);
  return { personId: member.personId, accountId: member.accountId, cookie, csrf };
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
        tenantA,
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
    `provider-secret:v1:${tenantA}:${inserted.id}`,
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

let adminA: SessionFixture | null = null;
let adminB: SessionFixture | null = null;

function requireAdmin(): SessionFixture {
  if (adminA === null) throw new Error('admin fixture missing');
  return adminA;
}

function authHeaders(
  session: { cookie: string; csrf: string },
  key?: string,
  ifMatch?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    cookie: `openhall_session_dev=${session.cookie}`,
    'x-csrf-token': session.csrf,
    origin: ORIGIN,
  };
  if (key !== undefined) headers['idempotency-key'] = key;
  if (ifMatch !== undefined) headers['if-match'] = ifMatch;
  return headers;
}

function requiredEtag(response: { headers: Record<string, unknown> }): string {
  const etag = response.headers.etag;
  if (typeof etag !== 'string') throw new Error('Expected ETag response header');
  return etag;
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

function redirectLocation(headers: OutgoingHttpHeaders): string {
  const location = headers.location;
  if (typeof location !== 'string') throw new Error('Missing redirect Location header');
  return location;
}

interface IssuedBody {
  enrollmentId: string;
  enrollmentToken: string;
  expiresAt: string;
  provider: { key: string; displayName: string };
}

interface EnrollmentBody {
  id: string;
  organizationId: string;
  personId: string;
  accountId: string;
  identityProviderId: string;
  status: string;
  expiresAt: string;
  revision: string;
  createdByAccountId: string | null;
  createdAt: string;
  consumedAt: string | null;
  revokedAt: string | null;
  revokedByAccountId: string | null;
}

async function issueEnrollment(
  admin: SessionFixture,
  schoolId: string,
  personId: string,
  providerKey = 'workspace',
  key: string = randomUUID(),
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/organizations/${schoolId}/people/${personId}/enrollments`,
    headers: authHeaders(admin, key),
    payload: { providerKey },
  });
}

/** Starts enrollment and drives the real provider round trip to a callback URL. */
async function startToCallback(
  enrollmentToken: string,
): Promise<{ callback: URL; binding: string }> {
  const start = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/enrollment/start',
    headers: { authorization: `Enrollment ${enrollmentToken}` },
  });
  expect(start.statusCode).toBe(200);
  const authorizationUrl = start.json<{ authorizationUrl: string }>().authorizationUrl;
  const binding = cookieValue(start.headers['set-cookie'], 'openhall_login_dev');
  if (binding === undefined) throw new Error('Missing binding cookie');
  const authorize = await fetch(authorizationUrl, { redirect: 'manual' });
  expect(authorize.status).toBe(302);
  const callbackUrl = authorize.headers.get('location');
  if (callbackUrl === null) throw new Error('Missing callback redirect');
  return { callback: new URL(callbackUrl), binding };
}

async function getCallback(callback: URL, binding: string) {
  return app.inject({
    method: 'GET',
    url: `${callback.pathname}${callback.search}`,
    headers: { cookie: `openhall_login_dev=${binding}` },
  });
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
  const databaseUrl = target.toString();
  const { migrateToLatest } = await import('@openhall/db');
  const handle = createDatabase(databaseUrl, { max: 4 });
  destroyDatabase = () => handle.destroy();
  await migrateToLatest(handle.database);
  pool = new Pool({ connectionString: databaseUrl, max: 8 });

  provider = await TestOidcProvider.start({
    clientId: 'test-client',
    clientSecret: 'test-client-secret',
    subject: 'enrollee-subject',
    email: 'enrollee@example.com',
  });
  providerIssuer = provider.issuer;

  tenantA = await insertReturningId(
    `INSERT INTO tenant (name, slug) VALUES ('TA', 'enta') RETURNING id`,
  );
  schoolA = await insertReturningId(
    `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'A School', 'ent-school', 'America/New_York') RETURNING id`,
    [tenantA],
  );
  tenantB = await insertReturningId(
    `INSERT INTO tenant (name, slug) VALUES ('TB', 'entb') RETURNING id`,
  );
  schoolB = await insertReturningId(
    `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'B School', 'entb-school', 'America/New_York') RETURNING id`,
    [tenantB],
  );
  adminA = await makeAdmin(tenantA, schoolA, 'Ada');
  adminB = await makeAdmin(tenantB, schoolB, 'Bob');

  await seedProviderRow(provider.issuer, 'workspace');

  app = await createApp({
    config,
    database: handle.database,
    logger: false,
    rateLimitDisabled: true,
    destinationFlowWorkerEnabled: false,
    readinessProbe: { check: () => Promise.resolve({ migration: '008_school_control_plane' }) },
  });
}, 120000);

afterAll(async () => {
  await app.close();
  await pool.end();
  await destroyDatabase();
  await provider.close();
  const client = new Client({ connectionString: administrationUrl });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${quotedIdentifier(databaseName)} WITH (FORCE)`);
  } finally {
    await client.end();
  }
});

describe('identity enrollment issuance', () => {
  it('reads only the active invitation status with its authoritative ETag', async () => {
    const member = await makeMember(tenantA, schoolA, 'student', 'Status');
    const empty = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/people/${member.personId}/enrollment`,
      headers: authHeaders(requireAdmin()),
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ enrollment: null });
    expect(empty.headers.etag).toBeUndefined();

    const issued = await issueEnrollment(requireAdmin(), schoolA, member.personId);
    const body = issued.json<IssuedBody>();
    const active = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/people/${member.personId}/enrollment`,
      headers: authHeaders(requireAdmin()),
    });
    expect(active.statusCode).toBe(200);
    expect(active.json()).toMatchObject({
      enrollment: {
        id: body.enrollmentId,
        organizationId: schoolA,
        personId: member.personId,
        status: 'active',
        revision: '1',
      },
    });
    expect(requiredEtag(active)).toBe(`"identity-enrollment:${body.enrollmentId}:1"`);

    if (adminB === null) throw new Error('admin fixture missing');
    const concealed = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/people/${member.personId}/enrollment`,
      headers: authHeaders(adminB),
    });
    expect(concealed.statusCode).toBe(404);
  });

  it('issues a one-time invitation and stores only the digest', async () => {
    const member = await makeMember(tenantA, schoolA, 'student', 'Invited');
    const response = await issueEnrollment(requireAdmin(), schoolA, member.personId);
    expect(response.statusCode).toBe(201);
    const body = response.json<IssuedBody>();
    expect(body.enrollmentToken.length).toBeGreaterThan(0);
    expect(body.provider).toEqual({ key: 'workspace', displayName: 'workspace display' });
    const issued = response.json<IssuedBody>();
    expect(new Date(issued.expiresAt).getTime()).toBeGreaterThan(Date.now() + 23 * 3600 * 1000);

    const row = (
      await pool.query<{ token_hash: Buffer; consumed_at: Date | null }>(
        `SELECT token_hash, consumed_at FROM identity_enrollment_grant WHERE id = $1`,
        [body.enrollmentId],
      )
    ).rows[0];
    expect(row?.consumed_at).toBeNull();
    const raw = Buffer.from(body.enrollmentToken, 'base64url');
    expect(raw).toHaveLength(32);
    expect(row?.token_hash.equals(Buffer.from(raw))).toBe(false);
    const digester = new HmacCredentialDigester(APP_SECRET);
    expect(row?.token_hash.equals(Buffer.from(digester.digest(new Uint8Array(raw))))).toBe(true);

    const audit = await pool.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata FROM audit_event WHERE target_id = $1`,
      [body.enrollmentId],
    );
    expect(audit.rows.map((entry) => entry.action)).toContain('identity_enrollment.issued');
    expect(JSON.stringify(audit.rows)).not.toContain(body.enrollmentToken);
    const outbox = await pool.query<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM outbox_event WHERE aggregate_id = $1`,
      [body.enrollmentId],
    );
    expect(outbox.rows.map((entry) => entry.event_type)).toEqual(['identity_enrollment.issued']);
    expect(JSON.stringify(outbox.rows)).not.toContain(body.enrollmentToken);
  });

  it('refuses duplicate live invitations and replays the original key', async () => {
    const member = await makeMember(tenantA, schoolA, 'staff', 'Doubled');
    const firstKey = randomUUID();
    const first = await issueEnrollment(
      requireAdmin(),
      schoolA,
      member.personId,
      'workspace',
      firstKey,
    );
    expect(first.statusCode).toBe(201);

    const duplicate = await issueEnrollment(requireAdmin(), schoolA, member.personId);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json<{ code: string }>().code).toBe('identity_enrollment_invalid');

    const replayed = await issueEnrollment(
      requireAdmin(),
      schoolA,
      member.personId,
      'workspace',
      firstKey,
    );
    expect(replayed.statusCode).toBe(201);
    expect(replayed.json<IssuedBody>().enrollmentId).toBe(first.json<IssuedBody>().enrollmentId);
    // The raw token is returned exactly once, never on replay.
    expect(replayed.json<IssuedBody>().enrollmentToken).toBe('');
  });

  it('refuses targets that are already enrolled on the provider', async () => {
    const member = await makeMember(tenantA, schoolA, 'student', 'Linked');
    await pool.query(
      `INSERT INTO auth_identity (tenant_id, account_id, issuer, provider_subject) VALUES ($1, $2, $3, $4)`,
      [tenantA, member.accountId, providerIssuer, 'already-there'],
    );
    const response = await issueEnrollment(requireAdmin(), schoolA, member.personId);
    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('identity_already_enrolled');
  });

  it('validates target eligibility and provider without leaking', async () => {
    const outsider = await makeMember(tenantB, schoolB, 'staff', 'Foreign');
    const concealed = await issueEnrollment(requireAdmin(), schoolA, outsider.personId);
    expect(concealed.statusCode).toBe(409);
    expect(concealed.json<{ code: string }>().code).toBe('identity_enrollment_invalid');

    const member = await makeMember(tenantA, schoolA, 'student', 'Unenrollable');
    await pool.query(`DELETE FROM organization_membership WHERE person_id = $1`, [member.personId]);
    const noMembership = await issueEnrollment(requireAdmin(), schoolA, member.personId);
    expect(noMembership.statusCode).toBe(409);

    const unknownProvider = await issueEnrollment(requireAdmin(), schoolA, member.personId, 'nope');
    expect(unknownProvider.statusCode).toBe(409);
    expect(unknownProvider.json<{ code: string }>().code).toBe('identity_enrollment_invalid');

    if (adminB === null) throw new Error('admin fixture missing');
    const crossSchool = await issueEnrollment(adminB, schoolA, member.personId);
    expect(crossSchool.statusCode).toBe(404);
  });
});

describe('identity enrollment revocation', () => {
  it('revokes live invitations with ETag lifecycle', async () => {
    const member = await makeMember(tenantA, schoolA, 'student', 'Revoked');
    const created = await issueEnrollment(requireAdmin(), schoolA, member.personId);
    const body = created.json<IssuedBody>();
    const etag = requiredEtag(created);

    const missing = await app.inject({
      method: 'POST',
      url: `/api/v1/identity-enrollments/${body.enrollmentId}/revoke`,
      headers: authHeaders(requireAdmin(), randomUUID()),
    });
    expect(missing.statusCode).toBe(428);

    const stale = await app.inject({
      method: 'POST',
      url: `/api/v1/identity-enrollments/${body.enrollmentId}/revoke`,
      headers: authHeaders(
        requireAdmin(),
        randomUUID(),
        `"identity-enrollment:${body.enrollmentId}:99"`,
      ),
    });
    expect(stale.statusCode).toBe(412);

    const revokeKey = randomUUID();
    const revoked = await app.inject({
      method: 'POST',
      url: `/api/v1/identity-enrollments/${body.enrollmentId}/revoke`,
      headers: authHeaders(requireAdmin(), revokeKey, etag),
    });
    expect(revoked.statusCode).toBe(200);
    const grant = revoked.json<{ enrollment: EnrollmentBody }>().enrollment;
    expect(grant.status).toBe('revoked');
    expect(grant.revision).toBe('2');
    expect(grant.revokedByAccountId).toBe(requireAdmin().accountId);
    expect(requiredEtag(revoked)).toBe(`"identity-enrollment:${body.enrollmentId}:2"`);

    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/identity-enrollments/${body.enrollmentId}/revoke`,
      headers: authHeaders(requireAdmin(), randomUUID(), requiredEtag(revoked)),
    });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ code: string }>().code).toBe('identity_enrollment_invalid');
  });
});

describe('identity enrollment OIDC flow', () => {
  it('completes a full invitation into a linked session', async () => {
    const member = await makeMember(tenantA, schoolA, 'student', 'Enrollee');
    const issued = (
      await issueEnrollment(requireAdmin(), schoolA, member.personId)
    ).json<IssuedBody>();
    const { callback, binding } = await startToCallback(issued.enrollmentToken);

    // The invitation is not consumed by start: retrying start still works.
    const retry = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/enrollment/start',
      headers: { authorization: `Enrollment ${issued.enrollmentToken}` },
    });
    expect(retry.statusCode).toBe(200);

    const response = await getCallback(callback, binding);
    expect(response.statusCode).toBe(302);
    expect(redirectLocation(response.headers)).toBe('/');
    const sessionCookie = cookieValue(response.headers['set-cookie'], 'openhall_session_dev');
    expect(sessionCookie).not.toBeUndefined();

    const identities = await pool.query<{ provider_subject: string; account_id: string }>(
      `SELECT provider_subject, account_id FROM auth_identity WHERE tenant_id = $1 AND issuer = $2`,
      [tenantA, providerIssuer],
    );
    const linked = identities.rows.find((entry) => entry.provider_subject === 'enrollee-subject');
    expect(linked?.account_id).toBe(member.accountId);

    const grant = (
      await pool.query<{ consumed_at: Date | null; revision: string }>(
        `SELECT consumed_at, revision FROM identity_enrollment_grant WHERE id = $1`,
        [issued.enrollmentId],
      )
    ).rows[0];
    expect(grant?.consumed_at).not.toBeNull();

    // A replayed callback fails closed without a second session.
    const replayed = await getCallback(callback, binding);
    expect(replayed.statusCode).toBe(302);
    expect(redirectLocation(replayed.headers)).not.toBe('/');
    expect(cookieValue(replayed.headers['set-cookie'], 'openhall_session_dev')).toBeUndefined();

    // The consumed invitation no longer starts.
    const after = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/enrollment/start',
      headers: { authorization: `Enrollment ${issued.enrollmentToken}` },
    });
    expect(after.statusCode).toBe(400);
  });

  it('fails closed when the identity belongs to another account', async () => {
    const owner = await makeMember(tenantA, schoolA, 'student', 'Owner');
    await pool.query(
      `INSERT INTO auth_identity (tenant_id, account_id, issuer, provider_subject) VALUES ($1, $2, $3, 'contested-subject')`,
      [tenantA, owner.accountId, providerIssuer],
    );
    const newcomer = await makeMember(tenantA, schoolA, 'student', 'Newcomer');
    const issued = (
      await issueEnrollment(requireAdmin(), schoolA, newcomer.personId)
    ).json<IssuedBody>();
    provider.rig.subjectOverride = 'contested-subject';
    try {
      const { callback, binding } = await startToCallback(issued.enrollmentToken);
      const response = await getCallback(callback, binding);
      expect(response.statusCode).toBe(302);
      expect(redirectLocation(response.headers)).toBe('/?error=identity_link_conflict');
      expect(cookieValue(response.headers['set-cookie'], 'openhall_session_dev')).toBeUndefined();
      const grant = (
        await pool.query<{ consumed_at: Date | null }>(
          `SELECT consumed_at FROM identity_enrollment_grant WHERE id = $1`,
          [issued.enrollmentId],
        )
      ).rows[0];
      expect(grant?.consumed_at).toBeNull();
    } finally {
      provider.rig.subjectOverride = undefined;
    }
  });

  it('rejects unknown and expired invitations at start', async () => {
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/enrollment/start',
      headers: {
        authorization: `Enrollment ${Buffer.from(randomBytes(32)).toString('base64url')}`,
      },
    });
    expect(unknown.statusCode).toBe(400);

    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/enrollment/start',
    });
    expect(missing.statusCode).toBe(401);

    const member = await makeMember(tenantA, schoolA, 'student', 'Stale');
    const issued = (
      await issueEnrollment(requireAdmin(), schoolA, member.personId)
    ).json<IssuedBody>();
    // CHECK (expires_at > created_at) forbids naive backdating: age the
    // whole row past the 24-hour invitation TTL instead.
    await pool.query(
      `UPDATE identity_enrollment_grant
       SET created_at = statement_timestamp() - interval '25 hours',
           expires_at = statement_timestamp() - interval '1 hour'
       WHERE id = $1`,
      [issued.enrollmentId],
    );
    const expired = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/enrollment/start',
      headers: { authorization: `Enrollment ${issued.enrollmentToken}` },
    });
    expect(expired.statusCode).toBe(400);
    expect(expired.json<{ code: string }>().code).toBe('auth_transaction_expired');
  });
});
