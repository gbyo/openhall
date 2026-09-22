import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { AppConfig } from '@openhall/config';
import { createDatabase } from '@openhall/db';
import type { FastifyInstance } from 'fastify';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';

const APP_SECRET = 'test-only-app-secret-32-characters!!';
const TEST_KEY = new Uint8Array(32).fill(7);

const config: AppConfig = {
  nodeEnv: 'test',
  appBaseUrl: new URL('http://localhost:3000'),
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

/** Mints a real session row and returns the cookie value (no fake headers). */
async function mintSessionCookie(
  tenantId: string,
  accountId: string,
  method: 'oidc' | 'recovery' = 'oidc',
): Promise<string> {
  const raw = randomBytes(32);
  const tokenDigest = domainHmac('session-digest:v1', raw);
  const csrfDigest = createHmac('sha256', APP_SECRET)
    .update(Buffer.from(domainHmac('csrf-token:v1', raw)))
    .digest();
  await pool.query(
    `INSERT INTO auth_session
      (tenant_id, account_id, token_hash, csrf_token_hash, account_session_revision,
       authentication_method, idle_expires_at, absolute_expires_at)
     VALUES ($1, $2, $3, $4, 0, $5, now() + interval '12 hours', now() + interval '7 days')`,
    [tenantId, accountId, Buffer.from(tokenDigest), csrfDigest, method],
  );
  return Buffer.from(raw).toString('base64url');
}

async function insertReturningId(text: string, params: unknown[] = []): Promise<string> {
  const id = (await pool.query<{ id: string }>(text, params)).rows[0]?.id;
  if (id === undefined) throw new Error('Fixture insert failed');
  return id;
}

async function insertAccount(
  tenantId: string,
  given: string,
): Promise<{ accountId: string; personId: string }> {
  const personId = await insertReturningId(
    `INSERT INTO person (tenant_id, given_name, family_name, display_name) VALUES ($1, $2, $3, $4) RETURNING id`,
    [tenantId, given, 'Test', `${given} Test`],
  );
  const accountId = await insertReturningId(
    `INSERT INTO account (tenant_id, person_id) VALUES ($1, $2) RETURNING id`,
    [tenantId, personId],
  );
  return { accountId, personId };
}

let tenantA = '';
let tenantB = '';
let schoolA = '';
let schoolB = '';
let tenantBSchool = '';
let archivedSchool = '';
let sectionA1 = '';
let sectionA2 = '';
let destinationA1 = '';

let studentCookie = '';
let teacherCookie = '';
let destinationStaffCookie = '';
let sysadminCookie = '';
let recoveryCookie = '';
let otherTenantCookie = '';

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
  pool = new Pool({ connectionString: databaseUrl, max: 4 });

  app = await createApp({
    config,
    database: handle.database,
    logger: false,
    rateLimitDisabled: true,
    readinessProbe: {
      check: () => Promise.resolve({ migration: '004_authorization_relationships' }),
    },
  });

  tenantA = await insertReturningId(
    `INSERT INTO tenant (name, slug) VALUES ('TA', 'ta') RETURNING id`,
  );
  tenantB = await insertReturningId(
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
  archivedSchool = await insertReturningId(
    `INSERT INTO organization (tenant_id, kind, name, slug, time_zone, status) VALUES ($1, 'school', 'Old', 'old-school', 'America/New_York', 'archived') RETURNING id`,
    [tenantA],
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

  const categoryA1 = await insertReturningId(
    `INSERT INTO room_category (tenant_id, organization_id, name, student_surface) VALUES ($1, $2, 'Nurse', 'primary') RETURNING id`,
    [tenantA, schoolA],
  );
  destinationA1 = await insertReturningId(
    `INSERT INTO room (tenant_id, organization_id, category_id, student_self_requestable, name) VALUES ($1, $2, $3, true, 'Nurse') RETURNING id`,
    [tenantA, schoolA, categoryA1],
  );

  // Student at school A.
  const student = await insertAccount(tenantA, 'Student');
  await pool.query(
    `INSERT INTO organization_membership (tenant_id, organization_id, person_id, affiliation) VALUES ($1, $2, $3, 'student')`,
    [tenantA, schoolA, student.personId],
  );
  studentCookie = await mintSessionCookie(tenantA, student.accountId);

  // Teacher of section A1; target student in the same section.
  const teacher = await insertAccount(tenantA, 'Teacher');
  await pool.query(
    `INSERT INTO organization_membership (tenant_id, organization_id, person_id, affiliation) VALUES ($1, $2, $3, 'staff')`,
    [tenantA, schoolA, teacher.personId],
  );
  await pool.query(
    `INSERT INTO section_membership (tenant_id, section_id, person_id, role) VALUES ($1, $2, $3, 'teacher')`,
    [tenantA, sectionA1, teacher.personId],
  );
  await pool.query(
    `INSERT INTO section_membership (tenant_id, section_id, person_id, role) VALUES ($1, $2, $3, 'student')`,
    [tenantA, sectionA1, student.personId],
  );
  teacherCookie = await mintSessionCookie(tenantA, teacher.accountId);

  // Destination staff assigned to the nurse destination.
  const nurse = await insertAccount(tenantA, 'Nurse');
  await pool.query(
    `INSERT INTO organization_membership (tenant_id, organization_id, person_id, affiliation) VALUES ($1, $2, $3, 'staff')`,
    [tenantA, schoolA, nurse.personId],
  );
  await pool.query(
    `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind, room_id) VALUES ($1, $2, 'room_staff', 'room', $3)`,
    [tenantA, nurse.accountId, destinationA1],
  );
  destinationStaffCookie = await mintSessionCookie(tenantA, nurse.accountId);

  // Tenant system admin without school membership.
  const sys = await insertAccount(tenantA, 'Sys');
  await pool.query(
    `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind) VALUES ($1, $2, 'system_admin', 'tenant')`,
    [tenantA, sys.accountId],
  );
  sysadminCookie = await mintSessionCookie(tenantA, sys.accountId);
  recoveryCookie = await mintSessionCookie(tenantA, sys.accountId, 'recovery');

  // Unrelated tenant session for cross-tenant probes.
  const other = await insertAccount(tenantB, 'Other');
  otherTenantCookie = await mintSessionCookie(tenantB, other.accountId);
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

function cookieHeader(cookie: string): Record<string, string> {
  return { cookie: `openhall_session_dev=${cookie}` };
}

describe('GET /api/v1/me/organizations', () => {
  it('rejects anonymous callers with 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/me/organizations' });
    expect(response.statusCode).toBe(401);
  });

  it('returns the student’s own school only', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/me/organizations',
      headers: cookieHeader(studentCookie),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json<{ organizations: { id: string; affiliations: string[] }[] }>();
    expect(body.organizations.map((entry) => entry.id)).toEqual([schoolA]);
    expect(body.organizations[0]?.affiliations).toEqual(['student']);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('authorization_grant');
    expect(raw).not.toContain('accountId');
    expect(raw).not.toContain('session_revision');
  });

  it('returns every active school to a tenant system admin', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/me/organizations',
      headers: cookieHeader(sysadminCookie),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ organizations: { id: string; affiliations: string[] }[] }>();
    const ids = body.organizations.map((entry) => entry.id);
    expect(ids).toContain(schoolA);
    expect(ids).toContain(schoolB);
    expect(ids).not.toContain(tenantBSchool);
    expect(ids).not.toContain(archivedSchool);
  });

  it('rejects recovery sessions with 403', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/me/organizations',
      headers: cookieHeader(recoveryCookie),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('recovery_session_restricted');
  });
});

