import { sql, type Kysely } from 'kysely';
import type { DB as Database } from './database.generated.js';
import { EXPECTED_MIGRATION } from './migrator.js';

export interface ReadinessStatus {
  readonly migration: string;
}

export interface ReadinessProbe {
  check(): Promise<ReadinessStatus>;
}

export class PostgresReadinessProbe implements ReadinessProbe {
  constructor(private readonly database: Kysely<Database>) {}

  async check(): Promise<ReadinessStatus> {
    await sql`select 1`.execute(this.database);
    const result = await sql<{ name: string }>`
      select name from kysely_migration order by timestamp desc, name desc limit 1
    `.execute(this.database);
    const migration = result.rows[0]?.name;
    if (migration !== EXPECTED_MIGRATION) {
      throw new Error('Database migrations are not at the expected version');
    }
    return { migration };
  }
}
