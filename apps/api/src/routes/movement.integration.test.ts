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

async function makeStudent(
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

let tenantA = '';
let schoolA = '';
let sectionA1 = '';
let sectionA2 = '';
/** Unlimited restroom, check-in none, 10-minute default duration. */
let restroom = '';
/** Capacity 2 nurse, queue enabled, check-in required. */
let nurse = '';
/** Capacity 1 office, queue enabled, check-in optional. */
let office = '';
/** Capacity 1 closet, queue disabled. */
let closet = '';
let closedRestroom = '';
let otherSchoolNurse = '';
let crossTenantDestination = '';

let teacher: SessionFixture | null = null;
let counselor: SessionFixture | null = null;
let nurseStaff: SessionFixture | null = null;
let officeStaff: SessionFixture | null = null;
let recoveryCookie = '';
let recoveryCsrf = '';

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

async function tableCount(table: string, where = ''): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*) AS count FROM ${table} ${where}`,
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function passEvents(passId: string): Promise<{ event_type: string; sequence: string }[]> {
  const result = await pool.query<{ event_type: string; sequence: string }>(
    `SELECT event_type, sequence FROM pass_event WHERE pass_id = $1 ORDER BY sequence`,
    [passId],
  );
  return result.rows;
}

async function passLifecycle(passId: string): Promise<{ state: string; revision: string }> {
  const row = (
    await pool.query<{ lifecycle_state: string; revision: string }>(
      `SELECT lifecycle_state, revision FROM pass WHERE id = $1`,
      [passId],
    )
  ).rows[0];
  if (row === undefined) throw new Error('Pass row missing');
  return { state: row.lifecycle_state, revision: row.revision };
}

function requiredEtag(response: { headers: Record<string, unknown> }): string {
  const etag = response.headers.etag;
  if (typeof etag !== 'string') throw new Error('Expected ETag response header');
  return etag;
}

interface PassBody {
  id: string;
  organizationId: string;
  studentId: string;
  destination: { id: string; displayName: string; serviceType: string; checkInMode: string };
  lifecycleState: string;
  revision: string;
  policy: { decision: string } | null;
  movement: {
    readyUntil: string | null;
    queueEnteredAt: string | null;
    queueExpiresAt: string | null;
    expectedReturnAt: string | null;
    reasonCode: string | null;
  };
}

/**
 * Creates a fresh destination per test so capacity and queue assertions stay
 * deterministic: leftover ready/queued passes from other tests never shift
 * positions or fill capacity here.
 */
async function makeDestination(input: {
  serviceType?: string;
  displayName?: string;
  capacity?: number | null;
  queueEnabled?: boolean;
  checkInMode?: 'none' | 'optional' | 'required';
  defaultDurationSeconds?: number | null;
}): Promise<string> {
  const locationId = await insertReturningId(
    `INSERT INTO location (tenant_id, organization_id, kind, name) VALUES ($1, $2, 'classroom', $3) RETURNING id`,
    [tenantA, schoolA, `Room ${randomUUID().slice(0, 8)}`],
  );
  return insertReturningId(
    `INSERT INTO destination
       (tenant_id, organization_id, location_id, service_type, display_name, capacity, queue_enabled, check_in_mode, default_duration_seconds)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      tenantA,
      schoolA,
      locationId,
      input.serviceType ?? 'office',
      input.displayName ?? `Dest ${randomUUID().slice(0, 8)}`,
      input.capacity ?? null,
      input.queueEnabled ?? false,
      input.checkInMode ?? 'none',
      input.defaultDurationSeconds ?? null,
    ],
  );
}

/** Fresh capacity-1 queue-enabled optional office with station staff assigned. */
async function makeOfficeStation(staff: SessionFixture): Promise<string> {
  const destinationId = await makeDestination({
    serviceType: 'office',
    capacity: 1,
    queueEnabled: true,
    checkInMode: 'optional',
  });
  await pool.query(
    `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind, destination_id) VALUES ($1, $2, 'destination_staff', 'destination', $3)`,
    [tenantA, staff.accountId, destinationId],
  );
  return destinationId;
}

/** Fresh capacity-2 queue-enabled required nurse with station staff assigned. */
async function makeNurseStation(staff: SessionFixture): Promise<string> {
  const destinationId = await makeDestination({
    serviceType: 'nurse',
    capacity: 2,
    queueEnabled: true,
    checkInMode: 'required',
  });
  await pool.query(
    `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind, destination_id) VALUES ($1, $2, 'destination_staff', 'destination', $3)`,
    [tenantA, staff.accountId, destinationId],
  );
  return destinationId;
}

