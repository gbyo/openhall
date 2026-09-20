import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/index.js';

const validEnvironment = {
  NODE_ENV: 'production',
  APP_BASE_URL: 'https://openhall.example.edu',
  DATABASE_URL: 'postgresql://openhall:secret@db/openhall',
  APP_SECRET: 'a-secure-production-secret-that-is-long-enough',
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
});
