import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '@openhall/config';
import type { DB } from '@openhall/db';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from './app.js';

const config: AppConfig = {
  nodeEnv: 'test',
  appBaseUrl: new URL('http://localhost:3000'),
  databaseUrl: 'postgresql://unused',
  destinationFlowPollMs: 2_000,
  appSecret: 'test-only-app-secret-32-characters!!',
  dataEncryptionKey: new Uint8Array(32).fill(7),
  dataEncryptionKeyId: 'test-key-1',
  trustProxy: false,
  port: 3000,
};

let app: FastifyInstance;
let webRoot: string;

beforeAll(async () => {
  webRoot = await mkdtemp(join(tmpdir(), 'openhall-spa-'));
  await writeFile(
    join(webRoot, 'index.html'),
    '<!doctype html><title>WayPass</title><div id="root"></div>',
  );
  await writeFile(join(webRoot, 'app.js'), 'console.log("waypass")');
  app = await createApp({
    config,
    database: {} as Kysely<DB>,
    logger: false,
    rateLimitDisabled: true,
    webRoot,
    readinessProbe: { check: () => Promise.resolve({ migration: '008_school_control_plane' }) },
  });
});

afterAll(async () => {
  await app.close();
  await rm(webRoot, { recursive: true, force: true });
});

describe('SPA history fallback', () => {
  it('serves the app shell for an extensionless HTML deep link', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/schools/school-id/admin/destinations/destination-id',
      headers: { accept: 'text/html' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('<title>WayPass</title>');
  });

  it('keeps unknown API paths as JSON Problem Details', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/does-not-exist',
      headers: { accept: 'text/html' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ code: 'not_found' });
  });

  it('does not turn a missing asset into the SPA', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/missing.js',
      headers: { accept: 'text/html' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
  });
});
