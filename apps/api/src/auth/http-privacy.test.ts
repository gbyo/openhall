import { describe, expect, it } from 'vitest';
import type { AppConfig } from '@openhall/config';
import { createDatabase } from '@openhall/db';
import { Writable } from 'node:stream';
import { createApp } from '../app.js';
import { safeRequestPath, scrubForLog } from '../http-privacy.js';

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

describe('safeRequestPath', () => {
  it('strips query strings and fragments', () => {
    expect(safeRequestPath('/api/v1/auth/oidc/callback?code=abc&state=xyz')).toBe(
      '/api/v1/auth/oidc/callback',
    );
    expect(safeRequestPath('/health/live#frag')).toBe('/health/live');
    expect(safeRequestPath('/')).toBe('/');
    expect(safeRequestPath(undefined)).toBe('/');
    expect(safeRequestPath('')).toBe('/');
  });
});

describe('scrubForLog', () => {
  it('redacts protocol secret fragments', () => {
    expect(scrubForLog('callback code=SUPER_SECRET&state=abc')).toBe(
      'callback code=[REDACTED]&state=[REDACTED]',
    );
    expect(scrubForLog('plain message')).toBe('plain message');
  });
});

describe('query-safe HTTP privacy', () => {
  it('keeps Problem Details instance to the pathname only', async () => {
    const database = createDatabase('postgresql://unused:5432/unused');
    const app = await createApp({
      config,
      database: database.database,
      logger: false,
      readinessProbe: {
        check: () => Promise.resolve({ migration: '003_identity_secure_sessions' }),
      },
    });
    const response = await app.inject({
      method: 'GET',
      url: '/no-such-route?code=SUPER_SECRET_CODE&state=SUPER_SECRET_STATE',
    });
    expect(response.statusCode).toBe(404);
    const body = response.json<{ instance?: string }>();
    expect(body.instance).toBe('/no-such-route');
    expect(response.body).not.toContain('SUPER_SECRET_CODE');
    expect(response.body).not.toContain('SUPER_SECRET_STATE');
    await app.close();
    await database.destroy();
  });

  it('never logs query strings, tokens, or headers', async () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const database = createDatabase('postgresql://unused:5432/unused');
    const app = await createApp({
      config,
      database: database.database,
      loggerStream: stream,
      readinessProbe: {
        check: () => Promise.resolve({ migration: '003_identity_secure_sessions' }),
      },
    });
    await app.inject({
      method: 'GET',
      url: '/api/v1/auth/oidc/callback?code=SUPER_SECRET_CODE&state=SUPER_SECRET_STATE',
      headers: {
        authorization: 'Bootstrap SUPER_SECRET_SESSION',
        cookie: 'openhall_session_dev=SUPER_SECRET_SESSION; openhall_login_dev=SUPER_SECRET_STATE',
        'x-csrf-token': 'SUPER_SECRET_CSRF',
      },
    });
    await app.close();
    await database.destroy();
    const logs = chunks.join('\n');
    // The request must have been logged; otherwise absence proves nothing.
    expect(logs).toContain('/api/v1/auth/oidc/callback');
    for (const secret of [
      'SUPER_SECRET_CODE',
      'SUPER_SECRET_STATE',
      'SUPER_SECRET_SESSION',
      'SUPER_SECRET_CSRF',
    ]) {
      expect(logs).not.toContain(secret);
    }
    // The request line itself must not carry the raw query string.
    expect(logs).not.toContain('code=');
  });
});
