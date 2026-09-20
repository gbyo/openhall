import { SystemClock } from '@openhall/domain';
import {
  PostgresAuditWriter,
  PostgresBootstrapFinalizer,
  PostgresBootstrapRepository,
  PostgresIdentityDirectory,
  PostgresOidcTransactionStore,
  PostgresOperatorGrantStore,
  PostgresRecoveryEligibilityChecker,
  PostgresSessionCredentialLookup,
  PostgresSessionRepository,
  PostgresSystemTransactionRunner,
  PostgresTenantDirectory,
  PostgresTenantTransactionRunner,
  type DatabaseHandle,
} from '@openhall/db';
import type { AppConfig } from '@openhall/config';
import type { Kysely } from 'kysely';
import type { DB as Database } from '@openhall/db';
import {
  Aes256GcmSecretProtector,
  HmacCredentialDigester,
  NodeSecureRandom,
  NodeSha256Hasher,
} from './crypto.js';
import { OpenIdClientAdapter } from './oidc-adapter.js';

/** Exact OIDC callback path derived from APP_BASE_URL, never from headers. */
export function oidcCallbackUrl(config: AppConfig): string {
  return `${config.appBaseUrl.origin}/api/v1/auth/oidc/callback`;
}

export interface AuthDependencies {
  readonly tenants: PostgresTenantDirectory;
  readonly directory: PostgresIdentityDirectory;
  readonly sessions: PostgresSessionRepository;
  readonly lookup: PostgresSessionCredentialLookup;
  readonly transactions: PostgresOidcTransactionStore;
  readonly grants: PostgresOperatorGrantStore;
  readonly drafts: PostgresBootstrapRepository;
  readonly audit: PostgresAuditWriter;
  readonly checker: PostgresRecoveryEligibilityChecker;
  readonly finalizer: PostgresBootstrapFinalizer;
  readonly adapter: OpenIdClientAdapter;
  readonly random: NodeSecureRandom;
  readonly digester: HmacCredentialDigester;
  readonly hasher: NodeSha256Hasher;
  readonly protector: Aes256GcmSecretProtector;
  readonly clock: SystemClock;
  readonly tenantRunner: PostgresTenantTransactionRunner;
  readonly systemRunner: PostgresSystemTransactionRunner;
  readonly redirectUri: string;
  readonly allowInsecureHttp: boolean;
  readonly isProduction: boolean;
  /** Bare origin of APP_BASE_URL; the only accepted request origin. */
  readonly origin: string;
}

/**
 * Composition root for authentication. Database handles are lazy: building
 * this bundle never connects, so OpenAPI generation and unit tests can
 * construct the full app without a live database.
 */
export function createAuthDependencies(
  config: AppConfig,
  database: Kysely<Database>,
): AuthDependencies {
  const random = new NodeSecureRandom();
  const digester = new HmacCredentialDigester(config.appSecret);
  const hasher = new NodeSha256Hasher();
  const protector = new Aes256GcmSecretProtector(
    config.dataEncryptionKey,
    config.dataEncryptionKeyId,
  );
  const clock = new SystemClock();
  const redirectUri = oidcCallbackUrl(config);
  return {
    tenants: new PostgresTenantDirectory(database),
    directory: new PostgresIdentityDirectory(),
    sessions: new PostgresSessionRepository(),
    lookup: new PostgresSessionCredentialLookup(database),
    transactions: new PostgresOidcTransactionStore(database),
    grants: new PostgresOperatorGrantStore(database),
    drafts: new PostgresBootstrapRepository(),
    audit: new PostgresAuditWriter(),
    checker: new PostgresRecoveryEligibilityChecker(),
    finalizer: new PostgresBootstrapFinalizer(protector),
    adapter: new OpenIdClientAdapter(),
    random,
    digester,
    hasher,
    protector,
    clock,
    tenantRunner: new PostgresTenantTransactionRunner(database),
    systemRunner: new PostgresSystemTransactionRunner(database),
    redirectUri,
    allowInsecureHttp: config.nodeEnv !== 'production',
    isProduction: config.nodeEnv === 'production',
    origin: config.appBaseUrl.origin,
  };
}

export type { DatabaseHandle };
