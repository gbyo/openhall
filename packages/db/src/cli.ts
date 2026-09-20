import { createDatabase } from './database.js';
import { migrateToLatest } from './migrator.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

const handle = createDatabase(databaseUrl, { max: 1 });
try {
  await migrateToLatest(handle.database);
  process.stdout.write('Database migrations are current.\n');
} finally {
  await handle.destroy();
}
