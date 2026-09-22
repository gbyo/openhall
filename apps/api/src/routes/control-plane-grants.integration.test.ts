import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { AppConfig } from '@openhall/config';
import { createDatabase, migrateToLatest } from '@openhall/db';
import type { FastifyInstance } from 'fastify';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';

const APP_SECRET = 'test-only-app-secret-32-characters!!';
const TEST_KEY = new Uint8Array(32).fill(7);
const ORIGIN = 'http://localhost:3000';

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
let pool: Pool;
let app: FastifyInstance;
let destroyHandle: () => Promise<void>;

let tenantA = '';
let schoolA = '';
let tenantB = '';
let schoolB = '';
let destinationA = '';
let archivedDestinationA = '';
let destinationB = '';

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

/** Staff person with account, session, and active staff membership. */
async function makeStaff(
  tenantId: string,
  schoolId: string,
  given: string,
): Promise<SessionFixture> {
  const personId = await insertReturningId(
    `INSERT INTO person (tenant_id, given_name, family_name, display_name) VALUES ($1, $2, $3, $4) RETURNING id`,
    [tenantId, given, 'Test', `${given} Test`],
  );
  const accountId = await insertReturningId(
    `INSERT INTO account (tenant_id, person_id) VALUES ($1, $2) RETURNING id`,
    [tenantId, personId],
  );
  await pool.query(
    `INSERT INTO organization_membership (tenant_id, organization_id, person_id, affiliation) VALUES ($1, $2, $3, 'staff')`,
    [tenantId, schoolId, personId],
  );
  const { cookie, csrf } = await mintSession(tenantId, accountId);
  return { personId, accountId, cookie, csrf };
}

/** Staff person with membership but deliberately no account. */
async function makeAccountlessStaff(
  tenantId: string,
  schoolId: string,
  given: string,
): Promise<string> {
  const personId = await insertReturningId(
    `INSERT INTO person (tenant_id, given_name, family_name, display_name) VALUES ($1, $2, $3, $4) RETURNING id`,
    [tenantId, given, 'Test', `${given} Test`],
  );
  await pool.query(
    `INSERT INTO organization_membership (tenant_id, organization_id, person_id, affiliation) VALUES ($1, $2, $3, 'staff')`,
    [tenantId, schoolId, personId],
  );
  return personId;
}

async function makeStudent(tenantId: string, schoolId: string, given: string): Promise<string> {
  const personId = await insertReturningId(
    `INSERT INTO person (tenant_id, given_name, family_name, display_name) VALUES ($1, $2, $3, $4) RETURNING id`,
    [tenantId, given, 'Test', `${given} Test`],
  );
  await pool.query(
    `INSERT INTO organization_membership (tenant_id, organization_id, person_id, affiliation) VALUES ($1, $2, $3, 'student')`,
    [tenantId, schoolId, personId],
  );
  return personId;
}

