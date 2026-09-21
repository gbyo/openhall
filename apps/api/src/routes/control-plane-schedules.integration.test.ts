import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import type { AppConfig } from '@openhall/config';
import { ExpectedPlacementResolver } from '@openhall/application';
import { createDatabase, migrateToLatest, PostgresExpectedPlacementRepository } from '@openhall/db';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { DB as Database } from '@openhall/db';
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
let database: Kysely<Database>;

let tenantA: string;
let schoolA: string;
let tenantB: string;
let schoolB: string;
let adminA: SessionFixture | null = null;
let adminB: SessionFixture | null = null;

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

async function mintSession(tenantId: string, accountId: string): Promise<SessionFixture> {
  const raw = randomBytes(32);
  const tokenDigest = domainHmac('session-digest:v1', raw);
  const csrfRaw = domainHmac('csrf-token:v1', raw);
  const csrfDigest = createHmac('sha256', APP_SECRET).update(Buffer.from(csrfRaw)).digest();
  const personId = (
    await pool.query<{ id: string }>(`SELECT person_id AS id FROM account WHERE id = $1`, [
      accountId,
    ])
  ).rows[0]?.id;
  if (personId === undefined) throw new Error('Account missing');
  await pool.query(
    `INSERT INTO auth_session
      (tenant_id, account_id, token_hash, csrf_token_hash, account_session_revision,
       authentication_method, idle_expires_at, absolute_expires_at)
     VALUES ($1, $2, $3, $4, 0, 'oidc', now() + interval '12 hours', now() + interval '7 days')`,
    [tenantId, accountId, Buffer.from(tokenDigest), csrfDigest],
  );
  return {
    personId,
    accountId,
    cookie: Buffer.from(raw).toString('base64url'),
    csrf: Buffer.from(csrfRaw).toString('base64url'),
  };
}

interface SessionFixture {
  personId: string;
  accountId: string;
  cookie: string;
  csrf: string;
}

async function insertReturningId(text: string, params: unknown[] = []): Promise<string> {
  const id = (await pool.query<{ id: string }>(text, params)).rows[0]?.id;
  if (id === undefined) throw new Error('Fixture insert failed');
  return id;
}

function requireAdmin(): SessionFixture {
  if (adminA === null) throw new Error('admin fixture missing');
  return adminA;
}

function requireOtherAdmin(): SessionFixture {
  if (adminB === null) throw new Error('other admin fixture missing');
  return adminB;
}

function authHeaders(
  session: SessionFixture,
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

interface BlockBody {
  id: string;
  code: string;
  displayName: string;
  kind: string;
  status: string;
}

interface SlotBody {
  id: string;
  blockId: string;
  startsAt: string;
  endsAt: string;
  ordinal: number;
}

interface TemplateBody {
  id: string;
  name: string;
  status: string;
  slots: SlotBody[];
}

async function readBlocks(
  admin: SessionFixture,
  schoolId: string,
): Promise<{ revision: string; etag: string; blocks: BlockBody[] }> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/organizations/${schoolId}/schedule/blocks`,
    headers: authHeaders(admin),
  });
  expect(response.statusCode).toBe(200);
  const body = response.json<{ blocks: BlockBody[]; revision: string }>();
  return { revision: body.revision, etag: requiredEtag(response), blocks: body.blocks };
}

async function createBlock(
  admin: SessionFixture,
  schoolId: string,
  body: Record<string, unknown>,
  etag: string,
  key = randomUUID(),
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/organizations/${schoolId}/schedule/blocks`,
    headers: authHeaders(admin, key, etag),
    payload: body,
  });
}

