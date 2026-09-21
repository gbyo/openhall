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

interface LocationBody {
  id: string;
  organizationId: string;
  parentLocationId: string | null;
  kind: string;
  name: string;
  code: string | null;
  floorLabel: string | null;
  status: string;
  revision: string;
}

interface DestinationBody {
  id: string;
  organizationId: string;
  locationId: string;
  serviceType: string;
  displayName: string | null;
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

const locationBody = {
  parentLocationId: null,
  kind: 'classroom',
  name: 'Room 101',
  code: 'R101',
  floorLabel: '1F',
};

const destinationBody = {
  serviceType: 'nurse',
  displayName: 'Nurse Office',
  capacity: 3,
  queueEnabled: true,
  checkInMode: 'optional',
  defaultDurationSeconds: 600,
  maxDurationSeconds: 1800,
  readyClaimTimeoutSeconds: 60,
  queueTimeoutSeconds: 600,
};

async function createLocation(
  admin: SessionFixture,
  schoolId: string = schoolA,
  body: Record<string, unknown> = locationBody,
  key = randomUUID(),
): Promise<{
  response: Awaited<ReturnType<FastifyInstance['inject']>>;
  location: LocationBody;
  etag: string;
}> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/organizations/${schoolId}/locations`,
    headers: authHeaders(admin, key),
    payload: body,
  });
  return {
    response,
    location: response.json<{ location: LocationBody }>().location,
    etag: requiredEtag(response),
  };
}

async function createDestination(
  admin: SessionFixture,
  schoolId: string,
  locationId: string,
  body: Record<string, unknown> = destinationBody,
  key = randomUUID(),
): Promise<{
  response: Awaited<ReturnType<FastifyInstance['inject']>>;
  destination: DestinationBody;
  etag: string;
}> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/organizations/${schoolId}/destinations`,
    headers: authHeaders(admin, key),
    payload: { ...body, locationId },
  });
  return {
    response,
    destination: response.json<{ destination: DestinationBody }>().destination,
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

describe('control-plane locations', () => {
  it('creates, reads, updates, and archives a location with strong ETags', async () => {
    const created = await createLocation(requireAdmin());
    expect(created.response.statusCode).toBe(201);
    expect(created.location.status).toBe('active');
    expect(created.location.revision).toBe('1');
    expect(created.etag).toBe(`"location:${created.location.id}:1"`);

    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/locations`,
      headers: authHeaders(requireAdmin()),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ locations: LocationBody[] }>().locations.map((row) => row.id)).toContain(
      created.location.id,
    );

    const fetched = await app.inject({
      method: 'GET',
      url: `/api/v1/locations/${created.location.id}`,
      headers: authHeaders(requireAdmin()),
    });
    expect(fetched.statusCode).toBe(200);
    expect(requiredEtag(fetched)).toBe(created.etag);

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/v1/locations/${created.location.id}`,
      headers: authHeaders(requireAdmin(), randomUUID(), created.etag),
      payload: { ...locationBody, name: 'Room 102' },
    });
    expect(updated.statusCode).toBe(200);
    const updatedBody = updated.json<{ location: LocationBody }>().location;
    expect(updatedBody.name).toBe('Room 102');
    expect(updatedBody.revision).toBe('2');
    const updateEtag = requiredEtag(updated);

    const archived = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${created.location.id}/archive`,
      headers: authHeaders(requireAdmin(), randomUUID(), updateEtag),
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json<{ location: LocationBody }>().location.status).toBe('archived');
  });

  it('requires If-Match, rejects malformed tags, and enforces staleness', async () => {
    const created = await createLocation(requireAdmin());
    expect(created.response.statusCode).toBe(201);

    const missing = await app.inject({
      method: 'PUT',
      url: `/api/v1/locations/${created.location.id}`,
      headers: authHeaders(requireAdmin(), randomUUID()),
      payload: locationBody,
    });
    expect(missing.statusCode).toBe(428);
    expect(missing.json<{ code: string }>().code).toBe('precondition_required');

    const malformed = await app.inject({
      method: 'PUT',
      url: `/api/v1/locations/${created.location.id}`,
      headers: authHeaders(requireAdmin(), randomUUID(), 'W/"location:1:1"'),
      payload: locationBody,
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json<{ code: string }>().code).toBe('invalid_precondition');

    const stale = await app.inject({
      method: 'PUT',
      url: `/api/v1/locations/${created.location.id}`,
      headers: authHeaders(requireAdmin(), randomUUID(), `"location:${created.location.id}:999"`),
      payload: locationBody,
    });
    expect(stale.statusCode).toBe(412);
    expect(stale.json<{ code: string }>().code).toBe('stale_resource_revision');
  });

  it('replays the same key before staleness checks', async () => {
    const key = randomUUID();
    const created = await createLocation(requireAdmin(), schoolA, locationBody, key);
    expect(created.response.statusCode).toBe(201);

    const keyB = randomUUID();
    const updated = await app.inject({
      method: 'PUT',
      url: `/api/v1/locations/${created.location.id}`,
      headers: authHeaders(requireAdmin(), keyB, created.etag),
      payload: { ...locationBody, name: 'Replay Target' },
    });
    expect(updated.statusCode).toBe(200);

    // Same original key + fingerprint replays the create success even though
    // the current revision has advanced past the original read.
    const replayed = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${schoolA}/locations`,
      headers: authHeaders(requireAdmin(), key),
      payload: locationBody,
    });
    expect(replayed.statusCode).toBe(201);
    expect(replayed.json<{ location: LocationBody }>().location.id).toBe(created.location.id);

    const reused = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${schoolA}/locations`,
      headers: authHeaders(requireAdmin(), key),
      payload: { ...locationBody, name: 'Different' },
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json<{ code: string }>().code).toBe('idempotency_key_reused');
  });

  it('rejects hierarchy violations inside the transaction', async () => {
    const parent = await createLocation(requireAdmin());
    expect(parent.response.statusCode).toBe(201);
    const childEtagParent = parent.etag;

    const child = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${schoolA}/locations`,
      headers: authHeaders(requireAdmin(), randomUUID()),
      payload: { ...locationBody, parentLocationId: parent.location.id },
    });
    expect(child.statusCode).toBe(201);
    const childId = child.json<{ location: LocationBody }>().location.id;

    const selfParent = await app.inject({
      method: 'PUT',
      url: `/api/v1/locations/${parent.location.id}`,
      headers: authHeaders(requireAdmin(), randomUUID(), childEtagParent),
      payload: { ...locationBody, parentLocationId: parent.location.id },
    });
    expect(selfParent.statusCode).toBe(400);
    expect(selfParent.json<{ code: string }>().code).toBe('invalid_location_parent');

    const fetchedChild = await app.inject({
      method: 'GET',
      url: `/api/v1/locations/${childId}`,
      headers: authHeaders(requireAdmin()),
    });
    const cycle = await app.inject({
      method: 'PUT',
      url: `/api/v1/locations/${parent.location.id}`,
      headers: authHeaders(requireAdmin(), randomUUID(), childEtagParent),
      payload: { ...locationBody, parentLocationId: childId },
    });
    expect(cycle.statusCode).toBe(400);
    expect(requiredEtag(fetchedChild)).toContain(childId);

    const other = await createLocation(requireOtherAdmin(), schoolB);
    expect(other.response.statusCode).toBe(201);
    const crossSchool = await app.inject({
      method: 'PUT',
      url: `/api/v1/locations/${parent.location.id}`,
      headers: authHeaders(requireAdmin(), randomUUID(), childEtagParent),
      payload: { ...locationBody, parentLocationId: other.location.id },
    });
    expect(crossSchool.statusCode).toBe(400);
    expect(cycle.json<{ code: string }>().code).toBe('invalid_location_parent');
  });

  it('refuses to archive a location still required by live references', async () => {
    const created = await createLocation(requireAdmin());
    const locationId = created.location.id;
    const destination = await createDestination(requireAdmin(), schoolA, locationId);
    expect(destination.response.statusCode).toBe(201);

    const blocked = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationId}/archive`,
      headers: authHeaders(requireAdmin(), randomUUID(), created.etag),
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<{ code: string }>().code).toBe('location_in_use');
  });

  it('conceals cross-tenant locations and denies students and recovery sessions', async () => {
    const other = await createLocation(requireOtherAdmin(), schoolB);
    expect(other.response.statusCode).toBe(201);

    const concealed = await app.inject({
      method: 'GET',
      url: `/api/v1/locations/${other.location.id}`,
      headers: authHeaders(requireAdmin()),
    });
    expect(concealed.statusCode).toBe(404);
    expect(concealed.json<{ code: string }>().code).toBe('location_not_found');

    const studentDenied = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${schoolA}/locations`,
      headers: authHeaders(requireStudent(), randomUUID()),
      payload: locationBody,
    });
    expect(studentDenied.statusCode).toBe(403);

    const recovery = await mintSession(tenantA, requireAdmin().accountId, 'recovery');
    const recoveryDenied = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${schoolA}/locations`,
      headers: authHeaders(recovery, randomUUID()),
      payload: locationBody,
    });
    expect(recoveryDenied.statusCode).toBe(403);
    expect(recoveryDenied.json<{ code: string }>().code).toBe('recovery_session_restricted');
  });
});

describe('control-plane destinations', () => {
  it('creates closed destinations and opens them explicitly', async () => {
    const location = await createLocation(requireAdmin());
    const created = await createDestination(requireAdmin(), schoolA, location.location.id);
    expect(created.response.statusCode).toBe(201);
    expect(created.destination.status).toBe('closed');
    expect(created.destination.revision).toBe('1');
    expect(created.etag).toBe(`"destination:${created.destination.id}:1"`);

    const opened = await app.inject({
      method: 'POST',
      url: `/api/v1/destinations/${created.destination.id}/open`,
      headers: authHeaders(requireAdmin(), randomUUID(), created.etag),
    });
    expect(opened.statusCode).toBe(200);
    const openedBody = opened.json<{ destination: DestinationBody }>().destination;
    expect(openedBody.status).toBe('active');
    expect(openedBody.revision).toBe('2');
    const openedEtag = requiredEtag(opened);

    const reopened = await app.inject({
      method: 'POST',
      url: `/api/v1/destinations/${created.destination.id}/open`,
      headers: authHeaders(requireAdmin(), randomUUID(), openedEtag),
    });
    expect(reopened.statusCode).toBe(409);
    expect(reopened.json<{ code: string }>().code).toBe('destination_already_open');

    const closed = await app.inject({
      method: 'POST',
      url: `/api/v1/destinations/${created.destination.id}/close`,
      headers: authHeaders(requireAdmin(), randomUUID(), openedEtag),
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json<{ destination: DestinationBody }>().destination.status).toBe('closed');
  });

  it('rejects lost updates between two administrators', async () => {
    const location = await createLocation(requireAdmin());
    const created = await createDestination(requireAdmin(), schoolA, location.location.id);
    expect(created.response.statusCode).toBe(201);

    const adminBKey = randomUUID();
    const first = await app.inject({
      method: 'PUT',
      url: `/api/v1/destinations/${created.destination.id}`,
      headers: authHeaders(requireAdmin(), adminBKey, created.etag),
      payload: { ...destinationBody, locationId: location.location.id, capacity: 2 },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<{ destination: DestinationBody }>().destination.revision).toBe('2');

    const stale = await app.inject({
      method: 'PUT',
      url: `/api/v1/destinations/${created.destination.id}`,
      headers: authHeaders(requireAdmin(), randomUUID(), created.etag),
      payload: { ...destinationBody, locationId: location.location.id, checkInMode: 'required' },
    });
    expect(stale.statusCode).toBe(412);

    const replayed = await app.inject({
      method: 'PUT',
      url: `/api/v1/destinations/${created.destination.id}`,
      headers: authHeaders(requireAdmin(), adminBKey, created.etag),
      payload: { ...destinationBody, locationId: location.location.id, capacity: 2 },
    });
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json<{ destination: DestinationBody }>().destination.capacity).toBe(2);
  });

  it('guards archive against live passes, grants, policies, and appointments', async () => {
    const location = await createLocation(requireAdmin());
    const created = await createDestination(requireAdmin(), schoolA, location.location.id);
    const destinationId = created.destination.id;

    const passId = await insertReturningId(
      `INSERT INTO pass (tenant_id, organization_id, student_id, destination_id, request_source, lifecycle_state)
       VALUES ($1, $2, $3, $4, 'student_web', 'ready') RETURNING id`,
      [tenantA, schoolA, requireStudent().personId, destinationId],
    );
    expect(passId).toBeDefined();
    const blockedByPass = await app.inject({
      method: 'POST',
      url: `/api/v1/destinations/${destinationId}/archive`,
      headers: authHeaders(requireAdmin(), randomUUID(), created.etag),
    });
    expect(blockedByPass.statusCode).toBe(409);
    expect(blockedByPass.json<{ code: string }>().code).toBe('destination_in_use');
    await pool.query(`UPDATE pass SET lifecycle_state = 'completed' WHERE id = $1`, [passId]);

    await pool.query(
      `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind, destination_id)
       VALUES ($1, $2, 'destination_staff', 'destination', $3)`,
      [tenantA, requireAdmin().accountId, destinationId],
    );
    const current = await app.inject({
      method: 'GET',
      url: `/api/v1/destinations/${destinationId}`,
      headers: authHeaders(requireAdmin()),
    });
    const blockedByGrant = await app.inject({
      method: 'POST',
      url: `/api/v1/destinations/${destinationId}/archive`,
      headers: authHeaders(requireAdmin(), randomUUID(), requiredEtag(current)),
    });
    expect(blockedByGrant.statusCode).toBe(409);
    await pool.query(
      `UPDATE authorization_grant SET status = 'revoked', revoked_at = now(), revoked_by_account_id = account_id WHERE destination_id = $1`,
      [destinationId],
    );

    await pool.query(
      `INSERT INTO policy_rule (tenant_id, organization_id, name, rule_type, scope_kind, scope_destination_id,
        configuration, override_mode, enabled)
       VALUES ($1, $2, 'Nurse rule', 'schedule_boundary', 'destination', $3,
        '{"schemaVersion": 1, "firstMinutes": 5, "lastMinutes": 10, "blockKinds": ["lunch"], "requestSources": ["student_web"]}',
        'never', true)`,
      [tenantA, schoolA, destinationId],
    );
    const current2 = await app.inject({
      method: 'GET',
      url: `/api/v1/destinations/${destinationId}`,
      headers: authHeaders(requireAdmin()),
    });
    const blockedByPolicy = await app.inject({
      method: 'POST',
      url: `/api/v1/destinations/${destinationId}/archive`,
      headers: authHeaders(requireAdmin(), randomUUID(), requiredEtag(current2)),
    });
    expect(blockedByPolicy.statusCode).toBe(409);
    await pool.query(`UPDATE policy_rule SET enabled = false WHERE scope_destination_id = $1`, [
      destinationId,
    ]);

    await pool.query(
      `INSERT INTO scheduled_authorization (tenant_id, organization_id, student_id, destination_id,
        created_by_person_id, valid_from, valid_until, approval_mode, origin_strategy)
       VALUES ($1, $2, $3, $4, $3, now(), now() + interval '1 hour', 'preapproved', 'expected')`,
      [tenantA, schoolA, requireStudent().personId, destinationId],
    );
    const current3 = await app.inject({
      method: 'GET',
      url: `/api/v1/destinations/${destinationId}`,
      headers: authHeaders(requireAdmin()),
    });
    const blockedByAppointment = await app.inject({
      method: 'POST',
      url: `/api/v1/destinations/${destinationId}/archive`,
      headers: authHeaders(requireAdmin(), randomUUID(), requiredEtag(current3)),
    });
    expect(blockedByAppointment.statusCode).toBe(409);
    await pool.query(
      `UPDATE scheduled_authorization SET status = 'cancelled', cancelled_at = now(), cancelled_by_account_id = $2 WHERE destination_id = $1`,
      [destinationId, requireAdmin().accountId],
    );

    const current4 = await app.inject({
      method: 'GET',
      url: `/api/v1/destinations/${destinationId}`,
      headers: authHeaders(requireAdmin()),
    });
    const archived = await app.inject({
      method: 'POST',
      url: `/api/v1/destinations/${destinationId}/archive`,
      headers: authHeaders(requireAdmin(), randomUUID(), requiredEtag(current4)),
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json<{ destination: DestinationBody }>().destination.status).toBe('archived');
  });

  it('exposes a safe member catalog without admin internals', async () => {
    const location = await createLocation(requireAdmin());
    const created = await createDestination(requireAdmin(), schoolA, location.location.id);
    const opened = await app.inject({
      method: 'POST',
      url: `/api/v1/destinations/${created.destination.id}/open`,
      headers: authHeaders(requireAdmin(), randomUUID(), created.etag),
    });
    expect(opened.statusCode).toBe(200);

    const catalog = await app.inject({
      method: 'GET',
      url: `/api/v1/me/organizations/${schoolA}/destinations`,
      headers: authHeaders(requireStudent()),
    });
    expect(catalog.statusCode).toBe(200);
    const entries = catalog.json<{ destinations: Record<string, unknown>[] }>().destinations;
    const entry = entries.find((row) => row.id === created.destination.id);
    expect(entry).toMatchObject({
      displayName: 'Nurse Office',
      serviceType: 'nurse',
      checkInMode: 'optional',
    });
    expect(Object.keys(entry ?? {}).sort()).toEqual(
      ['checkInMode', 'displayName', 'id', 'serviceType'].sort(),
    );

    const closedLocation = await createLocation(requireAdmin());
    const closed = await createDestination(requireAdmin(), schoolA, closedLocation.location.id);
    expect(closed.response.statusCode).toBe(201);
    const catalogAgain = await app.inject({
      method: 'GET',
      url: `/api/v1/me/organizations/${schoolA}/destinations`,
      headers: authHeaders(requireStudent()),
    });
    const ids = catalogAgain
      .json<{ destinations: { id: string }[] }>()
      .destinations.map((row) => row.id);
    expect(ids).not.toContain(closed.destination.id);
  });

  it('writes audit and outbox facts for every committed change', async () => {
    const location = await createLocation(requireAdmin());
    const created = await createDestination(requireAdmin(), schoolA, location.location.id);
    const auditRows = await pool.query<{ action: string }>(
      `SELECT action FROM audit_event WHERE target_id = $1 ORDER BY occurred_at`,
      [created.destination.id],
    );
    expect(auditRows.rows.map((row) => row.action)).toContain('destination.created');
    const outboxRows = await pool.query<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM outbox_event WHERE aggregate_id = $1 ORDER BY occurred_at`,
      [created.destination.id],
    );
    expect(outboxRows.rows.map((row) => row.event_type)).toContain('destination.created');
    const payload = outboxRows.rows[0]?.payload ?? {};
    expect(payload).not.toHaveProperty('token');
    expect(payload).toMatchObject({ schemaVersion: 1, revision: '1', status: 'closed' });
  });
});
