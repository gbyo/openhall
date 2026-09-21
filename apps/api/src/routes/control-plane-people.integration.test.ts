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
): Promise<{ cookie: string; csrf: string }> {
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
  family = 'Test',
  withAccount = true,
  gradeLevel: string | null = null,
): Promise<{ personId: string; accountId: string | null }> {
  const personId = await insertReturningId(
    `INSERT INTO person (tenant_id, given_name, family_name, display_name) VALUES ($1, $2, $3, $4) RETURNING id`,
    [tenantId, given, family, `${given} ${family}`],
  );
  let accountId: string | null = null;
  if (withAccount) {
    accountId = await insertReturningId(
      `INSERT INTO account (tenant_id, person_id) VALUES ($1, $2) RETURNING id`,
      [tenantId, personId],
    );
  }
  await pool.query(
    `INSERT INTO organization_membership (tenant_id, organization_id, person_id, affiliation, grade_level) VALUES ($1, $2, $3, $4, $5)`,
    [tenantId, schoolId, personId, affiliation, gradeLevel],
  );
  return { personId, accountId };
}

async function makeSession(
  tenantId: string,
  personId: string,
  accountId: string,
): Promise<SessionFixture> {
  const { cookie, csrf } = await mintSession(tenantId, accountId);
  return { personId, accountId, cookie, csrf };
}

let adminA: SessionFixture | null = null;
let adminB: SessionFixture | null = null;
let counselorA: SessionFixture | null = null;
let studentSession: SessionFixture | null = null;

function requireAdmin(): SessionFixture {
  if (adminA === null) throw new Error('admin fixture missing');
  return adminA;
}

function authHeaders(session: { cookie: string; csrf: string }): Record<string, string> {
  return {
    cookie: `openhall_session_dev=${session.cookie}`,
    'x-csrf-token': session.csrf,
    origin: ORIGIN,
  };
}

interface DirectoryPerson {
  personId: string;
  displayName: string;
  givenName: string;
  familyName: string;
  affiliation: string;
  gradeLevel: string | null;
  personStatus: string;
  membershipStatus: string;
  account: { exists: boolean; status: string | null; identityLinked: boolean };
}