async function grantSchoolAdmin(
  tenantId: string,
  accountId: string,
  schoolId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind, organization_id)
     VALUES ($1, $2, 'school_admin', 'organization', $3)`,
    [tenantId, accountId, schoolId],
  );
}

let adminA: SessionFixture | null = null;
let adminB: SessionFixture | null = null;
let recoveryA: { cookie: string; csrf: string } | null = null;

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

interface GrantBody {
  id: string;
  personId: string;
  person: { id: string; displayName: string };
  accountId: string;
  role: string;
  scopeKind: string;
  organizationId: string | null;
  roomId: string | null;
  room: { id: string; name: string } | null;
  status: string;
  validFrom: string | null;
  validUntil: string | null;
  revision: string;
  createdByAccountId: string | null;
  revokedAt: string | null;
  revokedByAccountId: string | null;
  createdAt: string;
}

async function issueGrant(
  admin: SessionFixture,
  schoolId: string,
  payload: Record<string, unknown>,
  key: string = randomUUID(),
) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/organizations/${schoolId}/authorization-grants`,
    headers: authHeaders(admin, key),
    payload,
  });
  return response;
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const base = new URL(process.env.DATABASE_URL);
  databaseName = `openhall_test_${randomUUID().replaceAll('-', '')}`;
  const administration = new URL(base);
  administration.pathname = '/postgres';
  const admin = new Client({ connectionString: administration.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${quotedIdentifier(databaseName)}`);
  await admin.end();
  const target = new URL(base);
  target.pathname = `/${databaseName}`;
  const databaseUrl = target.toString();
  const handle = createDatabase(databaseUrl, { max: 4 });
  destroyHandle = () => handle.destroy();
  await migrateToLatest(handle.database);
  pool = new Pool({ connectionString: databaseUrl, max: 8 });
  app = await createApp({
    config,
    database: handle.database,
    logger: false,
    rateLimitDisabled: true,
    destinationFlowWorkerEnabled: false,
    readinessProbe: { check: () => Promise.resolve({ migration: '008_school_control_plane' }) },
  });

  tenantA = await insertReturningId(
    `INSERT INTO tenant (name, slug) VALUES ('TA', 'cgta') RETURNING id`,
  );
  schoolA = await insertReturningId(
    `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'A School', 'cga-school', 'America/New_York') RETURNING id`,
    [tenantA],
  );
  tenantB = await insertReturningId(
    `INSERT INTO tenant (name, slug) VALUES ('TB', 'cgtb') RETURNING id`,
  );
  schoolB = await insertReturningId(
    `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'B School', 'cgb-school', 'America/New_York') RETURNING id`,
    [tenantB],
  );
  const adminPerson = await makeStaff(tenantA, schoolA, 'Ada');
  await grantSchoolAdmin(tenantA, adminPerson.accountId, schoolA);
  adminA = adminPerson;
  recoveryA = await mintSession(tenantA, adminPerson.accountId, 'recovery');
  const adminBPerson = await makeStaff(tenantB, schoolB, 'Bob');
  await grantSchoolAdmin(tenantB, adminBPerson.accountId, schoolB);
  adminB = adminBPerson;

  const categoryA = await insertReturningId(
    `INSERT INTO room_category (tenant_id, organization_id, name) VALUES ($1, $2, 'Grant Nurse Cat') RETURNING id`,
    [tenantA, schoolA],
  );
  destinationA = await insertReturningId(
    `INSERT INTO room (tenant_id, organization_id, category_id, name) VALUES ($1, $2, $3, 'Grant Nurse') RETURNING id`,
    [tenantA, schoolA, categoryA],
  );
  archivedDestinationA = await insertReturningId(
    `INSERT INTO room (tenant_id, organization_id, category_id, name, status) VALUES ($1, $2, $3, 'Grant Archive', 'archived') RETURNING id`,
    [tenantA, schoolA, categoryA],
  );
  const categoryB = await insertReturningId(
    `INSERT INTO room_category (tenant_id, organization_id, name) VALUES ($1, $2, 'Grant B Cat') RETURNING id`,
    [tenantB, schoolB],
  );
  destinationB = await insertReturningId(
    `INSERT INTO room (tenant_id, organization_id, category_id, name) VALUES ($1, $2, $3, 'Grant B Nurse') RETURNING id`,
    [tenantB, schoolB, categoryB],
  );
}, 120000);

afterAll(async () => {
  await app.close();
  await pool.end();
  await destroyHandle();
  const base = new URL(process.env.DATABASE_URL ?? '');
  const administration = new URL(base);
  administration.pathname = '/postgres';
  const client = new Client({ connectionString: administration.toString() });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${quotedIdentifier(databaseName)} WITH (FORCE)`);
  } finally {
    await client.end();
  }
});

