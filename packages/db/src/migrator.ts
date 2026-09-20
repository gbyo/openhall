import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Kysely } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';

export const EXPECTED_MIGRATION = '001_foundation';

export function createMigrator<Database>(database: Kysely<Database>) {
  return new Migrator({
    db: database,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: fileURLToPath(new URL('./migrations', import.meta.url)),
    }),
  });
}

export async function migrateToLatest<Database>(database: Kysely<Database>): Promise<void> {
  const result = await createMigrator(database).migrateToLatest();
  if (result.error) {
    throw result.error instanceof Error ? result.error : new Error('Database migration failed');
  }
}
