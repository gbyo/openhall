import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { AppConfig } from '@openhall/config';
import { createDatabase } from '@openhall/db';
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

interface StudentFixture {
  personId: string;
  accountId: string;
  cookie: string;
  csrf: string;
}

async function makeStudent(
  tenantId: string,
  schoolId: string,
  given: string,
): Promise<StudentFixture> {
  const personId = await insertReturningId(
    `INSERT INTO person (tenant_id, given_name, family_name, display_name) VALUES ($1, $2, $3, $4) RETURNING id`,
    [tenantId, given, 'Test', `${given} Test`],
  );
  const accountId = await insertReturningId(
    `INSERT INTO account (tenant_id, person_id) VALUES ($1, $2) RETURNING id`,
    [tenantId, personId],
  );
  await pool.query(
    `INSERT INTO organization_membership (tenant_id, organization_id, person_id, affiliation) VALUES ($1, $2, $3, 'student')`,
    [tenantId, schoolId, personId],
  );
  const { cookie, csrf } = await mintSession(tenantId, accountId);
  return { personId, accountId, cookie, csrf };
}

async function makeStaff(
  tenantId: string,
  schoolId: string,
  given: string,
): Promise<StudentFixture> {
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

let tenantA = '';
let schoolA = '';
let schoolB = '';
let tenantBSchool = '';
let sectionA1 = '';
let sectionA2 = '';
let destinationA = '';
let closedDestinationA = '';
let destinationB = '';
let crossTenantDestination = '';

let teacher: StudentFixture | null = null;
let counselor: StudentFixture | null = null;
let schoolBCounselor: StudentFixture | null = null;
let sysadminCookie = '';
let sysadminCsrf = '';
let recoveryCookie = '';
let recoveryCsrf = '';

function authHeaders(
  session: { cookie: string; csrf: string },
  key?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    cookie: `openhall_session_dev=${session.cookie}`,
    'x-csrf-token': session.csrf,
    origin: ORIGIN,
  };
  if (key !== undefined) headers['idempotency-key'] = key;
  return headers;
}

async function postSelfPass(
  session: { cookie: string; csrf: string },
  destinationId: string,
  key?: string,
) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/me/passes',
    headers: authHeaders(session, key),
    payload: { destinationId },
  });
}

