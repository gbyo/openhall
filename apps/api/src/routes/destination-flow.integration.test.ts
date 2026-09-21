import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { DestinationFlowReconciler, ExpectedPlacementResolver } from '@openhall/application';
import type { AppConfig } from '@openhall/config';
import {
  PostgresDestinationFlowRepository,
  PostgresExpectedPlacementRepository,
  PostgresOutboxWriter,
  PostgresPassRepository,
  PostgresPolicyRepository,
  PostgresTenantTransactionRunner,
  createDatabase,
} from '@openhall/db';
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
let reconciler: DestinationFlowReconciler;
/**
 * Fake worker clock: real time plus an adjustable offset. A frozen instant
 * anchored in beforeAll would predate every HTTP-stamped row and violate the
 * released_at >= reserved_at / entered_at coherence checks, so the clock
 * tracks the live clock and time travel happens through the offset.
 */
let clockOffsetMs = 0;

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

let tenantA = '';
let schoolA = '';
let sectionA1 = '';

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

async function passEvents(passId: string): Promise<string[]> {
  const result = await pool.query<{ event_type: string }>(
    `SELECT event_type FROM pass_event WHERE pass_id = $1 ORDER BY sequence`,
    [passId],
  );
  return result.rows.map((row) => row.event_type);
}

async function passLifecycle(passId: string): Promise<{ state: string; revision: string }> {
  const row = (
    await pool.query<{ lifecycle_state: string; revision: string }>(
      `SELECT lifecycle_state, revision FROM pass WHERE id = $1`,
      [passId],
    )
  ).rows[0];
  if (row === undefined) throw new Error('Pass row missing');
  return { state: row.lifecycle_state, revision: row.revision };
}

