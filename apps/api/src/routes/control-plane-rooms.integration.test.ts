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

async function makePerson(
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

function requireAdmin(): SessionFixture {
  if (adminA === null) throw new Error('admin fixture missing');
  return adminA;
}

function requireStudent(): SessionFixture {
  if (studentA === null) throw new Error('student fixture missing');
  return studentA;
}

function requireOtherAdmin(): SessionFixture {
  if (adminB === null) throw new Error('other admin fixture missing');
  return adminB;
}

function requiredEtag(response: { headers: Record<string, unknown> }): string {
  const etag = response.headers.etag;
  if (typeof etag !== 'string') throw new Error('Expected ETag response header');
  return etag;
}
interface RoomBody {
  id: string;
  organizationId: string;
  categoryId: string | null;
  name: string;
  code: string | null;
  floorLabel: string | null;
  studentSelfRequestable: boolean;
  originSelectable: boolean;
  capacity: number | null;
  queueEnabled: boolean;
  checkInMode: string;
  defaultDurationSeconds: number | null;
  maxDurationSeconds: number | null;
  readyClaimTimeoutSeconds: number;
  queueTimeoutSeconds: number;
  status: string;
  revision: string;
}

let tenantA = '';
let schoolA = '';
let tenantB = '';
let schoolB = '';
let adminA: SessionFixture | null = null;
let studentA: SessionFixture | null = null;
let adminB: SessionFixture | null = null;

const categoryBody = {
  name: 'Nurse',
  iconKey: 'generic',
  toneKey: 'neutral',
  studentSurface: 'primary',
  pickerMode: 'list',
  sortOrder: 0,
};

const roomBody = {
  name: 'Nurse Office',
  code: 'N101',
  floorLabel: '1F',
  studentSelfRequestable: true,
  originSelectable: true,
  capacity: 3,
  queueEnabled: true,
  checkInMode: 'optional',
  defaultDurationSeconds: 600,
  maxDurationSeconds: 1800,
  readyClaimTimeoutSeconds: 60,
  queueTimeoutSeconds: 600,
};

async function createRoom(
  admin: SessionFixture,
  schoolId: string = schoolA,
  body: Record<string, unknown> = {},
  key = randomUUID(),
): Promise<{
  response: Awaited<ReturnType<FastifyInstance['inject']>>;
  room: RoomBody;
  etag: string;
}> {
  const categoryResponse = await app.inject({
    method: 'POST',
    url: `/api/v1/organizations/${schoolId}/room-categories`,
    headers: authHeaders(admin, randomUUID()),
    payload: { ...categoryBody, name: `Cat ${randomUUID().slice(0, 8)}` },
  });
  const categoryId = categoryResponse.json<{ category: { id: string } }>().category.id;
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/organizations/${schoolId}/rooms`,
    headers: authHeaders(admin, key),
    payload: { ...roomBody, ...body, categoryId },
  });
  return {
    response,
    room: response.json<{ room: RoomBody }>().room,
    etag: requiredEtag(response),
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
  const adminPerson = await makePerson(tenantA, schoolA, 'staff', 'Ada');
  await grantSchoolAdmin(tenantA, adminPerson.accountId, schoolA);
  adminA = adminPerson;
  studentA = await makePerson(tenantA, schoolA, 'student', 'Stu');
  const adminBPerson = await makePerson(tenantB, schoolB, 'staff', 'Bob');
  await grantSchoolAdmin(tenantB, adminBPerson.accountId, schoolB);
  adminB = adminBPerson;
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

describe('control-plane rooms', () => {
  it('creates closed rooms and opens them explicitly', async () => {
    const created = await createRoom(requireAdmin());
    expect(created.response.statusCode).toBe(201);
    expect(created.room.status).toBe('closed');
    expect(created.room.revision).toBe('1');
    expect(created.etag).toBe(`"room:${created.room.id}:1"`);

    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/rooms`,
      headers: authHeaders(requireAdmin()),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ rooms: RoomBody[] }>().rooms.map((row) => row.id)).toContain(
      created.room.id,
    );

    const fetched = await app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${created.room.id}`,
      headers: authHeaders(requireAdmin()),
    });
    expect(fetched.statusCode).toBe(200);
    expect(requiredEtag(fetched)).toBe(created.etag);

    const opened = await app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${created.room.id}/open`,
      headers: authHeaders(requireAdmin(), randomUUID(), created.etag),
    });
    expect(opened.statusCode).toBe(200);
    const openedBody = opened.json<{ room: RoomBody }>().room;
    expect(openedBody.status).toBe('open');
    expect(openedBody.revision).toBe('2');
    const openedEtag = requiredEtag(opened);

    const reopened = await app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${created.room.id}/open`,
      headers: authHeaders(requireAdmin(), randomUUID(), openedEtag),
    });
    expect(reopened.statusCode).toBe(409);
    expect(reopened.json<{ code: string }>().code).toBe('room_already_open');

    const closed = await app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${created.room.id}/close`,
      headers: authHeaders(requireAdmin(), randomUUID(), openedEtag),
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json<{ room: RoomBody }>().room.status).toBe('closed');

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/v1/rooms/${created.room.id}`,
      headers: authHeaders(requireAdmin(), randomUUID(), requiredEtag(closed)),
      payload: { ...roomBody, categoryId: created.room.categoryId, name: 'Room 102' },
    });
    expect(updated.statusCode).toBe(200);
    const updatedBody = updated.json<{ room: RoomBody }>().room;
    expect(updatedBody.name).toBe('Room 102');
    expect(updatedBody.revision).toBe('4');
    const updateEtag = requiredEtag(updated);

    const archived = await app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${created.room.id}/archive`,
      headers: authHeaders(requireAdmin(), randomUUID(), updateEtag),
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json<{ room: RoomBody }>().room.status).toBe('archived');
  });

  it('requires If-Match, rejects malformed tags, and enforces staleness', async () => {
    const created = await createRoom(requireAdmin());
    expect(created.response.statusCode).toBe(201);

    const missing = await app.inject({
      method: 'PUT',
      url: `/api/v1/rooms/${created.room.id}`,
      headers: authHeaders(requireAdmin(), randomUUID()),
      payload: { ...roomBody, categoryId: created.room.categoryId },
    });
    expect(missing.statusCode).toBe(428);
    expect(missing.json<{ code: string }>().code).toBe('precondition_required');

    const malformed = await app.inject({
      method: 'PUT',
      url: `/api/v1/rooms/${created.room.id}`,
      headers: authHeaders(requireAdmin(), randomUUID(), 'W/"room:1:1"'),
      payload: { ...roomBody, categoryId: created.room.categoryId },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json<{ code: string }>().code).toBe('invalid_precondition');

    const stale = await app.inject({
      method: 'PUT',
      url: `/api/v1/rooms/${created.room.id}`,
      headers: authHeaders(requireAdmin(), randomUUID(), `"room:${created.room.id}:999"`),
      payload: { ...roomBody, categoryId: created.room.categoryId },
    });
    expect(stale.statusCode).toBe(412);
    expect(stale.json<{ code: string }>().code).toBe('stale_resource_revision');
  });

  it('replays the same key before staleness checks', async () => {
    const key = randomUUID();
    const created = await createRoom(requireAdmin(), schoolA, {}, key);
    expect(created.response.statusCode).toBe(201);

    const keyB = randomUUID();
    const updated = await app.inject({
      method: 'PUT',
      url: `/api/v1/rooms/${created.room.id}`,
      headers: authHeaders(requireAdmin(), keyB, created.etag),
      payload: { ...roomBody, categoryId: created.room.categoryId, name: 'Replay Target' },
    });
    expect(updated.statusCode).toBe(200);

    // Same original key + fingerprint replays the create success even though
    // the current revision has advanced past the original read.
    const replayed = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${schoolA}/rooms`,
      headers: authHeaders(requireAdmin(), key),
      payload: { ...roomBody, categoryId: created.room.categoryId },
    });
    expect(replayed.statusCode).toBe(201);
    expect(replayed.json<{ room: RoomBody }>().room.id).toBe(created.room.id);

    const reused = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${schoolA}/rooms`,
      headers: authHeaders(requireAdmin(), key),
      payload: { ...roomBody, categoryId: created.room.categoryId, name: 'Different' },
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json<{ code: string }>().code).toBe('idempotency_key_reused');
  });

  it('rejects lost updates between two administrators', async () => {
    const created = await createRoom(requireAdmin());
    expect(created.response.statusCode).toBe(201);

    const adminBKey = randomUUID();
    const updateBase = {
      ...roomBody,
      categoryId: created.room.categoryId,
      studentSelfRequestable: created.room.studentSelfRequestable,
    };
    const first = await app.inject({
      method: 'PUT',
      url: `/api/v1/rooms/${created.room.id}`,
      headers: authHeaders(requireAdmin(), adminBKey, created.etag),
      payload: { ...updateBase, capacity: 2 },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<{ room: RoomBody }>().room.revision).toBe('2');

    const stale = await app.inject({
      method: 'PUT',
      url: `/api/v1/rooms/${created.room.id}`,
      headers: authHeaders(requireAdmin(), randomUUID(), created.etag),
      payload: { ...updateBase, checkInMode: 'required' },
    });
    expect(stale.statusCode).toBe(412);

    const replayed = await app.inject({
      method: 'PUT',
      url: `/api/v1/rooms/${created.room.id}`,
      headers: authHeaders(requireAdmin(), adminBKey, created.etag),
      payload: { ...updateBase, capacity: 2 },
    });
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json<{ room: RoomBody }>().room.capacity).toBe(2);
  });

  it('guards archive against live passes, grants, policies, and appointments', async () => {
    const created = await createRoom(requireAdmin());
    const roomId = created.room.id;

    const passId = await insertReturningId(
      `INSERT INTO pass (tenant_id, organization_id, student_id, destination_room_id, request_source, lifecycle_state)
       VALUES ($1, $2, $3, $4, 'student_web', 'ready') RETURNING id`,
      [tenantA, schoolA, requireStudent().personId, roomId],
    );
    expect(passId).toBeDefined();
    const blockedByPass = await app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/archive`,
      headers: authHeaders(requireAdmin(), randomUUID(), created.etag),
    });
    expect(blockedByPass.statusCode).toBe(409);
    expect(blockedByPass.json<{ code: string }>().code).toBe('room_in_use');
    await pool.query(`UPDATE pass SET lifecycle_state = 'completed' WHERE id = $1`, [passId]);

    await pool.query(
      `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind, room_id)
       VALUES ($1, $2, 'room_staff', 'room', $3)`,
      [tenantA, requireAdmin().accountId, roomId],
    );
    const current = await app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}`,
      headers: authHeaders(requireAdmin()),
    });
    const blockedByGrant = await app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/archive`,
      headers: authHeaders(requireAdmin(), randomUUID(), requiredEtag(current)),
    });
    expect(blockedByGrant.statusCode).toBe(409);
    await pool.query(
      `UPDATE authorization_grant SET status = 'revoked', revoked_at = now(), revoked_by_account_id = account_id WHERE room_id = $1`,
      [roomId],
    );

    await pool.query(
      `INSERT INTO policy_rule (tenant_id, organization_id, name, rule_type, scope_kind, scope_room_id,
        configuration, override_mode, enabled)
       VALUES ($1, $2, 'Nurse rule', 'schedule_boundary', 'room', $3,
        '{"schemaVersion": 1, "firstMinutes": 5, "lastMinutes": 10, "blockKinds": ["lunch"], "requestSources": ["student_web"]}',
        'never', true)`,
      [tenantA, schoolA, roomId],
    );
    const current2 = await app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}`,
      headers: authHeaders(requireAdmin()),
    });
    const blockedByPolicy = await app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/archive`,
      headers: authHeaders(requireAdmin(), randomUUID(), requiredEtag(current2)),
    });
    expect(blockedByPolicy.statusCode).toBe(409);
    await pool.query(`UPDATE policy_rule SET enabled = false WHERE scope_room_id = $1`, [
      roomId,
    ]);

    await pool.query(
      `INSERT INTO scheduled_authorization (tenant_id, organization_id, student_id, destination_room_id,
        created_by_person_id, valid_from, valid_until, approval_mode, origin_strategy)
       VALUES ($1, $2, $3, $4, $3, now(), now() + interval '1 hour', 'preapproved', 'expected')`,
      [tenantA, schoolA, requireStudent().personId, roomId],
    );
    const current3 = await app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}`,
      headers: authHeaders(requireAdmin()),
    });
    const blockedByAppointment = await app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/archive`,
      headers: authHeaders(requireAdmin(), randomUUID(), requiredEtag(current3)),
    });
    expect(blockedByAppointment.statusCode).toBe(409);
    await pool.query(
      `UPDATE scheduled_authorization SET status = 'cancelled', cancelled_at = now(), cancelled_by_account_id = $2 WHERE destination_room_id = $1`,
      [roomId, requireAdmin().accountId],
    );

    const current4 = await app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}`,
      headers: authHeaders(requireAdmin()),
    });
    const archived = await app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/archive`,
      headers: authHeaders(requireAdmin(), randomUUID(), requiredEtag(current4)),
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json<{ room: RoomBody }>().room.status).toBe('archived');
  });

  it('conceals cross-tenant rooms and denies students and recovery sessions', async () => {
    const other = await createRoom(requireOtherAdmin(), schoolB);
    expect(other.response.statusCode).toBe(201);

    const concealed = await app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${other.room.id}`,
      headers: authHeaders(requireAdmin()),
    });
    expect(concealed.statusCode).toBe(404);
    expect(concealed.json<{ code: string }>().code).toBe('room_not_found');

    const studentDenied = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${schoolA}/rooms`,
      headers: authHeaders(requireStudent(), randomUUID()),
      payload: { ...roomBody, categoryId: other.room.categoryId },
    });
    expect(studentDenied.statusCode).toBe(403);

    const recovery = await mintSession(tenantA, requireAdmin().accountId, 'recovery');
    const recoveryDenied = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${schoolA}/rooms`,
      headers: authHeaders(recovery, randomUUID()),
      payload: { ...roomBody, categoryId: other.room.categoryId },
    });
    expect(recoveryDenied.statusCode).toBe(403);
    expect(recoveryDenied.json<{ code: string }>().code).toBe('recovery_session_restricted');
  });

  it('exposes a safe member catalog without admin internals', async () => {
    const created = await createRoom(requireAdmin());
    const opened = await app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${created.room.id}/open`,
      headers: authHeaders(requireAdmin(), randomUUID(), created.etag),
    });
    expect(opened.statusCode).toBe(200);

    const catalog = await app.inject({
      method: 'GET',
      url: `/api/v1/me/organizations/${schoolA}/rooms`,
      headers: authHeaders(requireStudent()),
    });
    expect(catalog.statusCode).toBe(200);
    const entries = catalog.json<{ rooms: Record<string, unknown>[] }>().rooms;
    const entry = entries.find((row) => row.id === created.room.id);
    expect(entry).toMatchObject({
      name: 'Nurse Office',
      checkInMode: 'optional',
      categoryId: created.room.categoryId,
    });
    expect(Object.keys(entry ?? {}).sort()).toEqual(
      ['categoryId', 'checkInMode', 'code', 'floorLabel', 'id', 'name'].sort(),
    );

    const closed = await createRoom(requireAdmin());
    expect(closed.response.statusCode).toBe(201);
    const catalogAgain = await app.inject({
      method: 'GET',
      url: `/api/v1/me/organizations/${schoolA}/rooms`,
      headers: authHeaders(requireStudent()),
    });
    const ids = catalogAgain
      .json<{ rooms: { id: string }[] }>()
      .rooms.map((row) => row.id);
    expect(ids).not.toContain(closed.room.id);
  });

  it('writes audit and outbox facts for every committed change', async () => {
    const created = await createRoom(requireAdmin());
    const auditRows = await pool.query<{ action: string }>(
      `SELECT action FROM audit_event WHERE target_id = $1 ORDER BY occurred_at`,
      [created.room.id],
    );
    expect(auditRows.rows.map((row) => row.action)).toContain('room.created');
    const outboxRows = await pool.query<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM outbox_event WHERE aggregate_id = $1 ORDER BY occurred_at`,
      [created.room.id],
    );
    expect(outboxRows.rows.map((row) => row.event_type)).toContain('room.created');
    const payload = outboxRows.rows[0]?.payload ?? {};
    expect(payload).not.toHaveProperty('token');
    expect(payload).toMatchObject({ schemaVersion: 1, revision: '1', status: 'closed' });
  });
});
