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

function requiredEtag(response: { headers: Record<string, unknown> }): string {
  const etag = response.headers.etag;
  if (typeof etag !== 'string') throw new Error('Expected ETag response header');
  return etag;
}

interface CategoryBody {
  id: string;
  organizationId: string;
  name: string;
  iconKey: string;
  toneKey: string;
  studentSurface: string;
  pickerMode: string;
  sortOrder: number;
  status: string;
  revision: string;
}

const categoryPayload = {
  iconKey: 'chat',
  toneKey: 'violet',
  studentSurface: 'primary',
  sortOrder: 10,
};

let tenantA = '';
let schoolA = '';
let tenantB = '';
let schoolB = '';
let adminA: SessionFixture | null = null;
let studentA: SessionFixture | null = null;
let adminB: SessionFixture | null = null;

function requireAdmin(): SessionFixture {
  if (adminA === null) throw new Error('admin fixture missing');
  return adminA;
}

function requireStudent(): SessionFixture {
  if (studentA === null) throw new Error('student fixture missing');
  return studentA;
}

function requireAdminB(): SessionFixture {
  if (adminB === null) throw new Error('other admin fixture missing');
  return adminB;
}

async function openDestination(admin: SessionFixture, destinationId: string): Promise<void> {
  const detail = await app.inject({
    method: 'GET',
    url: `/api/v1/destinations/${destinationId}`,
    headers: authHeaders(admin),
  });
  await app.inject({
    method: 'POST',
    url: `/api/v1/destinations/${destinationId}/open`,
    headers: authHeaders(admin, randomUUID(), requiredEtag(detail)),
  });
}

