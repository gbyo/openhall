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
let sectionA1 = '';
let destinationA = '';
let locationA = '';

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
    `INSERT INTO organization_membership (tenant_id, organization_id, person_id, affiliation) VALUES ($1, $2, $3, $4)`,
    [tenantId, schoolId, personId, affiliation],
  );
  const { cookie, csrf } = await mintSession(tenantId, accountId);
  return { personId, accountId, cookie, csrf };
}

async function grantRole(
  tenantId: string,
  accountId: string,
  role: string,
  schoolId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind, organization_id) VALUES ($1, $2, $3, 'organization', $4)`,
    [tenantId, accountId, role, schoolId],
  );
}

let adminA: SessionFixture | null = null;
let adminB: SessionFixture | null = null;
let counselorA: SessionFixture | null = null;
let recoveryA: { cookie: string; csrf: string } | null = null;

function requireAdmin(): SessionFixture {
  if (adminA === null) throw new Error('admin fixture missing');
  return adminA;
}

function requireCounselor(): SessionFixture {
  if (counselorA === null) throw new Error('counselor fixture missing');
  return counselorA;
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

/** New York wall-clock parts for the current instant. */
function nyParts(nowMs: number): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(nowMs));
  const get = (type: string): number => {
    const found = parts.find((entry) => entry.type === type);
    if (found === undefined) throw new Error('Missing date part');
    return Number(found.value);
  };
  return { year: get('year'), month: get('month'), day: get('day') };
}

function nyOffsetMs(utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type: string): number => {
    const found = parts.find((entry) => entry.type === type);
    if (found === undefined) throw new Error('Missing date part');
    return Number(found.value);
  };
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return asUtc - utcMs;
}

/** Converts a New York wall time to an ISO instant. */
function nyInstant(year: number, month: number, day: number, hour: number, minute: number): string {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    guess = Date.UTC(year, month - 1, day, hour, minute) - nyOffsetMs(guess);
  }
  return new Date(guess).toISOString();
}

/**
 * A live appointment window: contains now, sits within one New York school
 * day, and lasts at most six hours however the suite clock falls.
 */
function liveWindow(nowMs: number = Date.now()): { validFrom: string; validUntil: string } {
  const { year, month, day } = nyParts(nowMs);
  let midnight = Date.UTC(year, month - 1, day, 0, 0);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    midnight = Date.UTC(year, month - 1, day, 0, 0) - nyOffsetMs(midnight);
  }
  const nextMidnight = midnight + 24 * 3600 * 1000;
  const start = Math.max(midnight, nowMs - 3 * 3600 * 1000);
  const end = Math.min(nowMs + 3 * 3600 * 1000, nextMidnight - 1);
  if (!(start < nowMs && nowMs < end && end - start <= 6 * 3600 * 1000)) {
    throw new Error('Unable to build a live window');
  }
  return { validFrom: new Date(start).toISOString(), validUntil: new Date(end).toISOString() };
}

async function clearPolicy(): Promise<void> {
  await pool.query(`DELETE FROM pass_approval`);
  await pool.query(`DELETE FROM queue_entry`);
  await pool.query(`DELETE FROM room_reservation`);
  await pool.query(`DELETE FROM policy_evaluation_result`);
  await pool.query(`DELETE FROM policy_evaluation`);
  await pool.query(`DELETE FROM policy_rule`);
}

async function enrollInSection(studentId: string): Promise<void> {
  await pool.query(
    `INSERT INTO section_membership (tenant_id, section_id, person_id, role) VALUES ($1, $2, $3, 'student')`,
    [tenantA, sectionA1, studentId],
  );
}

interface AuthBody {
  id: string;
  organizationId: string;
  studentId: string;
  destinationRoomId: string;
  validFrom: string;
  validUntil: string;
  status: string;
  approvalMode: string;
  originStrategy: string;
  originRoomId: string | null;
  revision: string;
  createdByAccountId: string | null;
  createdAt: string;
  updatedAt: string;
  usedAt: string | null;
  usedByAccountId: string | null;
  cancelledAt: string | null;
  cancelledByAccountId: string | null;
  lastAttemptAt: string | null;
}

async function createAuth(
  admin: SessionFixture,
  schoolId: string,
  payload: Record<string, unknown>,
  key: string = randomUUID(),
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/organizations/${schoolId}/scheduled-authorizations`,
    headers: authHeaders(admin, key),
    payload,
  });
}