async function evaluationCount(passId: string): Promise<number> {
  const row = (
    await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM policy_evaluation WHERE pass_id = $1`,
      [passId],
    )
  ).rows[0];
  return Number(row?.count ?? '0');
}

function requiredEtag(response: { headers: Record<string, unknown> }): string {
  const etag = response.headers.etag;
  if (typeof etag !== 'string') throw new Error('Expected ETag response header');
  return etag;
}

interface PassBody {
  id: string;
  lifecycleState: string;
  revision: string;
  movement: {
    readyUntil: string | null;
    queueEnteredAt: string | null;
    queueExpiresAt: string | null;
    expectedReturnAt: string | null;
    reasonCode: string | null;
  };
}

async function makeDestination(input: {
  capacity?: number | null;
  queueEnabled?: boolean;
}): Promise<string> {
  const locationId = await insertReturningId(
    `INSERT INTO location (tenant_id, organization_id, kind, name) VALUES ($1, $2, 'classroom', $3) RETURNING id`,
    [tenantA, schoolA, `Room ${randomUUID().slice(0, 8)}`],
  );
  return insertReturningId(
    `INSERT INTO destination
       (tenant_id, organization_id, location_id, service_type, display_name, capacity, queue_enabled, check_in_mode)
     VALUES ($1, $2, $3, 'office', $4, $5, $6, 'optional') RETURNING id`,
    [
      tenantA,
      schoolA,
      locationId,
      `Dest ${randomUUID().slice(0, 8)}`,
      input.capacity ?? null,
      input.queueEnabled ?? false,
    ],
  );
}

async function requestPass(
  student: SessionFixture,
  destinationId: string,
): Promise<{ pass: PassBody; etag: string; status: number }> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/me/passes',
    headers: authHeaders(student, randomUUID()),
    payload: { destinationId },
  });
  if (created.statusCode !== 201)
    return { pass: null as never, etag: '', status: created.statusCode };
  return {
    pass: created.json<{ pass: PassBody }>().pass,
    etag: requiredEtag(created),
    status: 201,
  };
}

async function clearFlowRules(): Promise<void> {
  await pool.query(`DELETE FROM pass_override`);
  await pool.query(`DELETE FROM pass_approval`);
  await pool.query(`DELETE FROM queue_entry`);
  await pool.query(`DELETE FROM destination_reservation`);
  await pool.query(`DELETE FROM policy_evaluation_result`);
  await pool.query(`DELETE FROM policy_evaluation`);
  await pool.query(`DELETE FROM policy_rule`);
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

async function seedRule(input: {
  name: string;
  ruleType: string;
  configuration: unknown;
  overrideMode: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO policy_rule (tenant_id, organization_id, name, rule_type, scope_kind, scope_organization_id, configuration, override_mode)
     VALUES ($1, $2, $3, $4, 'organization', $2, $5, $6)`,
    [
      tenantA,
      schoolA,
      input.name,
      input.ruleType,
      JSON.stringify(input.configuration),
      input.overrideMode,
    ],
  );
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
    destinationFlowWorkerEnabled: false,
    readinessProbe: {
      check: () => Promise.resolve({ migration: '007_destination_flow_and_movement' }),
    },
  });

  // The reconciler under test uses a controllable clock; HTTP paths use the
  // real system clock. Time travel happens through SQL aging plus the clock
  // offset below.
  clockOffsetMs = 0;
  const runner = new PostgresTenantTransactionRunner(handle.database);
  reconciler = new DestinationFlowReconciler({
    clock: { now: () => Temporal.Now.instant().add({ milliseconds: clockOffsetMs }) },
    runner,
    passes: new PostgresPassRepository(),
    flow: new PostgresDestinationFlowRepository(handle.database),
    policy: new PostgresPolicyRepository(),
    placement: new ExpectedPlacementResolver(
      new PostgresExpectedPlacementRepository(handle.database),
    ),
    outbox: new PostgresOutboxWriter(),
  });

  tenantA = await insertReturningId(
    `INSERT INTO tenant (name, slug) VALUES ('TA', 'ta') RETURNING id`,
  );
  schoolA = await insertReturningId(
    `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'A School', 'a-school', 'America/New_York') RETURNING id`,
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
  const locationA = await insertReturningId(
    `INSERT INTO location (tenant_id, organization_id, kind, name) VALUES ($1, $2, 'classroom', 'Room 214') RETURNING id`,
    [tenantA, schoolA],
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

describe('allocator capacity and queueing', () => {
  it('fills exactly one slot under 20 concurrent requests', async () => {
    await clearFlowRules();
    const destinationId = await makeDestination({ capacity: 1, queueEnabled: true });
    const students = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        makeStudent(tenantA, schoolA, `Crowd${String(index)}`),
      ),
    );
    const results = await Promise.all(
      students.map((student) => requestPass(student, destinationId)),
    );
    expect(results.every((result) => result.status === 201)).toBe(true);
    const states = results.map((result) => result.pass.lifecycleState);
    expect(states.filter((state) => state === 'ready')).toHaveLength(1);
    expect(states.filter((state) => state === 'queued')).toHaveLength(19);
    const consuming = (
      await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM destination_reservation
         WHERE destination_id = $1 AND released_at IS NULL
           AND (claimed_at IS NOT NULL OR ready_expires_at > statement_timestamp())`,
        [destinationId],
      )
    ).rows[0];
    expect(Number(consuming?.count)).toBeLessThanOrEqual(1);
    // Flow deadlines never exceed the configured queue timeout.
    const deadlines = (
      await pool.query<{ flow_expires_at: Date; entered_at: Date }>(
        `SELECT flow_expires_at, entered_at FROM queue_entry WHERE destination_id = $1`,
        [destinationId],
      )
    ).rows;
    expect(deadlines).toHaveLength(19);
    for (const row of deadlines) {
      const span = row.flow_expires_at.getTime() - row.entered_at.getTime();
      expect(span).toBeGreaterThan(0);
      expect(span).toBeLessThanOrEqual(600_000);
    }
  });

  it('denies with destination_capacity_full when full without a queue', async () => {
    await clearFlowRules();
    const destinationId = await makeDestination({ capacity: 1, queueEnabled: false });
    const first = await makeStudent(tenantA, schoolA, 'NoQueueFirst');
    const created = await requestPass(first, destinationId);
    expect(created.pass.lifecycleState).toBe('ready');
    const second = await makeStudent(tenantA, schoolA, 'NoQueueSecond');
    const denied = await requestPass(second, destinationId);
    expect(denied.pass.lifecycleState).toBe('denied');
    expect(denied.pass.movement.reasonCode).toBe('destination_capacity_full');
    expect(await passEvents(denied.pass.id)).toEqual(['pass.requested', 'pass.denied']);
  });
});

describe('reconciler expiry', () => {
  it('expires a queued attempt past its flow deadline', async () => {
    await clearFlowRules();
    const destinationId = await makeDestination({ capacity: 1, queueEnabled: true });
    const holder = await makeStudent(tenantA, schoolA, 'ExpiryHolder');
    await requestPass(holder, destinationId);
    const waiter = await makeStudent(tenantA, schoolA, 'ExpiryWaiter');
    const queued = await requestPass(waiter, destinationId);
    expect(queued.pass.lifecycleState).toBe('queued');
    // Age the whole attempt past its deadline, preserving coherence.
    await pool.query(
      `UPDATE queue_entry
       SET entered_at = statement_timestamp() - interval '700 seconds',
           flow_expires_at = statement_timestamp() - interval '100 seconds'
       WHERE pass_id = $1`,
      [queued.pass.id],
    );
    expect(await reconciler.runOne()).toBe(true);
    expect((await passLifecycle(queued.pass.id)).state).toBe('expired');
    expect(await passEvents(queued.pass.id)).toEqual([
      'pass.requested',
      'pass.queued',
      'pass.expired',
    ]);
    const entry = (
      await pool.query<{ release_reason: string | null }>(
        `SELECT release_reason FROM queue_entry WHERE pass_id = $1`,
        [queued.pass.id],
      )
    ).rows[0];
    expect(entry?.release_reason).toBe('expired');
    const metadata = (
      await pool.query<{ metadata: unknown }>(
        `SELECT metadata FROM pass_event WHERE pass_id = $1 AND event_type = 'pass.expired'`,
        [queued.pass.id],
      )
    ).rows[0]?.metadata as { reasonCode?: string };
    expect(metadata.reasonCode).toBe('queue_timeout');
  });

  it('expires a missed ready offer when nobody waits', async () => {
    await clearFlowRules();
    const destinationId = await makeDestination({ capacity: 1, queueEnabled: true });
    const student = await makeStudent(tenantA, schoolA, 'MissedReady');
    const ready = await requestPass(student, destinationId);
    await pool.query(
      `UPDATE destination_reservation
       SET reserved_at = statement_timestamp() - interval '120 seconds',
           ready_expires_at = statement_timestamp() - interval '60 seconds'
       WHERE pass_id = $1`,
      [ready.pass.id],
    );
    expect(await reconciler.runOne()).toBe(true);
    expect((await passLifecycle(ready.pass.id)).state).toBe('expired');
    const reservation = (
      await pool.query<{ release_reason: string | null }>(
        `SELECT release_reason FROM destination_reservation WHERE pass_id = $1`,
        [ready.pass.id],
      )
    ).rows[0];
    expect(reservation?.release_reason).toBe('ready_claim_expired');
  });

  it('requeues a missed ready offer behind the waiter with the same deadline', async () => {
    await clearFlowRules();
    const destinationId = await makeDestination({ capacity: 1, queueEnabled: true });
    const holder = await makeStudent(tenantA, schoolA, 'RequeueHolder');
    const ready = await requestPass(holder, destinationId);
    const waiter = await makeStudent(tenantA, schoolA, 'RequeueWaiter');
    const queued = await requestPass(waiter, destinationId);
    expect(queued.pass.lifecycleState).toBe('queued');
    const originalFlow = (
      await pool.query<{ flow_expires_at: Date }>(
        `SELECT flow_expires_at FROM destination_reservation WHERE pass_id = $1`,
        [ready.pass.id],
      )
    ).rows[0]?.flow_expires_at;
    await pool.query(
      `UPDATE destination_reservation
       SET reserved_at = statement_timestamp() - interval '120 seconds',
           ready_expires_at = statement_timestamp() - interval '60 seconds'
       WHERE pass_id = $1`,
      [ready.pass.id],
    );
    expect(await reconciler.runOne()).toBe(true);
    expect((await passLifecycle(ready.pass.id)).state).toBe('queued');
    expect(await passEvents(ready.pass.id)).toEqual([
      'pass.requested',
      'pass.ready',
      'pass.queued',
    ]);
    const requeued = (
      await pool.query<{ flow_expires_at: Date; entered_at: Date; policy_evaluation_id: string }>(
        `SELECT flow_expires_at, entered_at, policy_evaluation_id FROM queue_entry
         WHERE pass_id = $1 AND released_at IS NULL`,
        [ready.pass.id],
      )
    ).rows[0];
    // The original flow deadline is preserved, not reset.
    expect(requeued?.flow_expires_at.getTime()).toBe(originalFlow?.getTime());
    const metadata = (
      await pool.query<{ metadata: unknown }>(
        `SELECT metadata FROM pass_event WHERE pass_id = $1 AND event_type = 'pass.queued' ORDER BY sequence DESC LIMIT 1`,
        [ready.pass.id],
      )
    ).rows[0]?.metadata as { reasonCode?: string };
    expect(metadata.reasonCode).toBe('ready_claim_expired');
  });
});

describe('reconciler promotion', () => {
  it('promotes the head in FIFO order when capacity frees', async () => {
    await clearFlowRules();
    const destinationId = await makeDestination({ capacity: 1, queueEnabled: true });
    const holder = await makeStudent(tenantA, schoolA, 'PromoteHolder');
    const held = await requestPass(holder, destinationId);
    const second = await makeStudent(tenantA, schoolA, 'PromoteSecond');
    const queuedSecond = await requestPass(second, destinationId);
    const third = await makeStudent(tenantA, schoolA, 'PromoteThird');
    const queuedThird = await requestPass(third, destinationId);
    expect(queuedSecond.pass.lifecycleState).toBe('queued');
    expect(queuedThird.pass.lifecycleState).toBe('queued');

    // Holder cancels: capacity frees but nobody is promoted inside cancel.
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${held.pass.id}/cancel`,
      headers: authHeaders(holder, randomUUID(), held.etag),
    });
    expect(cancel.statusCode).toBe(200);
    expect((await passLifecycle(queuedSecond.pass.id)).state).toBe('queued');

    expect(await reconciler.runBatch(5)).toBeGreaterThanOrEqual(1);
    expect((await passLifecycle(queuedSecond.pass.id)).state).toBe('ready');
    expect((await passLifecycle(queuedThird.pass.id)).state).toBe('queued');
    // The new reservation binds the fresh promotion evaluation, not the
    // stale queue-time one.
    expect(await evaluationCount(queuedSecond.pass.id)).toBe(2);
    const queueTimeEvaluation = (
      await pool.query<{ policy_evaluation_id: string }>(
        `SELECT policy_evaluation_id FROM queue_entry WHERE pass_id = $1`,
        [queuedSecond.pass.id],
      )
    ).rows[0]?.policy_evaluation_id;
    const binding = (
      await pool.query<{ policy_evaluation_id: string; pass_revision: number }>(
        `SELECT r.policy_evaluation_id, e.pass_revision
         FROM destination_reservation r
         JOIN policy_evaluation e ON e.id = r.policy_evaluation_id
         WHERE r.pass_id = $1 AND r.released_at IS NULL`,
        [queuedSecond.pass.id],
      )
    ).rows[0];
    const revision = Number((await passLifecycle(queuedSecond.pass.id)).revision);
    expect(Number(binding?.pass_revision)).toBe(revision - 1);
    expect(binding?.policy_evaluation_id).toBeDefined();
    expect(binding?.policy_evaluation_id).not.toBe(queueTimeEvaluation);
    expect(await passEvents(queuedSecond.pass.id)).toEqual([
      'pass.requested',
      'pass.queued',
      'pass.ready',
    ]);
  });

  it('moves past a cancelled head without leapfrogging a live one', async () => {
    await clearFlowRules();
    const destinationId = await makeDestination({ capacity: 1, queueEnabled: true });
    const holder = await makeStudent(tenantA, schoolA, 'SkipHolder');
    const held = await requestPass(holder, destinationId);
    const second = await makeStudent(tenantA, schoolA, 'SkipSecond');
    const queuedSecond = await requestPass(second, destinationId);
    const third = await makeStudent(tenantA, schoolA, 'SkipThird');
    const queuedThird = await requestPass(third, destinationId);
    // The head cancels itself; the next head promotes after capacity frees.
    const cancelHead = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${queuedSecond.pass.id}/cancel`,
      headers: authHeaders(second, randomUUID(), queuedSecond.etag),
    });
    expect(cancelHead.statusCode).toBe(200);
    const cancelHolder = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${held.pass.id}/cancel`,
      headers: authHeaders(holder, randomUUID(), held.etag),
    });
    expect(cancelHolder.statusCode).toBe(200);
    await reconciler.runBatch(5);
    expect((await passLifecycle(queuedThird.pass.id)).state).toBe('ready');
  });

  it('re-evaluates fresh policy at promotion and denies on new blackouts', async () => {
    await clearFlowRules();
    const destinationId = await makeDestination({ capacity: 1, queueEnabled: true });
    const holder = await makeStudent(tenantA, schoolA, 'PolicyHolder');
    const held = await requestPass(holder, destinationId);
    const waiter = await makeStudent(tenantA, schoolA, 'PolicyWaiter');
    const queued = await requestPass(waiter, destinationId);
    expect(queued.pass.lifecycleState).toBe('queued');
    // Policy changes while queued: a nonoverrideable blackout now applies.
    await seedRule({
      name: 'late blackout',
      ruleType: 'schedule_boundary',
      configuration: BLACKOUT_OVERLAP,
      overrideMode: 'never',
    });
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${held.pass.id}/cancel`,
      headers: authHeaders(holder, randomUUID(), held.etag),
    });
    expect(cancel.statusCode).toBe(200);
    await reconciler.runBatch(5);
    expect((await passLifecycle(queued.pass.id)).state).toBe('denied');
    expect(await evaluationCount(queued.pass.id)).toBe(2);
    const entry = (
      await pool.query<{ release_reason: string | null }>(
        `SELECT release_reason FROM queue_entry WHERE pass_id = $1`,
        [queued.pass.id],
      )
    ).rows[0];
    expect(entry?.release_reason).toBe('pass_terminal');
  });

  it('returns the pass to requested with readiness revoked when approval is needed', async () => {
    await clearFlowRules();
    const destinationId = await makeDestination({ capacity: 1, queueEnabled: true });
    const holder = await makeStudent(tenantA, schoolA, 'ApprovalHolder');
    const held = await requestPass(holder, destinationId);
    const waiter = await makeStudent(tenantA, schoolA, 'ApprovalWaiter');
    await pool.query(
      `INSERT INTO section_membership (tenant_id, section_id, person_id, role) VALUES ($1, $2, $3, 'student')`,
      [tenantA, sectionA1, waiter.personId],
    );
    const queued = await requestPass(waiter, destinationId);
    expect(queued.pass.lifecycleState).toBe('queued');
    await seedRule({
      name: 'late approval',
      ruleType: 'approval_requirement',
      configuration: APPROVAL_CONFIG,
      overrideMode: 'never',
    });
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${held.pass.id}/cancel`,
      headers: authHeaders(holder, randomUUID(), held.etag),
    });
    expect(cancel.statusCode).toBe(200);
    await reconciler.runBatch(5);
    expect((await passLifecycle(queued.pass.id)).state).toBe('requested');
    expect(await passEvents(queued.pass.id)).toContain('pass.readiness_revoked');
    const pending = (
      await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM pass_approval WHERE pass_id = $1 AND decision = 'pending'`,
        [queued.pass.id],
      )
    ).rows[0];
    expect(Number(pending?.count)).toBe(1);
  });

  it('terminalizes queued and ready flows when the destination closes', async () => {
    await clearFlowRules();
    const destinationId = await makeDestination({ capacity: 1, queueEnabled: true });
    const holder = await makeStudent(tenantA, schoolA, 'CloseHolder');
    const held = await requestPass(holder, destinationId);
    const waiter = await makeStudent(tenantA, schoolA, 'CloseWaiter');
    const queued = await requestPass(waiter, destinationId);
    await pool.query(`UPDATE destination SET status = 'closed' WHERE id = $1`, [destinationId]);
    await reconciler.runBatch(10);
    expect((await passLifecycle(held.pass.id)).state).toBe('denied');
    expect((await passLifecycle(queued.pass.id)).state).toBe('denied');
    const reasons = (
      await pool.query<{ metadata: unknown }>(
        `SELECT metadata FROM pass_event WHERE event_type = 'pass.denied' AND pass_id = ANY($1)`,
        [[held.pass.id, queued.pass.id]],
      )
    ).rows.map((row) => (row.metadata as { reasonCode?: string }).reasonCode);
    expect(reasons).toEqual(['destination_unavailable', 'destination_unavailable']);
  });

  it('never duplicates a policy evaluation for the same pass revision', async () => {
    await clearFlowRules();
    const destinationId = await makeDestination({ capacity: 1, queueEnabled: true });
    const holder = await makeStudent(tenantA, schoolA, 'EvalHolder');
    const held = await requestPass(holder, destinationId);
    const waiter = await makeStudent(tenantA, schoolA, 'EvalWaiter');
    const queued = await requestPass(waiter, destinationId);
    const before = await evaluationCount(queued.pass.id);
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${held.pass.id}/cancel`,
      headers: authHeaders(holder, randomUUID(), held.etag),
    });
    expect(cancel.statusCode).toBe(200);
    const [first, second] = await Promise.all([reconciler.runBatch(5), reconciler.runBatch(5)]);
    // Exactly one promotion happened across both workers.
    expect(first + second).toBeGreaterThanOrEqual(1);
    expect((await passLifecycle(queued.pass.id)).state).toBe('ready');
    expect(await evaluationCount(queued.pass.id)).toBe(before + 1);
    // Exactly one reservation, one lifecycle event per transition, and one
    // outbox fact per transition: no worker duplicated anything.
    expect(await passEvents(queued.pass.id)).toEqual([
      'pass.requested',
      'pass.queued',
      'pass.ready',
    ]);
    const activeReservations = (
      await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM destination_reservation
         WHERE pass_id = $1 AND released_at IS NULL`,
        [queued.pass.id],
      )
    ).rows[0];
    expect(Number(activeReservations?.count)).toBe(1);
    const outboxFacts = (
      await pool.query<{ event_type: string }>(
        `SELECT event_type FROM outbox_event
         WHERE aggregate_kind = 'pass' AND aggregate_id = $1
         ORDER BY occurred_at, id`,
        [queued.pass.id],
      )
    ).rows.map((row) => row.event_type);
    expect(outboxFacts).toEqual([
      'pass.requested',
      'pass.policy_evaluated',
      'pass.queued',
      'pass.policy_evaluated',
      'pass.ready',
    ]);
    // Idle ticks persist nothing further.
    await reconciler.runBatch(5);
    expect(await evaluationCount(queued.pass.id)).toBe(before + 1);
  });

  it('prefers expiry over promotion for a stale head with free capacity', async () => {
    await clearFlowRules();
    const destinationId = await makeDestination({ capacity: 1, queueEnabled: true });
    const holder = await makeStudent(tenantA, schoolA, 'StaleHeadHolder');
    const held = await requestPass(holder, destinationId);
    const waiter = await makeStudent(tenantA, schoolA, 'StaleHeadWaiter');
    const queued = await requestPass(waiter, destinationId);
    await pool.query(
      `UPDATE queue_entry
       SET entered_at = statement_timestamp() - interval '700 seconds',
           flow_expires_at = statement_timestamp() - interval '100 seconds'
       WHERE pass_id = $1`,
      [queued.pass.id],
    );
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${held.pass.id}/cancel`,
      headers: authHeaders(holder, randomUUID(), held.etag),
    });
    expect(cancel.statusCode).toBe(200);
    await reconciler.runBatch(5);
    expect((await passLifecycle(queued.pass.id)).state).toBe('expired');
  });
});