async function tableCount(table: string): Promise<number> {
  const result = await pool.query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`);
  return Number(result.rows[0]?.count ?? '0');
}

function requiredEtag(response: { headers: Record<string, unknown> }): string {
  const etag = response.headers.etag;
  if (typeof etag !== 'string') throw new Error('Expected ETag response header');
  return etag;
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

  app = await createApp({
    config,
    database: handle.database,
    logger: false,
    rateLimitDisabled: true,
    readinessProbe: {
      check: () => Promise.resolve({ migration: '005_pass_command_core' }),
    },
  });

  tenantA = await insertReturningId(
    `INSERT INTO tenant (name, slug) VALUES ('TA', 'ta') RETURNING id`,
  );
  const tenantB = await insertReturningId(
    `INSERT INTO tenant (name, slug) VALUES ('TB', 'tb') RETURNING id`,
  );
  schoolA = await insertReturningId(
    `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'A School', 'a-school', 'America/New_York') RETURNING id`,
    [tenantA],
  );
  schoolB = await insertReturningId(
    `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'B School', 'b-school', 'America/Chicago') RETURNING id`,
    [tenantA],
  );
  tenantBSchool = await insertReturningId(
    `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'TB School', 'tb-school', 'America/Denver') RETURNING id`,
    [tenantB],
  );

  const session = await insertReturningId(
    `INSERT INTO academic_session (tenant_id, organization_id, kind, name, starts_on, ends_on) VALUES ($1, $2, 'school_year', 'SY', '2026-08-01', '2027-06-01') RETURNING id`,
    [tenantA, schoolA],
  );
  sectionA1 = await insertReturningId(
    `INSERT INTO section (tenant_id, organization_id, academic_session_id, code, title) VALUES ($1, $2, $3, 'HIST-3', 'US History') RETURNING id`,
    [tenantA, schoolA, session],
  );
  sectionA2 = await insertReturningId(
    `INSERT INTO section (tenant_id, organization_id, academic_session_id, code, title) VALUES ($1, $2, $3, 'MATH-1', 'Math') RETURNING id`,
    [tenantA, schoolA, session],
  );

  const locationA = await insertReturningId(
    `INSERT INTO location (tenant_id, organization_id, kind, name) VALUES ($1, $2, 'classroom', 'Room 214') RETURNING id`,
    [tenantA, schoolA],
  );
  const locationB = await insertReturningId(
    `INSERT INTO location (tenant_id, organization_id, kind, name) VALUES ($1, $2, 'clinic', 'Clinic B') RETURNING id`,
    [tenantA, schoolB],
  );
  destinationA = await insertReturningId(
    `INSERT INTO destination (tenant_id, organization_id, location_id, service_type, display_name) VALUES ($1, $2, $3, 'restroom', 'Restroom B') RETURNING id`,
    [tenantA, schoolA, locationA],
  );
  closedDestinationA = await insertReturningId(
    `INSERT INTO destination (tenant_id, organization_id, location_id, service_type, display_name, status) VALUES ($1, $2, $3, 'restroom', 'Closed Restroom', 'closed') RETURNING id`,
    [tenantA, schoolA, locationA],
  );
  destinationB = await insertReturningId(
    `INSERT INTO destination (tenant_id, organization_id, location_id, service_type, display_name) VALUES ($1, $2, $3, 'nurse', 'Nurse B') RETURNING id`,
    [tenantA, schoolB, locationB],
  );
  const tenantBLocation = await insertReturningId(
    `INSERT INTO location (tenant_id, organization_id, kind, name) VALUES ($1, $2, 'clinic', 'TB Clinic') RETURNING id`,
    [tenantB, tenantBSchool],
  );
  crossTenantDestination = await insertReturningId(
    `INSERT INTO destination (tenant_id, organization_id, location_id, service_type, display_name) VALUES ($1, $2, $3, 'nurse', 'TB Nurse') RETURNING id`,
    [tenantB, tenantBSchool, tenantBLocation],
  );

  // Schedule fixtures so Expected Placement resolves for section members.
  const block = await insertReturningId(
    `INSERT INTO schedule_block (tenant_id, organization_id, code, display_name, kind) VALUES ($1, $2, 'P3', 'Third Period', 'instructional') RETURNING id`,
    [tenantA, schoolA],
  );
  const template = await insertReturningId(
    `INSERT INTO schedule_template (tenant_id, organization_id, name) VALUES ($1, $2, 'Daily') RETURNING id`,
    [tenantA, schoolA],
  );
  await pool.query(
    `INSERT INTO schedule_slot (tenant_id, organization_id, schedule_template_id, schedule_block_id, starts_at, ends_at, ordinal) VALUES ($1, $2, $3, $4, '00:00', '23:59:59', 0)`,
    [tenantA, schoolA, template, block],
  );
  const today = new Date();
  for (const offset of [-2, -1, 0, 1, 2]) {
    const day = new Date(today.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
    await pool.query(
      `INSERT INTO calendar_day (tenant_id, organization_id, date, day_kind, schedule_template_id) VALUES ($1, $2, $3, 'instructional', $4) ON CONFLICT DO NOTHING`,
      [tenantA, schoolA, day, template],
    );
  }
  await pool.query(
    `INSERT INTO section_meeting (tenant_id, organization_id, section_id, schedule_block_id, location_id) VALUES ($1, $2, $3, $4, $5)`,
    [tenantA, schoolA, sectionA1, block, locationA],
  );
  await pool.query(
    `INSERT INTO section_meeting (tenant_id, organization_id, section_id, schedule_block_id, location_id) VALUES ($1, $2, $3, $4, $5)`,
    [tenantA, schoolA, sectionA2, block, locationA],
  );

  teacher = await makeStaff(tenantA, schoolA, 'Teacher');
  await pool.query(
    `INSERT INTO section_membership (tenant_id, section_id, person_id, role) VALUES ($1, $2, $3, 'teacher')`,
    [tenantA, sectionA1, teacher.personId],
  );

  counselor = await makeStaff(tenantA, schoolA, 'Counselor');
  await pool.query(
    `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind, organization_id) VALUES ($1, $2, 'counselor', 'organization', $3)`,
    [tenantA, counselor.accountId, schoolA],
  );

  schoolBCounselor = await makeStaff(tenantA, schoolB, 'BCounselor');
  await pool.query(
    `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind, organization_id) VALUES ($1, $2, 'counselor', 'organization', $3)`,
    [tenantA, schoolBCounselor.accountId, schoolB],
  );

  const sys = await makeStaff(tenantA, schoolA, 'Sys');
  await pool.query(
    `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind) VALUES ($1, $2, 'system_admin', 'tenant')`,
    [tenantA, sys.accountId],
  );
  sysadminCookie = sys.cookie;
  sysadminCsrf = sys.csrf;
  const recovery = await mintSession(tenantA, sys.accountId, 'recovery');
  recoveryCookie = recovery.cookie;
  recoveryCsrf = recovery.csrf;
}, 60_000);

afterAll(async () => {
  await app.close();
  await destroyDatabase();
  await pool.end();
  const client = new Client({ connectionString: administrationUrl });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS ${quotedIdentifier(databaseName)} WITH (FORCE)`);
  await client.end();
});

