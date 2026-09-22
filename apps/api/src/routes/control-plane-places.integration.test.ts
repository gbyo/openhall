import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { AppConfig } from '@openhall/config';
import { createDatabase, migrateToLatest } from '@openhall/db';
import type { FastifyInstance } from 'fastify';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';

const APP_SECRET = 'test-only-app-secret-32-characters!!';
const ORIGIN = 'http://localhost:3000';

const config: AppConfig = {
  nodeEnv: 'test',
  appBaseUrl: new URL(ORIGIN),
  databaseUrl: 'postgresql://unused',
  destinationFlowPollMs: 2000,
  appSecret: APP_SECRET,
  dataEncryptionKey: new Uint8Array(32).fill(7),
  dataEncryptionKeyId: 'test-key-1',
  trustProxy: false,
  port: 3000,
};

let databaseName = '';
let pool: Pool;
let app: FastifyInstance;
let destroyHandle: () => Promise<void>;

let tenantA = '';
let schoolA = '';
let schoolB = '';
let room214 = '';
let room215 = '';
let gym = '';
let categoryVisits = '';

function domainHmac(domain: string, credential: Uint8Array): Uint8Array {
  const hmac = createHmac('sha256', APP_SECRET);
  hmac.update(domain, 'utf8');
  hmac.update(Buffer.from([0]));
  hmac.update(
    Buffer.from(credential.buffer as ArrayBuffer, credential.byteOffset, credential.byteLength),
  );
  return new Uint8Array(hmac.digest());
}

async function mintSession(tenantId: string, accountId: string) {
  const raw = randomBytes(32);
  const tokenDigest = domainHmac('session-digest:v1', raw);
  const csrfRaw = domainHmac('csrf-token:v1', raw);
  const csrfDigest = createHmac('sha256', APP_SECRET).update(Buffer.from(csrfRaw)).digest();
  await pool.query(
    `INSERT INTO auth_session
      (tenant_id, account_id, token_hash, csrf_token_hash, account_session_revision,
       authentication_method, idle_expires_at, absolute_expires_at)
     VALUES ($1, $2, $3, $4, 0, 'oidc', now() + interval '12 hours', now() + interval '7 days')`,
    [tenantId, accountId, Buffer.from(tokenDigest), csrfDigest],
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
  return { accountId, cookie, csrf };
}

async function grantRole(tenantId: string, accountId: string, role: string, schoolId: string) {
  await pool.query(
    `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind, organization_id) VALUES ($1, $2, $3, 'organization', $4)`,
    [tenantId, accountId, role, schoolId],
  );
}

let adminA: SessionFixture | null = null;
let studentA: SessionFixture | null = null;

function requireAdmin(): SessionFixture {
  if (adminA === null) throw new Error('admin fixture missing');
  return adminA;
}

function requireStudent(): SessionFixture {
  if (studentA === null) throw new Error('student fixture missing');
  return studentA;
}

function authHeaders(session: SessionFixture, key?: string) {
  return {
    cookie: `openhall_session_dev=${session.cookie}`,
    'x-csrf-token': session.csrf,
    origin: ORIGIN,
    ...(key ? { 'idempotency-key': key } : {}),
  };
}

beforeAll(async () => {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL is required for integration tests');
  databaseName = `openhall_places_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const admin = new Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
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
    readinessProbe: { check: () => Promise.resolve({ migration: '010_destination_categories' }) },
  });
  const baseCleanup = async () => {
    await pool.end();
    const cleanup = new Client({ connectionString: base });
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE "${databaseName}"`);
    await cleanup.end();
  };
  const priorDestroy = destroyHandle;
  destroyHandle = async () => {
    await priorDestroy();
    await baseCleanup();
  };

  tenantA = await insertReturningId(
    `INSERT INTO tenant (name, slug) VALUES ('Tenant A', 'tenant-a') RETURNING id`,
  );
  schoolA = await insertReturningId(
    `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'A School', 'a-school', 'America/New_York') RETURNING id`,
    [tenantA],
  );
  schoolB = await insertReturningId(
    `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'B School', 'b-school', 'America/New_York') RETURNING id`,
    [tenantA],
  );
  const adminPerson = await makeMember(tenantA, schoolA, 'staff', 'Ada');
  await grantRole(tenantA, adminPerson.accountId, 'school_admin', schoolA);
  adminA = adminPerson;
  studentA = await makeMember(tenantA, schoolA, 'student', 'Sam');

  // Places: two classrooms, one gym without classes, one room in school B.
  room214 = await insertReturningId(
    `INSERT INTO location (tenant_id, organization_id, kind, name, code, floor_label) VALUES ($1, $2, 'classroom', 'Room 214', '214', '2nd floor') RETURNING id`,
    [tenantA, schoolA],
  );
  room215 = await insertReturningId(
    `INSERT INTO location (tenant_id, organization_id, kind, name, code) VALUES ($1, $2, 'classroom', 'Room 215', '215') RETURNING id`,
    [tenantA, schoolA],
  );
  gym = await insertReturningId(
    `INSERT INTO location (tenant_id, organization_id, kind, name) VALUES ($1, $2, 'gym', 'Gym') RETURNING id`,
    [tenantA, schoolA],
  );
  await insertReturningId(
    `INSERT INTO location (tenant_id, organization_id, kind, name) VALUES ($1, $2, 'classroom', 'Room B') RETURNING id`,
    [tenantA, schoolB],
  );

  // Schedule: Algebra II + Geometry share Room 214 (two teachers); Biology
  // in Room 215 reuses the Algebra teacher (one teacher, two rooms).
  const session = await insertReturningId(
    `INSERT INTO academic_session (tenant_id, organization_id, kind, name, starts_on, ends_on) VALUES ($1, $2, 'school_year', 'SY', '2026-08-01', '2027-06-01') RETURNING id`,
    [tenantA, schoolA],
  );
  const block = await insertReturningId(
    `INSERT INTO schedule_block (tenant_id, organization_id, code, display_name, kind) VALUES ($1, $2, 'P1', 'First Period', 'instructional') RETURNING id`,
    [tenantA, schoolA],
  );
  const algebra = await insertReturningId(
    `INSERT INTO section (tenant_id, organization_id, academic_session_id, code, title) VALUES ($1, $2, $3, 'ALG-2', 'Algebra II') RETURNING id`,
    [tenantA, schoolA, session],
  );
  const geometry = await insertReturningId(
    `INSERT INTO section (tenant_id, organization_id, academic_session_id, code, title) VALUES ($1, $2, $3, 'GEO-1', 'Geometry') RETURNING id`,
    [tenantA, schoolA, session],
  );
  const biology = await insertReturningId(
    `INSERT INTO section (tenant_id, organization_id, academic_session_id, code, title) VALUES ($1, $2, $3, 'BIO-1', 'Biology') RETURNING id`,
    [tenantA, schoolA, session],
  );
  for (const [section, location] of [
    [algebra, room214],
    [geometry, room214],
    [biology, room215],
  ] as const) {
    await pool.query(
      `INSERT INTO section_meeting (tenant_id, organization_id, section_id, schedule_block_id, location_id) VALUES ($1, $2, $3, $4, $5)`,
      [tenantA, schoolA, section, block, location],
    );
  }
  const smith = await insertReturningId(
    `INSERT INTO person (tenant_id, given_name, family_name, display_name) VALUES ($1, 'Ava', 'Smith', 'Ms. Smith') RETURNING id`,
    [tenantA],
  );
  const jones = await insertReturningId(
    `INSERT INTO person (tenant_id, given_name, family_name, display_name) VALUES ($1, 'Jay', 'Jones', 'Mr. Jones') RETURNING id`,
    [tenantA],
  );
  for (const [section, person] of [
    [algebra, smith],
    [geometry, jones],
    [biology, smith],
  ] as const) {
    await pool.query(
      `INSERT INTO section_membership (tenant_id, section_id, person_id, role) VALUES ($1, $2, $3, 'teacher')`,
      [tenantA, section, person],
    );
  }
  categoryVisits = await insertReturningId(
    `INSERT INTO destination_category (tenant_id, organization_id, name, student_surface) VALUES ($1, $2, 'Room visits', 'secondary') RETURNING id`,
    [tenantA, schoolA],
  );
}, 120000);

