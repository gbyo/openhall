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

interface AuditEventBody {
  id: string;
  occurredAt: string;
  action: string;
  actor: { kind: string; accountId: string | null; displayName: string | null };
  target: { kind: string; id: string | null };
  outcome: string;
  requestId: string;
}

async function insertAuditEvent(input: {
  tenantId: string;
  organizationId: string;
  action: string;
  actorKind: string;
  actorId: string | null;
  targetKind: string;
  targetId: string | null;
  occurredAt: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `INSERT INTO audit_event
      (tenant_id, organization_id, action, actor_kind, actor_id, target_kind, target_id,
       outcome, occurred_at, request_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'success', $8, $9, $10)`,
    [
      input.tenantId,
      input.organizationId,
      input.action,
      input.actorKind,
      input.actorId,
      input.targetKind,
      input.targetId,
      input.occurredAt,
      randomUUID(),
      JSON.stringify(input.metadata),
    ],
  );
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
    `INSERT INTO tenant (name, slug) VALUES ('TA', 'aata') RETURNING id`,
  );
  schoolA = await insertReturningId(
    `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'A School', 'aa-school', 'America/New_York') RETURNING id`,
    [tenantA],
  );
  tenantB = await insertReturningId(
    `INSERT INTO tenant (name, slug) VALUES ('TB', 'aatb') RETURNING id`,
  );
  schoolB = await insertReturningId(
    `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'B School', 'ab-school', 'America/New_York') RETURNING id`,
    [tenantB],
  );
  const adminPerson = await makeMember(tenantA, schoolA, 'staff', 'Ada');
  await grantRole(tenantA, adminPerson.accountId, 'school_admin', schoolA);
  adminA = adminPerson;
  const adminBPerson = await makeMember(tenantB, schoolB, 'staff', 'Bob');
  await grantRole(tenantB, adminBPerson.accountId, 'school_admin', schoolB);
  adminB = adminBPerson;
  const counselorPerson = await makeMember(tenantA, schoolA, 'staff', 'Cora');
  await grantRole(tenantA, counselorPerson.accountId, 'counselor', schoolA);
  counselorA = counselorPerson;
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await destroyHandle();
  if (process.env.DATABASE_URL) {
    const base = new URL(process.env.DATABASE_URL);
    base.pathname = '/postgres';
    const client = new Client({ connectionString: base.toString() });
    await client.connect();
    await client.query(`DROP DATABASE IF EXISTS ${quotedIdentifier(databaseName)} WITH (FORCE)`);
    await client.end();
  }
});

describe('school audit feed', () => {
  it('projects committed mutations without metadata', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${schoolA}/locations`,
      headers: { ...authHeaders(requireAdmin()), 'idempotency-key': randomUUID() },
      payload: {
        parentLocationId: null,
        kind: 'classroom',
        name: 'Audit Room',
        code: 'AR1',
        floorLabel: '1F',
      },
    });
    expect(created.statusCode).toBe(201);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/audit-events?limit=10`,
      headers: authHeaders(requireAdmin()),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ events: AuditEventBody[]; nextCursor: string | null }>();
    const entry = body.events.find((event) => event.action === 'location.created');
    expect(entry).toBeDefined();
    expect(entry?.actor.kind).toBe('account');
    expect(entry?.actor.accountId).toBe(requireAdmin().accountId);
    expect(entry?.actor.displayName).toBe('Ada Test');
    expect(entry?.target.kind).toBe('location');
    expect(entry?.outcome).toBe('success');
    // Minimized projection: no metadata key anywhere in the payload.
    expect(response.body).not.toContain('metadata');
    expect(Object.keys(entry ?? {}).sort()).toEqual([
      'action',
      'actor',
      'id',
      'occurredAt',
      'outcome',
      'requestId',
      'target',
    ]);
  });

  it('conceals other schools and denies roles without audit.view', async () => {
    if (adminB === null || counselorA === null) throw new Error('fixtures missing');
    const concealed = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/audit-events`,
      headers: authHeaders(adminB),
    });
    expect(concealed.statusCode).toBe(404);

    const denied = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/audit-events`,
      headers: authHeaders(counselorA),
    });
    expect(denied.statusCode).toBe(403);
  });

  it('paginates stably under equal timestamps', async () => {
    const stamp = new Date().toISOString();
    for (let index = 0; index < 5; index += 1) {
      await insertAuditEvent({
        tenantId: tenantA,
        organizationId: schoolA,
        action: `test.pageable.${String(index)}`,
        actorKind: 'system',
        actorId: null,
        targetKind: 'test_target',
        targetId: null,
        occurredAt: stamp,
        metadata: { marker: `equal-stamp-${String(index)}` },
      });
    }

    const first = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/audit-events?limit=2`,
      headers: authHeaders(requireAdmin()),
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<{ events: AuditEventBody[]; nextCursor: string | null }>();
    // Newest rows sort first; the equal-stamp batch precedes older fixtures.
    expect(firstBody.events.map((event) => event.action)).toEqual([
      'test.pageable.4',
      'test.pageable.3',
    ]);
    expect(firstBody.nextCursor).not.toBeNull();

    const seen: string[] = firstBody.events.map((event) => event.id);
    let cursor: string | null = firstBody.nextCursor;
    while (cursor !== null) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${schoolA}/audit-events?limit=2&cursor=${encodeURIComponent(cursor)}`,
        headers: authHeaders(requireAdmin()),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ events: AuditEventBody[]; nextCursor: string | null }>();
      seen.push(...body.events.map((event) => event.id));
      cursor = body.nextCursor;
    }
    // Five distinct batch rows reachable exactly once across pages.
    expect(new Set(seen).size).toBe(seen.length);
    const batchActions = new Set<string>();
    let scan: string | null = null;
    const actions: string[] = [];
    do {
      const response: Awaited<ReturnType<FastifyInstance['inject']>> = await app.inject({
        method: 'GET',
        url:
          scan === null
            ? `/api/v1/organizations/${schoolA}/audit-events?limit=100`
            : `/api/v1/organizations/${schoolA}/audit-events?limit=100&cursor=${encodeURIComponent(scan)}`,
        headers: authHeaders(requireAdmin()),
      });
      const body = response.json<{ events: AuditEventBody[]; nextCursor: string | null }>();
      for (const event of body.events) {
        actions.push(event.action);
        if (event.action.startsWith('test.pageable.')) batchActions.add(event.action);
      }
      scan = body.nextCursor;
    } while (scan !== null);
    expect(batchActions.size).toBe(5);
    // Metadata markers never leak through pagination either.
    expect(JSON.stringify(actions)).not.toContain('equal-stamp');
  });

  it('rejects invalid cursors and limits', async () => {
    const badCursor = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/audit-events?cursor=not-a-cursor`,
      headers: authHeaders(requireAdmin()),
    });
    expect(badCursor.statusCode).toBe(400);

    const badLimit = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${schoolA}/audit-events?limit=500`,
      headers: authHeaders(requireAdmin()),
    });
    expect(badLimit.statusCode).toBe(400);
  });
});