async function createTemplate(
  admin: SessionFixture,
  schoolId: string,
  body: Record<string, unknown>,
  etag: string,
  key = randomUUID(),
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/organizations/${schoolId}/schedule/templates`,
    headers: authHeaders(admin, key, etag),
    payload: body,
  });
}

async function putCalendar(
  admin: SessionFixture,
  schoolId: string,
  days: Record<string, unknown>[],
  etag: string,
  key = randomUUID(),
) {
  return app.inject({
    method: 'PUT',
    url: `/api/v1/organizations/${schoolId}/schedule/calendar`,
    headers: authHeaders(admin, key, etag),
    payload: { days },
  });
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
  database = handle.database;
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
    `INSERT INTO tenant (name, slug) VALUES ('TA', 'schta') RETURNING id`,
  );
  schoolA = await insertReturningId(
    `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'A School', 'scha-school', 'America/New_York') RETURNING id`,
    [tenantA],
  );
  tenantB = await insertReturningId(
    `INSERT INTO tenant (name, slug) VALUES ('TB', 'schtb') RETURNING id`,
  );
  schoolB = await insertReturningId(
    `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'B School', 'schb-school', 'America/New_York') RETURNING id`,
    [tenantB],
  );
  // Schools provisioned after migration 008 arrive with their schedule
  // configuration row, exactly as future school provisioning must create it
  // transactionally with the school.
  for (const [tenantId, schoolId] of [
    [tenantA, schoolA],
    [tenantB, schoolB],
  ] as const) {
    await pool.query(
      `INSERT INTO school_schedule_configuration (tenant_id, organization_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [tenantId, schoolId],
    );
  }
  for (const [tenantId, schoolId, given] of [
    [tenantA, schoolA, 'Ada'],
    [tenantB, schoolB, 'Bob'],
  ] as const) {
    const personId = await insertReturningId(
      `INSERT INTO person (tenant_id, given_name, family_name, display_name) VALUES ($1, $2, 'Test', $3) RETURNING id`,
      [tenantId, given, `${given} Test`],
    );
    const accountId = await insertReturningId(
      `INSERT INTO account (tenant_id, person_id) VALUES ($1, $2) RETURNING id`,
      [tenantId, personId],
    );
    await pool.query(
      `INSERT INTO organization_membership (tenant_id, organization_id, person_id, affiliation) VALUES ($1, $2, $3, 'staff')`,
      [tenantId, schoolId, personId],
    );
    await pool.query(
      `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind, organization_id) VALUES ($1, $2, 'school_admin', 'organization', $3)`,
      [tenantId, accountId, schoolId],
    );
    const session = await mintSession(tenantId, accountId);
    if (tenantId === tenantA) adminA = session;
    else adminB = session;
  }
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