/** Requests a pass for a student and returns the ready pass body + ETag. */
async function requestReadyPass(
  student: SessionFixture,
  destinationId: string,
): Promise<{ pass: PassBody; etag: string }> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/me/passes',
    headers: authHeaders(student, randomUUID()),
    payload: { destinationId },
  });
  expect(created.statusCode).toBe(201);
  const pass = created.json<{ pass: PassBody }>().pass;
  expect(pass.lifecycleState).toBe('ready');
  return { pass, etag: requiredEtag(created) };
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
    destinationFlowWorkerEnabled: false,
    readinessProbe: {
      check: () => Promise.resolve({ migration: '008_school_control_plane' }),
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
  const schoolB = await insertReturningId(
    `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'B School', 'b-school', 'America/Chicago') RETURNING id`,
    [tenantA],
  );
  const tenantBSchool = await insertReturningId(
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
  const clinicA = await insertReturningId(
    `INSERT INTO location (tenant_id, organization_id, kind, name) VALUES ($1, $2, 'clinic', 'Clinic A') RETURNING id`,
    [tenantA, schoolA],
  );
  restroom = await insertReturningId(
    `INSERT INTO destination (tenant_id, organization_id, location_id, service_type, display_name, default_duration_seconds)
     VALUES ($1, $2, $3, 'restroom', 'Restroom B', 600) RETURNING id`,
    [tenantA, schoolA, locationA],
  );
  nurse = await insertReturningId(
    `INSERT INTO destination (tenant_id, organization_id, location_id, service_type, display_name, capacity, queue_enabled, check_in_mode)
     VALUES ($1, $2, $3, 'nurse', 'Nurse A', 2, true, 'required') RETURNING id`,
    [tenantA, schoolA, clinicA],
  );
  office = await insertReturningId(
    `INSERT INTO destination (tenant_id, organization_id, location_id, service_type, display_name, capacity, queue_enabled, check_in_mode)
     VALUES ($1, $2, $3, 'office', 'Office A', 1, true, 'optional') RETURNING id`,
    [tenantA, schoolA, locationA],
  );
  closet = await insertReturningId(
    `INSERT INTO destination (tenant_id, organization_id, location_id, service_type, display_name, capacity, queue_enabled)
     VALUES ($1, $2, $3, 'storage', 'Closet', 1, false) RETURNING id`,
    [tenantA, schoolA, locationA],
  );
  closedRestroom = await insertReturningId(
    `INSERT INTO destination (tenant_id, organization_id, location_id, service_type, display_name, status)
     VALUES ($1, $2, $3, 'restroom', 'Closed Restroom', 'closed') RETURNING id`,
    [tenantA, schoolA, locationA],
  );
  const locationB = await insertReturningId(
    `INSERT INTO location (tenant_id, organization_id, kind, name) VALUES ($1, $2, 'clinic', 'Clinic B') RETURNING id`,
    [tenantA, schoolB],
  );
  otherSchoolNurse = await insertReturningId(
    `INSERT INTO destination (tenant_id, organization_id, location_id, service_type, display_name)
     VALUES ($1, $2, $3, 'nurse', 'Nurse B') RETURNING id`,
    [tenantA, schoolB, locationB],
  );
  const tenantBLocation = await insertReturningId(
    `INSERT INTO location (tenant_id, organization_id, kind, name) VALUES ($1, $2, 'clinic', 'TB Clinic') RETURNING id`,
    [tenantB, tenantBSchool],
  );
  crossTenantDestination = await insertReturningId(
    `INSERT INTO destination (tenant_id, organization_id, location_id, service_type, display_name)
     VALUES ($1, $2, $3, 'nurse', 'TB Nurse') RETURNING id`,
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

  nurseStaff = await makeStaff(tenantA, schoolA, 'Nurse practical');
  await pool.query(
    `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind, destination_id) VALUES ($1, $2, 'destination_staff', 'destination', $3)`,
    [tenantA, nurseStaff.accountId, nurse],
  );

  officeStaff = await makeStaff(tenantA, schoolA, 'Office manager');
  await pool.query(
    `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind, destination_id) VALUES ($1, $2, 'destination_staff', 'destination', $3)`,
    [tenantA, officeStaff.accountId, office],
  );

  const sys = await makeStaff(tenantA, schoolA, 'Sys');
  await pool.query(
    `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind) VALUES ($1, $2, 'system_admin', 'tenant')`,
    [tenantA, sys.accountId],
  );
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

describe('POST /api/v1/me/passes/:passId/depart', () => {
  it('departs a ready pass with claimed capacity and expected return', async () => {
    const student = await makeStudent(tenantA, schoolA, 'Departurer');
    const { pass, etag } = await requestReadyPass(student, restroom);
    expect(pass.movement.readyUntil).not.toBeNull();
    const eventsBefore = await tableCount('pass_event');
    const departed = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${pass.id}/depart`,
      headers: authHeaders(student, randomUUID(), etag),
    });
    expect(departed.statusCode).toBe(200);
    expect(departed.headers['cache-control']).toBe('no-store');
    const body = departed.json<{ pass: PassBody }>().pass;
    expect(body.lifecycleState).toBe('outbound');
    expect(body.revision).toBe('3');
    expect(requiredEtag(departed)).toBe(`"pass:${pass.id}:3"`);
    // Ten-minute default duration snapshot at departure.
    expect(body.movement.expectedReturnAt).not.toBeNull();
    expect(body.movement.readyUntil).toBeNull();
    const eventRows = await passEvents(pass.id);
    expect(eventRows.map((entry) => entry.event_type)).toEqual([
      'pass.requested',
      'pass.ready',
      'pass.departed',
    ]);
    expect(await tableCount('pass_event')).toBe(eventsBefore + 1);
    const reservation = (
      await pool.query<{ claimed_at: Date | null; released_at: Date | null }>(
        `SELECT claimed_at, released_at FROM destination_reservation WHERE pass_id = $1`,
        [pass.id],
      )
    ).rows[0];
    expect(reservation?.claimed_at).not.toBeNull();
    expect(reservation?.released_at).toBeNull();
    const audit = await tableCount('audit_event', `WHERE target_id = '${pass.id}'`);
    expect(audit).toBeGreaterThanOrEqual(2);
  });

  it('requires active student membership in the pass school', async () => {
    const student = await makeStudent(tenantA, schoolA, 'Leaver');
    const { pass, etag } = await requestReadyPass(student, restroom);
    // Membership ends: departure is no longer authorized.
    await pool.query(`DELETE FROM organization_membership WHERE person_id = $1`, [
      student.personId,
    ]);
    const departed = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${pass.id}/depart`,
      headers: authHeaders(student, randomUUID(), etag),
    });
    expect(departed.statusCode).toBe(403);
    expect((await passLifecycle(pass.id)).state).toBe('ready');
  });

  it('rejects departure of a queued pass', async () => {
    const queuedOffice = await makeDestination({ capacity: 1, queueEnabled: true });
    const first = await makeStudent(tenantA, schoolA, 'OfficeOne');
    await requestReadyPass(first, queuedOffice);
    const second = await makeStudent(tenantA, schoolA, 'OfficeTwo');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/me/passes',
      headers: authHeaders(second, randomUUID()),
      payload: { destinationId: queuedOffice },
    });
    expect(created.statusCode).toBe(201);
    const queued = created.json<{ pass: PassBody }>().pass;
    expect(queued.lifecycleState).toBe('queued');
    const departed = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${queued.id}/depart`,
      headers: authHeaders(second, randomUUID(), requiredEtag(created)),
    });
    expect(departed.statusCode).toBe(409);
    expect(departed.json<{ code: string }>().code).toBe('invalid_pass_transition');
  });

  it('rejects an expired ready offer without mutating', async () => {
    const student = await makeStudent(tenantA, schoolA, 'Latecomer');
    const { pass, etag } = await requestReadyPass(student, restroom);
    // Age the offer honestly: the claim window stays after the offer, both in
    // the past, so coherence checks still hold while the offer is expired.
    await pool.query(
      `UPDATE destination_reservation
       SET reserved_at = statement_timestamp() - interval '120 seconds',
           ready_expires_at = statement_timestamp() - interval '60 seconds'
       WHERE pass_id = $1`,
      [pass.id],
    );
    const departed = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${pass.id}/depart`,
      headers: authHeaders(student, randomUUID(), etag),
    });
    expect(departed.statusCode).toBe(409);
    expect(departed.json<{ code: string }>().code).toBe('ready_offer_expired');
    expect((await passLifecycle(pass.id)).state).toBe('ready');
  });

  it('rejects departure when the destination closed after allocation', async () => {
    const student = await makeStudent(tenantA, schoolA, 'Shuttered');
    const { pass, etag } = await requestReadyPass(student, restroom);
    await pool.query(`UPDATE destination SET status = 'closed' WHERE id = $1`, [restroom]);
    try {
      const departed = await app.inject({
        method: 'POST',
        url: `/api/v1/me/passes/${pass.id}/depart`,
        headers: authHeaders(student, randomUUID(), etag),
      });
      expect(departed.statusCode).toBe(409);
      expect(departed.json<{ code: string }>().code).toBe('destination_unavailable');
      expect((await passLifecycle(pass.id)).state).toBe('ready');
    } finally {
      await pool.query(`UPDATE destination SET status = 'active' WHERE id = $1`, [restroom]);
    }
  });

  it('replays the stored departure instead of 412', async () => {
    const student = await makeStudent(tenantA, schoolA, 'ReplayDepart');
    const { pass, etag } = await requestReadyPass(student, restroom);
    const key = randomUUID();
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${pass.id}/depart`,
      headers: authHeaders(student, key, etag),
    });
    expect(first.statusCode).toBe(200);
    const events = await tableCount('pass_event');
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${pass.id}/depart`,
      headers: authHeaders(student, key, etag),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(await tableCount('pass_event')).toBe(events);
  });

  it('rejects stale revisions and missing preconditions', async () => {
    const student = await makeStudent(tenantA, schoolA, 'StaleDepart');
    const { pass } = await requestReadyPass(student, restroom);
    const stale = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${pass.id}/depart`,
      headers: authHeaders(student, randomUUID(), `"pass:${pass.id}:1"`),
    });
    expect(stale.statusCode).toBe(412);
    const missing = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${pass.id}/depart`,
      headers: authHeaders(student, randomUUID()),
    });
    expect(missing.statusCode).toBe(428);
    expect((await passLifecycle(pass.id)).state).toBe('ready');
  });

  it('conceals other students and cross-tenant passes with 404', async () => {
    const owner = await makeStudent(tenantA, schoolA, 'DepartOwner');
    const intruder = await makeStudent(tenantA, schoolA, 'DepartIntruder');
    const { pass, etag } = await requestReadyPass(owner, restroom);
    const forged = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${pass.id}/depart`,
      headers: authHeaders(intruder, randomUUID(), etag),
    });
    expect(forged.statusCode).toBe(404);
    expect((await passLifecycle(pass.id)).state).toBe('ready');
  });

  it('rejects recovery sessions', async () => {
    const student = await makeStudent(tenantA, schoolA, 'DepartRecovery');
    const { pass, etag } = await requestReadyPass(student, restroom);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${pass.id}/depart`,
      headers: {
        cookie: `openhall_session_dev=${recoveryCookie}`,
        'x-csrf-token': recoveryCsrf,
        origin: ORIGIN,
        'idempotency-key': randomUUID(),
        'if-match': etag,
      },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('destination capacity allocation', () => {
  it('denies with destination_capacity_full when full without a queue', async () => {
    const first = await makeStudent(tenantA, schoolA, 'ClosetFirst');
    await requestReadyPass(first, closet);
    const second = await makeStudent(tenantA, schoolA, 'ClosetSecond');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/me/passes',
      headers: authHeaders(second, randomUUID()),
      payload: { destinationId: closet },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json<{ pass: PassBody }>().pass;
    expect(body.lifecycleState).toBe('denied');
    expect(body.movement.reasonCode).toBe('destination_capacity_full');
    expect(body.policy?.decision).toBe('allow');
    expect((await passEvents(body.id)).map((entry) => entry.event_type)).toEqual([
      'pass.requested',
      'pass.denied',
    ]);
  });

  it('rejects requests at a closed destination without creating a pass', async () => {
    const student = await makeStudent(tenantA, schoolA, 'ClosedWalker');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/me/passes',
      headers: authHeaders(student, randomUUID()),
      payload: { destinationId: closedRestroom },
    });
    expect(created.statusCode).toBe(409);
    expect(created.json<{ code: string }>().code).toBe('destination_unavailable');
  });

  it('conceals other-school destinations with 404', async () => {
    const student = await makeStudent(tenantA, schoolA, 'OtherSchooler');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/me/passes',
      headers: authHeaders(student, randomUUID()),
      payload: { destinationId: otherSchoolNurse },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /api/v1/passes/:passId/depart', () => {
  it('lets a counselor depart a device-less student', async () => {
    if (counselor === null) throw new Error('counselor fixture missing');
    const student = await makeStudent(tenantA, schoolA, 'Deviceless');
    const { pass, etag } = await requestReadyPass(student, restroom);
    const departed = await app.inject({
      method: 'POST',
      url: `/api/v1/passes/${pass.id}/depart`,
      headers: authHeaders(counselor, randomUUID(), etag),
    });
    expect(departed.statusCode).toBe(200);
    expect(departed.json<{ pass: PassBody }>().pass.lifecycleState).toBe('outbound');
    expect((await passLifecycle(pass.id)).state).toBe('outbound');
  });

  it('lets the current-section teacher depart through the fallback', async () => {
    if (teacher === null) throw new Error('teacher fixture missing');
    const student = await makeStudent(tenantA, schoolA, 'SectionDepart');
    await pool.query(
      `INSERT INTO section_membership (tenant_id, section_id, person_id, role) VALUES ($1, $2, $3, 'student')`,
      [tenantA, sectionA1, student.personId],
    );
    const { pass, etag } = await requestReadyPass(student, restroom);
    const departed = await app.inject({
      method: 'POST',
      url: `/api/v1/passes/${pass.id}/depart`,
      headers: authHeaders(teacher, randomUUID(), etag),
    });
    expect(departed.statusCode).toBe(200);
    expect(departed.json<{ pass: PassBody }>().pass.lifecycleState).toBe('outbound');
  });

  it('conceals passes from teachers of other sections and other tenants', async () => {
    if (teacher === null) throw new Error('teacher fixture missing');
    const student = await makeStudent(tenantA, schoolA, 'OtherSectionDepart');
    await pool.query(
      `INSERT INTO section_membership (tenant_id, section_id, person_id, role) VALUES ($1, $2, $3, 'student')`,
      [tenantA, sectionA2, student.personId],
    );
    const { pass, etag } = await requestReadyPass(student, restroom);
    const forged = await app.inject({
      method: 'POST',
      url: `/api/v1/passes/${pass.id}/depart`,
      headers: authHeaders(teacher, randomUUID(), etag),
    });
    expect(forged.statusCode).toBe(404);
    expect((await passLifecycle(pass.id)).state).toBe('ready');
  });
});

describe('self arrival, return, and completion', () => {
  async function departFor(student: SessionFixture, destinationId: string) {
    const { pass, etag } = await requestReadyPass(student, destinationId);
    const departed = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${pass.id}/depart`,
      headers: authHeaders(student, randomUUID(), etag),
    });
    expect(departed.statusCode).toBe(200);
    return departed.json<{ pass: PassBody }>().pass;
  }

  it('arrives at an optional destination', async () => {
    const student = await makeStudent(tenantA, schoolA, 'Arriver');
    const arriveOffice = await makeDestination({
      capacity: 1,
      queueEnabled: true,
      checkInMode: 'optional',
    });
    const outbound = await departFor(student, arriveOffice);
    expect(outbound.lifecycleState).toBe('outbound');
    const arrived = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${outbound.id}/arrive`,
      headers: authHeaders(student, randomUUID(), `"pass:${outbound.id}:${outbound.revision}"`),
    });
    expect(arrived.statusCode).toBe(200);
    expect(arrived.json<{ pass: PassBody }>().pass.lifecycleState).toBe('at_destination');
  });

  it('refuses self arrival at none and required destinations', async () => {
    const plain = await makeStudent(tenantA, schoolA, 'NoCheckpoint');
    const outboundPlain = await departFor(plain, restroom);
    const noneArrive = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${outboundPlain.id}/arrive`,
      headers: authHeaders(
        plain,
        randomUUID(),
        `"pass:${outboundPlain.id}:${outboundPlain.revision}"`,
      ),
    });
    expect(noneArrive.statusCode).toBe(409);
    expect(noneArrive.json<{ code: string }>().code).toBe('check_in_not_supported');

    const clinical = await makeStudent(tenantA, schoolA, 'NeedsStation');
    const needyNurse = await makeDestination({
      capacity: 2,
      queueEnabled: true,
      checkInMode: 'required',
    });
    const outboundRequired = await departFor(clinical, needyNurse);
    const requiredArrive = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${outboundRequired.id}/arrive`,
      headers: authHeaders(
        clinical,
        randomUUID(),
        `"pass:${outboundRequired.id}:${outboundRequired.revision}"`,
      ),
    });
    expect(requiredArrive.statusCode).toBe(409);
    expect(requiredArrive.json<{ code: string }>().code).toBe('station_check_in_required');
  });

  it('begins return and releases destination capacity', async () => {
    const student = await makeStudent(tenantA, schoolA, 'Returner');
    await pool.query(
      `INSERT INTO section_membership (tenant_id, section_id, person_id, role) VALUES ($1, $2, $3, 'student')`,
      [tenantA, sectionA1, student.personId],
    );
    const returnOffice = await makeDestination({
      capacity: 1,
      queueEnabled: true,
      checkInMode: 'optional',
    });
    const outbound = await departFor(student, returnOffice);
    const arrived = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${outbound.id}/arrive`,
      headers: authHeaders(student, randomUUID(), `"pass:${outbound.id}:${outbound.revision}"`),
    });
    const atDestination = arrived.json<{ pass: PassBody }>().pass;
    const returning = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${outbound.id}/return`,
      headers: authHeaders(
        student,
        randomUUID(),
        `"pass:${outbound.id}:${atDestination.revision}"`,
      ),
    });
    expect(returning.statusCode).toBe(200);
    const body = returning.json<{ pass: PassBody }>().pass;
    expect(body.lifecycleState).toBe('returning');
    const row = (
      await pool.query<{ return_location_id: string | null }>(
        `SELECT return_location_id FROM pass WHERE id = $1`,
        [outbound.id],
      )
    ).rows[0];
    expect(row?.return_location_id).not.toBeNull();
    const reservation = (
      await pool.query<{ release_reason: string | null }>(
        `SELECT release_reason FROM destination_reservation WHERE pass_id = $1`,
        [outbound.id],
      )
    ).rows[0];
    expect(reservation?.release_reason).toBe('return_started');
  });

  it('completes an outbound movement with no fabricated checkpoints', async () => {
    const student = await makeStudent(tenantA, schoolA, 'Lightweight');
    const outbound = await departFor(student, restroom);
    const completed = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${outbound.id}/complete`,
      headers: authHeaders(student, randomUUID(), `"pass:${outbound.id}:${outbound.revision}"`),
    });
    expect(completed.statusCode).toBe(200);
    const body = completed.json<{ pass: PassBody }>().pass;
    expect(body.lifecycleState).toBe('completed');
    const events = await passEvents(outbound.id);
    expect(events.map((entry) => entry.event_type)).toEqual([
      'pass.requested',
      'pass.ready',
      'pass.departed',
      'pass.completed',
    ]);
    // Only pass.completed was emitted for the final transition.
    expect(events.filter((entry) => entry.event_type === 'pass.completed')).toHaveLength(1);
    const reservation = (
      await pool.query<{ release_reason: string | null }>(
        `SELECT release_reason FROM destination_reservation WHERE pass_id = $1`,
        [outbound.id],
      )
    ).rows[0];
    expect(reservation?.release_reason).toBe('completed');
  });

  it('completes after returning and at optional destinations', async () => {
    const student = await makeStudent(tenantA, schoolA, 'ReturnCompleter');
    const completeOffice = await makeDestination({
      capacity: 1,
      queueEnabled: true,
      checkInMode: 'optional',
    });
    const outbound = await departFor(student, completeOffice);
    const arrived = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${outbound.id}/arrive`,
      headers: authHeaders(student, randomUUID(), `"pass:${outbound.id}:${outbound.revision}"`),
    });
    const atDestination = arrived.json<{ pass: PassBody }>().pass;
    const returning = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${outbound.id}/return`,
      headers: authHeaders(
        student,
        randomUUID(),
        `"pass:${outbound.id}:${atDestination.revision}"`,
      ),
    });
    const returningBody = returning.json<{ pass: PassBody }>().pass;
    const completed = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${outbound.id}/complete`,
      headers: authHeaders(
        student,
        randomUUID(),
        `"pass:${outbound.id}:${returningBody.revision}"`,
      ),
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json<{ pass: PassBody }>().pass.lifecycleState).toBe('completed');

    const direct = await makeStudent(tenantA, schoolA, 'OfficeCompleter');
    const directOffice = await makeDestination({
      capacity: 1,
      queueEnabled: true,
      checkInMode: 'optional',
    });
    const directOutbound = await departFor(direct, directOffice);
    const directArrived = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${directOutbound.id}/arrive`,
      headers: authHeaders(
        direct,
        randomUUID(),
        `"pass:${directOutbound.id}:${directOutbound.revision}"`,
      ),
    });
    const directAt = directArrived.json<{ pass: PassBody }>().pass;
    const directCompleted = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${directOutbound.id}/complete`,
      headers: authHeaders(
        direct,
        randomUUID(),
        `"pass:${directOutbound.id}:${directAt.revision}"`,
      ),
    });
    expect(directCompleted.statusCode).toBe(200);
    expect(directCompleted.json<{ pass: PassBody }>().pass.lifecycleState).toBe('completed');
  });

  it('refuses direct self completion at required destinations', async () => {
    const outboundStudent = await makeStudent(tenantA, schoolA, 'RequiredOutbound');
    const requiredNurse = await makeDestination({
      capacity: 2,
      queueEnabled: true,
      checkInMode: 'required',
    });
    const outbound = await departFor(outboundStudent, requiredNurse);
    const early = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${outbound.id}/complete`,
      headers: authHeaders(
        outboundStudent,
        randomUUID(),
        `"pass:${outbound.id}:${outbound.revision}"`,
      ),
    });
    expect(early.statusCode).toBe(409);
    expect(early.json<{ code: string }>().code).toBe('station_check_in_required');
  });

  it('serializes self completion against station completion', async () => {
    if (officeStaff === null) throw new Error('office fixture missing');
    const student = await makeStudent(tenantA, schoolA, 'CompleteRace');
    const raceOffice = await makeOfficeStation(officeStaff);
    const outbound = await departFor(student, raceOffice);
    const arrived = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${outbound.id}/arrive`,
      headers: authHeaders(student, randomUUID(), `"pass:${outbound.id}:${outbound.revision}"`),
    });
    const atDestination = arrived.json<{ pass: PassBody }>().pass;
    const etag = `"pass:${outbound.id}:${atDestination.revision}"`;
    const [selfDone, stationDone] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/v1/me/passes/${outbound.id}/complete`,
        headers: authHeaders(student, randomUUID(), etag),
      }),
      app.inject({
        method: 'POST',
        url: `/api/v1/destinations/${raceOffice}/passes/${outbound.id}/complete`,
        headers: authHeaders(officeStaff, randomUUID(), etag),
      }),
    ]);
    const codes = [selfDone.statusCode, stationDone.statusCode].sort();
    expect(codes).toEqual([200, 412]);
    expect((await passLifecycle(outbound.id)).state).toBe('completed');
  });
});

describe('destination station commands', () => {
  async function departFor(student: SessionFixture, destinationId: string) {
    const { pass, etag } = await requestReadyPass(student, destinationId);
    const departed = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${pass.id}/depart`,
      headers: authHeaders(student, randomUUID(), etag),
    });
    expect(departed.statusCode).toBe(200);
    return departed.json<{ pass: PassBody }>().pass;
  }

  it('checks in arrivals at a required destination', async () => {
    if (nurseStaff === null) throw new Error('nurse fixture missing');
    const student = await makeStudent(tenantA, schoolA, 'Patient');
    const checkinNurse = await makeNurseStation(nurseStaff);
    const outbound = await departFor(student, checkinNurse);
    const checkedIn = await app.inject({
      method: 'POST',
      url: `/api/v1/destinations/${checkinNurse}/passes/${outbound.id}/check-in`,
      headers: authHeaders(nurseStaff, randomUUID(), `"pass:${outbound.id}:${outbound.revision}"`),
    });
    expect(checkedIn.statusCode).toBe(200);
    expect(checkedIn.json<{ pass: PassBody }>().pass.lifecycleState).toBe('at_destination');
    const events = await passEvents(outbound.id);
    expect(events.map((entry) => entry.event_type)).toContain('pass.arrived');
  });

  it('refuses station operations for the wrong destination', async () => {
    if (nurseStaff === null || officeStaff === null) throw new Error('fixture missing');
    const student = await makeStudent(tenantA, schoolA, 'WrongDesk');
    const wrongNurse = await makeNurseStation(nurseStaff);
    const wrongOffice = await makeOfficeStation(officeStaff);
    const outbound = await departFor(student, wrongNurse);
    const etag = `"pass:${outbound.id}:${outbound.revision}"`;
    // Office staff operate the office station, not the nurse station.
    const forged = await app.inject({
      method: 'POST',
      url: `/api/v1/destinations/${wrongNurse}/passes/${outbound.id}/check-in`,
      headers: authHeaders(officeStaff, randomUUID(), etag),
    });
    expect(forged.statusCode).toBe(404);
    // A valid nurse pass is not operable from the office station either.
    const crossed = await app.inject({
      method: 'POST',
      url: `/api/v1/destinations/${wrongOffice}/passes/${outbound.id}/check-in`,
      headers: authHeaders(officeStaff, randomUUID(), etag),
    });
    expect(crossed.statusCode).toBe(404);
    expect((await passLifecycle(outbound.id)).state).toBe('outbound');
  });

  it('completes one-way movement at the station and refuses skipping arrival', async () => {
    if (nurseStaff === null) throw new Error('nurse fixture missing');
    const student = await makeStudent(tenantA, schoolA, 'OneWay');
    const oneWayNurse = await makeNurseStation(nurseStaff);
    const outbound = await departFor(student, oneWayNurse);
    const etag = `"pass:${outbound.id}:${outbound.revision}"`;
    // No arrival checkpoint may be skipped: station completion needs one.
    const early = await app.inject({
      method: 'POST',
      url: `/api/v1/destinations/${oneWayNurse}/passes/${outbound.id}/complete`,
      headers: authHeaders(nurseStaff, randomUUID(), etag),
    });
    expect(early.statusCode).toBe(409);
    const checkedIn = await app.inject({
      method: 'POST',
      url: `/api/v1/destinations/${oneWayNurse}/passes/${outbound.id}/check-in`,
      headers: authHeaders(nurseStaff, randomUUID(), etag),
    });
    expect(checkedIn.statusCode).toBe(200);
    const atDestination = checkedIn.json<{ pass: PassBody }>().pass;
    const completed = await app.inject({
      method: 'POST',
      url: `/api/v1/destinations/${oneWayNurse}/passes/${outbound.id}/complete`,
      headers: authHeaders(
        nurseStaff,
        randomUUID(),
        `"pass:${outbound.id}:${atDestination.revision}"`,
      ),
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json<{ pass: PassBody }>().pass.lifecycleState).toBe('completed');
    const reservation = (
      await pool.query<{ release_reason: string | null }>(
        `SELECT release_reason FROM destination_reservation WHERE pass_id = $1`,
        [outbound.id],
      )
    ).rows[0];
    expect(reservation?.release_reason).toBe('completed');
  });

  it('begins return from the station and frees capacity', async () => {
    if (officeStaff === null) throw new Error('office fixture missing');
    const student = await makeStudent(tenantA, schoolA, 'StationReturn');
    const stationOffice = await makeOfficeStation(officeStaff);
    const outbound = await departFor(student, stationOffice);
    const checkedIn = await app.inject({
      method: 'POST',
      url: `/api/v1/destinations/${stationOffice}/passes/${outbound.id}/check-in`,
      headers: authHeaders(officeStaff, randomUUID(), `"pass:${outbound.id}:${outbound.revision}"`),
    });
    const atDestination = checkedIn.json<{ pass: PassBody }>().pass;
    const begun = await app.inject({
      method: 'POST',
      url: `/api/v1/destinations/${stationOffice}/passes/${outbound.id}/begin-return`,
      headers: authHeaders(
        officeStaff,
        randomUUID(),
        `"pass:${outbound.id}:${atDestination.revision}"`,
      ),
    });
    expect(begun.statusCode).toBe(200);
    expect(begun.json<{ pass: PassBody }>().pass.lifecycleState).toBe('returning');
    const reservation = (
      await pool.query<{ release_reason: string | null }>(
        `SELECT release_reason FROM destination_reservation WHERE pass_id = $1`,
        [outbound.id],
      )
    ).rows[0];
    expect(reservation?.release_reason).toBe('return_started');
  });
});