afterAll(async () => {
  await destroyHandle();
});

describe('places administration', () => {
  it('lists Places derived from locations with class usage and destination state', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/places`,
      headers: authHeaders(requireAdmin()),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      places: {
        id: string;
        name: string;
        kind: string;
        code: string | null;
        floorLabel: string | null;
        classUsage: { sectionCount: number; teacherNames: string[]; classes: unknown[] };
        destinationSummary: { count: number };
      }[];
    }>();
    // Tenant/school isolation: school B room excluded.
    expect(body.places.map((place) => place.name).sort()).toEqual(['Gym', 'Room 214', 'Room 215']);
    const room = body.places.find((place) => place.id === room214);
    expect(room?.code).toBe('214');
    expect(room?.floorLabel).toBe('2nd floor');
    // Shared room: two sections, two distinct teachers.
    expect(room?.classUsage.sectionCount).toBe(2);
    expect(room?.classUsage.teacherNames).toEqual(['Mr. Jones', 'Ms. Smith']);
    expect(room?.classUsage.classes).toEqual([]);
    // Teacher in two rooms: Biology teacher also listed at Room 215.
    const other = body.places.find((place) => place.id === room215);
    expect(other?.classUsage.sectionCount).toBe(1);
    expect(other?.classUsage.teacherNames).toEqual(['Ms. Smith']);
    // Gym without meetings has no usage.
    expect(body.places.find((place) => place.id === gym)?.classUsage.sectionCount).toBe(0);
    expect(room?.destinationSummary.count).toBe(0);
  });

  it('reads one Place with per-class detail', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/places/${room214}`,
      headers: authHeaders(requireAdmin()),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      place: {
        name: string;
        classUsage: {
          sectionCount: number;
          teacherNames: string[];
          classes: { title: string; code: string | null; teacherNames: string[] }[];
        };
      };
    }>();
    expect(body.place.name).toBe('Room 214');
    expect(body.place.classUsage.classes).toEqual([
      { title: 'Algebra II', code: 'ALG-2', teacherNames: ['Ms. Smith'] },
      { title: 'Geometry', code: 'GEO-1', teacherNames: ['Mr. Jones'] },
    ]);
  });

  it('bulk-creates one ordinary destination per Place and skips covered Places', async () => {
    const payload = {
      locationIds: [room214, room215, gym],
      categoryId: categoryVisits,
      studentSelfRequestable: true,
      checkInMode: 'none',
      capacity: null,
      defaultDurationSeconds: 600,
    };
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${schoolA}/destinations/bulk-create-from-locations`,
      headers: authHeaders(requireAdmin(), randomUUID()),
      payload,
    });
    expect(first.statusCode).toBe(200);
    const created = first.json<{
      created: { id: string; status: string }[];
      skippedLocationIds: string[];
    }>();
    expect(created.created).toHaveLength(3);
    expect(created.skippedLocationIds).toEqual([]);
    // Ordinary destinations: closed on creation, no staff grants implied.
    for (const entry of created.created) expect(entry.status).toBe('closed');
    const rows = await pool.query<{ location_id: string; service_type: string; status: string }>(
      `SELECT location_id, service_type, status FROM destination WHERE tenant_id = $1 AND organization_id = $2 AND category_id = $3 AND status <> 'archived'`,
      [tenantA, schoolA, categoryVisits],
    );
    expect(rows.rowCount).toBe(3);

    // Retry is idempotent: everything covered, nothing duplicated.
    const retry = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${schoolA}/destinations/bulk-create-from-locations`,
      headers: authHeaders(requireAdmin(), randomUUID()),
      payload,
    });
    expect(retry.statusCode).toBe(200);
    const repeated = retry.json<{ created: unknown[]; skippedLocationIds: string[] }>();
    expect(repeated.created).toHaveLength(0);
    expect(repeated.skippedLocationIds.sort()).toEqual([gym, room214, room215].sort());
    const again = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM destination WHERE tenant_id = $1 AND category_id = $2`,
      [tenantA, categoryVisits],
    );
    expect(again.rows[0]?.n).toBe(3);
  });

  it('creates nothing when any selected Place is invalid', async () => {
    const before = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM destination WHERE tenant_id = $1`,
      [tenantA],
    );
    const bad = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${schoolA}/destinations/bulk-create-from-locations`,
      headers: authHeaders(requireAdmin(), randomUUID()),
      payload: {
        locationIds: [room215, '00000000-0000-4000-8000-000000000099'],
        categoryId: categoryVisits,
        studentSelfRequestable: true,
      },
    });
    expect(bad.statusCode).toBe(400);
    const after = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM destination WHERE tenant_id = $1`,
      [tenantA],
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it('exposes safe search context in the student catalog', async () => {
    // Bulk-created destinations start closed: open Room 214 for the catalog read.
    const target = await pool.query<{ id: string }>(
      `SELECT id FROM destination WHERE tenant_id = $1 AND organization_id = $2 AND location_id = $3 AND category_id = $4 AND status = 'closed' LIMIT 1`,
      [tenantA, schoolA, room214, categoryVisits],
    );
    const destinationId = target.rows[0]?.id;
    if (!destinationId) throw new Error('bulk fixture missing');
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/destinations/${destinationId}`,
      headers: authHeaders(requireAdmin()),
    });
    expect(detail.statusCode).toBe(200);
    const etag = detail.headers.etag ?? '';
    const open = await app.inject({
      method: 'POST',
      url: `/api/v1/destinations/${destinationId}/open`,
      headers: { ...authHeaders(requireAdmin(), randomUUID()), 'if-match': etag },
    });
    expect(open.statusCode).toBe(200);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/me/organizations/${schoolA}/student-destination-catalog`,
      headers: authHeaders(requireStudent()),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      categories: {
        name: string;
        destinations: {
          displayName: string;
          location: { name: string; code: string | null };
          searchContext: { staffDisplayNames: string[]; sectionLabels: string[] };
        }[];
      }[];
    }>();
    const room = body.categories
      .flatMap((category) => category.destinations)
      .find((entry) => entry.location.name === 'Room 214');
    expect(room?.location.code).toBe('214');
    // Derived schedule context only: no staff IDs, grants, or rosters.
    expect(room?.searchContext.staffDisplayNames).toEqual(['Mr. Jones', 'Ms. Smith']);
    expect(room?.searchContext.sectionLabels).toEqual(
      expect.arrayContaining(['Algebra II', 'Geometry', 'ALG-2', 'GEO-1']),
    );
  });
});
