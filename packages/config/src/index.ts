export type NodeEnvironment = 'development' | 'test' | 'production';

export interface AppConfig {
  readonly nodeEnv: NodeEnvironment;
  readonly appBaseUrl: URL;
  readonly databaseUrl: string;
  readonly appSecret: string;
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

  const trustProxyValue = environment.TRUST_PROXY?.trim() ?? 'false';
  if (trustProxyValue !== 'true' && trustProxyValue !== 'false') {
    issues.push('TRUST_PROXY must be true or false');
  }

  const portValue = environment.PORT?.trim() ?? '3000';
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    issues.push('PORT must be an integer from 1 through 65535');
  }

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  return {
    nodeEnv,
    appBaseUrl,
    databaseUrl,
    appSecret,
    trustProxy: trustProxyValue === 'true',
    port,
  };
}