describe('GET /api/v1/me/passes/:passId/queue-status', () => {
  it('reports derived positions without leaking other students', async () => {
    const statusOffice = await makeDestination({ capacity: 1, queueEnabled: true });
    const first = await makeStudent(tenantA, schoolA, 'QueueFirst');
    await requestReadyPass(first, statusOffice);
    const second = await makeStudent(tenantA, schoolA, 'QueueSecond');
    const createdSecond = await app.inject({
      method: 'POST',
      url: '/api/v1/me/passes',
      headers: authHeaders(second, randomUUID()),
      payload: { destinationId: statusOffice },
    });
    const secondPass = createdSecond.json<{ pass: PassBody }>().pass;
    expect(secondPass.lifecycleState).toBe('queued');
    const third = await makeStudent(tenantA, schoolA, 'QueueThird');
    const createdThird = await app.inject({
      method: 'POST',
      url: '/api/v1/me/passes',
      headers: authHeaders(third, randomUUID()),
      payload: { destinationId: statusOffice },
    });
    const thirdPass = createdThird.json<{ pass: PassBody }>().pass;
    expect(thirdPass.lifecycleState).toBe('queued');

    const secondStatus = await app.inject({
      method: 'GET',
      url: `/api/v1/me/passes/${secondPass.id}/queue-status`,
      headers: { cookie: `openhall_session_dev=${second.cookie}` },
    });
    expect(secondStatus.statusCode).toBe(200);
    expect(secondStatus.headers['cache-control']).toBe('no-store');
    expect(secondStatus.headers.etag).toBeUndefined();
    const secondBody = secondStatus.json<{
      position: number;
      ahead: number;
      enteredAt: string;
      expiresAt: string;
    }>();
    expect(secondBody.position).toBe(1);
    expect(secondBody.ahead).toBe(0);

    const thirdStatus = await app.inject({
      method: 'GET',
      url: `/api/v1/me/passes/${thirdPass.id}/queue-status`,
      headers: { cookie: `openhall_session_dev=${third.cookie}` },
    });
    expect(thirdStatus.json<{ position: number; ahead: number }>().position).toBe(2);
    expect(thirdStatus.json<{ position: number; ahead: number }>().ahead).toBe(1);

    // Another student's queued pass stays concealed.
    const forged = await app.inject({
      method: 'GET',
      url: `/api/v1/me/passes/${secondPass.id}/queue-status`,
      headers: { cookie: `openhall_session_dev=${third.cookie}` },
    });
    expect(forged.statusCode).toBe(404);

    // A ready pass has no queue status.
    const readyStatus = await app.inject({
      method: 'GET',
      url: `/api/v1/me/passes/${secondPass.id}/queue-status`,
      headers: { cookie: `openhall_session_dev=${second.cookie}` },
    });
    expect(readyStatus.statusCode).toBe(200);
    const readyPass = await makeStudent(tenantA, schoolA, 'QueueReady');
    const { pass: ready } = await requestReadyPass(readyPass, restroom);
    const notQueued = await app.inject({
      method: 'GET',
      url: `/api/v1/me/passes/${ready.id}/queue-status`,
      headers: { cookie: `openhall_session_dev=${readyPass.cookie}` },
    });
    expect(notQueued.statusCode).toBe(409);
    expect(notQueued.json<{ code: string }>().code).toBe('queue_status_unavailable');
  });
});