interface PassBody {
  id: string;
  organizationId: string;
  studentId: string;
  destination: { id: string; displayName: string; serviceType: string };
  origin: {
    placementKind: string;
    block: { id: string; code: string; displayName: string } | null;
    section: { id: string; code: string | null; title: string } | null;
    location: { id: string; name: string } | null;
  };
  requestSource: string;
  requestedAt: string;
  lifecycleState: string;
  revision: string;
}

describe('POST /api/v1/me/passes', () => {
  it('rejects anonymous callers with 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/me/passes',
      payload: { destinationId: destinationA },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects missing CSRF with 403', async () => {
    const student = await makeStudent(tenantA, schoolA, 'AnonCsrf');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/me/passes',
      headers: {
        cookie: `openhall_session_dev=${student.cookie}`,
        origin: ORIGIN,
        'idempotency-key': randomUUID(),
      },
      payload: { destinationId: destinationA },
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects missing Idempotency-Key with 400', async () => {
    const student = await makeStudent(tenantA, schoolA, 'NoKey');
    const response = await postSelfPass(
      { cookie: student.cookie, csrf: student.csrf },
      destinationA,
    );
    expect(response.statusCode).toBe(400);
  });

  it('creates a requested pass at revision 1 with ETag and no-store', async () => {
    const student = await makeStudent(tenantA, schoolA, 'Requester');
    await pool.query(
      `INSERT INTO section_membership (tenant_id, section_id, person_id, role) VALUES ($1, $2, $3, 'student')`,
      [tenantA, sectionA1, student.personId],
    );
    const before = await tableCount('pass_event');
    const response = await postSelfPass(
      { cookie: student.cookie, csrf: student.csrf },
      destinationA,
      randomUUID(),
    );
    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    const etag = response.headers.etag;
    expect(etag).toMatch(/^"pass:[0-9a-f-]{36}:1"$/);
    const body = response.json<{ pass: PassBody }>();
    expect(body.pass.lifecycleState).toBe('requested');
    expect(body.pass.revision).toBe('1');
    expect(body.pass.requestSource).toBe('student_web');
    expect(body.pass.studentId).toBe(student.personId);
    expect(body.pass.organizationId).toBe(schoolA);
    expect(body.pass.destination.id).toBe(destinationA);
    expect(body.pass.destination.displayName).toBe('Restroom B');
    expect(body.pass.origin.placementKind).toBe('resolved');
    expect(body.pass.origin.section?.code).toBe('HIST-3');
    const raw = JSON.stringify(body);
    for (const leaked of ['teacher', 'authorization_grant', 'accountId', 'email', 'session']) {
      expect(raw).not.toContain(leaked);
    }
    expect(await tableCount('pass_event')).toBe(before + 1);
  });

  it('replays the stored result for the same key without new side effects', async () => {
    const student = await makeStudent(tenantA, schoolA, 'Replayer');
    const key = randomUUID();
    const session = { cookie: student.cookie, csrf: student.csrf };
    const first = await postSelfPass(session, destinationA, key);
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<{ pass: PassBody }>();
    const counts = {
      pass: await tableCount('pass'),
      event: await tableCount('pass_event'),
      audit: await tableCount('audit_event'),
      outbox: await tableCount('outbox_event'),
      idempotency: await tableCount('idempotency_record'),
    };
    const second = await postSelfPass(session, destinationA, key);
    expect(second.statusCode).toBe(201);
    expect(second.json<{ pass: PassBody }>().pass.id).toBe(firstBody.pass.id);
    expect(second.headers.etag).toBe(first.headers.etag);
    expect(await tableCount('pass')).toBe(counts.pass);
    expect(await tableCount('pass_event')).toBe(counts.event);
    expect(await tableCount('audit_event')).toBe(counts.audit);
    expect(await tableCount('outbox_event')).toBe(counts.outbox);
    expect(await tableCount('idempotency_record')).toBe(counts.idempotency);
  });

  it('rejects the same key with a different destination as 409', async () => {
    const student = await makeStudent(tenantA, schoolA, 'KeyReuser');
    const key = randomUUID();
    const session = { cookie: student.cookie, csrf: student.csrf };
    const first = await postSelfPass(session, destinationA, key);
    expect(first.statusCode).toBe(201);
    const second = await postSelfPass(session, closedDestinationA, key);
    expect(second.statusCode).toBe(409);
    expect(second.json<{ code: string }>().code).toBe('idempotency_key_reused');
  });

  it('rejects a second active pass with 409 and no new rows', async () => {
    const student = await makeStudent(tenantA, schoolA, 'Doubler');
    const session = { cookie: student.cookie, csrf: student.csrf };
    const first = await postSelfPass(session, destinationA, randomUUID());
    expect(first.statusCode).toBe(201);
    const events = await tableCount('pass_event');
    const second = await postSelfPass(session, destinationA, randomUUID());
    expect(second.statusCode).toBe(409);
    expect(second.json<{ code: string }>().code).toBe('active_pass_exists');
    expect(await tableCount('pass_event')).toBe(events);
  });

  it('rejects a closed destination with 409 destination_unavailable', async () => {
    const student = await makeStudent(tenantA, schoolA, 'ClosedDest');
    const response = await postSelfPass(
      { cookie: student.cookie, csrf: student.csrf },
      closedDestinationA,
      randomUUID(),
    );
    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('destination_unavailable');
  });

  it('conceals other-school destinations with 404', async () => {
    const student = await makeStudent(tenantA, schoolA, 'OtherSchool');
    const response = await postSelfPass(
      { cookie: student.cookie, csrf: student.csrf },
      destinationB,
      randomUUID(),
    );
    expect(response.statusCode).toBe(404);
    expect(response.json<{ code: string }>().code).toBe('destination_not_found');
  });

  it('conceals cross-tenant destinations with 404', async () => {
    const student = await makeStudent(tenantA, schoolA, 'CrossTenant');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/me/passes',
      headers: authHeaders({ cookie: student.cookie, csrf: student.csrf }, randomUUID()),
      payload: { destinationId: crossTenantDestination },
    });
    expect(response.statusCode).toBe(404);
  });

  it('rejects self-requests from non-students', async () => {
    const staff = await makeStaff(tenantA, schoolA, 'Staffer');
    const response = await postSelfPass(
      { cookie: staff.cookie, csrf: staff.csrf },
      destinationA,
      randomUUID(),
    );
    expect(response.statusCode).toBe(404);
    expect(response.json<{ code: string }>().code).toBe('student_not_found');
  });

  it('rejects recovery sessions', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/me/passes',
      headers: authHeaders({ cookie: recoveryCookie, csrf: recoveryCsrf }, randomUUID()),
      payload: { destinationId: destinationA },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('recovery_session_restricted');
  });

  it('serializes concurrent identical keys into one mutation', async () => {
    const student = await makeStudent(tenantA, schoolA, 'Racer');
    const session = { cookie: student.cookie, csrf: student.csrf };
    const key = randomUUID();
    const eventsBefore = await tableCount('pass_event');
    const [left, right] = await Promise.all([
      postSelfPass(session, destinationA, key),
      postSelfPass(session, destinationA, key),
    ]);
    expect(left.statusCode).toBe(201);
    expect(right.statusCode).toBe(201);
    expect(left.json<{ pass: PassBody }>().pass.id).toBe(right.json<{ pass: PassBody }>().pass.id);
    expect(await tableCount('pass_event')).toBe(eventsBefore + 1);
  });

  it('lets exactly one of two concurrent keys win with active_pass_exists', async () => {
    const student = await makeStudent(tenantA, schoolA, 'Contender');
    const session = { cookie: student.cookie, csrf: student.csrf };
    const passesBefore = await tableCount('pass');
    const [left, right] = await Promise.all([
      postSelfPass(session, destinationA, randomUUID()),
      postSelfPass(session, destinationA, randomUUID()),
    ]);
    const codes = [left.statusCode, right.statusCode].sort();
    expect(codes).toEqual([201, 409]);
    const loser = left.statusCode === 409 ? left : right;
    expect(loser.json<{ code: string }>().code).toBe('active_pass_exists');
    expect(await tableCount('pass')).toBe(passesBefore + 1);
  });
});

