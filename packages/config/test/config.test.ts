import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/index.js';

const validEnvironment = {
  NODE_ENV: 'production',
  APP_BASE_URL: 'https://openhall.example.edu',
  DATABASE_URL: 'postgresql://openhall:secret@db/openhall',
  APP_SECRET: 'a-secure-production-secret-that-is-long-enough',
  DATA_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  DATA_ENCRYPTION_KEY_ID: 'prod-key-1',
  TRUST_PROXY: 'false',
  PORT: '3000',
};

describe('loadConfig', () => {
  it('returns a typed configuration', () => {
    const config = loadConfig(validEnvironment);
    expect(config.nodeEnv).toBe('production');
    expect(config.port).toBe(3000);
    expect(config.trustProxy).toBe(false);
  });

  it('rejects weak production secrets and insecure base URLs', () => {
    expect(() =>
      loadConfig({ ...validEnvironment, APP_SECRET: 'short', APP_BASE_URL: 'http://example.edu' }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({
        ...validEnvironment,
        APP_SECRET: 'development-only-change-this-secret-32-characters',
      }),
    ).toThrow(/non-example secret/);
  });

  it('does not silently invent required settings', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL is required/);
  });

  it('requires a bare-origin APP_BASE_URL for exact redirect construction', () => {
    expect(() =>
      loadConfig({ ...validEnvironment, APP_BASE_URL: 'https://openhall.example.edu/app' }),
    ).toThrow(/must not include a path/);
    expect(() =>
      loadConfig({ ...validEnvironment, APP_BASE_URL: 'https://user@example.edu' }),
    ).toThrow(/must not include credentials/);
    expect(() =>
      loadConfig({ ...validEnvironment, APP_BASE_URL: 'https://example.edu/?next=/x' }),
    ).toThrow(/must not include a query or fragment/);
  });

  it('requires exactly 256 bits of data-encryption key material', () => {
    const key = loadConfig(validEnvironment).dataEncryptionKey;
    expect(key.length).toBe(32);
    expect(() => loadConfig({ ...validEnvironment, DATA_ENCRYPTION_KEY: 'short' })).toThrow(
      /DATA_ENCRYPTION_KEY/,
    );
    expect(() =>
      loadConfig({
        ...validEnvironment,
        DATA_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdeg',
      }),
    ).toThrow(/DATA_ENCRYPTION_KEY/);
    const base64 = loadConfig({
      ...validEnvironment,
      DATA_ENCRYPTION_KEY: Buffer.from(validEnvironment.DATA_ENCRYPTION_KEY, 'hex').toString(
        'base64url',
      ),
    }).dataEncryptionKey;
    expect(base64.length).toBe(32);
    expect(() => loadConfig({ ...validEnvironment, DATA_ENCRYPTION_KEY_ID: '' })).toThrow(
      /DATA_ENCRYPTION_KEY_ID is required/,
    );
  });
});