describe('GET /api/v1/destinations/:destinationId/station', () => {
  it('serves minimized aggregates to authorized station staff', async () => {
    if (officeStaff === null) throw new Error('office fixture missing');
    const viewOffice = await makeOfficeStation(officeStaff);
    const first = await makeStudent(tenantA, schoolA, 'StationFirst');
    await requestReadyPass(first, viewOffice);
    const second = await makeStudent(tenantA, schoolA, 'StationSecond');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/me/passes',
      headers: authHeaders(second, randomUUID()),
      payload: { destinationId: viewOffice },
    });
    const secondPass = created.json<{ pass: PassBody }>().pass;

    const view = await app.inject({
      method: 'GET',
      url: `/api/v1/destinations/${viewOffice}/station`,
      headers: { cookie: `openhall_session_dev=${officeStaff.cookie}` },
    });
    expect(view.statusCode).toBe(200);
    expect(view.headers['cache-control']).toBe('no-store');
    expect(view.headers.etag).toBeUndefined();
    const body = view.json<{
      destination: {
        id: string;
        displayName: string;
        serviceType: string;
        checkInMode: string;
        capacity: number | null;
      };
      occupancy: { consumingReservations: number; availableCapacity: number | null };
      queueCount: number;
      ready: {
        passId: string;
        passRevision: string;
        passEtag: string;
        student: { id: string; displayName: string };
        readyUntil: string;
      }[];
      outbound: unknown[];
      atDestination: unknown[];
      queued: {
        passId: string;
        passRevision: string;
        passEtag: string;
        student: { id: string; displayName: string };
        enteredAt: string;
      }[];
    }>();
    expect(body.destination).toMatchObject({
      id: viewOffice,
      serviceType: 'office',
      checkInMode: 'optional',
      capacity: 1,
    });
    expect(body.occupancy).toEqual({ consumingReservations: 1, availableCapacity: 0 });
    expect(body.queueCount).toBe(1);
    expect(body.ready.map((entry) => entry.passId)).toHaveLength(1);
    expect(body.queued.map((entry) => entry.passId)).toEqual([secondPass.id]);
    expect(body.ready[0]?.student.displayName).toContain('StationFirst');
    const readyEntry = body.ready[0];
    const queuedEntry = body.queued[0];
    if (readyEntry === undefined || queuedEntry === undefined)
      throw new Error('station fixtures missing');
    expect(readyEntry.passEtag).toBe(`"pass:${readyEntry.passId}:${readyEntry.passRevision}"`);
    expect(queuedEntry.passEtag).toBe(`"pass:${queuedEntry.passId}:${queuedEntry.passRevision}"`);
    const raw = JSON.stringify(body);
    for (const leaked of ['authorization_grant', 'accountId', 'email', 'session', 'override']) {
      expect(raw.toLowerCase()).not.toContain(leaked);
    }
  });

  it('conceals the station from unauthorized staff and tenants', async () => {
    if (teacher === null) throw new Error('teacher fixture missing');
    const denied = await app.inject({
      method: 'GET',
      url: `/api/v1/destinations/${office}/station`,
      headers: { cookie: `openhall_session_dev=${teacher.cookie}` },
    });
    expect(denied.statusCode).toBe(404);
    const crossTenant = await app.inject({
      method: 'GET',
      url: `/api/v1/destinations/${crossTenantDestination}/station`,
      headers: { cookie: `openhall_session_dev=${teacher.cookie}` },
    });
    expect(crossTenant.statusCode).toBe(404);
  });
});