describe('control-plane authorization grants', () => {
  it('issues an organization duty and creates a login-less account', async () => {
    const personId = await makeAccountlessStaff(tenantA, schoolA, 'Dutiful');
    const before = await pool.query(`SELECT id FROM account WHERE person_id = $1`, [personId]);
    expect(before.rows).toHaveLength(0);

    const response = await issueGrant(requireAdmin(), schoolA, {
      personId,
      role: 'counselor',
      roomId: null,
      validFrom: null,
      validUntil: null,
    });
    expect(response.statusCode).toBe(201);
    const grant = response.json<{ grant: GrantBody }>().grant;
    expect(grant.personId).toBe(personId);
    expect(grant.role).toBe('counselor');
    expect(grant.scopeKind).toBe('organization');
    expect(grant.organizationId).toBe(schoolA);
    expect(grant.roomId).toBeNull();
    expect(grant.status).toBe('active');
    expect(grant.revision).toBe('1');
    expect(grant.createdByAccountId).toBe(requireAdmin().accountId);
    expect(requiredEtag(response)).toBe(`"grant:${grant.id}:1"`);

    const accounts = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM account WHERE person_id = $1`,
      [personId],
    );
    expect(accounts.rows).toHaveLength(1);
    expect(grant.accountId).toBe(accounts.rows[0]?.id);

    const audit = await pool.query<{ action: string }>(
      `SELECT action FROM audit_event WHERE target_id = $1`,
      [grant.id],
    );
    expect(audit.rows.map((row) => row.action)).toContain('authorization_grant.issued');
    const outbox = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM outbox_event WHERE aggregate_id = $1`,
      [grant.id],
    );
    expect(outbox.rows.map((row) => row.event_type)).toEqual(['authorization_grant.issued']);
  });

  it('rejects duplicate active duties and replays the original key', async () => {
    const target = await makeStaff(tenantA, schoolA, 'Doubled');
    const payload = {
      personId: target.personId,
      role: 'office_staff',
      roomId: null,
      validFrom: null,
      validUntil: null,
    };
    const firstKey = randomUUID();
    const first = await issueGrant(requireAdmin(), schoolA, payload, firstKey);
    expect(first.statusCode).toBe(201);
    const firstGrant = first.json<{ grant: GrantBody }>().grant;

    const duplicate = await issueGrant(requireAdmin(), schoolA, payload, randomUUID());
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json<{ code: string }>().code).toBe('authorization_grant_exists');

    const replayed = await issueGrant(requireAdmin(), schoolA, payload, firstKey);
    expect(replayed.statusCode).toBe(201);
    expect(replayed.json<{ grant: GrantBody }>().grant.id).toBe(firstGrant.id);

    const count = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM authorization_grant WHERE account_id = $1 AND role = 'office_staff' AND status = 'active'`,
      [target.accountId],
    );
    expect(Number(count.rows[0]?.count)).toBe(1);
  });

  it('rejects non-staff targets without leaking existence', async () => {
    const studentId = await makeStudent(tenantA, schoolA, 'Studious');
    const otherTenantStaff = await makeStaff(tenantB, schoolB, 'Foreign');
    const noMembership = await makeStaff(tenantA, schoolA, 'Roaming');
    await pool.query(`DELETE FROM organization_membership WHERE person_id = $1`, [
      noMembership.personId,
    ]);
    const inactive = await makeStaff(tenantA, schoolA, 'Dormant');
    await pool.query(`UPDATE person SET status = 'inactive' WHERE id = $1`, [inactive.personId]);

    for (const [label, personId] of [
      ['student', studentId],
      ['cross-tenant staff', otherTenantStaff.personId],
      ['staff without membership', noMembership.personId],
      ['inactive person', inactive.personId],
      ['missing person', randomUUID()],
    ] as const) {
      const response = await issueGrant(
        requireAdmin(),
        schoolA,
        { personId, role: 'counselor', roomId: null, validFrom: null, validUntil: null },
        randomUUID(),
      );
      expect(response.statusCode, `${label}: status`).toBe(409);
      expect(response.json<{ code: string }>().code, `${label}: code`).toBe(
        'target_not_active_staff',
      );
    }
  });

  it('scopes room duties to live same-school rooms', async () => {
    const target = await makeStaff(tenantA, schoolA, 'Stationed');
    const missing = await issueGrant(
      requireAdmin(),
      schoolA,
      {
        personId: target.personId,
        role: 'room_staff',
        roomId: null,
        validFrom: null,
        validUntil: null,
      },
      randomUUID(),
    );
    expect(missing.statusCode).toBe(409);
    expect(missing.json<{ code: string }>().code).toBe('invalid_authorization_grant_state');

    const crossSchool = await issueGrant(
      requireAdmin(),
      schoolA,
      {
        personId: target.personId,
        role: 'room_staff',
        roomId: destinationB,
        validFrom: null,
        validUntil: null,
      },
      randomUUID(),
    );
    expect(crossSchool.statusCode).toBe(409);
    expect(crossSchool.json<{ code: string }>().code).toBe('invalid_authorization_grant_state');

    const archived = await issueGrant(
      requireAdmin(),
      schoolA,
      {
        personId: target.personId,
        role: 'room_staff',
        roomId: archivedDestinationA,
        validFrom: null,
        validUntil: null,
      },
      randomUUID(),
    );
    expect(archived.statusCode).toBe(409);
    expect(archived.json<{ code: string }>().code).toBe('invalid_authorization_grant_state');

    const orgWithDestination = await issueGrant(
      requireAdmin(),
      schoolA,
      {
        personId: target.personId,
        role: 'counselor',
        roomId: destinationA,
        validFrom: null,
        validUntil: null,
      },
      randomUUID(),
    );
    expect(orgWithDestination.statusCode).toBe(409);
    expect(orgWithDestination.json<{ code: string }>().code).toBe(
      'invalid_authorization_grant_state',
    );

    const created = await issueGrant(
      requireAdmin(),
      schoolA,
      {
        personId: target.personId,
        role: 'room_staff',
        roomId: destinationA,
        validFrom: null,
        validUntil: null,
      },
      randomUUID(),
    );
    expect(created.statusCode).toBe(201);
    const grant = created.json<{ grant: GrantBody }>().grant;
    expect(grant.scopeKind).toBe('room');
    expect(grant.organizationId).toBeNull();
    expect(grant.roomId).toBe(destinationA);
  });

  it('validates the duty validity interval', async () => {
    const target = await makeStaff(tenantA, schoolA, 'Timed');
    const inverted = await issueGrant(
      requireAdmin(),
      schoolA,
      {
        personId: target.personId,
        role: 'counselor',
        roomId: null,
        validFrom: '2027-01-02T00:00:00Z',
        validUntil: '2027-01-01T00:00:00Z',
      },
      randomUUID(),
    );
    expect(inverted.statusCode).toBe(409);
    expect(inverted.json<{ code: string }>().code).toBe('invalid_authorization_grant_state');

    const windowed = await issueGrant(
      requireAdmin(),
      schoolA,
      {
        personId: target.personId,
        role: 'counselor',
        roomId: null,
        validFrom: '2027-01-01T00:00:00Z',
        validUntil: '2027-02-01T00:00:00Z',
      },
      randomUUID(),
    );
    expect(windowed.statusCode).toBe(201);
    expect(windowed.json<{ grant: GrantBody }>().grant.validFrom).toBe('2027-01-01T00:00:00Z');
  });

  it('revokes with ETag lifecycle and replays the original key', async () => {
    const target = await makeStaff(tenantA, schoolA, 'Relieved');
    const created = await issueGrant(requireAdmin(), schoolA, {
      personId: target.personId,
      role: 'office_staff',
      roomId: null,
      validFrom: null,
      validUntil: null,
    });
    const grant = created.json<{ grant: GrantBody }>().grant;
    const etag = requiredEtag(created);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/authorization-grants/${grant.id}`,
      headers: authHeaders(requireAdmin()),
    });
    expect(detail.statusCode).toBe(200);
    expect(requiredEtag(detail)).toBe(etag);
    expect(detail.json<{ grant: GrantBody }>().grant.person).toEqual({
      id: target.personId,
      displayName: 'Relieved Test',
    });

    const missing = await app.inject({
      method: 'POST',
      url: `/api/v1/authorization-grants/${grant.id}/revoke`,
      headers: authHeaders(requireAdmin(), randomUUID()),
    });
    expect(missing.statusCode).toBe(428);

    const stale = await app.inject({
      method: 'POST',
      url: `/api/v1/authorization-grants/${grant.id}/revoke`,
      headers: authHeaders(requireAdmin(), randomUUID(), `"grant:${grant.id}:99"`),
    });
    expect(stale.statusCode).toBe(412);

    const revokeKey = randomUUID();
    const revoked = await app.inject({
      method: 'POST',
      url: `/api/v1/authorization-grants/${grant.id}/revoke`,
      headers: authHeaders(requireAdmin(), revokeKey, etag),
    });
    expect(revoked.statusCode).toBe(200);
    const revokedGrant = revoked.json<{ grant: GrantBody }>().grant;
    expect(revokedGrant.status).toBe('revoked');
    expect(revokedGrant.revision).toBe('2');
    expect(revokedGrant.revokedByAccountId).toBe(requireAdmin().accountId);
    expect(revokedGrant.revokedAt).not.toBeNull();
    expect(requiredEtag(revoked)).toBe(`"grant:${grant.id}:2"`);

    const replayed = await app.inject({
      method: 'POST',
      url: `/api/v1/authorization-grants/${grant.id}/revoke`,
      headers: authHeaders(requireAdmin(), revokeKey, etag),
    });
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json<{ grant: GrantBody }>().grant.revision).toBe('2');

    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/authorization-grants/${grant.id}/revoke`,
      headers: authHeaders(requireAdmin(), randomUUID(), requiredEtag(revoked)),
    });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ code: string }>().code).toBe('invalid_authorization_grant_state');
  });

  it('lists school duties and conceals other schools and tenants', async () => {
    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/authorization-grants`,
      headers: authHeaders(requireAdmin()),
    });
    expect(listed.statusCode).toBe(200);
    const grants = listed.json<{ grants: GrantBody[] }>().grants;
    expect(grants.length).toBeGreaterThan(0);
    for (const grant of grants) {
      expect(grant).not.toHaveProperty('updatedAt');
      expect(grant.person.displayName).toBeTruthy();
      if (grant.roomId !== null) expect(grant.room?.name).toBeTruthy();
    }

    if (adminB === null) throw new Error('admin fixture missing');
    const concealed = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/authorization-grants`,
      headers: authHeaders(adminB),
    });
    expect(concealed.statusCode).toBe(404);
  });

  it('denies students and recovery sessions on grant endpoints', async () => {
    const pupil = await makeStaff(tenantA, schoolA, 'PupilStaff');
    await pool.query(
      `UPDATE organization_membership SET affiliation = 'student' WHERE person_id = $1`,
      [pupil.personId],
    );
    const denied = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/authorization-grants`,
      headers: authHeaders(pupil),
    });
    expect(denied.statusCode).toBe(403);

    if (recoveryA === null) throw new Error('recovery fixture missing');
    const recovery = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${schoolA}/authorization-grants`,
      headers: authHeaders(recoveryA, randomUUID()),
      payload: {
        personId: pupil.personId,
        role: 'counselor',
        roomId: null,
        validFrom: null,
        validUntil: null,
      },
    });
    expect(recovery.statusCode).toBe(403);
  });

  it('rejects out-of-vocabulary roles at the contract', async () => {
    const target = await makeStaff(tenantA, schoolA, 'Elevated');
    const response = await issueGrant(
      requireAdmin(),
      schoolA,
      {
        personId: target.personId,
        role: 'system_admin',
        roomId: null,
        validFrom: null,
        validUntil: null,
      },
      randomUUID(),
    );
    expect(response.statusCode).toBe(400);
  });
});
