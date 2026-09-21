import { describe, expect, it } from 'vitest';
import type { AppConfig } from '@openhall/config';
import { createDatabase } from '@openhall/db';
import { createApp } from './app.js';

const config: AppConfig = {
  nodeEnv: 'test',
  appBaseUrl: new URL('http://localhost:3000'),
  databaseUrl: 'postgresql://unused',
  appSecret: 'test-secret',
  dataEncryptionKey: new Uint8Array(32).fill(7),
  dataEncryptionKeyId: 'test-key-1',
  trustProxy: false,
  port: 3000,
};

describe('foundation HTTP API', () => {
  it('reports liveness and readiness without exposing configuration', async () => {
    const database = createDatabase('postgresql://unused:5432/unused');
    const app = await createApp({
      config,
      database: database.database,
      logger: false,
      readinessProbe: { check: () => Promise.resolve({ migration: '001_foundation' }) },
    });

    const live = await app.inject({ method: 'GET', url: '/health/live' });
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    const info = await app.inject({ method: 'GET', url: '/api/v1/system/info' });

    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: 'ok' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({
      status: 'ready',
      database: 'ready',
      migration: '001_foundation',
    });
    expect(info.json()).toEqual({
      name: 'OpenHall',
      version: '0.1.0',
      apiVersion: 'v1',
      status: 'foundation',
    });
    expect(info.body).not.toContain('databaseUrl');
    expect(info.body).not.toContain('appSecret');
    await app.close();
    await database.destroy();
  });

  it('returns RFC 9457-style Problem Details when the database is unavailable', async () => {
    const database = createDatabase('postgresql://unused:5432/unused');
    const app = await createApp({
      config,
      database: database.database,
      logger: false,
      readinessProbe: { check: () => Promise.reject(new Error('connection refused')) },
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ status: 503, code: 'not_ready' });
    expect(response.body).not.toContain('connection refused');
    await app.close();
    await database.destroy();
  });

  it('generates OpenAPI 3.1 from the registered route schemas', async () => {
    const database = createDatabase('postgresql://unused:5432/unused');
    const app = await createApp({
      config,
      database: database.database,
      logger: false,
      readinessProbe: { check: () => Promise.resolve({ migration: '001_foundation' }) },
    });
    await app.ready();
    const document = app.swagger();

    expect(document).toMatchObject({
      openapi: '3.1.0',
      paths: {
        '/health/live': { get: { operationId: 'getLiveness' } },
        '/api/v1/system/info': { get: { operationId: 'getSystemInfo' } },
      },
    });

    const openapi = document as unknown as {
      components?: {
        schemas?: Record<string, unknown>;
      };
      paths: Record<
        string,
        {
          get?: {
            responses?: Record<
              string,
              {
                content?: Record<
                  string,
                  {
                    schema?: Record<string, unknown>;
                  }
                >;
              }
            >;
          };
        }
      >;
    };
    const schemas = openapi.components?.schemas;
    expect(schemas).toBeDefined();
    for (const schemaName of [
      'ProblemDetails',
      'Liveness',
      'Readiness',
      'SystemInfo',
      'Me',
      'MyOrganizationContext',
      'Pass',
    ]) {
      expect(schemas).toHaveProperty(schemaName);
    }
    expect(
      openapi.paths['/health/live']?.get?.responses?.['200']?.content?.['application/json']?.schema,
    ).toEqual({ $ref: '#/components/schemas/Liveness' });
    expect(
      openapi.paths['/health/ready']?.get?.responses?.['503']?.content?.['application/problem+json']
        ?.schema,
    ).toEqual({ $ref: '#/components/schemas/ProblemDetails' });

    await app.close();
    await database.destroy();
  });

  it('documents cookie AND CSRF in one requirement for protected mutations', async () => {
    const database = createDatabase('postgresql://unused:5432/unused');
    const app = await createApp({
      config,
      database: database.database,
      logger: false,
      readinessProbe: { check: () => Promise.resolve({ migration: '001_foundation' }) },
    });
    await app.ready();
    const document = app.swagger() as unknown as {
      paths: Record<string, Record<string, { security?: Record<string, string[]>[] }>>;
    };
    for (const path of ['/api/v1/auth/logout', '/api/v1/auth/logout-all']) {
      const security = document.paths[path]?.post?.security;
      expect(security).toBeDefined();
      // One requirement object must demand both schemes (AND). Separate
      // objects would document OR.
      expect(
        security?.some((requirement) => 'cookieAuth' in requirement && 'csrfHeader' in requirement),
      ).toBe(true);
    }
    await app.close();
    await database.destroy();
  });

  it('documents /auth/session as anonymously callable while /me requires cookie auth', async () => {
    const database = createDatabase('postgresql://unused:5432/unused');
    const app = await createApp({
      config,
      database: database.database,
      logger: false,
      readinessProbe: { check: () => Promise.resolve({ migration: '001_foundation' }) },
    });
    await app.ready();
    const document = app.swagger() as unknown as {
      paths: Record<string, Record<string, { security?: Record<string, string[]>[] }>>;
    };
    const sessionSecurity = document.paths['/api/v1/auth/session']?.get?.security;
    expect(sessionSecurity).toBeDefined();
    expect(sessionSecurity?.some((requirement) => Object.keys(requirement).length === 0)).toBe(
      true,
    );
    expect(sessionSecurity?.some((requirement) => 'cookieAuth' in requirement)).toBe(true);
    const meSecurity = document.paths['/api/v1/me']?.get?.security;
    expect(meSecurity).toEqual([{ cookieAuth: [] }]);
    await app.close();
    await database.destroy();
  });
});