interface SectionChoiceBody {
  id: string;
  code: string | null;
  title: string;
  status: string;
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
    `INSERT INTO tenant (name, slug) VALUES ('TA', 'cpta') RETURNING id`,
  );
  schoolA = await insertReturningId(
    `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'A School', 'cpa-school', 'America/New_York') RETURNING id`,
    [tenantA],
  );
  tenantB = await insertReturningId(
    `INSERT INTO tenant (name, slug) VALUES ('TB', 'cptb') RETURNING id`,
  );
  schoolB = await insertReturningId(
    `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'B School', 'cpb-school', 'America/New_York') RETURNING id`,
    [tenantB],
  );

  const adminMember = await makeMember(tenantA, schoolA, 'staff', 'Ada');
  if (adminMember.accountId === null) throw new Error('admin needs an account');
  await pool.query(
    `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind, organization_id) VALUES ($1, $2, 'school_admin', 'organization', $3)`,
    [tenantA, adminMember.accountId, schoolA],
  );
  adminA = await makeSession(tenantA, adminMember.personId, adminMember.accountId);

  const adminBMember = await makeMember(tenantB, schoolB, 'staff', 'Bob');
  if (adminBMember.accountId === null) throw new Error('admin needs an account');
  await pool.query(
    `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind, organization_id) VALUES ($1, $2, 'school_admin', 'organization', $3)`,
    [tenantB, adminBMember.accountId, schoolB],
  );
  adminB = await makeSession(tenantB, adminBMember.personId, adminBMember.accountId);

  const counselorMember = await makeMember(tenantA, schoolA, 'staff', 'Cora');
  if (counselorMember.accountId === null) throw new Error('counselor needs an account');
  await pool.query(
    `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind, organization_id) VALUES ($1, $2, 'counselor', 'organization', $3)`,
    [tenantA, counselorMember.accountId, schoolA],
  );
  counselorA = await makeSession(tenantA, counselorMember.personId, counselorMember.accountId);

  // Directory population for school A.
  await makeMember(tenantA, schoolA, 'staff', 'Alice', 'Anderson');
  const bob = await makeMember(tenantA, schoolA, 'staff', 'Bob', 'Brown');
  if (bob.accountId !== null) {
    await pool.query(
      `INSERT INTO auth_identity (tenant_id, account_id, issuer, provider_subject, email_snapshot) VALUES ($1, $2, 'https://accounts.example.test', 'bob-subject', 'bob@example.test')`,
      [tenantA, bob.accountId],
    );
  }
  const cara = await makeMember(tenantA, schoolA, 'student', 'Cara', 'Carter', true, '09');
  if (cara.accountId === null) throw new Error('student needs an account');
  studentSession = await makeSession(tenantA, cara.personId, cara.accountId);
  await makeMember(tenantA, schoolA, 'student', 'Nancy', 'Noaccount', false, '10');
  // Isolation fixtures: other school member and a person with no membership.
  await makeMember(tenantB, schoolB, 'staff', 'Far', 'Faraway');
  await insertReturningId(
    `INSERT INTO person (tenant_id, given_name, family_name, display_name) VALUES ($1, 'Ghost', 'Nobody', 'Ghost Nobody') RETURNING id`,
    [tenantA],
  );

  const session = await insertReturningId(
    `INSERT INTO academic_session (tenant_id, organization_id, kind, name, starts_on, ends_on) VALUES ($1, $2, 'school_year', 'SY', '2026-08-01', '2027-06-01') RETURNING id`,
    [tenantA, schoolA],
  );
  await insertReturningId(
    `INSERT INTO section (tenant_id, organization_id, academic_session_id, code, title) VALUES ($1, $2, $3, 'HIST-1', 'History') RETURNING id`,
    [tenantA, schoolA, session],
  );
  await insertReturningId(
    `INSERT INTO section (tenant_id, organization_id, academic_session_id, code, title) VALUES ($1, $2, $3, 'MATH-2', 'Math') RETURNING id`,
    [tenantA, schoolA, session],
  );
  const sessionB = await insertReturningId(
    `INSERT INTO academic_session (tenant_id, organization_id, kind, name, starts_on, ends_on) VALUES ($1, $2, 'school_year', 'SY', '2026-08-01', '2027-06-01') RETURNING id`,
    [tenantB, schoolB],
  );
  await insertReturningId(
    `INSERT INTO section (tenant_id, organization_id, academic_session_id, code, title) VALUES ($1, $2, $3, 'SCI-9', 'Science') RETURNING id`,
    [tenantB, schoolB, sessionB],
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

describe('control-plane people search', () => {
  it('returns the exact-school directory with enrollment visibility', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/people`,
      headers: authHeaders(requireAdmin()),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ people: DirectoryPerson[]; nextCursor: string | null }>();
    expect(body.nextCursor).toBeNull();
    const names = body.people.map((entry) => entry.displayName);
    expect(names).toEqual([...names].sort());
    expect(names).toContain('Ada Test');
    expect(names).toContain('Alice Anderson');
    expect(names).toContain('Bob Brown');
    expect(names).toContain('Cara Carter');
    expect(names).toContain('Nancy Noaccount');
    expect(names).not.toContain('Far Faraway');
    expect(names).not.toContain('Ghost Nobody');

    const bob = body.people.find((entry) => entry.displayName === 'Bob Brown');
    expect(bob?.account).toEqual({ exists: true, status: 'active', identityLinked: true });
    const alice = body.people.find((entry) => entry.displayName === 'Alice Anderson');
    expect(alice?.account).toEqual({ exists: true, status: 'active', identityLinked: false });
    const nancy = body.people.find((entry) => entry.displayName === 'Nancy Noaccount');
    expect(nancy?.account).toEqual({ exists: false, status: null, identityLinked: false });
    expect(nancy?.gradeLevel).toBe('10');
    expect(nancy?.affiliation).toBe('student');

    const raw = JSON.stringify(body);
    expect(raw).not.toContain('bob-subject');
    expect(raw).not.toContain('accounts.example.test');
    expect(raw).not.toContain('bob@example.test');
  });

  it('filters by text and affiliation', async () => {
    const admin = authHeaders(requireAdmin());
    const byName = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/people?q=alice`,
      headers: admin,
    });
    expect(byName.statusCode).toBe(200);
    expect(byName.json<{ people: DirectoryPerson[] }>().people.map((e) => e.displayName)).toEqual([
      'Alice Anderson',
    ]);

    const missing = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/people?q=zzz-no-such-person`,
      headers: admin,
    });
    expect(missing.json<{ people: DirectoryPerson[] }>().people).toEqual([]);

    const students = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/people?affiliation=student`,
      headers: admin,
    });
    const studentNames = students
      .json<{ people: DirectoryPerson[] }>()
      .people.map((e) => e.displayName);
    expect(studentNames).toContain('Cara Carter');
    expect(studentNames).toContain('Nancy Noaccount');
    expect(studentNames).not.toContain('Alice Anderson');

    const staff = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/people?affiliation=staff`,
      headers: admin,
    });
    const staffNames = staff.json<{ people: DirectoryPerson[] }>().people.map((e) => e.displayName);
    expect(staffNames).toContain('Alice Anderson');
    expect(staffNames).not.toContain('Cara Carter');
  });

  it('pages with keyset cursors', async () => {
    const admin = authHeaders(requireAdmin());
    const first = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/people?limit=2`,
      headers: admin,
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<{ people: DirectoryPerson[]; nextCursor: string | null }>();
    expect(firstBody.people).toHaveLength(2);
    if (firstBody.nextCursor === null) throw new Error('Expected a next cursor');

    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/people?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
      headers: admin,
    });
    const secondBody = second.json<{ people: DirectoryPerson[]; nextCursor: string | null }>();
    expect(secondBody.people).toHaveLength(2);
    const overlap = firstBody.people
      .map((e) => e.personId)
      .filter((id) => secondBody.people.some((e) => e.personId === id));
    expect(overlap).toEqual([]);

    const bad = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/people?cursor=not-a-cursor`,
      headers: admin,
    });
    expect(bad.statusCode).toBe(400);

    const tooMany = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/people?limit=200`,
      headers: admin,
    });
    expect(tooMany.statusCode).toBe(400);
  });

  it('conceals other schools and denies students', async () => {
    if (adminB === null || studentSession === null) throw new Error('fixtures missing');
    const concealed = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/people`,
      headers: authHeaders(adminB),
    });
    expect(concealed.statusCode).toBe(404);

    const denied = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/people`,
      headers: authHeaders(studentSession),
    });
    expect(denied.statusCode).toBe(403);
  });
});

describe('control-plane section chooser', () => {
  it('returns section choices without rosters', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/sections`,
      headers: authHeaders(requireAdmin()),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ sections: SectionChoiceBody[]; nextCursor: string | null }>();
    expect(body.nextCursor).toBeNull();
    expect(body.sections).toHaveLength(2);
    for (const section of body.sections) {
      expect(Object.keys(section).sort()).toEqual(['code', 'id', 'status', 'title']);
    }
    const titles = body.sections.map((section) => section.title).sort();
    expect(titles).toEqual(['History', 'Math']);

    const filtered = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/sections?q=hist`,
      headers: authHeaders(requireAdmin()),
    });
    expect(filtered.json<{ sections: SectionChoiceBody[] }>().sections.map((s) => s.code)).toEqual([
      'HIST-1',
    ]);
  });

  it('denies callers without schedule or people view', async () => {
    if (counselorA === null || studentSession === null) throw new Error('fixtures missing');
    const denied = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/sections`,
      headers: authHeaders(counselorA),
    });
    expect(denied.statusCode).toBe(403);
    const student = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/sections`,
      headers: authHeaders(studentSession),
    });
    expect(student.statusCode).toBe(403);
  });
});