describe('POST /api/v1/students/:studentId/passes', () => {
  async function postStaffPass(
    session: { cookie: string; csrf: string },
    studentId: string,
    destinationId: string,
    key: string,
  ) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentId}/passes`,
      headers: authHeaders(session, key),
      payload: { destinationId },
    });
  }

  it('lets a counselor create a staff_web pass with Cache-Control no-store', async () => {
    const student = await makeStudent(tenantA, schoolA, 'Counseled');
    if (counselor === null) throw new Error('counselor fixture missing');
    const response = await postStaffPass(
      { cookie: counselor.cookie, csrf: counselor.csrf },
      student.personId,
      destinationA,
      randomUUID(),
    );
    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json<{ pass: PassBody }>();
    expect(body.pass.requestSource).toBe('staff_web');
    expect(body.pass.studentId).toBe(student.personId);
    expect(body.pass.lifecycleState).toBe('requested');
    expect(body.pass.revision).toBe('1');
  });

  it('lets the current-section teacher create a pass', async () => {
    const sectionStudent = await makeStudent(tenantA, schoolA, 'SectionKid');
    await pool.query(
      `INSERT INTO section_membership (tenant_id, section_id, person_id, role) VALUES ($1, $2, $3, 'student')`,
      [tenantA, sectionA1, sectionStudent.personId],
    );
    if (teacher === null) throw new Error('teacher fixture missing');
    const response = await postStaffPass(
      { cookie: teacher.cookie, csrf: teacher.csrf },
      sectionStudent.personId,
      destinationA,
      randomUUID(),
    );
    expect(response.statusCode).toBe(201);
    expect(response.json<{ pass: PassBody }>().pass.requestSource).toBe('staff_web');
  });

  it('denies a teacher for a student in another current section', async () => {
    const otherStudent = await makeStudent(tenantA, schoolA, 'OtherSectionKid');
    await pool.query(
      `INSERT INTO section_membership (tenant_id, section_id, person_id, role) VALUES ($1, $2, $3, 'student')`,
      [tenantA, sectionA2, otherStudent.personId],
    );
    if (teacher === null) throw new Error('teacher fixture missing');
    const response = await postStaffPass(
      { cookie: teacher.cookie, csrf: teacher.csrf },
      otherStudent.personId,
      destinationA,
      randomUUID(),
    );
    expect(response.statusCode).toBe(403);
  });

  it('lets a system admin create a pass in the same tenant', async () => {
    const student = await makeStudent(tenantA, schoolA, 'AdminCreated');
    const response = await postStaffPass(
      { cookie: sysadminCookie, csrf: sysadminCsrf },
      student.personId,
      destinationA,
      randomUUID(),
    );
    expect(response.statusCode).toBe(201);
  });

  it('denies unauthorized staff without revealing student existence', async () => {
    // Authorization precedes the student lookup, so a caller without
    // authority learns nothing from missing versus active student IDs.
    if (teacher === null) throw new Error('teacher fixture missing');
    const missing = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${randomUUID()}/passes`,
      headers: authHeaders({ cookie: teacher.cookie, csrf: teacher.csrf }, randomUUID()),
      payload: { destinationId: destinationA },
    });
    expect(missing.statusCode).toBe(403);
    expect(missing.json<{ code: string }>().code).toBe('forbidden');
  });

  it('denies staff authority from another school', async () => {
    const student = await makeStudent(tenantA, schoolA, 'WrongSchool');
    if (schoolBCounselor === null) throw new Error('school B counselor missing');
    const response = await postStaffPass(
      { cookie: schoolBCounselor.cookie, csrf: schoolBCounselor.csrf },
      student.personId,
      destinationA,
      randomUUID(),
    );
    expect(response.statusCode).toBe(403);
  });
});