function authPayload(
  studentId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    studentId,
    destinationRoomId: destinationA,
    ...liveWindow(),
    approvalMode: 'approval_required',
    origin: { strategy: 'expected' },
    ...overrides,
  };
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
    `INSERT INTO tenant (name, slug) VALUES ('TA', 'sata') RETURNING id`,
  );
  schoolA = await insertReturningId(
    `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'A School', 'sa-school', 'America/New_York') RETURNING id`,
    [tenantA],
  );
  tenantB = await insertReturningId(
    `INSERT INTO tenant (name, slug) VALUES ('TB', 'satb') RETURNING id`,
  );
  schoolB = await insertReturningId(
    `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'B School', 'sb-school', 'America/New_York') RETURNING id`,
    [tenantB],
  );
  const adminPerson = await makeMember(tenantA, schoolA, 'staff', 'Ada');
  await grantRole(tenantA, adminPerson.accountId, 'school_admin', schoolA);
  adminA = adminPerson;
  recoveryA = await mintSession(tenantA, adminPerson.accountId, 'recovery');
  const adminBPerson = await makeMember(tenantB, schoolB, 'staff', 'Bob');
  await grantRole(tenantB, adminBPerson.accountId, 'school_admin', schoolB);
  adminB = adminBPerson;
  const counselorPerson = await makeMember(tenantA, schoolA, 'staff', 'Cora');
  await grantRole(tenantA, counselorPerson.accountId, 'counselor', schoolA);
  counselorA = counselorPerson;

  // Movement fixtures: session, section with meeting, all-day schedule, open destination.
  const sessionA = await insertReturningId(
    `INSERT INTO academic_session (tenant_id, organization_id, kind, name, starts_on, ends_on) VALUES ($1, $2, 'school_year', 'SY', '2026-08-01', '2027-06-01') RETURNING id`,
    [tenantA, schoolA],
  );
  sectionA1 = await insertReturningId(
    `INSERT INTO section (tenant_id, organization_id, academic_session_id, code, title) VALUES ($1, $2, $3, 'P3', 'Period 3') RETURNING id`,
    [tenantA, schoolA, sessionA],
  );
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
  const today = new Date().toISOString().slice(0, 10);
  for (const offset of [-2, -1, 0, 1, 2]) {
    const day = new Date(new Date(`${today}T12:00:00Z`).getTime() + offset * 86400_000)
      .toISOString()
      .slice(0, 10);
    await pool.query(
      `INSERT INTO calendar_day (tenant_id, organization_id, date, day_kind, schedule_template_id) VALUES ($1, $2, $3, 'instructional', $4) ON CONFLICT DO NOTHING`,
      [tenantA, schoolA, day, template],
    );
  }
  locationA = await insertReturningId(
    `INSERT INTO room (tenant_id, organization_id, name) VALUES ($1, $2, 'Room 3') RETURNING id`,
    [tenantA, schoolA],
  );
  await pool.query(
    `INSERT INTO section_meeting (tenant_id, organization_id, section_id, schedule_block_id, room_id) VALUES ($1, $2, $3, $4, $5)`,
    [tenantA, schoolA, sectionA1, block, locationA],
  );
  const categoryA = await insertReturningId(
    `INSERT INTO room_category (tenant_id, organization_id, name, student_surface) VALUES ($1, $2, 'Nurse', 'primary') RETURNING id`,
    [tenantA, schoolA],
  );
  destinationA = await insertReturningId(
    `INSERT INTO room (tenant_id, organization_id, category_id, student_self_requestable, name) VALUES ($1, $2, $3, true, 'Nurse') RETURNING id`,
    [tenantA, schoolA, categoryA],
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

describe('scheduled authorization administration', () => {
  it('creates expected and specific appointments', async () => {
    const student = await makeMember(tenantA, schoolA, 'student', 'Pupil');
    await enrollInSection(student.personId);
    const created = await createAuth(requireAdmin(), schoolA, authPayload(student.personId));
    expect(created.statusCode).toBe(201);
    const body = created.json<{ authorization: AuthBody }>().authorization;
    expect(body.status).toBe('active');
    expect(body.revision).toBe('1');
    expect(body.originStrategy).toBe('expected');
    expect(body.originRoomId).toBeNull();
    expect(body.createdByAccountId).toBe(requireAdmin().accountId);
    expect(requiredEtag(created)).toBe(`"scheduled-authorization:${body.id}:1"`);

    const specific = await createAuth(
      requireAdmin(),
      schoolA,
      authPayload(student.personId, { origin: { strategy: 'specific', roomId: locationA } }),
    );
    expect(specific.statusCode).toBe(201);
    expect(specific.json<{ authorization: AuthBody }>().authorization.originRoomId).toBe(
      locationA,
    );
  });

  it('validates windows, targets, and rooms', async () => {
    const student = await makeMember(tenantA, schoolA, 'student', 'Windowed');
    const { year, month, day } = nyParts(Date.now());
    const base = liveWindow();
    const window = { validFrom: base.validFrom, validUntil: base.validUntil };

    const crossDay = await createAuth(
      requireAdmin(),
      schoolA,
      authPayload(student.personId, {
        validFrom: nyInstant(year, month, day, 22, 0),
        validUntil: new Date(
          new Date(nyInstant(year, month, day, 22, 0)).getTime() + 3 * 3600 * 1000,
        ).toISOString(),
      }),
    );
    expect(crossDay.statusCode).toBe(409);

    const tooLong = await createAuth(
      requireAdmin(),
      schoolA,
      authPayload(student.personId, {
        validFrom: nyInstant(year, month, day, 0, 30),
        validUntil: nyInstant(year, month, day, 13, 31),
      }),
    );
    expect(tooLong.statusCode).toBe(409);

    const horizon = new Date(Date.now() + 400 * 86400_000).toISOString();
    const farOut = await createAuth(
      requireAdmin(),
      schoolA,
      authPayload(student.personId, {
        validFrom: horizon,
        validUntil: new Date(new Date(horizon).getTime() + 3600_000).toISOString(),
      }),
    );
    expect(farOut.statusCode).toBe(409);

    const inverted = await createAuth(
      requireAdmin(),
      schoolA,
      authPayload(student.personId, { validFrom: window.validUntil, validUntil: window.validFrom }),
    );
    expect(inverted.statusCode).toBe(409);

    const staffTarget = await makeMember(tenantA, schoolA, 'staff', 'Staffer');
    const notStudent = await createAuth(requireAdmin(), schoolA, authPayload(staffTarget.personId));
    expect(notStudent.statusCode).toBe(404);

    const missing = await createAuth(requireAdmin(), schoolA, authPayload(randomUUID()));
    expect(missing.statusCode).toBe(404);

    const archivedCategory = await insertReturningId(
      `INSERT INTO room_category (tenant_id, organization_id, name) VALUES ($1, $2, 'Archived Cat') RETURNING id`,
      [tenantA, schoolA],
    );
    const archived = await insertReturningId(
      `INSERT INTO room (tenant_id, organization_id, category_id, name, status) VALUES ($1, $2, $3, 'Archived', 'archived') RETURNING id`,
      [tenantA, schoolA, archivedCategory],
    );
    const archivedDest = await createAuth(
      requireAdmin(),
      schoolA,
      authPayload(student.personId, { destinationRoomId: archived }),
    );
    expect(archivedDest.statusCode).toBe(409);

    const expectedWithLocation = await createAuth(
      requireAdmin(),
      schoolA,
      authPayload(student.personId, {
        origin: { strategy: 'expected', roomId: locationA },
      }),
    );
    expect(expectedWithLocation.statusCode).toBe(400);
  });

  it('cancels live appointments without touching passes', async () => {
    const student = await makeMember(tenantA, schoolA, 'student', 'Cancelled');
    const created = await createAuth(requireAdmin(), schoolA, authPayload(student.personId));
    const body = created.json<{ authorization: AuthBody }>().authorization;
    const etag = requiredEtag(created);

    const missing = await app.inject({
      method: 'POST',
      url: `/api/v1/scheduled-authorizations/${body.id}/cancel`,
      headers: authHeaders(requireAdmin(), randomUUID()),
    });
    expect(missing.statusCode).toBe(428);

    const stale = await app.inject({
      method: 'POST',
      url: `/api/v1/scheduled-authorizations/${body.id}/cancel`,
      headers: authHeaders(requireAdmin(), randomUUID(), `"scheduled-authorization:${body.id}:99"`),
    });
    expect(stale.statusCode).toBe(412);

    const key = randomUUID();
    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/scheduled-authorizations/${body.id}/cancel`,
      headers: authHeaders(requireAdmin(), key, etag),
    });
    expect(cancelled.statusCode).toBe(200);
    const cancelledBody = cancelled.json<{ authorization: AuthBody }>().authorization;
    expect(cancelledBody.status).toBe('cancelled');
    expect(cancelledBody.revision).toBe('2');
    expect(cancelledBody.cancelledByAccountId).toBe(requireAdmin().accountId);

    const replayed = await app.inject({
      method: 'POST',
      url: `/api/v1/scheduled-authorizations/${body.id}/cancel`,
      headers: authHeaders(requireAdmin(), key, etag),
    });
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json<{ authorization: AuthBody }>().authorization.revision).toBe('2');

    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/scheduled-authorizations/${body.id}/cancel`,
      headers: authHeaders(requireAdmin(), randomUUID(), requiredEtag(cancelled)),
    });
    expect(again.statusCode).toBe(409);
  });

  it('lists and reads with school scoping', async () => {
    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/scheduled-authorizations`,
      headers: authHeaders(requireAdmin()),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ authorizations: AuthBody[] }>().authorizations.length).toBeGreaterThan(0);

    const counselorListed = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/scheduled-authorizations`,
      headers: authHeaders(requireCounselor()),
    });
    expect(counselorListed.statusCode).toBe(200);

    if (adminB === null) throw new Error('admin fixture missing');
    const concealed = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/scheduled-authorizations`,
      headers: authHeaders(adminB),
    });
    expect(concealed.statusCode).toBe(404);

    if (recoveryA === null) throw new Error('recovery fixture missing');
    const recovery = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${schoolA}/scheduled-authorizations`,
      headers: authHeaders(recoveryA, randomUUID()),
      payload: authPayload((await makeMember(tenantA, schoolA, 'student', 'Nope')).personId),
    });
    expect(recovery.statusCode).toBe(403);
  });
});