describe('flow-aware cancellation', () => {
  it('releases the queue entry when a queued pass is cancelled', async () => {
    const cancelOffice = await makeDestination({ capacity: 1, queueEnabled: true });
    const first = await makeStudent(tenantA, schoolA, 'CancelQueueFirst');
    await requestReadyPass(first, cancelOffice);
    const second = await makeStudent(tenantA, schoolA, 'CancelQueued');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/me/passes',
      headers: authHeaders(second, randomUUID()),
      payload: { destinationId: cancelOffice },
    });
    const queued = created.json<{ pass: PassBody }>().pass;
    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${queued.id}/cancel`,
      headers: authHeaders(second, randomUUID(), requiredEtag(created)),
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json<{ pass: PassBody }>().pass.lifecycleState).toBe('cancelled');
    const entry = (
      await pool.query<{ released_at: Date | null; release_reason: string | null }>(
        `SELECT released_at, release_reason FROM queue_entry WHERE pass_id = $1`,
        [queued.id],
      )
    ).rows[0];
    expect(entry?.released_at).not.toBeNull();
    expect(entry?.release_reason).toBe('cancelled');
  });

  it('releases the reservation when a ready pass is cancelled', async () => {
    const student = await makeStudent(tenantA, schoolA, 'CancelReady');
    const cancelReadyOffice = await makeDestination({ capacity: 1, queueEnabled: true });
    const { pass, etag } = await requestReadyPass(student, cancelReadyOffice);
    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${pass.id}/cancel`,
      headers: authHeaders(student, randomUUID(), etag),
    });
    expect(cancelled.statusCode).toBe(200);
    const reservation = (
      await pool.query<{ released_at: Date | null; release_reason: string | null }>(
        `SELECT released_at, release_reason FROM destination_reservation WHERE pass_id = $1`,
        [pass.id],
      )
    ).rows[0];
    expect(reservation?.released_at).not.toBeNull();
    expect(reservation?.release_reason).toBe('cancelled');
  });

  it('races cancellation against departure so only one wins', async () => {
    const student = await makeStudent(tenantA, schoolA, 'CancelDepartRace');
    const { pass, etag } = await requestReadyPass(student, restroom);
    const [cancelled, departed] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/v1/me/passes/${pass.id}/cancel`,
        headers: authHeaders(student, randomUUID(), etag),
      }),
      app.inject({
        method: 'POST',
        url: `/api/v1/me/passes/${pass.id}/depart`,
        headers: authHeaders(student, randomUUID(), etag),
      }),
    ]);
    const codes = [cancelled.statusCode, departed.statusCode].sort();
    expect(codes).toEqual([200, 412]);
    const state = (await passLifecycle(pass.id)).state;
    expect(['cancelled', 'outbound']).toContain(state);
  });
});

describe('scheduling alignment', () => {
  it('serves identical destination facts across scheduling, passes, and station', async () => {
    if (officeStaff === null) throw new Error('office fixture missing');
    const student = await makeStudent(tenantA, schoolA, 'Aligned');
    const alignedOffice = await makeOfficeStation(officeStaff);
    const { pass } = await requestReadyPass(student, alignedOffice);
    const row = (
      await pool.query<{ display_name: string | null; service_type: string }>(
        `SELECT display_name, service_type FROM destination WHERE id = $1`,
        [alignedOffice],
      )
    ).rows[0];
    expect(pass.destination).toMatchObject({
      id: alignedOffice,
      displayName: row?.display_name,
      serviceType: row?.service_type,
      checkInMode: 'optional',
    });
    const active = await app.inject({
      method: 'GET',
      url: '/api/v1/me/passes/active',
      headers: { cookie: `openhall_session_dev=${student.cookie}` },
    });
    const activePass = active.json<{ pass: PassBody }>().pass;
    expect(activePass.destination).toEqual(pass.destination);
    const view = await app.inject({
      method: 'GET',
      url: `/api/v1/destinations/${alignedOffice}/station`,
      headers: { cookie: `openhall_session_dev=${officeStaff.cookie}` },
    });
    const station = view.json<{
      destination: { id: string; displayName: string; serviceType: string };
    }>().destination;
    expect(station).toMatchObject({
      id: alignedOffice,
      displayName: row?.display_name,
      serviceType: row?.service_type,
    });
  });
});

describe('movement regression coverage', () => {
  it('keeps the pass ETag stable when another student leaves the queue', async () => {
    const etagOffice = await makeDestination({
      serviceType: 'office',
      capacity: 1,
      queueEnabled: true,
      checkInMode: 'none',
    });
    const holder = await makeStudent(tenantA, schoolA, 'EtagHolder');
    await requestReadyPass(holder, etagOffice);
    const first = await makeStudent(tenantA, schoolA, 'EtagFirst');
    const createdFirst = await app.inject({
      method: 'POST',
      url: '/api/v1/me/passes',
      headers: authHeaders(first, randomUUID()),
      payload: { destinationId: etagOffice },
    });
    expect(createdFirst.statusCode).toBe(201);
    expect(createdFirst.json<{ pass: PassBody }>().pass.lifecycleState).toBe('queued');
    const firstPass = createdFirst.json<{ pass: PassBody }>().pass;
    const second = await makeStudent(tenantA, schoolA, 'EtagSecond');
    const createdSecond = await app.inject({
      method: 'POST',
      url: '/api/v1/me/passes',
      headers: authHeaders(second, randomUUID()),
      payload: { destinationId: etagOffice },
    });
    expect(createdSecond.statusCode).toBe(201);
    const secondPass = createdSecond.json<{ pass: PassBody }>().pass;
    expect(secondPass.lifecycleState).toBe('queued');

    const readActive = async (): Promise<{ etag: string; body: unknown }> => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/me/passes/active',
        headers: { cookie: `openhall_session_dev=${second.cookie}` },
      });
      expect(response.statusCode).toBe(200);
      return { etag: requiredEtag(response), body: response.json() };
    };
    const before = await readActive();
    // The first queued student cancels; capacity stays held by the holder.
    const cancelFirst = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${firstPass.id}/cancel`,
      headers: authHeaders(first, randomUUID(), requiredEtag(createdFirst)),
    });
    expect(cancelFirst.statusCode).toBe(200);
    const after = await readActive();
    // B's queue position changed, but B's pass revision did not.
    expect(after.etag).toBe(before.etag);
    expect(after.body).toEqual(before.body);
    const status = await app.inject({
      method: 'GET',
      url: `/api/v1/me/passes/${secondPass.id}/queue-status`,
      headers: { cookie: `openhall_session_dev=${second.cookie}` },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json<{ position: number; ahead: number }>().position).toBe(1);
  });

  it('snapshots expected return at departure and ignores later config edits', async () => {
    const timed = await makeDestination({
      serviceType: 'office',
      capacity: 2,
      queueEnabled: false,
      checkInMode: 'none',
      defaultDurationSeconds: 300,
    });
    const student = await makeStudent(tenantA, schoolA, 'TimedReturn');
    const { pass, etag } = await requestReadyPass(student, timed);
    const departed = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${pass.id}/depart`,
      headers: authHeaders(student, randomUUID(), etag),
    });
    expect(departed.statusCode).toBe(200);
    const row = (
      await pool.query<{ claimed_at: Date; expected_return_at: Date | null }>(
        `SELECT r.claimed_at, p.expected_return_at
         FROM destination_reservation r JOIN pass p ON p.id = r.pass_id
         WHERE r.pass_id = $1`,
        [pass.id],
      )
    ).rows[0];
    if (row === undefined) {
      throw new Error('Expected return was not snapshotted');
    }
    const expectedReturnAt = row.expected_return_at;
    if (expectedReturnAt === null) {
      throw new Error('Expected return was not snapshotted');
    }
    // 12:00 departure with a 300-second default means 12:05 expected return.
    const spanSeconds = (expectedReturnAt.getTime() - row.claimed_at.getTime()) / 1000;
    expect(spanSeconds).toBe(300);
    const snapshotted = expectedReturnAt.toISOString();
    // Later destination edits must not reinterpret history.
    await pool.query(`UPDATE destination SET default_duration_seconds = 3600 WHERE id = $1`, [
      timed,
    ]);
    const reread = (
      await pool.query<{ expected_return_at: Date | null }>(
        `SELECT expected_return_at FROM pass WHERE id = $1`,
        [pass.id],
      )
    ).rows[0];
    expect(reread?.expected_return_at?.toISOString()).toBe(snapshotted);
  });

  it('replays a stored completion on retry with the old ETag', async () => {
    const student = await makeStudent(tenantA, schoolA, 'ReplayComplete');
    const { pass, etag } = await requestReadyPass(student, restroom);
    const departed = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${pass.id}/depart`,
      headers: authHeaders(student, randomUUID(), etag),
    });
    expect(departed.statusCode).toBe(200);
    const key = randomUUID();
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${pass.id}/complete`,
      headers: authHeaders(student, key, requiredEtag(departed)),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<{ pass: PassBody }>().pass.lifecycleState).toBe('completed');
    const events = await tableCount('pass_event');
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${pass.id}/complete`,
      headers: authHeaders(student, key, requiredEtag(departed)),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(await tableCount('pass_event')).toBe(events);
    expect((await passLifecycle(pass.id)).revision).toBe('4');
  });
});

describe('station display fallback', () => {
  it('falls back to the service type when display name is missing', async () => {
    if (officeStaff === null) throw new Error('office fixture missing');
    const fallbackOffice = await makeDestination({
      serviceType: 'office',
      capacity: 1,
      queueEnabled: true,
      checkInMode: 'optional',
    });
    await pool.query(`UPDATE destination SET display_name = NULL WHERE id = $1`, [fallbackOffice]);
    await pool.query(
      `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind, destination_id) VALUES ($1, $2, 'destination_staff', 'destination', $3)`,
      [tenantA, officeStaff.accountId, fallbackOffice],
    );
    const student = await makeStudent(tenantA, schoolA, 'FallbackStudent');
    await requestReadyPass(student, fallbackOffice);
    const view = await app.inject({
      method: 'GET',
      url: `/api/v1/destinations/${fallbackOffice}/station`,
      headers: { cookie: `openhall_session_dev=${officeStaff.cookie}` },
    });
    expect(view.statusCode).toBe(200);
    expect(
      view.json<{ destination: { displayName: string; serviceType: string } }>().destination,
    ).toMatchObject({ displayName: 'office', serviceType: 'office' });
  });
});
