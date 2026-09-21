import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from './database.js';
import { demoSeedSql } from './demo.js';
import { migrateToLatest } from './migrator.js';

let databaseName: string;
let pool: Pool;
let destroyHandle: () => Promise<void>;

function quotedIdentifier(value: string): string {
  if (!/^[a-z0-9_]+$/.test(value)) throw new Error('Unsafe database identifier');
  return `"${value}"`;
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
  pool = new Pool({ connectionString: databaseUrl, max: 4 });
  await pool.query(demoSeedSql);
});

afterAll(async () => {
  await pool.end();
  await destroyHandle();
});

/**
 * Fresh `pnpm demo` data must satisfy the production invariants the runtime
 * depends on: the seeded student appointment is live immediately, and no
 * seeded policy evaluation collides with its pass's current revision (which
 * previously sent the destination-flow reconciler into a duplicate-key
 * error loop on every tick).
 */
describe('demo seed invariants', () => {
  it('presents the seeded student appointment inside a live window', async () => {
    const { rows } = await pool.query<{
      id: string;
      status: string;
      live: boolean;
    }>(
      `SELECT id, status,
        (status = 'active' AND valid_from <= now() AND valid_until > now()) AS live
       FROM scheduled_authorization
       WHERE id = '10000000-0000-4000-8000-000000000901'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('active');
    expect(rows[0]?.live).toBe(true);
  });

  it('keeps reconciler-scoped passes free of current-revision evaluations', async () => {
    // The destination-flow reconciler reevaluates queued/ready passes at
    // their current revision without bumping first, so a seeded evaluation
    // at that same revision fails every tick with
    // `policy_evaluation_one_per_pass_revision`. Requested passes are out of
    // reconciler scope and legitimately carry their request evaluation.
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM policy_evaluation pe
       JOIN pass p ON p.tenant_id = pe.tenant_id AND p.id = pe.pass_id
       WHERE p.lifecycle_state IN ('queued', 'ready')
         AND pe.pass_revision >= p.revision`,
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('seeds policy rule configurations the engine parser accepts', async () => {
    // Malformed rule configurations fail closed (deny with
    // policy_configuration_error), which previously denied every demo pass
    // request including the student scheduled start.
    const { rows } = await pool.query<{ id: string; rule_type: string; keys: string[] }>(
      `SELECT id::text AS id, rule_type,
        (SELECT array_agg(key) FROM jsonb_object_keys(configuration) AS key) AS keys
       FROM policy_rule`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.keys).toContain('schemaVersion');
      expect(row.keys).toContain('requestSources');
      if (row.rule_type === 'schedule_boundary') {
        expect(row.keys).toEqual(
          expect.arrayContaining(['firstMinutes', 'lastMinutes', 'blockKinds']),
        );
      } else if (row.rule_type === 'approval_requirement') {
        expect(row.keys).toContain('approver');
        expect(row.keys).not.toContain('requiredApprover');
      }
    }
  });

  it('uses only engine-emitted decisions in seeded evaluations', async () => {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM policy_evaluation
       WHERE decision NOT IN ('allow', 'deny', 'approval_required', 'override_required')`,
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('leaves room for the reconciler promotion-time evaluation', async () => {
    const queued = await pool.query<{ tenant_id: string; id: string; revision: string }>(
      `SELECT tenant_id, id, revision::text AS revision FROM pass
       WHERE id = '10000000-0000-4000-8000-000000001003'`,
    );
    expect(queued.rows).toHaveLength(1);
    const pass = queued.rows[0];
    if (pass === undefined) throw new Error('Seeded queued pass is missing');
    // A promotion-time reevaluation for the pass's current revision must not
    // collide with a pre-existing row, or every reconciler tick fails with
    // `policy_evaluation_one_per_pass_revision`.
    await pool.query('BEGIN');
    try {
      await pool.query(
        `INSERT INTO policy_evaluation
          (tenant_id, pass_id, pass_revision, stage, decision, evaluated_at, context_snapshot)
         VALUES ($1, $2, $3, 'reevaluation', 'allow', now(), '{}')`,
        [pass.tenant_id, pass.id, pass.revision],
      );
    } finally {
      await pool.query('ROLLBACK');
    }
  });
});