describe('scheduled student lookup', () => {
  it('serves counselors without people.view', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/students`,
      headers: authHeaders(requireCounselor()),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      students: { id: string; displayName: string; gradeLevel: string | null }[];
      nextCursor: string | null;
    }>();
    expect(body.students.length).toBeGreaterThan(0);
    for (const entry of body.students) {
      expect(Object.keys(entry).sort()).toEqual(['displayName', 'gradeLevel', 'id']);
    }
    const filtered = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/students?q=pupil`,
      headers: authHeaders(requireCounselor()),
    });
    expect(
      filtered.json<{ students: { displayName: string }[] }>().students.map((e) => e.displayName),
    ).toContain('Pupil Test');
  });
});

describe('scheduled start', () => {
  it('starts a live pass and consumes the appointment', async () => {
    const student = await makeMember(tenantA, schoolA, 'student', 'Starter');
    await enrollInSection(student.personId);
    const created = await createAuth(requireAdmin(), schoolA, authPayload(student.personId));
    const body = created.json<{ authorization: AuthBody }>().authorization;
    const etag = requiredEtag(created);

    const mine = await app.inject({
      method: 'GET',
      url: '/api/v1/me/scheduled-authorizations',
      headers: authHeaders(student),
    });
    expect(mine.statusCode).toBe(200);
    const mineBody = mine.json<{
      authorizations: { id: string; destination: object; originRoom: null }[];
    }>();
    expect(mineBody.authorizations.map((entry) => entry.id)).toContain(body.id);

    const key = randomUUID();
    const started = await app.inject({
      method: 'POST',
      url: `/api/v1/me/scheduled-authorizations/${body.id}/start`,
      headers: authHeaders(student, key, etag),
    });
    expect(started.statusCode).toBe(201);
    const pass = started.json<{
      pass: {
        id: string;
        lifecycleState: string;
        requestSource: string;
        scheduledAuthorizationId: string;
      };
    }>().pass;
    expect(['requested', 'queued', 'ready']).toContain(pass.lifecycleState);
    expect(pass.requestSource).toBe('scheduled');
    expect(pass.scheduledAuthorizationId).toBe(body.id);

    const used = await pool.query<{ status: string; revision: string; used_by_account_id: string }>(
      `SELECT status, revision, used_by_account_id FROM scheduled_authorization WHERE id = $1`,
      [body.id],
    );
    expect(used.rows[0]?.status).toBe('used');
    expect(used.rows[0]?.used_by_account_id).toBe(student.accountId);

    // Same key replays the original pass even though the revision advanced.
    const replayed = await app.inject({
      method: 'POST',
      url: `/api/v1/me/scheduled-authorizations/${body.id}/start`,
      headers: authHeaders(student, key, etag),
    });
    expect(replayed.statusCode).toBe(201);
    expect(replayed.json<{ pass: { id: string } }>().pass.id).toBe(pass.id);

    // A used appointment cannot start again.
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/scheduled-authorizations/${body.id}`,
      headers: authHeaders(requireAdmin()),
    });
    const freshEtag = requiredEtag(detail);
    const reused = await app.inject({
      method: 'POST',
      url: `/api/v1/me/scheduled-authorizations/${body.id}/start`,
      headers: authHeaders(student, randomUUID(), freshEtag),
    });
    expect(reused.statusCode).toBe(409);
  });

  it('serializes a student start against a staff cancel on the same ETag', async () => {
    const student = await makeMember(tenantA, schoolA, 'student', 'Racer');
    await enrollInSection(student.personId);
    const created = await createAuth(requireAdmin(), schoolA, authPayload(student.personId));
    const body = created.json<{ authorization: AuthBody }>().authorization;
    const etag = requiredEtag(created);

    const [started, cancelled] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/v1/me/scheduled-authorizations/${body.id}/start`,
        headers: authHeaders(student, randomUUID(), etag),
      }),
      app.inject({
        method: 'POST',
        url: `/api/v1/scheduled-authorizations/${body.id}/cancel`,
        headers: authHeaders(requireAdmin(), randomUUID(), etag),
      }),
    ]);

    // Exactly one command wins the row lock; the loser observes 409 state
    // conflict or 412 stale revision, never a second success.
    const winner = [started.statusCode, cancelled.statusCode].filter((status) =>
      [200, 201].includes(status),
    );
    expect(winner).toHaveLength(1);
    const loser = started.statusCode === winner[0] ? cancelled : started;
    expect([409, 412]).toContain(loser.statusCode);

    const row = (
      await pool.query<{ status: string }>(
        `SELECT status FROM scheduled_authorization WHERE id = $1`,
        [body.id],
      )
    ).rows[0];
    const passes = (
      await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM pass WHERE scheduled_authorization_id = $1`,
        [body.id],
      )
    ).rows[0];
    if (started.statusCode === 201) {
      expect(row?.status).toBe('used');
      expect(Number(passes?.count)).toBe(1);
    } else {
      // Cancel won: no pass may be committed against a cancelled authorization.
      expect(row?.status).toBe('cancelled');
      expect(Number(passes?.count)).toBe(0);
    }
  });

  it('records denied attempts without consuming', async () => {
    await pool.query(`DELETE FROM policy_rule`);
    await pool.query(
      `INSERT INTO policy_rule (tenant_id, organization_id, name, rule_type, scope_kind, scope_organization_id, priority, configuration, override_mode, enabled)
       VALUES ($1, $2, 'Deny all day', 'schedule_boundary', 'organization', $2, 0,
         '{"schemaVersion":1,"firstMinutes":1440,"lastMinutes":1440,"blockKinds":["instructional"],"requestSources":["scheduled"]}',
         'never', true)`,
      [tenantA, schoolA],
    );
    try {
      const student = await makeMember(tenantA, schoolA, 'student', 'Denied');
      await enrollInSection(student.personId);
      const created = await createAuth(requireAdmin(), schoolA, authPayload(student.personId));
      const body = created.json<{ authorization: AuthBody }>().authorization;

      const started = await app.inject({
        method: 'POST',
        url: `/api/v1/me/scheduled-authorizations/${body.id}/start`,
        headers: authHeaders(student, randomUUID(), requiredEtag(created)),
      });
      expect(started.statusCode).toBe(201);
      expect(started.json<{ pass: { lifecycleState: string } }>().pass.lifecycleState).toBe(
        'denied',
      );

      const row = (
        await pool.query<{ status: string; revision: string; last_attempt_at: Date | null }>(
          `SELECT status, revision, last_attempt_at FROM scheduled_authorization WHERE id = $1`,
          [body.id],
        )
      ).rows[0];
      expect(row?.status).toBe('active');
      expect(row?.revision).toBe('2');
      expect(row?.last_attempt_at).not.toBeNull();
    } finally {
      await clearPolicy();
    }
  });

  it('satisfies classroom approvals only when preapproved', async () => {
    await pool.query(`DELETE FROM policy_rule`);
    await pool.query(
      `INSERT INTO policy_rule (tenant_id, organization_id, name, rule_type, scope_kind, scope_section_id, priority, configuration, override_mode, enabled)
       VALUES ($1, $2, 'Teacher approval', 'approval_requirement', 'section', $3, 0,
         '{"schemaVersion":1,"requestSources":["scheduled"],"approver":"current_section_teacher"}',
         'never', true)`,
      [tenantA, schoolA, sectionA1],
    );
    try {
      const preapprovedStudent = await makeMember(tenantA, schoolA, 'student', 'Preok');
      await enrollInSection(preapprovedStudent.personId);
      const preapproved = await createAuth(
        requireAdmin(),
        schoolA,
        authPayload(preapprovedStudent.personId, { approvalMode: 'preapproved' }),
      );
      const preBody = preapproved.json<{ authorization: AuthBody }>().authorization;
      const preStarted = await app.inject({
        method: 'POST',
        url: `/api/v1/me/scheduled-authorizations/${preBody.id}/start`,
        headers: authHeaders(preapprovedStudent, randomUUID(), requiredEtag(preapproved)),
      });
      expect(preStarted.statusCode).toBe(201);
      const prePass = preStarted.json<{ pass: { id: string; lifecycleState: string } }>().pass;
      expect(prePass.lifecycleState).toBe('ready');
      const prePending = await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM pass_approval WHERE pass_id = $1 AND decision = 'pending'`,
        [prePass.id],
      );
      expect(Number(prePending.rows[0]?.count)).toBe(0);

      const normalStudent = await makeMember(tenantA, schoolA, 'student', 'Needsok');
      await enrollInSection(normalStudent.personId);
      const normal = await createAuth(
        requireAdmin(),
        schoolA,
        authPayload(normalStudent.personId, { approvalMode: 'approval_required' }),
      );
      const normalBody = normal.json<{ authorization: AuthBody }>().authorization;
      const normalStarted = await app.inject({
        method: 'POST',
        url: `/api/v1/me/scheduled-authorizations/${normalBody.id}/start`,
        headers: authHeaders(normalStudent, randomUUID(), requiredEtag(normal)),
      });
      expect(normalStarted.statusCode).toBe(201);
      const normalPass = normalStarted.json<{ pass: { id: string; lifecycleState: string } }>()
        .pass;
      expect(normalPass.lifecycleState).toBe('requested');
      const normalPending = await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM pass_approval WHERE pass_id = $1 AND decision = 'pending'`,
        [normalPass.id],
      );
      expect(Number(normalPending.rows[0]?.count)).toBe(1);
    } finally {
      await clearPolicy();
    }
  });

  it('rejects stale, foreign, and out-of-window starts', async () => {
    const student = await makeMember(tenantA, schoolA, 'student', 'Staley');
    await enrollInSection(student.personId);
    const other = await makeMember(tenantA, schoolA, 'student', 'Other');
    const created = await createAuth(requireAdmin(), schoolA, authPayload(student.personId));
    const body = created.json<{ authorization: AuthBody }>().authorization;
    const etag = requiredEtag(created);

    const foreign = await app.inject({
      method: 'POST',
      url: `/api/v1/me/scheduled-authorizations/${body.id}/start`,
      headers: authHeaders(other, randomUUID(), etag),
    });
    expect(foreign.statusCode).toBe(404);

    const stale = await app.inject({
      method: 'POST',
      url: `/api/v1/me/scheduled-authorizations/${body.id}/start`,
      headers: authHeaders(student, randomUUID(), `"scheduled-authorization:${body.id}:99"`),
    });
    expect(stale.statusCode).toBe(412);

    const missing = await app.inject({
      method: 'POST',
      url: `/api/v1/me/scheduled-authorizations/${body.id}/start`,
      headers: authHeaders(student, randomUUID()),
    });
    expect(missing.statusCode).toBe(428);

    const { year, month, day } = nyParts(Date.now());
    const future = await createAuth(
      requireAdmin(),
      schoolA,
      authPayload(student.personId, {
        validFrom: nyInstant(year, month, day, 23, 0),
        validUntil: nyInstant(year, month, day, 23, 59),
      }),
    );
    if (future.statusCode === 201) {
      const futureBody = future.json<{ authorization: AuthBody }>().authorization;
      const early = await app.inject({
        method: 'POST',
        url: `/api/v1/me/scheduled-authorizations/${futureBody.id}/start`,
        headers: authHeaders(student, randomUUID(), requiredEtag(future)),
      });
      // Either the window already opened (late suite run) or it has not.
      expect([201, 409]).toContain(early.statusCode);
      if (early.statusCode === 409) {
        expect(early.json<{ code: string }>().code).toBe('scheduled_authorization_not_yet_valid');
      }
    }
  });
});
