import path from 'node:path';
import { loadConfig } from '@openhall/config';
import { createDatabase, PostgresReadinessProbe } from '@openhall/db';
import { createApp } from './app.js';

const config = loadConfig();
const databaseHandle = createDatabase(config.databaseUrl);
const app = await createApp({
  config,
  database: databaseHandle.database,
  readinessProbe: new PostgresReadinessProbe(databaseHandle.database),
  webRoot: path.resolve(process.cwd(), 'apps/web/dist'),
});

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'Shutting down OpenHall');
  await app.close();
  await databaseHandle.destroy();
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ host: '0.0.0.0', port: config.port });
} catch (error) {
  app.log.fatal({ err: error }, 'OpenHall failed to start');
  await databaseHandle.destroy();
  process.exitCode = 1;
}