describe('GET /api/v1/me/organizations/:organizationId/context', () => {
  it('rejects anonymous callers with 401', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/me/organizations/${schoolA}/context`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns student context with self capabilities and minimized placement', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/me/organizations/${schoolA}/context`,
      headers: cookieHeader(studentCookie),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json<{
      affiliations: string[];
      capabilities: string[];
      expectedPlacement: { kind: string } | null;
      teachingSections: unknown[];
      staffedRooms: unknown[];
    }>();
    expect(body.affiliations).toEqual(['student']);
    expect(body.capabilities).toEqual([
      'organization.context.read',
      'pass.request.self',
      'pass.depart.self',
    ]);
    expect(body.teachingSections).toEqual([]);
    expect(body.expectedPlacement?.kind).toBe('calendar_not_configured');
    const raw = JSON.stringify(body);
    for (const leaked of [
      'authorization_grant',
      '"role"',
      'accountId',
      'session_revision',
      'teacher',
    ]) {
      expect(raw).not.toContain(leaked);
    }
  });

  it('returns teacher relationships on the assignment, never rosters', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/me/organizations/${schoolA}/context`,
      headers: cookieHeader(teacherCookie),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      capabilities: string[];
      teachingSections: { id: string; capabilities: string[] }[];
      expectedPlacement: unknown;
    }>();
    expect(body.capabilities).toEqual(['organization.context.read']);
    expect(body.teachingSections.map((section) => section.id)).toEqual([sectionA1]);
    expect(body.teachingSections).not.toContainEqual(expect.objectContaining({ id: sectionA2 }));
    expect(body.teachingSections[0]?.capabilities).toEqual([
      'pass.create.student',
      'pass.depart.student',
      'pass.approve.section',
      'pass.view.section_live',
      'pass.override.request.student',
      'pass.override.resolve.section',
    ]);
    expect(body.expectedPlacement).toBeNull();
  });

  it('returns explicit destination assignments only', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/me/organizations/${schoolA}/context`,
      headers: cookieHeader(destinationStaffCookie),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      capabilities: string[];
      staffedRooms: { id: string; displayName: string; capabilities: string[] }[];
    }>();
    expect(body.capabilities).toEqual(['organization.context.read']);
    expect(body.staffedRooms.map((destination) => destination.id)).toEqual([destinationA1]);
    expect(body.staffedRooms[0]?.capabilities).toEqual(['room.station.manage']);
  });

  it('conceals inaccessible schools as 404, including cross-tenant UUIDs', async () => {
    for (const id of [schoolB, tenantBSchool, randomUUID()]) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/me/organizations/${id}/context`,
        headers: cookieHeader(studentCookie),
      });
      expect(response.statusCode).toBe(404);
      expect(response.json<{ code: string }>().code).toBe('not_found');
    }
    // Cross-tenant session against a real school-A UUID is also 404, not 403.
    const cross = await app.inject({
      method: 'GET',
      url: `/api/v1/me/organizations/${schoolA}/context`,
      headers: cookieHeader(otherTenantCookie),
    });
    expect(cross.statusCode).toBe(404);
  });

  it('rejects recovery sessions with 403 rather than 404', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/me/organizations/${schoolA}/context`,
      headers: cookieHeader(recoveryCookie),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('recovery_session_restricted');
  });

  it('authorizes SSE against the exact school without leaking inaccessible schools', async () => {
    const anonymous = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/events`,
    });
    expect(anonymous.statusCode).toBe(401);

    const recovery = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/events`,
      headers: cookieHeader(recoveryCookie),
    });
    expect(recovery.statusCode).toBe(403);
    expect(recovery.json<{ code: string }>().code).toBe('recovery_session_restricted');

    const crossTenant = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/events`,
      headers: cookieHeader(otherTenantCookie),
    });
    expect(crossTenant.statusCode).toBe(404);
    expect(crossTenant.json<{ code: string }>().code).toBe('not_found');
  });

  it('documents cookie auth and stable operation IDs in OpenAPI', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/openapi.json' });
    expect(response.statusCode).toBe(200);
    const document = response.json<{
      paths: Record<string, Record<string, { operationId?: string; security?: unknown }>>;
    }>();
    expect(document.paths['/api/v1/me/organizations']?.get?.operationId).toBe(
      'listMyOrganizations',
    );
    expect(
      document.paths['/api/v1/me/organizations/{organizationId}/context']?.get?.operationId,
    ).toBe('getMyOrganizationContext');
    expect(document.paths['/api/v1/me/organizations']?.get?.security).toEqual([{ cookieAuth: [] }]);
  });
});