describe('GET /api/v1/me/passes/active', () => {
  it('returns pass:null with no-store when there is no active pass', async () => {
    const student = await makeStudent(tenantA, schoolA, 'Idle');
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/me/passes/active',
      headers: { cookie: `openhall_session_dev=${student.cookie}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json<{ pass: PassBody | null }>().pass).toBeNull();
  });

  it('returns the current requested pass with its ETag', async () => {
    const student = await makeStudent(tenantA, schoolA, 'Active');
    const session = { cookie: student.cookie, csrf: student.csrf };
    const created = await postSelfPass(session, destinationA, randomUUID());
    expect(created.statusCode).toBe(201);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/me/passes/active',
      headers: { cookie: `openhall_session_dev=${student.cookie}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ pass: PassBody }>();
    expect(body.pass.id).toBe(created.json<{ pass: PassBody }>().pass.id);
    expect(response.headers.etag).toBe(created.headers.etag);
  });

  it('rejects recovery sessions with 403', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/me/passes/active',
      headers: { cookie: `openhall_session_dev=${recoveryCookie}` },
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects anonymous callers with 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/me/passes/active' });
    expect(response.statusCode).toBe(401);
  });
});

describe('POST /api/v1/me/passes/:passId/cancel', () => {
  async function cancel(
    session: { cookie: string; csrf: string },
    passId: string,
    key: string,
    ifMatch?: string,
  ) {
    const headers: Record<string, string> = authHeaders(session, key);
    if (ifMatch !== undefined) headers['if-match'] = ifMatch;
    else delete headers['if-match'];
    return app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${passId}/cancel`,
      headers,
    });
  }

  it('requires If-Match with 428', async () => {
    const student = await makeStudent(tenantA, schoolA, 'Canceller428');
    const created = await postSelfPass(
      { cookie: student.cookie, csrf: student.csrf },
      destinationA,
      randomUUID(),
    );
    const passId = created.json<{ pass: PassBody }>().pass.id;
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${passId}/cancel`,
      headers: authHeaders({ cookie: student.cookie, csrf: student.csrf }, randomUUID()),
    });
    expect(response.statusCode).toBe(428);
    expect(response.json<{ code: string }>().code).toBe('precondition_required');
  });

  it('cancels at revision 2 with a new ETag', async () => {
    const student = await makeStudent(tenantA, schoolA, 'Canceller');
    const session = { cookie: student.cookie, csrf: student.csrf };
    const created = await postSelfPass(session, destinationA, randomUUID());
    expect(created.statusCode).toBe(201);
    const passId = created.json<{ pass: PassBody }>().pass.id;
    const etag = requiredEtag(created);
    const events = await tableCount('pass_event');
    const response = await cancel(session, passId, randomUUID(), etag);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json<{ pass: PassBody }>();
    expect(body.pass.lifecycleState).toBe('cancelled');
    expect(body.pass.revision).toBe('2');
    expect(response.headers.etag).toBe(`"pass:${passId}:2"`);
    expect(await tableCount('pass_event')).toBe(events + 1);
    const active = await app.inject({
      method: 'GET',
      url: '/api/v1/me/passes/active',
      headers: { cookie: `openhall_session_dev=${student.cookie}` },
    });
    expect(active.json<{ pass: PassBody | null }>().pass).toBeNull();
  });

  it('replays a lost cancellation response instead of 412', async () => {
    const student = await makeStudent(tenantA, schoolA, 'LostResponse');
    const session = { cookie: student.cookie, csrf: student.csrf };
    const created = await postSelfPass(session, destinationA, randomUUID());
    const passId = created.json<{ pass: PassBody }>().pass.id;
    const etag = requiredEtag(created);
    const key = randomUUID();
    const first = await cancel(session, passId, key, etag);
    expect(first.statusCode).toBe(200);
    const events = await tableCount('pass_event');
    const retry = await cancel(session, passId, key, etag);
    expect(retry.statusCode).toBe(200);
    expect(retry.json<{ pass: PassBody }>().pass.revision).toBe('2');
    expect(await tableCount('pass_event')).toBe(events);
  });

  it('rejects the same key with a different If-Match as 409', async () => {
    const student = await makeStudent(tenantA, schoolA, 'KeySwap');
    const session = { cookie: student.cookie, csrf: student.csrf };
    const created = await postSelfPass(session, destinationA, randomUUID());
    const passId = created.json<{ pass: PassBody }>().pass.id;
    const etag = requiredEtag(created);
    const key = randomUUID();
    const first = await cancel(session, passId, key, etag);
    expect(first.statusCode).toBe(200);
    const second = await cancel(session, passId, key, requiredEtag(first));
    expect(second.statusCode).toBe(409);
    expect(second.json<{ code: string }>().code).toBe('idempotency_key_reused');
  });

  it('rejects stale revisions with 412 for a new key', async () => {
    const student = await makeStudent(tenantA, schoolA, 'Stale');
    const session = { cookie: student.cookie, csrf: student.csrf };
    const created = await postSelfPass(session, destinationA, randomUUID());
    const passId = created.json<{ pass: PassBody }>().pass.id;
    const etag = requiredEtag(created);
    const first = await cancel(session, passId, randomUUID(), etag);
    expect(first.statusCode).toBe(200);
    const second = await cancel(session, passId, randomUUID(), etag);
    expect(second.statusCode).toBe(412);
    expect(second.json<{ code: string }>().code).toBe('stale_pass_revision');
  });

  it('conceals another student\u2019s pass with 404', async () => {
    const owner = await makeStudent(tenantA, schoolA, 'Owner');
    const intruder = await makeStudent(tenantA, schoolA, 'Intruder');
    const created = await postSelfPass(
      { cookie: owner.cookie, csrf: owner.csrf },
      destinationA,
      randomUUID(),
    );
    const passId = created.json<{ pass: PassBody }>().pass.id;
    const response = await cancel(
      { cookie: intruder.cookie, csrf: intruder.csrf },
      passId,
      randomUUID(),
      requiredEtag(created),
    );
    expect(response.statusCode).toBe(404);
    expect(response.json<{ code: string }>().code).toBe('pass_not_found');
  });

  it('rejects cancelling a departed pass with 409', async () => {
    const student = await makeStudent(tenantA, schoolA, 'Departed');
    const session = { cookie: student.cookie, csrf: student.csrf };
    const created = await postSelfPass(session, destinationA, randomUUID());
    const pass = created.json<{ pass: PassBody }>().pass;
    await pool.query(`UPDATE pass SET lifecycle_state = 'outbound', revision = 2 WHERE id = $1`, [
      pass.id,
    ]);
    const outboundEtag = `"pass:${pass.id}:2"`;
    const response = await cancel(session, pass.id, randomUUID(), outboundEtag);
    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('invalid_pass_transition');
  });

  it('waits on the row lock so exactly one cancellation wins', async () => {
    const student = await makeStudent(tenantA, schoolA, 'CancelRace');
    const session = { cookie: student.cookie, csrf: student.csrf };
    const created = await postSelfPass(session, destinationA, randomUUID());
    const passId = created.json<{ pass: PassBody }>().pass.id;
    const etag = requiredEtag(created);
    const events = await tableCount('pass_event');
    const [left, right] = await Promise.all([
      cancel(session, passId, randomUUID(), etag),
      cancel(session, passId, randomUUID(), etag),
    ]);
    const codes = [left.statusCode, right.statusCode].sort();
    expect(codes).toEqual([200, 412]);
    expect(await tableCount('pass_event')).toBe(events + 1);
  });
});

