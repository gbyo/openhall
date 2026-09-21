import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/database.js';
import { migrateToLatest } from '../src/migrator.js';
import { PostgresOutboxListener, type ObservedOutboxEvent } from '../src/outbox-listener.js';
import { PostgresOutboxWriter } from '../src/repositories/outbox-repository.js';
import { PostgresTenantTransactionRunner } from '../src/transactions.js';
import type { DB } from '../src/database.generated.js';
import type { Kysely } from 'kysely';

let databaseName = '';
let databaseUrl = '';
let administrationUrl = '';
let pool: Pool;
let database: Kysely<DB>;
let destroyDatabase: () => Promise<void>;

function quotedIdentifier(value: string): string {
  if (!/^[a-z0-9_]+$/.test(value)) throw new Error('Unsafe database identifier');
  return `"${value}"`;
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => {
        reject(new Error(`Timed out waiting for ${label}`));
      }, 5_000),
    ),
  ]);
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
  databaseUrl = target.toString();
  const handle = createDatabase(databaseUrl, { max: 1 });
  await migrateToLatest(handle.database);
  database = handle.database;
  destroyDatabase = () => handle.destroy();
  pool = new Pool({ connectionString: databaseUrl, max: 4 });
});

afterAll(async () => {
  await pool.end();
  await destroyDatabase();
  const client = new Client({ connectionString: administrationUrl });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS ${quotedIdentifier(databaseName)} WITH (FORCE)`);
  await client.end();
});

describe('PostgresOutboxListener', () => {
  it('delivers one committed wakeup independently to two API-replica listeners', async () => {
    const tenant = (
      await pool.query<{ id: string }>(
        'INSERT INTO tenant (name, slug) VALUES ($1, $2) RETURNING id',
        ['Realtime', `realtime-${randomUUID()}`],
      )
    ).rows[0]?.id;
    if (!tenant) throw new Error('tenant fixture missing');
    const organization = (
      await pool.query<{ id: string }>(
        "INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'Realtime School', $2, 'America/New_York') RETURNING id",
        [tenant, `school-${randomUUID()}`],
      )
    ).rows[0]?.id;
    if (!organization) throw new Error('organization fixture missing');

    const first = new PostgresOutboxListener(databaseUrl);
    const second = new PostgresOutboxListener(databaseUrl);
    await Promise.all([first.start(), second.start()]);
    try {
      let resolveFirst!: (event: ObservedOutboxEvent) => void;
      let resolveSecond!: (event: ObservedOutboxEvent) => void;
      const firstEvent = new Promise<ObservedOutboxEvent>((resolve) => {
        resolveFirst = resolve;
      });
      const secondEvent = new Promise<ObservedOutboxEvent>((resolve) => {
        resolveSecond = resolve;
      });
      first.onEvent(resolveFirst);
      second.onEvent(resolveSecond);

      const aggregateId = randomUUID();
      const studentId = randomUUID();
      const runner = new PostgresTenantTransactionRunner(database);
      const writer = new PostgresOutboxWriter();
      await runner.run(tenant, (context) =>
        writer.append(context, {
          tenantId: tenant,
          organizationId: organization,
          aggregateKind: 'pass',
          aggregateId,
          eventType: 'pass.ready',
          occurredAt: new Date().toISOString(),
          payload: { studentId },
        }),
      );
      const eventId =
        (
          await pool.query<{ id: string }>('SELECT id FROM outbox_event WHERE aggregate_id = $1', [
            aggregateId,
          ])
        ).rows[0]?.id ?? '';

      const [observedFirst, observedSecond] = await Promise.all([
        withTimeout(firstEvent, 'first listener'),
        withTimeout(secondEvent, 'second listener'),
      ]);
      expect(observedFirst.id).toBe(eventId);
      expect(observedSecond.id).toBe(eventId);
      expect(observedFirst.payload).toEqual(observedSecond.payload);
      const row = await pool.query<{ published_at: Date | null }>(
        'SELECT published_at FROM outbox_event WHERE id = $1',
        [eventId],
      );
      expect(row.rows[0]?.published_at).toBeNull();
    } finally {
      await Promise.all([first.stop(), second.stop()]);
    }
  });
});
