import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '@openhall/config';
import { createDatabase } from '@openhall/db';
import { createApp } from '../src/app.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const outputPath = path.join(repositoryRoot, 'openapi/openapi.json');
const config: AppConfig = {
  nodeEnv: 'test',
  appBaseUrl: new URL('http://localhost:3000'),
  databaseUrl: 'postgresql://unused',
  appSecret: 'unused-in-openapi-generation',
  dataEncryptionKey: new Uint8Array(32).fill(7),
  dataEncryptionKeyId: 'test-key-1',
  trustProxy: false,
  port: 3000,
};
const database = createDatabase('postgresql://unused:5432/unused');
const app = await createApp({
  config,
  database: database.database,
  logger: false,
  readinessProbe: { check: () => Promise.resolve({ migration: '001_foundation' }) },
});
await app.ready();
const rendered = `${JSON.stringify(app.swagger(), null, 2)}\n`;
await app.close();
await database.destroy();

if (process.argv.includes('--check')) {
  const committed = await readFile(outputPath, 'utf8');
  if (committed !== rendered) {
    throw new Error('Generated OpenAPI document differs; run pnpm openapi:generate');
  }
} else {
  await writeFile(outputPath, rendered, 'utf8');
}
