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
let destinationA = '';
let tenantB = '';
let tenantBSchool = '';

let teacher: SessionFixture | null = null;
let otherTeacher: SessionFixture | null = null;
let counselor: SessionFixture | null = null;
let outsider: SessionFixture | null = null;

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

function mustFind<T extends { passId: string }>(items: readonly T[], passId: string): T {
  const found = items.find((entry) => entry.passId === passId);
  if (found === undefined) throw new Error('Expected workflow item missing');
  return found;
}

interface PolicyProjection {
  decision: string;
  evaluatedAt: string;
  reasonCodes: string[];
  approvalPending: boolean;
  overrideAvailable: boolean;
  overridePending: boolean;
}

interface PassBody {
  id: string;
  lifecycleState: string;
  revision: string;
  policy: PolicyProjection | null;
  movement: {
    readyUntil: string | null;
    queueEnteredAt: string | null;
    queueExpiresAt: string | null;
    expectedReturnAt: string | null;
    reasonCode: string | null;
  };
}

async function seedRule(input: {
  name: string;
  ruleType: string;
  scopeKind: 'organization' | 'section' | 'destination' | 'destination_category';
  scopeId: string;
  priority?: number;
  configuration: unknown;
  overrideMode: string;
}): Promise<string> {
  const scopeColumn =
    input.scopeKind === 'organization'
      ? 'scope_organization_id'
      : input.scopeKind === 'section'
        ? 'scope_section_id'
        : input.scopeKind === 'destination'
          ? 'scope_destination_id'
          : 'scope_destination_category_id';
  return insertReturningId(
    `INSERT INTO policy_rule (tenant_id, organization_id, name, rule_type, scope_kind, ${scopeColumn}, priority, configuration, override_mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      tenantA,
      schoolA,
      input.name,
      input.ruleType,
      input.scopeKind,
      input.scopeId,
      input.priority ?? 0,
      JSON.stringify(input.configuration),
      input.overrideMode,
    ],
  );
}

const BLACKOUT_OVERLAP = {
  schemaVersion: 1,
  firstMinutes: 720,
  lastMinutes: 720,
  blockKinds: ['instructional'],
  requestSources: ['student_web', 'staff_web'],
};

const APPROVAL_CONFIG = {
  schemaVersion: 1,
  requestSources: ['student_web'],
  approver: 'current_section_teacher',
};

async function clearRules(): Promise<void> {
  await pool.query(`DELETE FROM pass_override`);
  await pool.query(`DELETE FROM pass_approval`);
  // Destination-flow rows bind exact policy evaluations; delete them before
  // the evaluations they reference.
  await pool.query(`DELETE FROM queue_entry`);
  await pool.query(`DELETE FROM destination_reservation`);
  await pool.query(`DELETE FROM policy_evaluation_result`);
  await pool.query(`DELETE FROM policy_evaluation`);
  await pool.query(`DELETE FROM policy_rule`);
}

async function makePassStudent(given: string, sectionId: string | null = sectionA1) {
  const student = await makeStudent(tenantA, schoolA, given);
  if (sectionId !== null) {
    await pool.query(
      `INSERT INTO section_membership (tenant_id, section_id, person_id, role) VALUES ($1, $2, $3, 'student')`,
      [tenantA, sectionId, student.personId],
    );
  }
  return student;
}

async function requestPass(student: SessionFixture, key: string = randomUUID()) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/me/passes',
    headers: authHeaders(student, key),
    payload: { destinationId: destinationA },
  });
}

async function tableCount(table: string, where = ''): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*) AS count FROM ${table} ${where}`,
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function passEvents(passId: string): Promise<{ event_type: string; sequence: string }[]> {
  return (
    await pool.query<{ event_type: string; sequence: string }>(
      `SELECT event_type, sequence FROM pass_event WHERE pass_id = $1 ORDER BY sequence`,
      [passId],
    )
  ).rows;
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
      check: () => Promise.resolve({ migration: '006_movement_policy_approvals_overrides' }),
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
  const categoryA = await insertReturningId(
    `INSERT INTO destination_category (tenant_id, organization_id, name, student_surface) VALUES ($1, $2, 'Restrooms', 'primary') RETURNING id`,
    [tenantA, schoolA],
  );
  destinationA = await insertReturningId(
    `INSERT INTO destination (tenant_id, organization_id, location_id, category_id, student_self_requestable, service_type, display_name) VALUES ($1, $2, $3, $4, true, 'restroom', 'Restroom B') RETURNING id`,
    [tenantA, schoolA, locationA, categoryA],
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
  otherTeacher = await makeStaff(tenantA, schoolA, 'OtherTeacher');
  await pool.query(
    `INSERT INTO section_membership (tenant_id, section_id, person_id, role) VALUES ($1, $2, $3, 'teacher')`,
    [tenantA, sectionA2, otherTeacher.personId],
  );
  counselor = await makeStaff(tenantA, schoolA, 'Counselor');
  await pool.query(
    `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind, organization_id) VALUES ($1, $2, 'counselor', 'organization', $3)`,
    [tenantA, counselor.accountId, schoolA],
  );
  outsider = await makeStaff(tenantB, tenantBSchool, 'Outsider');
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

describe('initial request policy integration', () => {
  it('records allow with no rules and one evaluation', async () => {
    await clearRules();
    const student = await makePassStudent('Allow');
    const created = await requestPass(student);
    expect(created.statusCode).toBe(201);
    const pass = created.json<{ pass: PassBody }>().pass;
    // Phase 7 consumes the policy-allow boundary: a cleared pass is offered
    // destination capacity inside the request transaction.
    expect(pass.lifecycleState).toBe('ready');
    expect(pass.revision).toBe('2');
    expect(pass.policy?.decision).toBe('allow');
    expect(pass.movement.readyUntil).not.toBeNull();
    expect(requiredEtag(created)).toContain(':2"');
    expect(await tableCount('policy_evaluation')).toBe(1);
    expect(
      await tableCount(
        'destination_reservation',
        `WHERE pass_id = '${pass.id}' AND released_at IS NULL`,
      ),
    ).toBe(1);
    expect((await passEvents(pass.id)).map((entry) => entry.event_type)).toEqual([
      'pass.requested',
      'pass.ready',
    ]);
  });

  it('denies immediately on a nonoverrideable blackout with truthful history', async () => {
    await clearRules();
    await seedRule({
      name: 'blackout',
      ruleType: 'schedule_boundary',
      scopeKind: 'organization',
      scopeId: schoolA,
      configuration: BLACKOUT_OVERLAP,
      overrideMode: 'never',
    });
    const student = await makePassStudent('Denied');
    const created = await requestPass(student);
    expect(created.statusCode).toBe(201);
    const pass = created.json<{ pass: PassBody }>().pass;
    expect(pass.lifecycleState).toBe('denied');
    expect(pass.revision).toBe('2');
    expect(pass.policy?.decision).toBe('deny');
    expect(pass.policy?.reasonCodes).toContain('schedule_boundary_blackout');
    expect(requiredEtag(created)).toContain(':2"');
    expect((await passEvents(pass.id)).map((entry) => entry.event_type)).toEqual([
      'pass.requested',
      'pass.denied',
    ]);
    expect(
      await tableCount('pass_approval', `WHERE pass_id = '${pass.id}' AND decision = 'pending'`),
    ).toBe(0);
  });

  it('leaves overrideable blackouts requested with override available', async () => {
    await clearRules();
    await seedRule({
      name: 'blackout',
      ruleType: 'schedule_boundary',
      scopeKind: 'organization',
      scopeId: schoolA,
      configuration: BLACKOUT_OVERLAP,
      overrideMode: 'authorized',
    });
    const student = await makePassStudent('Overridable');
    const created = await requestPass(student);
    expect(created.statusCode).toBe(201);
    const pass = created.json<{ pass: PassBody }>().pass;
    expect(pass.lifecycleState).toBe('requested');
    expect(pass.revision).toBe('1');
    expect(pass.policy?.decision).toBe('override_required');
    expect(pass.policy?.overrideAvailable).toBe(true);
    expect(pass.policy?.overridePending).toBe(false);
  });

  it('creates exactly one pending approval for an approval requirement', async () => {
    await clearRules();
    await seedRule({
      name: 'teacher approval',
      ruleType: 'approval_requirement',
      scopeKind: 'organization',
      scopeId: schoolA,
      configuration: APPROVAL_CONFIG,
      overrideMode: 'never',
    });
    const student = await makePassStudent('Approval');
    const created = await requestPass(student);
    expect(created.statusCode).toBe(201);
    const pass = created.json<{ pass: PassBody }>().pass;
    expect(pass.lifecycleState).toBe('requested');
    expect(pass.policy?.decision).toBe('approval_required');
    expect(pass.policy?.approvalPending).toBe(true);
    expect(
      await tableCount('pass_approval', `WHERE pass_id = '${pass.id}' AND decision = 'pending'`),
    ).toBe(1);
  });
});

describe('standard approval workflow', () => {
  async function approvalScenario(given: string) {
    await clearRules();
    await seedRule({
      name: 'teacher approval',
      ruleType: 'approval_requirement',
      scopeKind: 'organization',
      scopeId: schoolA,
      configuration: APPROVAL_CONFIG,
      overrideMode: 'never',
    });
    const student = await makePassStudent(given);
    const created = await requestPass(student);
    expect(created.statusCode).toBe(201);
    const pass = created.json<{ pass: PassBody }>().pass;
    return { student, pass, etag: requiredEtag(created) };
  }

  async function pendingFor(session: SessionFixture) {
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/me/pass-approvals/pending',
      headers: { cookie: `openhall_session_dev=${session.cookie}` },
    });
    expect(listed.statusCode).toBe(200);
    return listed.json<{ approvals: { approvalId: string; passId: string; passEtag: string }[] }>()
      .approvals;
  }

  it('grants approval and allocates the pass into destination flow', async () => {
    if (teacher === null) throw new Error('teacher fixture missing');
    const { pass, etag } = await approvalScenario('Grant');
    const approvals = await pendingFor(teacher);
    const target = mustFind(approvals, pass.id);
    const resolved = await app.inject({
      method: 'POST',
      url: `/api/v1/pass-approvals/${target.approvalId}/approve`,
      headers: authHeaders(teacher, randomUUID(), etag),
    });
    expect(resolved.statusCode).toBe(200);
    const body = resolved.json<{ pass: PassBody }>().pass;
    // Approval clears the pass to allow, so the same command transaction
    // allocates it: approval grant (rev 2) then ready offer (rev 3).
    expect(body.lifecycleState).toBe('ready');
    expect(body.revision).toBe('3');
    expect(body.policy?.decision).toBe('allow');
    expect(body.movement.readyUntil).not.toBeNull();
    expect(requiredEtag(resolved)).toContain(':3"');
    expect(
      await tableCount(
        'destination_reservation',
        `WHERE pass_id = '${pass.id}' AND released_at IS NULL`,
      ),
    ).toBe(1);
    // A resolved approval cannot be resolved again.
    const retry = await app.inject({
      method: 'POST',
      url: `/api/v1/pass-approvals/${target.approvalId}/approve`,
      headers: authHeaders(teacher, randomUUID(), requiredEtag(resolved)),
    });
    expect(retry.statusCode).toBe(409);
    expect(retry.json<{ code: string }>().code).toBe('invalid_approval_state');
  });

  it('denies approval into a terminal pass with coherent history', async () => {
    if (teacher === null) throw new Error('teacher fixture missing');
    const { pass, etag } = await approvalScenario('DenyFlow');
    const approvals = await pendingFor(teacher);
    const target = mustFind(approvals, pass.id);
    const resolved = await app.inject({
      method: 'POST',
      url: `/api/v1/pass-approvals/${target.approvalId}/deny`,
      headers: authHeaders(teacher, randomUUID(), etag),
    });
    expect(resolved.statusCode).toBe(200);
    const body = resolved.json<{ pass: PassBody }>().pass;
    expect(body.lifecycleState).toBe('denied');
    expect(body.revision).toBe('3');
    expect(body.policy?.decision).toBe('deny');
    expect((await passEvents(pass.id)).map((entry) => entry.event_type)).toEqual([
      'pass.requested',
      'pass.approval_denied',
      'pass.denied',
    ]);
    expect(
      await tableCount('pass_approval', `WHERE pass_id = '${pass.id}' AND decision = 'pending'`),
    ).toBe(0);
  });

  it('conceals approvals from teachers of other sections', async () => {
    if (otherTeacher === null) throw new Error('other teacher fixture missing');
    const { pass } = await approvalScenario('Concealed');
    const approvals = await pendingFor(otherTeacher);
    expect(approvals.find((entry) => entry.passId === pass.id)).toBeUndefined();
    const forged = await app.inject({
      method: 'POST',
      url: `/api/v1/pass-approvals/${randomUUID()}/approve`,
      headers: authHeaders(
        otherTeacher,
        randomUUID(),
        '"pass:00000000-0000-0000-0000-000000000000:1"',
      ),
    });
    expect(forged.statusCode).toBe(404);
  });

  it('replays idempotent approval resolution without new effects', async () => {
    if (teacher === null) throw new Error('teacher fixture missing');
    const { pass, etag } = await approvalScenario('Replay');
    const approvals = await pendingFor(teacher);
    const target = mustFind(approvals, pass.id);
    const key = randomUUID();
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/pass-approvals/${target.approvalId}/approve`,
      headers: authHeaders(teacher, key, etag),
    });
    expect(first.statusCode).toBe(200);
    const eventsBefore = await passEvents(pass.id);
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/pass-approvals/${target.approvalId}/approve`,
      headers: authHeaders(teacher, key, etag),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(await passEvents(pass.id)).toEqual(eventsBefore);
  });

  it('serializes concurrent approval resolutions with 412 for the loser', async () => {
    if (teacher === null) throw new Error('teacher fixture missing');
    const { pass, etag } = await approvalScenario('Race');
    const approvals = await pendingFor(teacher);
    const target = mustFind(approvals, pass.id);
    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/v1/pass-approvals/${target.approvalId}/approve`,
        headers: authHeaders(teacher, randomUUID(), etag),
      }),
      app.inject({
        method: 'POST',
        url: `/api/v1/pass-approvals/${target.approvalId}/deny`,
        headers: authHeaders(teacher, randomUUID(), etag),
      }),
    ]);
    const codes = [first.statusCode, second.statusCode].sort();
    expect(codes).toEqual([200, 412]);
  });

  it('binds approvals to the exact rule revision', async () => {
    if (teacher === null) throw new Error('teacher fixture missing');
    const { pass, etag } = await approvalScenario('RevBind');
    const approvals = await pendingFor(teacher);
    const target = mustFind(approvals, pass.id);
    await pool.query(`UPDATE policy_rule SET revision = 2 WHERE scope_kind = 'organization'`);
    const resolved = await app.inject({
      method: 'POST',
      url: `/api/v1/pass-approvals/${target.approvalId}/approve`,
      headers: authHeaders(teacher, randomUUID(), etag),
    });
    expect(resolved.statusCode).toBe(200);
    // The revision-1 approval no longer satisfies revision 2: still waiting.
    const body = resolved.json<{ pass: PassBody }>().pass;
    expect(body.policy?.decision).toBe('approval_required');
    expect(body.policy?.approvalPending).toBe(true);
  });

  it('conceals cross-tenant approvals', async () => {
    if (outsider === null || teacher === null) throw new Error('fixture missing');
    const { pass, etag } = await approvalScenario('CrossTenant');
    const approvals = await pendingFor(teacher);
    const target = mustFind(approvals, pass.id);
    const forged = await app.inject({
      method: 'POST',
      url: `/api/v1/pass-approvals/${target.approvalId}/approve`,
      headers: authHeaders(outsider, randomUUID(), etag),
    });
    expect(forged.statusCode).toBe(404);
  });
});

describe('override workflow', () => {
  async function blackoutScenario(given: string, overrideMode: string) {
    await clearRules();
    await seedRule({
      name: 'blackout',
      ruleType: 'schedule_boundary',
      scopeKind: 'organization',
      scopeId: schoolA,
      configuration: BLACKOUT_OVERLAP,
      overrideMode,
    });
    const student = await makePassStudent(given);
    const created = await requestPass(student);
    expect(created.statusCode).toBe(201);
    const pass = created.json<{ pass: PassBody }>().pass;
    return { student, pass, etag: requiredEtag(created) };
  }

  async function pendingOverridesFor(session: SessionFixture) {
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/me/pass-overrides/pending',
      headers: { cookie: `openhall_session_dev=${session.cookie}` },
    });
    expect(listed.statusCode).toBe(200);
    return listed.json<{ overrides: { overrideId: string; passId: string; passEtag: string }[] }>()
      .overrides;
  }

  it('rejects unknown categories and extra body properties', async () => {
    const { student, pass, etag } = await blackoutScenario('CatCheck', 'authorized');
    const badCategory = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${pass.id}/overrides`,
      headers: authHeaders(student, randomUUID(), etag),
      payload: { category: 'sick' },
    });
    expect(badCategory.statusCode).toBe(400);
    const extra = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${pass.id}/overrides`,
      headers: authHeaders(student, randomUUID(), etag),
      payload: { category: 'urgent', note: 'hello' },
    });
    expect(extra.statusCode).toBe(400);
    const missingPrecondition = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${pass.id}/overrides`,
      headers: authHeaders(student, randomUUID()),
      payload: { category: 'urgent' },
    });
    expect(missingPrecondition.statusCode).toBe(428);
  });

  it('returns 409 when no overrideable blocker exists', async () => {
    await clearRules();
    const student = await makePassStudent('NoBlocker');
    const created = await requestPass(student);
    const pass = created.json<{ pass: PassBody }>().pass;
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${pass.id}/overrides`,
      headers: authHeaders(student, randomUUID(), requiredEtag(created)),
      payload: { category: 'urgent' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('override_not_available');

    await clearRules();
    await seedRule({
      name: 'blackout',
      ruleType: 'schedule_boundary',
      scopeKind: 'organization',
      scopeId: schoolA,
      configuration: BLACKOUT_OVERLAP,
      overrideMode: 'never',
    });
    const blocked = await makePassStudent('NeverMode');
    const createdBlocked = await requestPass(blocked);
    const blockedPass = createdBlocked.json<{ pass: PassBody }>().pass;
    expect(blockedPass.lifecycleState).toBe('denied');
  });

  it('records a student self request as pending and resolves it by a teacher', async () => {
    if (teacher === null) throw new Error('teacher fixture missing');
    const { student, pass, etag } = await blackoutScenario('SelfReq', 'authorized');
    const requested = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${pass.id}/overrides`,
      headers: authHeaders(student, randomUUID(), etag),
      payload: { category: 'urgent' },
    });
    expect(requested.statusCode).toBe(200);
    let body = requested.json<{ pass: PassBody }>().pass;
    expect(body.revision).toBe('2');
    expect(body.policy?.decision).toBe('override_required');
    expect(body.policy?.overridePending).toBe(true);
    const pending = await pendingOverridesFor(teacher);
    const target = mustFind(pending, pass.id);
    const approved = await app.inject({
      method: 'POST',
      url: `/api/v1/pass-overrides/${target.overrideId}/approve`,
      headers: authHeaders(teacher, randomUUID(), requiredEtag(requested)),
    });
    expect(approved.statusCode).toBe(200);
    body = approved.json<{ pass: PassBody }>().pass;
    // Override approval clears to allow, so the same command allocates:
    // override request (rev 2), approval (rev 3), ready offer (rev 4).
    expect(body.lifecycleState).toBe('ready');
    expect(body.revision).toBe('4');
    expect(body.policy?.decision).toBe('allow');
    expect(body.movement.readyUntil).not.toBeNull();
  });

  it('lets authorized teachers resolve directly through the staff surface', async () => {
    if (teacher === null) throw new Error('teacher fixture missing');
    const { pass, etag } = await blackoutScenario('Direct', 'authorized');
    const requested = await app.inject({
      method: 'POST',
      url: `/api/v1/passes/${pass.id}/overrides`,
      headers: authHeaders(teacher, randomUUID(), etag),
      payload: { category: 'staff_directed' },
    });
    expect(requested.statusCode).toBe(200);
    const body = requested.json<{ pass: PassBody }>().pass;
    // Direct staff resolution clears to allow and allocates immediately.
    expect(body.lifecycleState).toBe('ready');
    expect(body.policy?.decision).toBe('allow');
    expect(body.movement.readyUntil).not.toBeNull();
    const row = (
      await pool.query<{ decision: string; category: string }>(
        `SELECT decision, category FROM pass_override WHERE pass_id = $1`,
        [pass.id],
      )
    ).rows;
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ decision: 'approved', category: 'staff_directed' });
  });

  it('enforces the school-tier escalation and separation of duties', async () => {
    if (teacher === null || counselor === null) throw new Error('fixture missing');
    const { pass, etag } = await blackoutScenario('Escalate', 'approval_required');
    // Teacher may request but cannot resolve school-tier overrides.
    const requested = await app.inject({
      method: 'POST',
      url: `/api/v1/passes/${pass.id}/overrides`,
      headers: authHeaders(teacher, randomUUID(), etag),
      payload: { category: 'safety' },
    });
    expect(requested.statusCode).toBe(200);
    expect(requested.json<{ pass: PassBody }>().pass.policy?.decision).toBe('override_required');
    const pending = await pendingOverridesFor(teacher);
    expect(pending.find((entry) => entry.passId === pass.id)).toBeUndefined();
    const teacherPending = await pendingOverridesFor(counselor);
    const target = mustFind(teacherPending, pass.id);
    // Requester cannot approve their own approval_required override.
    const selfApprove = await app.inject({
      method: 'POST',
      url: `/api/v1/pass-overrides/${target.overrideId}/approve`,
      headers: authHeaders(teacher, randomUUID(), requiredEtag(requested)),
    });
    // Teacher lacks school-tier authority: concealed before SoD even applies.
    expect(selfApprove.statusCode).toBe(404);
    // Counselor resolves at the school tier.
    const approved = await app.inject({
      method: 'POST',
      url: `/api/v1/pass-overrides/${target.overrideId}/approve`,
      headers: authHeaders(counselor, randomUUID(), requiredEtag(requested)),
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json<{ pass: PassBody }>().pass.policy?.decision).toBe('allow');

    // Separation of duties: a school-tier requester cannot approve their own
    // approval_required override.
    const second = await makePassStudent('SoDStudent');
    const secondCreated = await requestPass(second);
    const secondPass = secondCreated.json<{ pass: PassBody }>().pass;
    const secondRequested = await app.inject({
      method: 'POST',
      url: `/api/v1/passes/${secondPass.id}/overrides`,
      headers: authHeaders(counselor, randomUUID(), requiredEtag(secondCreated)),
      payload: { category: 'safety' },
    });
    expect(secondRequested.statusCode).toBe(200);
    const secondPending = await pendingOverridesFor(counselor);
    const secondTarget = mustFind(secondPending, secondPass.id);
    const selfApproved = await app.inject({
      method: 'POST',
      url: `/api/v1/pass-overrides/${secondTarget.overrideId}/approve`,
      headers: authHeaders(counselor, randomUUID(), requiredEtag(secondRequested)),
    });
    expect(selfApproved.statusCode).toBe(409);
    expect(selfApproved.json<{ code: string }>().code).toBe(
      'override_requires_independent_approver',
    );
  });

  it('rejects recovery sessions on workflow endpoints', async () => {
    if (counselor === null) throw new Error('fixture missing');
    const recovery = await mintSession(tenantA, counselor.accountId, 'recovery');
    const { pass, etag } = await blackoutScenario('RecoveryFlow', 'authorized');
    const requested = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${pass.id}/overrides`,
      headers: authHeaders(recovery, randomUUID(), etag),
      payload: { category: 'urgent' },
    });
    expect(requested.statusCode).toBe(403);
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/me/pass-overrides/pending',
      headers: { cookie: `openhall_session_dev=${recovery.cookie}` },
    });
    expect(listed.statusCode).toBe(403);
    const approvals = await app.inject({
      method: 'GET',
      url: '/api/v1/me/pass-approvals/pending',
      headers: { cookie: `openhall_session_dev=${recovery.cookie}` },
    });
    expect(approvals.statusCode).toBe(403);
  });

  it('denies the pass when an override is denied', async () => {
    if (teacher === null) throw new Error('teacher fixture missing');
    const { student, pass, etag } = await blackoutScenario('OverrideDeny', 'authorized');
    const requested = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${pass.id}/overrides`,
      headers: authHeaders(student, randomUUID(), etag),
      payload: { category: 'private' },
    });
    expect(requested.statusCode).toBe(200);
    const pending = await pendingOverridesFor(teacher);
    const target = mustFind(pending, pass.id);
    const denied = await app.inject({
      method: 'POST',
      url: `/api/v1/pass-overrides/${target.overrideId}/deny`,
      headers: authHeaders(teacher, randomUUID(), requiredEtag(requested)),
    });
    expect(denied.statusCode).toBe(200);
    const body = denied.json<{ pass: PassBody }>().pass;
    expect(body.lifecycleState).toBe('denied');
    expect(body.policy?.decision).toBe('deny');
    expect((await passEvents(pass.id)).map((entry) => entry.event_type)).toEqual([
      'pass.requested',
      'pass.override_requested',
      'pass.override_denied',
      'pass.denied',
    ]);
  });

  it('fails closed with 409 when rules change after the last evaluation', async () => {
    if (counselor === null) throw new Error('fixture missing');
    await clearRules();
    await seedRule({
      name: 'teacher approval',
      ruleType: 'approval_requirement',
      scopeKind: 'organization',
      scopeId: schoolA,
      configuration: APPROVAL_CONFIG,
      overrideMode: 'authorized',
    });
    const student = await makePassStudent('RuleChange');
    const created = await requestPass(student);
    expect(created.statusCode).toBe(201);
    const pass = created.json<{ pass: PassBody }>().pass;
    expect(pass.policy?.decision).toBe('approval_required');
    const evaluationsBefore = await tableCount('policy_evaluation');
    // A second rule becomes applicable after the request-time evaluation was
    // persisted at revision 1. The one-evaluation-per-revision invariant
    // forbids a second evaluation row, so the request must fail closed with
    // a domain conflict instead of an internal error.
    await seedRule({
      name: 'late blackout',
      ruleType: 'schedule_boundary',
      scopeKind: 'organization',
      scopeId: schoolA,
      configuration: BLACKOUT_OVERLAP,
      overrideMode: 'authorized',
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/passes/${pass.id}/overrides`,
      headers: authHeaders(counselor, randomUUID(), requiredEtag(created)),
      payload: { category: 'safety' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('override_not_available');
    expect(await tableCount('policy_evaluation')).toBe(evaluationsBefore);
  });

  it('advances updated_at when a pass is cancelled', async () => {
    await clearRules();
    const student = await makePassStudent('CancelStamp');
    const created = await requestPass(student);
    expect(created.statusCode).toBe(201);
    const pass = created.json<{ pass: PassBody }>().pass;
    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${pass.id}/cancel`,
      headers: authHeaders(student, randomUUID(), requiredEtag(created)),
    });
    expect(cancelled.statusCode).toBe(200);
    const rows = (
      await pool.query<{ updated_at: Date; requested_at: Date }>(
        `SELECT updated_at, requested_at FROM pass WHERE id = $1`,
        [pass.id],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) throw new Error('Expected pass row');
    expect(row.updated_at.getTime()).toBeGreaterThan(row.requested_at.getTime());
  });

  it('cleans pending workflows when a pass is cancelled', async () => {
    await clearRules();
    await seedRule({
      name: 'teacher approval',
      ruleType: 'approval_requirement',
      scopeKind: 'organization',
      scopeId: schoolA,
      configuration: APPROVAL_CONFIG,
      overrideMode: 'never',
    });
    const student = await makePassStudent('CancelFlow');
    const created = await requestPass(student);
    const pass = created.json<{ pass: PassBody }>().pass;
    expect(
      await tableCount('pass_approval', `WHERE pass_id = '${pass.id}' AND decision = 'pending'`),
    ).toBe(1);
    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${pass.id}/cancel`,
      headers: authHeaders(student, randomUUID(), requiredEtag(created)),
    });
    expect(cancelled.statusCode).toBe(200);
    expect(
      await tableCount('pass_approval', `WHERE pass_id = '${pass.id}' AND decision = 'pending'`),
    ).toBe(0);
  });
});

describe('Phase 8 policy rule administration', () => {
  let schoolAdmin: SessionFixture | null = null;

  async function ensureSchoolAdmin(): Promise<SessionFixture> {
    if (schoolAdmin !== null) return schoolAdmin;
    const admin = await makeStaff(tenantA, schoolA, 'PolicyAdmin');
    await pool.query(
      `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind, organization_id) VALUES ($1, $2, 'school_admin', 'organization', $3)`,
      [tenantA, admin.accountId, schoolA],
    );
    schoolAdmin = admin;
    return admin;
  }

  interface RuleBody {
    id: string;
    revision: number;
    enabled: boolean;
  }

  async function createRule(
    admin: SessionFixture,
    body: Record<string, unknown>,
  ): Promise<{
    status: number;
    code: string | undefined;
    rule: RuleBody | undefined;
    etag: string | undefined;
  }> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${schoolA}/policy-rules`,
      headers: authHeaders(admin, randomUUID()),
      payload: body,
    });
    const parsed = response.json<{ rule?: RuleBody; code?: string }>();
    const etag = response.headers.etag;
    return {
      status: response.statusCode,
      code: parsed.code,
      rule: parsed.rule,
      etag: typeof etag === 'string' ? etag : undefined,
    };
  }

  function boundaryBody(configuration: Record<string, unknown>): Record<string, unknown> {
    return {
      name: 'Admin boundary',
      ruleType: 'schedule_boundary',
      scope: {
        kind: 'organization',
        organizationId: schoolA,
        sectionId: null,
        destinationId: null,
        destinationCategoryId: null,
      },
      priority: 0,
      configuration,
      overrideMode: 'never',
      validFrom: null,
      validUntil: null,
    };
  }

  const VALID_BOUNDARY = {
    schemaVersion: 1,
    firstMinutes: 60,
    lastMinutes: 60,
    blockKinds: ['instructional'],
    requestSources: ['student_web'],
  };

  const VALID_APPROVAL = {
    schemaVersion: 1,
    requestSources: ['student_web'],
    approver: 'current_section_teacher',
  };

  it('rejects invalid configurations with 409 policy_rule_invalid', async () => {
    await clearRules();
    const admin = await ensureSchoolAdmin();
    const cases: { label: string; body: Record<string, unknown> }[] = [
      { label: 'negative minutes', body: boundaryBody({ ...VALID_BOUNDARY, firstMinutes: -1 }) },
      { label: 'fractional minutes', body: boundaryBody({ ...VALID_BOUNDARY, firstMinutes: 1.5 }) },
      {
        label: 'minutes above day bound',
        body: boundaryBody({ ...VALID_BOUNDARY, firstMinutes: 1441 }),
      },
      {
        label: 'empty window',
        body: boundaryBody({ ...VALID_BOUNDARY, firstMinutes: 0, lastMinutes: 0 }),
      },
      {
        label: 'unknown block kind',
        body: boundaryBody({ ...VALID_BOUNDARY, blockKinds: ['bogus'] }),
      },
      {
        label: 'empty block kinds',
        body: boundaryBody({ ...VALID_BOUNDARY, blockKinds: [] }),
      },
      {
        label: 'unknown request source',
        body: boundaryBody({ ...VALID_BOUNDARY, requestSources: ['sms'] }),
      },
      {
        label: 'empty request sources',
        body: boundaryBody({ ...VALID_BOUNDARY, requestSources: [] }),
      },
      {
        label: 'unknown property',
        body: boundaryBody({ ...VALID_BOUNDARY, extra: 'nope' }),
      },
      {
        label: 'unsupported schema version',
        body: boundaryBody({ ...VALID_BOUNDARY, schemaVersion: 2 }),
      },
      {
        label: 'unknown approver',
        body: {
          name: 'Admin approval',
          ruleType: 'approval_requirement',
          scope: {
            kind: 'section',
            organizationId: null,
            sectionId: sectionA1,
            destinationId: null,
            destinationCategoryId: null,
          },
          priority: 0,
          configuration: { ...VALID_APPROVAL, approver: 'principal' },
          overrideMode: 'approval_required',
          validFrom: null,
          validUntil: null,
        },
      },
      {
        label: 'missing approver',
        body: {
          name: 'Admin approval',
          ruleType: 'approval_requirement',
          scope: {
            kind: 'section',
            organizationId: null,
            sectionId: sectionA1,
            destinationId: null,
            destinationCategoryId: null,
          },
          priority: 0,
          configuration: { schemaVersion: 1, requestSources: ['student_web'] },
          overrideMode: 'approval_required',
          validFrom: null,
          validUntil: null,
        },
      },
    ];
    for (const entry of cases) {
      const result = await createRule(admin, entry.body);
      expect(result.status, `${entry.label}: status`).toBe(409);
      expect(result.code, `${entry.label}: code`).toBe('policy_rule_invalid');
    }
    expect(await tableCount('policy_rule')).toBe(0);
  });

  it('accepts both closed rule shapes starting disabled at revision 1', async () => {
    await clearRules();
    const admin = await ensureSchoolAdmin();
    const boundary = await createRule(admin, boundaryBody(VALID_BOUNDARY));
    expect(boundary.status).toBe(201);
    expect(boundary.rule?.revision).toBe(1);
    expect(boundary.rule?.enabled).toBe(false);
    if (boundary.etag === undefined) throw new Error('Expected rule ETag');

    const approval = await createRule(admin, {
      name: 'Admin approval',
      ruleType: 'approval_requirement',
      scope: {
        kind: 'section',
        organizationId: null,
        sectionId: sectionA1,
        destinationId: null,
        destinationCategoryId: null,
      },
      priority: 0,
      configuration: VALID_APPROVAL,
      overrideMode: 'approval_required',
      validFrom: null,
      validUntil: null,
    });
    expect(approval.status).toBe(201);
    expect(approval.rule?.revision).toBe(1);
    expect(approval.rule?.enabled).toBe(false);

    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/policy-rules`,
      headers: authHeaders(admin),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ rules: RuleBody[] }>().rules).toHaveLength(2);
  });

  it('enforces a boundary deny only after activation and preserves snapshots', async () => {
    await clearRules();
    const admin = await ensureSchoolAdmin();
    // A full-day instructional boundary: deterministic deny whatever time the
    // suite runs in the school time zone.
    const created = await createRule(
      admin,
      boundaryBody({
        schemaVersion: 1,
        firstMinutes: 1440,
        lastMinutes: 1440,
        blockKinds: ['instructional'],
        requestSources: ['student_web'],
      }),
    );
    expect(created.status).toBe(201);
    const ruleId = created.rule?.id;
    if (ruleId === undefined || created.etag === undefined) throw new Error('Expected rule');

    // Disabled rules never affect students.
    const allowedStudent = await makePassStudent('BoundaryAllowed');
    const allowed = await requestPass(allowedStudent);
    expect(allowed.statusCode).toBe(201);
    const allowedPass = allowed.json<{ pass: PassBody }>().pass;
    expect(allowedPass.lifecycleState).toBe('ready');
    expect(allowedPass.policy?.decision).toBe('allow');

    const activated = await app.inject({
      method: 'POST',
      url: `/api/v1/policy-rules/${ruleId}/activate`,
      headers: authHeaders(admin, randomUUID(), created.etag),
    });
    expect(activated.statusCode).toBe(200);
    const activeBody = activated.json<{ rule: RuleBody }>().rule;
    expect(activeBody.enabled).toBe(true);
    expect(activeBody.revision).toBe(2);
    const activeEtag = activated.headers.etag;
    if (typeof activeEtag !== 'string') throw new Error('Expected activation ETag');

    const deniedStudent = await makePassStudent('BoundaryDenied');
    const denied = await requestPass(deniedStudent);
    expect(denied.statusCode).toBe(201);
    const deniedPass = denied.json<{ pass: PassBody }>().pass;
    expect(deniedPass.lifecycleState).toBe('denied');
    expect(deniedPass.policy?.decision).toBe('deny');

    // Updating the rule must not rewrite the evaluation history: the denied
    // pass keeps pointing at revision 2 with its immutable snapshot.
    const updated = await app.inject({
      method: 'PUT',
      url: `/api/v1/policy-rules/${ruleId}`,
      headers: authHeaders(admin, randomUUID(), activeEtag),
      payload: boundaryBody({
        schemaVersion: 1,
        firstMinutes: 1440,
        lastMinutes: 1440,
        blockKinds: ['instructional'],
        requestSources: ['student_web'],
      }),
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<{ rule: RuleBody }>().rule.revision).toBe(3);

    const snapshots = (
      await pool.query<{ revision: number; snapshot: Record<string, unknown>; reason: string }>(
        `SELECT r.policy_rule_revision AS revision, r.rule_snapshot AS snapshot, r.reason_code AS reason
         FROM policy_evaluation_result r
         JOIN policy_evaluation e ON e.id = r.evaluation_id
         WHERE e.pass_id = $1`,
        [deniedPass.id],
      )
    ).rows;
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.revision).toBe(2);
    expect(snapshots[0]?.reason).toBe('schedule_boundary_blackout');
    const snapshot = snapshots[0]?.snapshot as { revision?: number; ruleType?: string };
    expect(snapshot.revision).toBe(2);
    expect(snapshot.ruleType).toBe('schedule_boundary');

    const allowedSnapshots = await tableCount(
      'policy_evaluation_result r JOIN policy_evaluation e ON e.id = r.evaluation_id',
      `WHERE e.pass_id = '${allowedPass.id}'`,
    );
    expect(allowedSnapshots).toBe(0);
  });
});

describe('destination responsible-staff approval', () => {
  const DESTINATION_APPROVAL_CONFIG = {
    schemaVersion: 1,
    requestSources: ['student_web'],
    approver: 'destination_responsible_staff',
  };

  async function categoryIdByName(name: string): Promise<string> {
    const id = (
      await pool.query<{ id: string }>(
        `SELECT id FROM destination_category WHERE tenant_id = $1 AND organization_id = $2 AND name = $3`,
        [tenantA, schoolA, name],
      )
    ).rows[0]?.id;
    if (id === undefined) throw new Error('Expected destination category fixture');
    return id;
  }

  async function destinationScenario(given: string) {
    await clearRules();
    const categoryId = await categoryIdByName('Restrooms');
    await seedRule({
      name: 'room visits need destination approval',
      ruleType: 'approval_requirement',
      scopeKind: 'destination_category',
      scopeId: categoryId,
      configuration: DESTINATION_APPROVAL_CONFIG,
      overrideMode: 'never',
    });
    const student = await makePassStudent(given);
    const created = await requestPass(student);
    expect(created.statusCode).toBe(201);
    const pass = created.json<{ pass: PassBody }>().pass;
    expect(pass.policy?.decision).toBe('approval_required');
    return { student, pass, etag: requiredEtag(created) };
  }

  async function pendingApprovals(session: SessionFixture) {
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/me/pass-approvals/pending',
      headers: { cookie: `openhall_session_dev=${session.cookie}` },
    });
    expect(listed.statusCode).toBe(200);
    return listed.json<{
      approvals: { approvalId: string; passId: string; passEtag: string }[];
    }>().approvals;
  }

  it('binds the pending approval to the destination with its approver kind', async () => {
    const { pass } = await destinationScenario('DestBound');
    const rows = (
      await pool.query<{
        approver_kind: string;
        required_section_id: string | null;
        required_destination_id: string | null;
        decision: string;
      }>(
        `SELECT approver_kind, required_section_id, required_destination_id, decision FROM pass_approval WHERE pass_id = $1`,
        [pass.id],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      approver_kind: 'destination_responsible_staff',
      required_section_id: null,
      required_destination_id: destinationA,
      decision: 'pending',
    });
  });

  it('resolves through classroom teachers derived from the schedule', async () => {
    if (teacher === null) throw new Error('teacher fixture missing');
    const { pass, etag } = await destinationScenario('DestTeacher');
    // The section-A1 teacher meets at Room 214 through the schedule: the
    // pending destination approval is visible without any explicit grant.
    const approvals = await pendingApprovals(teacher);
    const target = mustFind(approvals, pass.id);
    const resolved = await app.inject({
      method: 'POST',
      url: `/api/v1/pass-approvals/${target.approvalId}/approve`,
      headers: authHeaders(teacher, randomUUID(), etag),
    });
    expect(resolved.statusCode).toBe(200);
    const body = resolved.json<{ pass: PassBody }>().pass;
    expect(body.lifecycleState).toBe('ready');
    expect(body.policy?.decision).toBe('allow');
  });

  it('resolves through explicit destination staff', async () => {
    if (teacher === null) throw new Error('teacher fixture missing');
    const { pass } = await destinationScenario('DestStaff');
    const staff = await makeStaff(tenantA, schoolA, 'Nurse');
    await pool.query(
      `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind, destination_id) VALUES ($1, $2, 'destination_staff', 'destination', $3)`,
      [tenantA, staff.accountId, destinationA],
    );
    const approvals = await pendingApprovals(staff);
    const target = mustFind(approvals, pass.id);
    const denied = await app.inject({
      method: 'POST',
      url: `/api/v1/pass-approvals/${target.approvalId}/deny`,
      headers: authHeaders(staff, randomUUID(), target.passEtag),
    });
    expect(denied.statusCode).toBe(200);
    expect(denied.json<{ pass: PassBody }>().pass.lifecycleState).toBe('denied');
  });

  it('conceals destination approvals from uninvolved staff', async () => {
    if (counselor === null) throw new Error('counselor fixture missing');
    const { pass } = await destinationScenario('DestHidden');
    expect(await pendingApprovals(counselor)).toHaveLength(0);
    const probe = await app.inject({
      method: 'POST',
      url: `/api/v1/pass-approvals/${randomUUID()}/approve`,
      headers: authHeaders(
        counselor,
        randomUUID(),
        '"pass:00000000-0000-0000-0000-000000000000:1"',
      ),
    });
    expect(probe.statusCode).toBe(404);
    // The pending row survives the concealed probe untouched.
    expect(
      await tableCount('pass_approval', `WHERE pass_id = '${pass.id}' AND decision = 'pending'`),
    ).toBe(1);
  });

  it('administers category scope and approver through the policy API', async () => {
    const admin = await makeStaff(tenantA, schoolA, 'CategoryAdmin');
    await pool.query(
      `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind, organization_id) VALUES ($1, $2, 'school_admin', 'organization', $3)`,
      [tenantA, admin.accountId, schoolA],
    );
    const categoryId = await categoryIdByName('Restrooms');
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${schoolA}/policy-rules`,
      headers: authHeaders(admin, randomUUID()),
      payload: {
        name: 'Room visits need destination approval',
        ruleType: 'approval_requirement',
        scope: {
          kind: 'destination_category',
          organizationId: null,
          sectionId: null,
          destinationId: null,
          destinationCategoryId: categoryId,
        },
        priority: 100,
        configuration: DESTINATION_APPROVAL_CONFIG,
        overrideMode: 'never',
        validFrom: null,
        validUntil: null,
      },
    });
    expect(created.statusCode).toBe(201);
    const rule = created.json<{ rule: { id: string; scope: Record<string, unknown> } }>().rule;
    expect(rule.scope).toMatchObject({
      kind: 'destination_category',
      destinationCategoryId: categoryId,
    });

    // A category from another school is rejected, not silently scoped.
    const foreign = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${schoolA}/policy-rules`,
      headers: authHeaders(admin, randomUUID()),
      payload: {
        name: 'Foreign category rule',
        ruleType: 'approval_requirement',
        scope: {
          kind: 'destination_category',
          organizationId: null,
          sectionId: null,
          destinationId: null,
          destinationCategoryId: randomUUID(),
        },
        priority: 100,
        configuration: DESTINATION_APPROVAL_CONFIG,
        overrideMode: 'never',
        validFrom: null,
        validUntil: null,
      },
    });
    expect(foreign.statusCode).toBe(409);
    expect(foreign.json<{ code: string }>().code).toBe('policy_rule_invalid');
  });
});