describe('control-plane schedule aggregate', () => {
  it('reads the backfilled aggregate and creates blocks under the lock', async () => {
    const initial = await readBlocks(requireAdmin(), schoolA);
    expect(initial.revision).toBe('1');
    expect(initial.etag).toBe(`"schedule:${schoolA}:1"`);

    const created = await createBlock(
      requireAdmin(),
      schoolA,
      { code: 'P1', displayName: 'Period 1', kind: 'instructional' },
      initial.etag,
    );
    expect(created.statusCode).toBe(201);
    expect(created.json<{ block: BlockBody }>().block.status).toBe('active');
    expect(requiredEtag(created)).toBe(`"schedule:${schoolA}:2"`);

    const reread = await readBlocks(requireAdmin(), schoolA);
    expect(reread.revision).toBe('2');
    expect(reread.blocks.map((block) => block.code)).toContain('P1');
  });

  it('rejects stale aggregate ETags and replays keys before staleness', async () => {
    const initial = await readBlocks(requireAdmin(), schoolA);
    const key = randomUUID();
    const created = await createBlock(
      requireAdmin(),
      schoolA,
      { code: 'P2', displayName: 'Period 2', kind: 'instructional' },
      initial.etag,
      key,
    );
    expect(created.statusCode).toBe(201);

    const stale = await createBlock(
      requireAdmin(),
      schoolA,
      { code: 'P3', displayName: 'Period 3', kind: 'instructional' },
      initial.etag,
    );
    expect(stale.statusCode).toBe(412);
    expect(stale.json<{ code: string }>().code).toBe('stale_resource_revision');

    const replayed = await createBlock(
      requireAdmin(),
      schoolA,
      { code: 'P2', displayName: 'Period 2', kind: 'instructional' },
      initial.etag,
      key,
    );
    expect(replayed.statusCode).toBe(201);
    expect(replayed.json<{ block: BlockBody }>().block.code).toBe('P2');
  });

  it('rejects duplicate block codes and immutable used codes', async () => {
    const initial = await readBlocks(requireAdmin(), schoolA);
    const duplicate = await createBlock(
      requireAdmin(),
      schoolA,
      { code: 'P1', displayName: 'Duplicate', kind: 'lunch' },
      initial.etag,
    );
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json<{ code: string }>().code).toBe('schedule_block_exists');

    const block = await createBlock(
      requireAdmin(),
      schoolA,
      { code: 'L1', displayName: 'Lunch', kind: 'lunch' },
      initial.etag,
    );
    const blockId = block.json<{ block: BlockBody }>().block.id;
    const afterBlock = await readBlocks(requireAdmin(), schoolA);
    const template = await createTemplate(
      requireAdmin(),
      schoolA,
      {
        name: 'Midday',
        slots: [{ blockId, startsAt: '12:00', endsAt: '12:30' }],
      },
      afterBlock.etag,
    );
    expect(template.statusCode).toBe(201);
    const afterTemplate = await readBlocks(requireAdmin(), schoolA);

    const rename = await app.inject({
      method: 'PUT',
      url: `/api/v1/organizations/${schoolA}/schedule/blocks/${blockId}`,
      headers: authHeaders(requireAdmin(), randomUUID(), afterTemplate.etag),
      payload: { code: 'L2', displayName: 'Lunch', kind: 'lunch' },
    });
    expect(rename.statusCode).toBe(409);
    expect(rename.json<{ code: string }>().code).toBe('invalid_schedule_state');

    const relabel = await app.inject({
      method: 'PUT',
      url: `/api/v1/organizations/${schoolA}/schedule/blocks/${blockId}`,
      headers: authHeaders(requireAdmin(), randomUUID(), afterTemplate.etag),
      payload: { code: 'L1', displayName: 'Midday Meal', kind: 'lunch' },
    });
    expect(relabel.statusCode).toBe(200);
  });

  it('validates template slots atomically and derives ordinals', async () => {
    const initial = await readBlocks(requireAdmin(), schoolA);
    const blockResponse = await createBlock(
      requireAdmin(),
      schoolA,
      { code: 'T1', displayName: 'Template Block', kind: 'instructional' },
      initial.etag,
    );
    const blockId = blockResponse.json<{ block: BlockBody }>().block.id;
    const afterBlock = await readBlocks(requireAdmin(), schoolA);

    const overlapping = await createTemplate(
      requireAdmin(),
      schoolA,
      {
        name: 'Regular',
        slots: [
          { blockId, startsAt: '08:00', endsAt: '09:00' },
          { blockId, startsAt: '08:30', endsAt: '09:30' },
        ],
      },
      afterBlock.etag,
    );
    expect(overlapping.statusCode).toBe(409);
    expect(overlapping.json<{ code: string }>().code).toBe('schedule_slots_overlap');

    const backwards = await createTemplate(
      requireAdmin(),
      schoolA,
      { name: 'Regular', slots: [{ blockId, startsAt: '09:00', endsAt: '08:00' }] },
      afterBlock.etag,
    );
    expect(backwards.statusCode).toBe(409);

    const created = await createTemplate(
      requireAdmin(),
      schoolA,
      {
        name: 'Regular',
        slots: [
          { blockId, startsAt: '09:00', endsAt: '10:00' },
          { blockId, startsAt: '08:00', endsAt: '09:00' },
        ],
      },
      afterBlock.etag,
    );
    expect(created.statusCode).toBe(201);
    const template = created.json<{ template: TemplateBody }>().template;
    expect(template.slots.map((slot) => slot.ordinal)).toEqual([1, 2]);
    expect(template.slots.map((slot) => slot.startsAt)).toEqual(['08:00:00', '09:00:00']);

    const replaced = await app.inject({
      method: 'PUT',
      url: `/api/v1/organizations/${schoolA}/schedule/templates/${template.id}`,
      headers: authHeaders(requireAdmin(), randomUUID(), requiredEtag(created)),
      payload: {
        name: 'Regular Updated',
        slots: [{ blockId, startsAt: '08:00', endsAt: '08:45' }],
      },
    });
    expect(replaced.statusCode).toBe(200);
    const updated = replaced.json<{ template: TemplateBody }>().template;
    expect(updated.slots).toHaveLength(1);
    expect(updated.slots[0]?.ordinal).toBe(1);
  });

  it('guards archives against template references and current assignments', async () => {
    const initial = await readBlocks(requireAdmin(), schoolA);
    const blockResponse = await createBlock(
      requireAdmin(),
      schoolA,
      { code: 'H1', displayName: 'History', kind: 'instructional' },
      initial.etag,
    );
    const blockId = blockResponse.json<{ block: BlockBody }>().block.id;
    const afterBlock = await readBlocks(requireAdmin(), schoolA);

    const templateResponse = await createTemplate(
      requireAdmin(),
      schoolA,
      { name: 'Dated', slots: [{ blockId, startsAt: '10:00', endsAt: '11:00' }] },
      afterBlock.etag,
    );
    expect(templateResponse.statusCode).toBe(201);
    const templateId = templateResponse.json<{ template: TemplateBody }>().template.id;
    const afterTemplate = await readBlocks(requireAdmin(), schoolA);

    const blockedBySlot = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${schoolA}/schedule/blocks/${blockId}/archive`,
      headers: authHeaders(requireAdmin(), randomUUID(), afterTemplate.etag),
    });
    expect(blockedBySlot.statusCode).toBe(409);
    expect(blockedBySlot.json<{ code: string }>().code).toBe('schedule_block_in_use');

    const assigned = await putCalendar(
      requireAdmin(),
      schoolA,
      [
        {
          date: '2030-04-07',
          dayKind: 'instructional',
          templateId,
          cycleCode: 'A',
          operationalNote: null,
        },
      ],
      afterTemplate.etag,
    );
    expect(assigned.statusCode).toBe(200);
    const afterAssign = await readBlocks(requireAdmin(), schoolA);

    const blockedByAssignment = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${schoolA}/schedule/templates/${templateId}/archive`,
      headers: authHeaders(requireAdmin(), randomUUID(), afterAssign.etag),
    });
    expect(blockedByAssignment.statusCode).toBe(409);
    expect(blockedByAssignment.json<{ code: string }>().code).toBe('schedule_template_in_use');

    const pastAssigned = await putCalendar(
      requireAdmin(),
      schoolA,
      [
        {
          date: '2020-04-07',
          dayKind: 'instructional',
          templateId,
          cycleCode: 'A',
          operationalNote: null,
        },
      ],
      afterAssign.etag,
    );
    expect(pastAssigned.statusCode).toBe(200);
  });

  it('applies calendar bulk assignment atomically with one revision', async () => {
    const initial = await readBlocks(requireAdmin(), schoolA);
    const blockResponse = await createBlock(
      requireAdmin(),
      schoolA,
      { code: 'C1', displayName: 'Class', kind: 'instructional' },
      initial.etag,
    );
    const blockId = blockResponse.json<{ block: BlockBody }>().block.id;
    const afterBlock = await readBlocks(requireAdmin(), schoolA);
    const templateResponse = await createTemplate(
      requireAdmin(),
      schoolA,
      { name: 'Calendar Template', slots: [{ blockId, startsAt: '08:00', endsAt: '09:00' }] },
      afterBlock.etag,
    );
    const templateId = templateResponse.json<{ template: TemplateBody }>().template.id;
    const before = await readBlocks(requireAdmin(), schoolA);

    const invalidBatch = await putCalendar(
      requireAdmin(),
      schoolA,
      [
        {
          date: '2030-05-01',
          dayKind: 'instructional',
          templateId,
          cycleCode: null,
          operationalNote: null,
        },
        {
          date: '2030-05-02',
          dayKind: 'instructional',
          templateId: null,
          cycleCode: null,
          operationalNote: null,
        },
      ],
      before.etag,
    );
    expect(invalidBatch.statusCode).toBe(400);
    const rolledBack = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/schedule/calendar?from=2030-05-01&through=2030-05-02`,
      headers: authHeaders(requireAdmin()),
    });
    expect(rolledBack.statusCode).toBe(200);
    expect(rolledBack.json<{ days: unknown[] }>().days).toEqual([]);
    const sameRevision = await readBlocks(requireAdmin(), schoolA);
    expect(sameRevision.revision).toBe(before.revision);

    const validBatch = await putCalendar(
      requireAdmin(),
      schoolA,
      [
        {
          date: '2030-05-01',
          dayKind: 'instructional',
          templateId,
          cycleCode: 'A',
          operationalNote: null,
        },
        {
          date: '2030-05-02',
          dayKind: 'closed',
          templateId: null,
          cycleCode: null,
          operationalNote: 'Snow',
        },
      ],
      before.etag,
    );
    expect(validBatch.statusCode).toBe(200);
    expect(requiredEtag(validBatch)).toBe(
      `"schedule:${schoolA}:${String(Number(before.revision) + 1)}"`,
    );
    const ranged = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/schedule/calendar?from=2030-05-01&through=2030-05-02`,
      headers: authHeaders(requireAdmin()),
    });
    expect(ranged.statusCode).toBe(200);
    expect(ranged.json<{ days: { date: string }[] }>().days.map((day) => day.date)).toEqual([
      '2030-05-01',
      '2030-05-02',
    ]);

    const duplicateDates = await putCalendar(
      requireAdmin(),
      schoolA,
      [
        {
          date: '2030-06-01',
          dayKind: 'closed',
          templateId: null,
          cycleCode: null,
          operationalNote: null,
        },
        {
          date: '2030-06-01',
          dayKind: 'closed',
          templateId: null,
          cycleCode: null,
          operationalNote: null,
        },
      ],
      requiredEtag(validBatch),
    );
    expect(duplicateDates.statusCode).toBe(400);

    const unbounded = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/schedule/calendar?from=2030-01-01&through=2032-01-01`,
      headers: authHeaders(requireAdmin()),
    });
    expect(unbounded.statusCode).toBe(400);
  });

  it('drives real placement from admin-created configuration', async () => {
    const initial = await readBlocks(requireAdmin(), schoolA);
    const blockResponse = await createBlock(
      requireAdmin(),
      schoolA,
      { code: 'R1', displayName: 'Resolver Block', kind: 'instructional' },
      initial.etag,
    );
    const blockId = blockResponse.json<{ block: BlockBody }>().block.id;
    const afterBlock = await readBlocks(requireAdmin(), schoolA);
    const templateResponse = await createTemplate(
      requireAdmin(),
      schoolA,
      { name: 'Resolver Template', slots: [{ blockId, startsAt: '08:00', endsAt: '10:00' }] },
      afterBlock.etag,
    );
    const templateId = templateResponse.json<{ template: TemplateBody }>().template.id;
    const afterTemplate = await readBlocks(requireAdmin(), schoolA);
    const assigned = await putCalendar(
      requireAdmin(),
      schoolA,
      [
        {
          date: '2030-04-07',
          dayKind: 'instructional',
          templateId,
          cycleCode: null,
          operationalNote: null,
        },
      ],
      afterTemplate.etag,
    );
    expect(assigned.statusCode).toBe(200);

    const studentId = await insertReturningId(
      `INSERT INTO person (tenant_id, given_name, family_name, display_name) VALUES ($1, 'Res', 'Olver', 'Res Olver') RETURNING id`,
      [tenantA],
    );
    await pool.query(
      `INSERT INTO organization_membership (tenant_id, organization_id, person_id, affiliation) VALUES ($1, $2, $3, 'student')`,
      [tenantA, schoolA, studentId],
    );
    const sessionId = await insertReturningId(
      `INSERT INTO academic_session (tenant_id, organization_id, kind, name, starts_on, ends_on) VALUES ($1, $2, 'school_year', 'SY', '2030-08-01', '2031-06-01') RETURNING id`,
      [tenantA, schoolA],
    );
    const sectionId = await insertReturningId(
      `INSERT INTO section (tenant_id, organization_id, academic_session_id, code, title) VALUES ($1, $2, $3, 'RES-1', 'Resolver') RETURNING id`,
      [tenantA, schoolA, sessionId],
    );
    await pool.query(
      `INSERT INTO section_membership (tenant_id, section_id, person_id, role) VALUES ($1, $2, $3, 'student')`,
      [tenantA, sectionId, studentId],
    );
    await pool.query(
      `INSERT INTO section_meeting (tenant_id, organization_id, section_id, schedule_block_id) VALUES ($1, $2, $3, $4)`,
      [tenantA, schoolA, sectionId, blockId],
    );

    const resolver = new ExpectedPlacementResolver(
      new PostgresExpectedPlacementRepository(database),
    );
    const inside = await resolver.resolve({
      tenantId: tenantA,
      organizationId: schoolA,
      personId: studentId,
      at: Temporal.Instant.from('2030-04-07T13:00:00Z'),
    });
    expect(inside.kind).toBe('resolved');

    const outside = await resolver.resolve({
      tenantId: tenantA,
      organizationId: schoolA,
      personId: studentId,
      at: Temporal.Instant.from('2030-04-07T16:00:00Z'),
    });
    expect(outside.kind).toBe('outside_schedule');
  });

  it('conceals cross-tenant schedules', async () => {
    const concealed = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolB}/schedule/blocks`,
      headers: authHeaders(requireAdmin()),
    });
    expect(concealed.statusCode).toBe(404);
    expect(concealed.json<{ code: string }>().code).toBe('schedule_not_found');

    const other = await readBlocks(requireOtherAdmin(), schoolB);
    expect(other.revision).toBe('1');
  });
});