describe('reconciler safety and races', () => {
  it('leaves outbound movement alone even far past every deadline', async () => {
    await clearFlowRules();
    const destinationId = await makeDestination({ capacity: 1, queueEnabled: true });
    const student = await makeStudent(tenantA, schoolA, 'LongGone');
    const ready = await requestPass(student, destinationId);
    const departed = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${ready.pass.id}/depart`,
      headers: authHeaders(student, randomUUID(), ready.etag),
    });
    expect(departed.statusCode).toBe(200);
    clockOffsetMs += 6 * 3_600_000;
    try {
      expect(await reconciler.runBatch(10)).toBe(0);
      const state = await passLifecycle(ready.pass.id);
      expect(state.state).toBe('outbound');
      const reservation = (
        await pool.query<{ claimed_at: Date | null; released_at: Date | null }>(
          `SELECT claimed_at, released_at FROM destination_reservation WHERE pass_id = $1`,
          [ready.pass.id],
        )
      ).rows[0];
      expect(reservation?.claimed_at).not.toBeNull();
      expect(reservation?.released_at).toBeNull();
    } finally {
      clockOffsetMs = 0;
    }
  });

  it('orders depart-then-expire and expire-then-depart deterministically', async () => {
    await clearFlowRules();
    const destinationId = await makeDestination({ capacity: 1, queueEnabled: true });
    const early = await makeStudent(tenantA, schoolA, 'DepartFirst');
    const readyEarly = await requestPass(early, destinationId);
    await pool.query(
      `UPDATE destination_reservation
       SET reserved_at = statement_timestamp() - interval '120 seconds',
           ready_expires_at = statement_timestamp() - interval '60 seconds'
       WHERE pass_id = $1`,
      [readyEarly.pass.id],
    );
    const depart = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${readyEarly.pass.id}/depart`,
      headers: authHeaders(early, randomUUID(), readyEarly.etag),
    });
    expect(depart.statusCode).toBe(409);
    expect(depart.json<{ code: string }>().code).toBe('ready_offer_expired');
    expect(await reconciler.runOne()).toBe(true);
    expect((await passLifecycle(readyEarly.pass.id)).state).toBe('expired');

    const late = await makeStudent(tenantA, schoolA, 'ExpireFirst');
    const readyLate = await requestPass(late, destinationId);
    await pool.query(
      `UPDATE destination_reservation
       SET reserved_at = statement_timestamp() - interval '120 seconds',
           ready_expires_at = statement_timestamp() - interval '60 seconds'
       WHERE pass_id = $1`,
      [readyLate.pass.id],
    );
    expect(await reconciler.runOne()).toBe(true);
    expect((await passLifecycle(readyLate.pass.id)).state).toBe('expired');
    const staleDepart = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${readyLate.pass.id}/depart`,
      headers: authHeaders(late, randomUUID(), readyLate.etag),
    });
    expect(staleDepart.statusCode).toBe(412);
  });

  it('releases stranded flow rows on terminal passes without touching state', async () => {
    await clearFlowRules();
    const destinationId = await makeDestination({ capacity: 1, queueEnabled: true });
    const student = await makeStudent(tenantA, schoolA, 'Stranded');
    const ready = await requestPass(student, destinationId);
    // Simulate a stranded row: terminal pass with an active reservation.
    await pool.query(`UPDATE pass SET lifecycle_state = 'denied' WHERE id = $1`, [ready.pass.id]);
    expect(await reconciler.runOne()).toBe(true);
    const reservation = (
      await pool.query<{ release_reason: string | null }>(
        `SELECT release_reason FROM destination_reservation WHERE pass_id = $1`,
        [ready.pass.id],
      )
    ).rows[0];
    expect(reservation?.release_reason).toBe('pass_terminal');
    expect((await passLifecycle(ready.pass.id)).state).toBe('denied');
  });
});

describe('reconciler fairness chain', () => {
  async function activeFlowDeadline(passId: string): Promise<string> {
    const row = (
      await pool.query<{ flow_expires_at: Date }>(
        `SELECT flow_expires_at FROM queue_entry WHERE pass_id = $1 AND released_at IS NULL`,
        [passId],
      )
    ).rows[0];
    if (row === undefined) throw new Error('Active queue entry missing');
    return row.flow_expires_at.toISOString();
  }

  async function ageReadyOffer(passId: string): Promise<void> {
    await pool.query(
      `UPDATE destination_reservation
       SET reserved_at = statement_timestamp() - interval '120 seconds',
           ready_expires_at = statement_timestamp() - interval '60 seconds'
       WHERE pass_id = $1`,
      [passId],
    );
  }

  async function queueStatusPosition(
    session: { cookie: string; csrf: string },
    passId: string,
  ): Promise<number> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/me/passes/${passId}/queue-status`,
      headers: authHeaders(session),
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ position: number }>().position;
  }

  it('promotes A then B then C with missed claims requeued behind', async () => {
    await clearFlowRules();
    const destinationId = await makeDestination({ capacity: 1, queueEnabled: true });
    const holder = await makeStudent(tenantA, schoolA, 'ChainHolder');
    const held = await requestPass(holder, destinationId);
    const studentA = await makeStudent(tenantA, schoolA, 'ChainA');
    const queuedA = await requestPass(studentA, destinationId);
    const studentB = await makeStudent(tenantA, schoolA, 'ChainB');
    const queuedB = await requestPass(studentB, destinationId);
    const studentC = await makeStudent(tenantA, schoolA, 'ChainC');
    const queuedC = await requestPass(studentC, destinationId);
    expect(queuedA.pass.lifecycleState).toBe('queued');
    expect(queuedB.pass.lifecycleState).toBe('queued');
    expect(queuedC.pass.lifecycleState).toBe('queued');
    const originalDeadlineA = await activeFlowDeadline(queuedA.pass.id);
    const originalDeadlineB = await activeFlowDeadline(queuedB.pass.id);

    // Capacity frees: the head promotes first.
    const cancelHolder = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${held.pass.id}/cancel`,
      headers: authHeaders(holder, randomUUID(), held.etag),
    });
    expect(cancelHolder.statusCode).toBe(200);
    expect(await reconciler.runBatch(5)).toBe(1);
    expect((await passLifecycle(queuedA.pass.id)).state).toBe('ready');
    expect((await passLifecycle(queuedB.pass.id)).state).toBe('queued');
    expect((await passLifecycle(queuedC.pass.id)).state).toBe('queued');

    // A misses the claim while B and C wait: A goes behind C, B promotes.
    await ageReadyOffer(queuedA.pass.id);
    expect(await reconciler.runOne()).toBe(true);
    expect((await passLifecycle(queuedA.pass.id)).state).toBe('queued');
    expect(await activeFlowDeadline(queuedA.pass.id)).toBe(originalDeadlineA);
    expect(await reconciler.runBatch(5)).toBe(1);
    expect((await passLifecycle(queuedB.pass.id)).state).toBe('ready');
    expect((await passLifecycle(queuedC.pass.id)).state).toBe('queued');

    // B misses too: C promotes next, B lands behind A with its deadline kept.
    await ageReadyOffer(queuedB.pass.id);
    expect(await reconciler.runOne()).toBe(true);
    expect((await passLifecycle(queuedB.pass.id)).state).toBe('queued');
    expect(await reconciler.runBatch(5)).toBe(1);
    expect((await passLifecycle(queuedC.pass.id)).state).toBe('ready');
    // The promotion binds the fresh evaluation, never the queue-time one.
    const queueEvalC = (
      await pool.query<{ policy_evaluation_id: string }>(
        `SELECT policy_evaluation_id FROM queue_entry WHERE pass_id = $1`,
        [queuedC.pass.id],
      )
    ).rows[0]?.policy_evaluation_id;
    const reservationC = (
      await pool.query<{ policy_evaluation_id: string }>(
        `SELECT policy_evaluation_id FROM destination_reservation
         WHERE pass_id = $1 AND released_at IS NULL`,
        [queuedC.pass.id],
      )
    ).rows[0]?.policy_evaluation_id;
    expect(reservationC).toBeDefined();
    expect(reservationC).not.toBe(queueEvalC);

    // Final order behind the ready offer: A ahead of B.
    expect(await queueStatusPosition(studentA, queuedA.pass.id)).toBe(1);
    expect(await queueStatusPosition(studentB, queuedB.pass.id)).toBe(2);
    expect(await activeFlowDeadline(queuedB.pass.id)).toBe(originalDeadlineB);
  });
});

describe('allocator unlimited capacity', () => {
  it('grants ready to every policy-cleared pass without queue rows', async () => {
    await clearFlowRules();
    const destinationId = await makeDestination({ capacity: null, queueEnabled: true });
    const students = await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        makeStudent(tenantA, schoolA, `Open${String(index)}`),
      ),
    );
    const results = await Promise.all(
      students.map((student) => requestPass(student, destinationId)),
    );
    expect(results.every((result) => result.pass.lifecycleState === 'ready')).toBe(true);
    // A reservation still exists for ready-lease and movement provenance.
    const reservations = (
      await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM destination_reservation
         WHERE destination_id = $1 AND released_at IS NULL`,
        [destinationId],
      )
    ).rows[0];
    expect(Number(reservations?.count)).toBe(3);
    const queued = (
      await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM queue_entry WHERE destination_id = $1`,
        [destinationId],
      )
    ).rows[0];
    expect(Number(queued?.count)).toBe(0);
  });
});

describe('reconciler active-movement immunity', () => {
  it('leaves arrived and returning movement alone past every deadline', async () => {
    await clearFlowRules();
    const destinationId = await makeDestination({ capacity: 1, queueEnabled: true });
    const first = await makeStudent(tenantA, schoolA, 'FarAlongFirst');
    const readyFirst = await requestPass(first, destinationId);
    const departed = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${readyFirst.pass.id}/depart`,
      headers: authHeaders(first, randomUUID(), readyFirst.etag),
    });
    expect(departed.statusCode).toBe(200);
    const arrived = await app.inject({
      method: 'POST',
      url: `/api/v1/me/passes/${readyFirst.pass.id}/arrive`,
      headers: authHeaders(first, randomUUID(), requiredEtag(departed)),
    });
    expect(arrived.statusCode).toBe(200);
    expect((await passLifecycle(readyFirst.pass.id)).state).toBe('at_destination');

    // A second student queues behind the claimed capacity.
    const second = await makeStudent(tenantA, schoolA, 'FarAlongSecond');
    const queuedSecond = await requestPass(second, destinationId);
    expect(queuedSecond.pass.lifecycleState).toBe('queued');

    // Six hours later the waiter expires, but the arrived pass is untouched
    // and still consumes its claimed capacity.
    clockOffsetMs += 6 * 3_600_000;
    try {
      expect(await reconciler.runBatch(10)).toBe(1);
      expect((await passLifecycle(readyFirst.pass.id)).state).toBe('at_destination');
      expect((await passLifecycle(queuedSecond.pass.id)).state).toBe('expired');
      const held = (
        await pool.query<{ claimed_at: Date | null; released_at: Date | null }>(
          `SELECT claimed_at, released_at FROM destination_reservation WHERE pass_id = $1`,
          [readyFirst.pass.id],
        )
      ).rows[0];
      expect(held?.claimed_at).not.toBeNull();
      expect(held?.released_at).toBeNull();

      // The return trip is equally immune; its release is explicit, not timed.
      const returning = await app.inject({
        method: 'POST',
        url: `/api/v1/me/passes/${readyFirst.pass.id}/return`,
        headers: authHeaders(first, randomUUID(), requiredEtag(arrived)),
      });
      expect(returning.statusCode).toBe(200);
      expect(await reconciler.runBatch(10)).toBe(0);
      expect((await passLifecycle(readyFirst.pass.id)).state).toBe('returning');
      const released = (
        await pool.query<{ released_at: Date | null; release_reason: string | null }>(
          `SELECT released_at, release_reason FROM destination_reservation WHERE pass_id = $1`,
          [readyFirst.pass.id],
        )
      ).rows[0];
      expect(released?.released_at).not.toBeNull();
      expect(released?.release_reason).toBe('return_started');
    } finally {
      clockOffsetMs = 0;
    }
  });
});
