export type NodeEnvironment = 'development' | 'test' | 'production';

export interface AppConfig {
  readonly nodeEnv: NodeEnvironment;
  readonly appBaseUrl: URL;
  readonly databaseUrl: string;
  /**
   * Destination-flow reconciler poll interval in milliseconds. The database
   * stays the durable work source; this only sets how often the worker looks
   * for pre-departure expiries and queue promotions.
   */
  readonly destinationFlowPollMs: number;
  readonly appSecret: string;
  /**
   * Long-lived data-encryption key: exactly 256 random bits. Configured as
   * 64 hex characters or base64/base64url encoding 32 bytes. Used only for
   * durable AES-256-GCM secrets (OIDC client secrets, login-transaction
   * secrets). Ephemeral credential digests use APP_SECRET instead.
   */
  readonly dataEncryptionKey: Uint8Array;
  readonly dataEncryptionKeyId: string;
  readonly trustProxy: boolean;
  readonly port: number;
}

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/**
 * Development-only fallback shared by .env.example and compose.yaml. It is
 * published in the repository, so production validation must reject it below.
 */
const DEVELOPMENT_DATA_ENCRYPTION_KEY_HEX =
  'd1891fe393da7c992d51a8f99ec6ee3ea4646b3aa574d3fd1fa37be90725f01d';

const DEVELOPMENT_DATA_ENCRYPTION_KEY_BYTES = (() => {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = Number.parseInt(
      DEVELOPMENT_DATA_ENCRYPTION_KEY_HEX.slice(index * 2, index * 2 + 2),
      16,
    );
  }
  return bytes;
})();

function isDevelopmentKey(bytes: Uint8Array): boolean {
  if (bytes.length !== DEVELOPMENT_DATA_ENCRYPTION_KEY_BYTES.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const actual = bytes[index] ?? 0;
    const expected = DEVELOPMENT_DATA_ENCRYPTION_KEY_BYTES[index] ?? 0;
    difference |= actual ^ expected;
  }
  return difference === 0;
}

/**
 * Parses DATA_ENCRYPTION_KEY as exactly 256 random bits in a documented
 * encoding: 64 hexadecimal characters, or base64/base64url encoding 32 bytes.
 */
function parseDataEncryptionKey(environment: NodeJS.ProcessEnv, issues: string[]): Uint8Array {
  const raw = environment.DATA_ENCRYPTION_KEY?.trim() ?? '';
  if (raw.length === 0) {
    issues.push('DATA_ENCRYPTION_KEY is required');
    return new Uint8Array(32);
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    const bytes = new Uint8Array(32);
    for (let index = 0; index < 32; index += 1) {
      bytes[index] = Number.parseInt(raw.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
  }
  const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  try {
    const decoded = Buffer.from(padded, 'base64');
    if (decoded.length !== 32 || !/^[A-Za-z0-9+/]+={0,2}$/.test(padded)) {
      throw new Error('wrong length');
    }
    return new Uint8Array(decoded);
  } catch {
    issues.push('DATA_ENCRYPTION_KEY must be 64 hex characters or base64 of exactly 32 bytes');
    return new Uint8Array(32);
  }
}

function required(environment: NodeJS.ProcessEnv, key: string, issues: string[]): string {
  const value = environment[key]?.trim();
  if (!value) {
    issues.push(`${key} is required`);
    return '';
  }
  return value;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const issues: string[] = [];
  const nodeEnvValue = required(environment, 'NODE_ENV', issues);
  const nodeEnv: NodeEnvironment =
    nodeEnvValue === 'development' || nodeEnvValue === 'test' || nodeEnvValue === 'production'
      ? nodeEnvValue
      : 'development';
  if (nodeEnvValue && nodeEnv === 'development' && nodeEnvValue !== 'development') {
    issues.push('NODE_ENV must be development, test, or production');
  }

  const appBaseUrlValue = required(environment, 'APP_BASE_URL', issues);
  let appBaseUrl = new URL('http://invalid.local');
  try {
    appBaseUrl = new URL(appBaseUrlValue);
    if (!['http:', 'https:'].includes(appBaseUrl.protocol)) {
      issues.push('APP_BASE_URL must use http or https');
    }
    if (nodeEnv === 'production' && appBaseUrl.protocol !== 'https:') {
      issues.push('APP_BASE_URL must use https in production');
    }
    // Phase 3 builds exact OIDC redirect URIs from this origin, so it must
    // be a bare origin: no credentials, path, query, or fragment. Redirect
    // construction never consults Host/Forwarded headers.
    if (appBaseUrl.username.length > 0 || appBaseUrl.password.length > 0) {
      issues.push('APP_BASE_URL must not include credentials');
    }
    if (appBaseUrl.pathname !== '/' && appBaseUrl.pathname !== '') {
      issues.push('APP_BASE_URL must not include a path');
    }
    if (appBaseUrl.search.length > 0 || appBaseUrl.hash.length > 0) {
      issues.push('APP_BASE_URL must not include a query or fragment');
    }
  } catch {
    issues.push('APP_BASE_URL must be an absolute URL');
  }

  const databaseUrl = required(environment, 'DATABASE_URL', issues);
  try {
    const parsed = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
      issues.push('DATABASE_URL must use the postgres or postgresql scheme');
    }
  } catch {
    issues.push('DATABASE_URL must be a valid PostgreSQL URL');
  }

  const appSecret = required(environment, 'APP_SECRET', issues);
  if (
    nodeEnv === 'production' &&
    (appSecret.length < 32 || /development|change-this|example/i.test(appSecret))
  ) {
    issues.push('APP_SECRET must be a non-example secret of at least 32 characters in production');
  }

  const dataEncryptionKeyId = required(environment, 'DATA_ENCRYPTION_KEY_ID', issues);
  if (
    nodeEnv === 'production' &&
    /development|example|change-this|test/i.test(dataEncryptionKeyId)
  ) {
    issues.push('DATA_ENCRYPTION_KEY_ID must be a production key id in production');
  }
  const dataEncryptionKey = parseDataEncryptionKey(environment, issues);
  if (nodeEnv === 'production' && isDevelopmentKey(dataEncryptionKey)) {
    issues.push('DATA_ENCRYPTION_KEY must be a fresh production key in production');
  }

  const trustProxyValue = environment.TRUST_PROXY?.trim() ?? 'false';
  if (trustProxyValue !== 'true' && trustProxyValue !== 'false') {
    issues.push('TRUST_PROXY must be true or false');
  }

  const portValue = environment.PORT?.trim() ?? '3000';
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    issues.push('PORT must be an integer from 1 through 65535');
  }

  const destinationFlowPollValue = environment.DESTINATION_FLOW_POLL_MS?.trim() ?? '2000';
  const destinationFlowPollMs = Number(destinationFlowPollValue);
  if (
    !Number.isInteger(destinationFlowPollMs) ||
    destinationFlowPollMs < 250 ||
    destinationFlowPollMs > 60_000
  ) {
    issues.push('DESTINATION_FLOW_POLL_MS must be an integer from 250 through 60000');
  }

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  return {
    nodeEnv,
    appBaseUrl,
    databaseUrl,
    destinationFlowPollMs,
    appSecret,
    dataEncryptionKey,
    dataEncryptionKeyId,
    trustProxy: trustProxyValue === 'true',
    port,
  };
}
