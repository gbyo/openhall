import { randomUUID } from 'node:crypto';
import type { AppConfig } from '@openhall/config';
import { createDatabase, migrateToLatest } from '@openhall/db';
import type { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';

let databaseName: string;
let administrationUrl: string;
let destroyDatabase: () => Promise<void>;
let app: FastifyInstance;

const config: AppConfig = {
  nodeEnv: 'test',
  appBaseUrl: new URL('http://localhost:3000'),
  databaseUrl: 'postgresql://unused',
  appSecret: 'test-only-app-secret-32-characters!!',
  dataEncryptionKey: new Uint8Array(32).fill(7),
  dataEncryptionKeyId: 'test-key-1',
  trustProxy: false,
  port: 3000,
};

function quotedIdentifier(value: string): string {
  if (!/^[a-z0-9_]+$/.test(value)) throw new Error('Unsafe database identifier');
  return `"${value}"`;
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
  const handle = createDatabase(target.toString(), { max: 2 });
  destroyDatabase = () => handle.destroy();
  await migrateToLatest(handle.database);

  // Limits intentionally enabled here (no rateLimitDisabled hook): this is
  // the one suite that proves abuse resistance end to end.
  app = await createApp({
    config,
    database: handle.database,
    logger: false,
    readinessProbe: { check: () => Promise.resolve({ migration: '003_identity_secure_sessions' }) },
  });
});

afterAll(async () => {
  await app.close();
  await destroyDatabase();
  const client = new Client({ connectionString: administrationUrl });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS ${quotedIdentifier(databaseName)} WITH (FORCE)`);
  await client.end();
});

describe('rate limiting', () => {
  // Schema-valid so the request reaches the handler (and the limiter counts
  // it); the bogus operator token then fails closed with 401.
  const preparePayload = {
    tenantName: 'Greenwood',
    tenantSlug: 'greenwood',
    schoolName: 'Greenwood High',
    schoolSlug: 'greenwood-high',
    schoolTimeZone: 'America/Chicago',
    adminGivenName: 'Ada',
    adminFamilyName: 'Admin',
    adminDisplayName: 'Ada Admin',
    providerKey: 'workspace',
    providerDisplayName: 'Workspace',
    providerIssuer: 'https://provider.example',
    providerClientId: 'test-client',
    providerClientSecret: 'test-client-secret',
    providerAuthMethod: 'client_secret_basic',
    providerScopes: ['openid', 'email'],
  };

  it('answers 429 with a safe problem body once the prepare budget is spent', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/bootstrap/prepare',
        headers: { authorization: 'Bootstrap bogus-token' },
        payload: preparePayload,
      });
      statuses.push(response.statusCode);
      if (attempt === 10) {
        expect(response.statusCode).toBe(429);
        expect(response.json()).toMatchObject({
          code: 'rate_limited',
          status: 429,
          instance: '/api/v1/bootstrap/prepare',
        });
      }
    }
    expect(statuses.slice(0, 10)).toEqual(new Array<number>(10).fill(401));
  });

  it('answers 429 once the recovery budget is spent', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/recovery',
        headers: { authorization: 'Recovery bogus' },
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 10)).toEqual(new Array<number>(10).fill(401));
    expect(statuses[10]).toBe(429);
  });
});
