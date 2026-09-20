import { Kysely, PostgresDialect } from 'kysely';
import { Pool, type PoolConfig } from 'pg';
import type { DB as Database } from './database.generated.js';

export interface DatabaseHandle {
  readonly database: Kysely<Database>;
  readonly pool: Pool;
  destroy(): Promise<void>;
}

export function createDatabase(
  databaseUrl: string,
  poolOverrides: PoolConfig = {},
): DatabaseHandle {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...poolOverrides,
  });
  const database = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });

  return {
    database,
    pool,
    async destroy(): Promise<void> {
      await database.destroy();
    },
  };
}
