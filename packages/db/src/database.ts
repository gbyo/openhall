import { Kysely, PostgresDialect } from 'kysely';
import { Pool, TypeOverrides, types as defaultTypes, type PoolConfig } from 'pg';
import type { DB as Database } from './database.generated.js';

const TEXTUAL_DATE_TIME_OIDS = [
  1082, // date
  1083, // time without time zone
  1114, // timestamp without time zone
  1184, // timestamp with time zone
  1266, // time with time zone
] as const;

function databaseTypeOverrides(baseTypes: PoolConfig['types']): TypeOverrides {
  const overrides = new TypeOverrides(baseTypes ?? defaultTypes);
  for (const oid of TEXTUAL_DATE_TIME_OIDS) overrides.setTypeParser(oid, (value) => value);
  return overrides;
}

export interface DatabaseHandle {
  readonly database: Kysely<Database>;
  readonly pool: Pool;
  destroy(): Promise<void>;
}

export function createDatabase(
  databaseUrl: string,
  poolOverrides: PoolConfig = {},
): DatabaseHandle {
  const { types, ...remainingOverrides } = poolOverrides;
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Temporal values travel as text; pinning the session zone keeps their
    // rendering deterministic no matter how the server was initialized.
    options: '-c TimeZone=UTC',
    ...remainingOverrides,
    types: databaseTypeOverrides(types),
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