describe('pass command durability', () => {
  it('does not persist failed commands, so the same key succeeds later', async () => {
    const student = await makeStudent(tenantA, schoolA, 'RetryAfterFail');
    const session = { cookie: student.cookie, csrf: student.csrf };
    const key = randomUUID();
    const denied = await postSelfPass(session, closedDestinationA, key);
    expect(denied.statusCode).toBe(409);
    const idempotency = await tableCount('idempotency_record');
    const retry = await postSelfPass(session, destinationA, key);
    expect(retry.statusCode).toBe(201);
    expect(retry.json<{ pass: PassBody }>().pass.lifecycleState).toBe('requested');
    expect(await tableCount('idempotency_record')).toBe(idempotency + 1);
  });

  it('conceals cross-tenant students from staff requests', async () => {
    // Authorization precedes the lookup, so staff cannot probe whether an
    // unknown ID belongs to a student elsewhere: 403 either way.
    const outsiderId = await insertReturningId(
      `INSERT INTO person (tenant_id, given_name, family_name, display_name) VALUES ((SELECT tenant_id FROM organization WHERE id = $1), 'X', 'Y', 'X Y') RETURNING id`,
      [tenantBSchool],
    );
    if (counselor === null) throw new Error('counselor fixture missing');
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${outsiderId}/passes`,
      headers: authHeaders({ cookie: counselor.cookie, csrf: counselor.csrf }, randomUUID()),
      payload: { destinationId: destinationA },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('forbidden');
  });

  it('snapshots block-only placement without fabricating section or room', async () => {
    const student = await makeStudent(tenantA, schoolA, 'BlockOnly');
    const created = await postSelfPass(
      { cookie: student.cookie, csrf: student.csrf },
      destinationA,
      randomUUID(),
    );
    expect(created.statusCode).toBe(201);
    const body = created.json<{ pass: PassBody }>();
    expect(body.pass.origin.placementKind).toBe('block_only');
    expect(body.pass.origin.block?.code).toBe('P3');
    expect(body.pass.origin.section).toBeNull();
    expect(body.pass.origin.location).toBeNull();
    const row = (
      await pool.query<{
        origin_schedule_block_id: string | null;
        origin_section_id: string | null;
        origin_location_id: string | null;
      }>(
        `SELECT origin_schedule_block_id, origin_section_id, origin_location_id FROM pass WHERE id = $1`,
        [body.pass.id],
      )
    ).rows[0];
    expect(row?.origin_schedule_block_id).not.toBeNull();
    expect(row?.origin_section_id).toBeNull();
    expect(row?.origin_location_id).toBeNull();
    const metadata = (
      await pool.query<{ metadata: unknown }>(
        `SELECT metadata FROM pass_event WHERE pass_id = $1`,
        [body.pass.id],
      )
    ).rows[0]?.metadata as { origin: Record<string, unknown> };
    expect(metadata.origin.kind).toBe('block_only');
    expect(metadata.origin.blockId).toBe(row?.origin_schedule_block_id);
    expect(metadata.origin.sectionId).toBeUndefined();
    const active = await app.inject({
      method: 'GET',
      url: '/api/v1/me/passes/active',
      headers: { cookie: `openhall_session_dev=${student.cookie}` },
    });
    expect(active.json<{ pass: PassBody }>().pass.origin.placementKind).toBe(
      body.pass.origin.placementKind,
    );
  });

  it('records ambiguous placement without candidate IDs', async () => {
    const student = await makeStudent(tenantA, schoolA, 'Ambiguous');
    await pool.query(
      `INSERT INTO section_membership (tenant_id, section_id, person_id, role) VALUES ($1, $2, $3, 'student'), ($1, $4, $3, 'student')`,
      [tenantA, sectionA1, student.personId, sectionA2],
    );
    const created = await postSelfPass(
      { cookie: student.cookie, csrf: student.csrf },
      destinationA,
      randomUUID(),
    );
    expect(created.statusCode).toBe(201);
    const body = created.json<{ pass: PassBody }>();
    // The create response matches later reads, which derive the kind from
    // stored row fields; the detailed snapshot stays in pass.requested.
    expect(body.pass.origin.placementKind).toBe('unresolved');
    expect(body.pass.origin.section).toBeNull();
    const metadata = (
      await pool.query<{ metadata: unknown }>(
        `SELECT metadata FROM pass_event WHERE pass_id = $1`,
        [body.pass.id],
      )
    ).rows[0]?.metadata as { origin: Record<string, unknown> };
    expect(metadata.origin.kind).toBe('ambiguous');
    expect(metadata.origin.reason).toBe('multiple_placements');
    expect(JSON.stringify(metadata)).not.toContain(sectionA1);
    expect(JSON.stringify(metadata)).not.toContain(sectionA2);
  });

  it('records unconfigured calendars truthfully and minimally', async () => {
    const student = await makeStudent(tenantA, schoolB, 'NoCalendar');
    if (schoolBCounselor === null) throw new Error('school B counselor missing');
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${student.personId}/passes`,
      headers: authHeaders(
        { cookie: schoolBCounselor.cookie, csrf: schoolBCounselor.csrf },
        randomUUID(),
      ),
      payload: { destinationId: destinationB },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<{ pass: PassBody }>();
    expect(body.pass.origin.placementKind).toBe('unresolved');
    expect(body.pass.origin.block).toBeNull();
    expect(body.pass.origin.section).toBeNull();
    expect(body.pass.origin.location).toBeNull();
  });

  it('keeps pass events, audit, and outbox minimized', async () => {
    const student = await makeStudent(tenantA, schoolA, 'Minimized');
    await pool.query(
      `INSERT INTO section_membership (tenant_id, section_id, person_id, role) VALUES ($1, $2, $3, 'student')`,
      [tenantA, sectionA1, student.personId],
    );
    const created = await postSelfPass(
      { cookie: student.cookie, csrf: student.csrf },
      destinationA,
      randomUUID(),
    );
    expect(created.statusCode).toBe(201);
    const passId = created.json<{ pass: PassBody }>().pass.id;
    const event = (
      await pool.query<{ event_type: string; sequence: string; metadata: unknown }>(
        `SELECT event_type, sequence, metadata FROM pass_event WHERE pass_id = $1 ORDER BY sequence`,
        [passId],
      )
    ).rows;
    expect(event).toHaveLength(1);
    expect(event[0]?.event_type).toBe('pass.requested');
    const metadata = JSON.stringify(event[0]?.metadata);
    expect(metadata).toContain('"state":"requested"');
    for (const leaked of [
      'teacher',
      'authorization_grant',
      'email',
      'session',
      'csrf',
      'candidate',
    ]) {
      expect(metadata.toLowerCase()).not.toContain(leaked);
    }
    const outbox = (
      await pool.query<{ event_type: string; payload: unknown }>(
        `SELECT event_type, payload FROM outbox_event WHERE aggregate_id = $1`,
        [passId],
      )
    ).rows;
    expect(outbox.map((entry) => entry.event_type).sort()).toEqual(
      ['pass.policy_evaluated', 'pass.requested'].sort(),
    );
    const evaluated = outbox.find((entry) => entry.event_type === 'pass.policy_evaluated');
    expect((evaluated?.payload as { decision?: string }).decision).toBe('allow');
    for (const entry of outbox) {
      const payloadRaw = JSON.stringify(entry.payload);
      for (const leaked of ['teacher', 'email', 'session', 'displayname']) {
        expect(payloadRaw.toLowerCase()).not.toContain(leaked);
      }
    }
    const audit = (
      await pool.query<{ action: string; metadata: unknown }>(
        `SELECT action, metadata FROM audit_event WHERE target_id = $1`,
        [passId],
      )
    ).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]?.action).toBe('pass.requested');
    expect(JSON.stringify(audit[0]?.metadata).toLowerCase()).not.toContain('schedule');
  });
});