async function createCategory(
  admin: SessionFixture,
  schoolId: string,
  body: Record<string, unknown> = {},
  key = randomUUID(),
) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/organizations/${schoolId}/destination-categories`,
    headers: authHeaders(admin, key),
    payload: { name: `Cat ${randomUUID().slice(0, 8)}`, ...categoryPayload, ...body },
  });
  return {
    response,
    category: response.json<{ category: CategoryBody }>().category,
    etag: response.statusCode === 201 ? requiredEtag(response) : '',
  };
}

async function createLocation(schoolId: string, name: string) {
  const id = await insertReturningId(
    `INSERT INTO location (tenant_id, organization_id, kind, name) VALUES ($1, $2, 'classroom', $3) RETURNING id`,
    [schoolId === schoolB ? tenantB : tenantA, schoolId, name],
  );
  return id;
}

async function createDestination(
  admin: SessionFixture,
  schoolId: string,
  locationId: string,
  categoryId: string,
  body: Record<string, unknown> = {},
  key = randomUUID(),
) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/organizations/${schoolId}/destinations`,
    headers: authHeaders(admin, key),
    payload: {
      locationId,
      categoryId,
      studentSelfRequestable: true,
      serviceType: 'counseling',
      displayName: `Dest ${randomUUID().slice(0, 8)}`,
      capacity: null,
      queueEnabled: false,
      checkInMode: 'none',
      defaultDurationSeconds: 600,
      maxDurationSeconds: 1200,
      readyClaimTimeoutSeconds: 120,
      queueTimeoutSeconds: 1800,
      ...body,
    },
  });
  return { response, destination: response.json<{ destination: { id: string } }>().destination };
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
    readinessProbe: { check: () => Promise.resolve({ migration: '010_destination_categories' }) },
  });

  tenantA = await insertReturningId(
    `INSERT INTO tenant (name, slug) VALUES ('TA', 'dcta') RETURNING id`,
  );
  schoolA = await insertReturningId(
    `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'A School', 'dca-school', 'America/New_York') RETURNING id`,
    [tenantA],
  );
  tenantB = await insertReturningId(
    `INSERT INTO tenant (name, slug) VALUES ('TB', 'dctb') RETURNING id`,
  );
  schoolB = await insertReturningId(
    `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'B School', 'dcb-school', 'America/New_York') RETURNING id`,
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
  const admin = new Client({ connectionString: administration.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${quotedIdentifier(databaseName)} WITH (FORCE)`);
  await admin.end();
});

describe('destination-category administration', () => {
  it('creates, reads, updates, and archives a category with ETag concurrency', async () => {
    const created = await createCategory(requireAdmin(), schoolA, { name: 'Counselor' });
    expect(created.response.statusCode).toBe(201);
    expect(created.category.status).toBe('active');
    expect(created.category.revision).toBe('1');
    expect(created.etag).toBe(`"destination-category:${created.category.id}:1"`);

    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/destination-categories`,
      headers: authHeaders(requireAdmin()),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ categories: CategoryBody[] }>().categories.map((c) => c.name)).toContain(
      'Counselor',
    );

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/v1/destination-categories/${created.category.id}`,
      headers: authHeaders(requireAdmin(), randomUUID(), created.etag),
      payload: {
        name: 'Counseling',
        ...categoryPayload,
        studentSurface: 'secondary',
        sortOrder: 5,
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<{ category: CategoryBody }>().category.revision).toBe('2');
    expect(requiredEtag(updated)).toBe(`"destination-category:${created.category.id}:2"`);

    const stale = await app.inject({
      method: 'PUT',
      url: `/api/v1/destination-categories/${created.category.id}`,
      headers: authHeaders(requireAdmin(), randomUUID(), created.etag),
      payload: { name: 'Stale', ...categoryPayload },
    });
    expect(stale.statusCode).toBe(412);
    expect(stale.json<{ code: string }>().code).toBe('stale_resource_revision');

    const noPrecondition = await app.inject({
      method: 'PUT',
      url: `/api/v1/destination-categories/${created.category.id}`,
      headers: authHeaders(requireAdmin(), randomUUID()),
      payload: { name: 'Nope', ...categoryPayload },
    });
    expect(noPrecondition.statusCode).toBe(428);

    const archived = await app.inject({
      method: 'POST',
      url: `/api/v1/destination-categories/${created.category.id}/archive`,
      headers: authHeaders(requireAdmin(), randomUUID(), requiredEtag(updated)),
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json<{ category: CategoryBody }>().category.status).toBe('archived');

    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/destination-categories/${created.category.id}`,
      headers: authHeaders(requireAdmin()),
    });
    expect(read.statusCode).toBe(200);
    // Archived history stays readable; renames never rewrite destinations.
    expect(read.json<{ category: CategoryBody }>().category.name).toBe('Counseling');
  });

  it('rejects duplicate active names case-insensitively but reuses archived names', async () => {
    const first = await createCategory(requireAdmin(), schoolA, { name: 'Principal' });
    expect(first.response.statusCode).toBe(201);

    const duplicate = await createCategory(requireAdmin(), schoolA, { name: 'principal' });
    expect(duplicate.response.statusCode).toBe(409);
    expect(duplicate.response.json<{ code: string }>().code).toBe('destination_category_exists');

    // Same name in another school is fine.
    const otherSchool = await createCategory(requireAdminB(), schoolB, {
      name: 'Principal',
    });
    expect(otherSchool.response.statusCode).toBe(201);

    const archived = await app.inject({
      method: 'POST',
      url: `/api/v1/destination-categories/${first.category.id}/archive`,
      headers: authHeaders(requireAdmin(), randomUUID(), first.etag),
    });
    expect(archived.statusCode).toBe(200);

    const reused = await createCategory(requireAdmin(), schoolA, { name: 'Principal' });
    expect(reused.response.statusCode).toBe(201);
  });

  it('rejects unknown icons and conceals cross-tenant categories', async () => {
    const badIcon = await createCategory(requireAdmin(), schoolA, { iconKey: 'rocket' });
    expect(badIcon.response.statusCode).toBe(400);

    const foreign = await createCategory(requireAdminB(), schoolB, { name: 'Foreign' });
    expect(foreign.response.statusCode).toBe(201);
    const concealed = await app.inject({
      method: 'GET',
      url: `/api/v1/destination-categories/${foreign.category.id}`,
      headers: authHeaders(requireAdmin()),
    });
    expect(concealed.statusCode).toBe(404);
    expect(concealed.json<{ code: string }>().code).toBe('destination_category_not_found');
  });

  it('defaults picker mode to auto and round-trips explicit modes', async () => {
    const implicit = await createCategory(requireAdmin(), schoolA, { name: 'Implicit Picker' });
    expect(implicit.response.statusCode).toBe(201);
    expect(implicit.category.pickerMode).toBe('auto');

    const searching = await createCategory(requireAdmin(), schoolA, {
      name: 'Search Picker',
      pickerMode: 'search',
    });
    expect(searching.response.statusCode).toBe(201);
    expect(searching.category.pickerMode).toBe('search');

    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/destination-categories`,
      headers: authHeaders(requireAdmin()),
    });
    const modes = new Map(
      listed.json<{ categories: CategoryBody[] }>().categories.map((c) => [c.name, c.pickerMode]),
    );
    expect(modes.get('Implicit Picker')).toBe('auto');
    expect(modes.get('Search Picker')).toBe('search');

    const relisted = await app.inject({
      method: 'PUT',
      url: `/api/v1/destination-categories/${searching.category.id}`,
      headers: authHeaders(requireAdmin(), randomUUID(), searching.etag),
      payload: { name: 'Search Picker', ...categoryPayload, pickerMode: 'list' },
    });
    expect(relisted.statusCode).toBe(200);
    expect(relisted.json<{ category: CategoryBody }>().category.pickerMode).toBe('list');

    const catalog = await app.inject({
      method: 'GET',
      url: `/api/v1/me/organizations/${schoolA}/student-destination-catalog`,
      headers: authHeaders(requireStudent()),
    });
    expect(catalog.statusCode).toBe(200);
    for (const entry of catalog.json<{
      categories: { name: string; pickerMode: string }[];
    }>().categories) {
      expect(['auto', 'list', 'search']).toContain(entry.pickerMode);
    }
  });

  it('rejects unknown picker modes with a closed vocabulary', async () => {
    const bad = await createCategory(requireAdmin(), schoolA, { pickerMode: 'Room visits' });
    expect(bad.response.statusCode).toBe(400);
  });

  it('requires destination.manage and replays idempotent creates', async () => {
    const denied = await createCategory(requireStudent(), schoolA, { name: 'Nope' });
    expect(denied.response.statusCode).toBe(403);

    const key = randomUUID();
    const first = await createCategory(requireAdmin(), schoolA, { name: 'Replay' }, key);
    expect(first.response.statusCode).toBe(201);
    const second = await createCategory(requireAdmin(), schoolA, { name: 'Replay' }, key);
    expect(second.response.statusCode).toBe(201);
    expect(second.category.id).toBe(first.category.id);
  });

  it('blocks archive while non-archived destinations reference the category', async () => {
    const category = await createCategory(requireAdmin(), schoolA, { name: 'Guarded' });
    const locationId = await createLocation(schoolA, 'Guard Room');
    const destination = await createDestination(
      requireAdmin(),
      schoolA,
      locationId,
      category.category.id,
    );
    expect(destination.response.statusCode).toBe(201);

    const blocked = await app.inject({
      method: 'POST',
      url: `/api/v1/destination-categories/${category.category.id}/archive`,
      headers: authHeaders(requireAdmin(), randomUUID(), category.etag),
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<{ code: string }>().code).toBe('destination_category_in_use');

    // Archiving the destination clears the guard; the category archives cleanly.
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/destinations/${destination.destination.id}`,
      headers: authHeaders(requireAdmin()),
    });
    const archivedDest = await app.inject({
      method: 'POST',
      url: `/api/v1/destinations/${destination.destination.id}/archive`,
      headers: authHeaders(requireAdmin(), randomUUID(), requiredEtag(detail)),
    });
    expect(archivedDest.statusCode).toBe(200);

    const refreshed = await app.inject({
      method: 'GET',
      url: `/api/v1/destination-categories/${category.category.id}`,
      headers: authHeaders(requireAdmin()),
    });
    const cleared = await app.inject({
      method: 'POST',
      url: `/api/v1/destination-categories/${category.category.id}/archive`,
      headers: authHeaders(requireAdmin(), randomUUID(), requiredEtag(refreshed)),
    });
    expect(cleared.statusCode).toBe(200);
  });

  it('validates destination category references on create and update', async () => {
    const locationId = await createLocation(schoolA, 'Ref Room');

    const missing = await createDestination(requireAdmin(), schoolA, locationId, randomUUID());
    expect(missing.response.statusCode).toBe(400);

    const foreign = await createCategory(requireAdminB(), schoolB, { name: 'Far' });
    const crossSchool = await createDestination(
      requireAdmin(),
      schoolA,
      locationId,
      foreign.category.id,
    );
    expect(crossSchool.response.statusCode).toBe(400);

    const archivedCat = await createCategory(requireAdmin(), schoolA, { name: 'Gone' });
    await app.inject({
      method: 'POST',
      url: `/api/v1/destination-categories/${archivedCat.category.id}/archive`,
      headers: authHeaders(requireAdmin(), randomUUID(), archivedCat.etag),
    });
    const archivedRef = await createDestination(
      requireAdmin(),
      schoolA,
      locationId,
      archivedCat.category.id,
    );
    expect(archivedRef.response.statusCode).toBe(400);

    const noCategory = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${schoolA}/destinations`,
      headers: authHeaders(requireAdmin(), randomUUID()),
      payload: {
        locationId,
        serviceType: 'nurse',
        displayName: 'No Cat',
        capacity: null,
        queueEnabled: false,
        checkInMode: 'none',
        defaultDurationSeconds: 600,
        maxDurationSeconds: 1200,
        readyClaimTimeoutSeconds: 120,
        queueTimeoutSeconds: 1800,
      },
    });
    expect(noCategory.statusCode).toBe(400);
  });
});

describe('student destination catalog and request gating', () => {
  it('serves only eligible categories and destinations to students', async () => {
    const admin = requireAdmin();
    const locationId = await createLocation(schoolA, 'Catalog Room');
    const primary = await createCategory(admin, schoolA, {
      name: 'Catalog Primary',
      iconKey: 'restroom',
      toneKey: 'aqua',
      studentSurface: 'primary',
      sortOrder: 5,
    });
    const secondary = await createCategory(admin, schoolA, {
      name: 'Catalog Secondary',
      studentSurface: 'secondary',
      sortOrder: 50,
    });
    const hidden = await createCategory(admin, schoolA, {
      name: 'Catalog Hidden',
      studentSurface: 'hidden',
      sortOrder: 1,
    });
    const empty = await createCategory(admin, schoolA, { name: 'Catalog Empty' });

    const open = await createDestination(admin, schoolA, locationId, primary.category.id, {
      displayName: 'Open Restroom',
    });
    expect(open.response.statusCode).toBe(201);
    // Open the destination so student requests can target it.
    await openDestination(admin, open.destination.id);
    const gated = await createDestination(admin, schoolA, locationId, primary.category.id, {
      displayName: 'Staff Only Restroom',
      studentSelfRequestable: false,
    });
    expect(gated.response.statusCode).toBe(201);
    const more = await createDestination(admin, schoolA, locationId, secondary.category.id, {
      displayName: 'Back Room',
    });
    expect(more.response.statusCode).toBe(201);
    await openDestination(admin, more.destination.id);
    const secret = await createDestination(admin, schoolA, locationId, hidden.category.id, {
      displayName: 'Secret Room',
    });
    expect(secret.response.statusCode).toBe(201);

    const catalog = await app.inject({
      method: 'GET',
      url: `/api/v1/me/organizations/${schoolA}/student-destination-catalog`,
      headers: authHeaders(requireStudent()),
    });
    expect(catalog.statusCode).toBe(200);
    const body = catalog.json<{
      categories: {
        id: string;
        name: string;
        iconKey: string;
        toneKey: string;
        studentSurface: string;
        destinations: { id: string; displayName: string; location: { id: string; name: string } }[];
      }[];
    }>();
    const names = body.categories.map((c) => c.name);
    expect(names).toContain('Catalog Primary');
    expect(names).toContain('Catalog Secondary');
    expect(names).not.toContain('Catalog Hidden');
    expect(names).not.toContain('Catalog Empty');
    // Server orders by sort_order, not creation order.
    expect(names.indexOf('Catalog Primary')).toBeLessThan(names.indexOf('Catalog Secondary'));
    const primaryEntry = body.categories.find((c) => c.name === 'Catalog Primary');
    expect(primaryEntry?.destinations.map((d) => d.displayName)).toEqual(['Open Restroom']);
    expect(primaryEntry?.iconKey).toBe('restroom');
    const secondaryEntry = body.categories.find((c) => c.name === 'Catalog Secondary');
    expect(secondaryEntry?.destinations.map((d) => d.displayName)).toEqual(['Back Room']);
    expect(secondaryEntry?.destinations[0]?.location.name).toBe('Catalog Room');
    expect(empty).toBeDefined();

    // Flat member catalog is unchanged in shape (plus categoryId) and still
    // lists every active destination, requestable or not.
    const flat = await app.inject({
      method: 'GET',
      url: `/api/v1/me/organizations/${schoolA}/destinations`,
      headers: authHeaders(requireStudent()),
    });
    expect(flat.statusCode).toBe(200);
    const flatEntries = flat.json<{
      destinations: { displayName: string; serviceType: string; categoryId: string }[];
    }>().destinations;
    expect(flatEntries.map((d) => d.displayName)).toEqual(
      expect.arrayContaining(['Open Restroom', 'Back Room']),
    );
    for (const entry of flatEntries) {
      expect(typeof entry.categoryId).toBe('string');
      expect(typeof entry.serviceType).toBe('string');
    }
  });

  it('gates student self-service while staff creation stays open', async () => {
    const admin = requireAdmin();
    const student = requireStudent();
    const locationId = await createLocation(schoolA, 'Gate Room');
    const hidden = await createCategory(admin, schoolA, {
      name: 'Gate Hidden',
      studentSurface: 'hidden',
    });
    const hiddenDest = await createDestination(admin, schoolA, locationId, hidden.category.id, {
      displayName: 'Hidden Appt',
    });
    await openDestination(admin, hiddenDest.destination.id);
    // Staff creates directly against the hidden destination.
    const staffCreated = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${student.personId}/passes`,
      headers: authHeaders(admin, randomUUID()),
      payload: { destinationId: hiddenDest.destination.id },
    });
    expect(staffCreated.statusCode).toBe(201);

    // The student cannot self-request the hidden destination.
    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/me/passes',
      headers: authHeaders(student, randomUUID()),
      payload: { destinationId: hiddenDest.destination.id },
    });
    expect(denied.statusCode).toBe(409);
    expect(denied.json<{ code: string }>().code).toBe('destination_unavailable');

    // Nor a destination flagged off for self-service.
    const offCat = await createCategory(admin, schoolA, { name: 'Gate Off' });
    const offDest = await createDestination(admin, schoolA, locationId, offCat.category.id, {
      displayName: 'Off Dest',
      studentSelfRequestable: false,
    });
    const deniedOff = await app.inject({
      method: 'POST',
      url: '/api/v1/me/passes',
      headers: authHeaders(student, randomUUID()),
      payload: { destinationId: offDest.destination.id },
    });
    expect(deniedOff.statusCode).toBe(409);

    // The active pass and scheduled projections carry category metadata.
    const active = await app.inject({
      method: 'GET',
      url: '/api/v1/me/passes/active',
      headers: authHeaders(student),
    });
    expect(active.statusCode).toBe(200);
    const pass = active.json<{ pass: { destination: { category: unknown } } | null }>().pass;
    expect(pass?.destination.category).toMatchObject({ name: 'Gate Hidden' });
  });

  it('conceals the student catalog from students of other schools', async () => {
    const other = await app.inject({
      method: 'GET',
      url: `/api/v1/me/organizations/${schoolB}/student-destination-catalog`,
      headers: authHeaders(requireStudent()),
    });
    expect(other.statusCode).toBe(404);
  });
});
