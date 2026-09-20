import { Temporal } from '@js-temporal/polyfill';
import type { Clock } from '@openhall/domain';
import type { TenantTransactionContext } from '../persistence.js';
import { AuthenticationError } from './errors.js';
import type { Principal } from './principal.js';
import type {
  AccountRecord,
  AuditWriter,
  CredentialDigester,
  IdentityDirectory,
  PersonRecord,
  SessionCredentialLookup,
  SessionRecord,
  SessionRepository,
  TenantRecord,
} from './ports.js';

/**
 * Centralized session policy. Conservative code-level defaults; kept in one
 * place so they can become configurable later.
 */
export const SESSION_POLICY = {
  /** Idle expiration for normal OIDC web sessions. */
  idleTtlSeconds: 12 * 60 * 60,
  /** Absolute expiration for normal OIDC web sessions. */
  absoluteTtlSeconds: 7 * 24 * 60 * 60,
  /** last_seen_at is only rewritten after this window elapses. */
  touchWindowSeconds: 5 * 60,
  /** Idle expiration for break-glass recovery sessions. */
  recoveryIdleTtlSeconds: 15 * 60,
  /** Absolute expiration for break-glass recovery sessions. */
  recoveryAbsoluteTtlSeconds: 30 * 60,
} as const;

export function sessionExpiry(
  authenticatedAt: Temporal.Instant,
  recovery: boolean,
): { readonly idleExpiresAt: Temporal.Instant; readonly absoluteExpiresAt: Temporal.Instant } {
  const idle = recovery ? SESSION_POLICY.recoveryIdleTtlSeconds : SESSION_POLICY.idleTtlSeconds;
  const absolute = recovery
    ? SESSION_POLICY.recoveryAbsoluteTtlSeconds
    : SESSION_POLICY.absoluteTtlSeconds;
  return {
    idleExpiresAt: authenticatedAt.add({ seconds: idle }),
    absoluteExpiresAt: authenticatedAt.add({ seconds: absolute }),
  };
}

export interface ResolvedSession {
  readonly principal: Principal;
  readonly session: SessionRecord;
  readonly tenant: TenantRecord;
  readonly account: AccountRecord;
  readonly person: PersonRecord;
  /** True when last_seen_at was rewritten during this resolution. */
  readonly touched: boolean;
}

export interface SessionResolutionDependencies {
  readonly lookup: SessionCredentialLookup;
  readonly directory: IdentityDirectory;
  readonly sessions: SessionRepository;
  readonly digester: CredentialDigester;
  readonly clock: Clock;
  readonly runTenantTransaction: (
    tenantId: string,
    operation: (context: TenantTransactionContext) => Promise<ResolvedSession>,
  ) => Promise<ResolvedSession>;
}

/**
 * Resolves an opaque session Bearer [REDACTED] to a trustworthy Principal.
 * Every failure returns a generic unauthenticated error without revealing
 * which check failed. Runs inside one short tenant transaction so the
 * last_seen touch, if due, is atomic with validation reads.
 */
export async function resolveSession(
  rawToken: Uint8Array,
  dependencies: SessionResolutionDependencies,
): Promise<ResolvedSession> {
  const digest = dependencies.digester.digest(rawToken);
  const session = await dependencies.lookup.findByTokenDigest(digest);
  if (session?.revokedAt !== null) {
    throw new AuthenticationError('unauthenticated');
  }
  return dependencies.runTenantTransaction(session.tenantId, async (context) => {
    const now = dependencies.clock.now();
    if (
      Temporal.Instant.compare(now, session.idleExpiresAt) >= 0 ||
      Temporal.Instant.compare(now, session.absoluteExpiresAt) >= 0
    ) {
      throw new AuthenticationError('unauthenticated');
    }
    const tenant = await dependencies.directory.findTenant(context, session.tenantId);
    const account = await dependencies.directory.findAccount(context, session.accountId);
    if (tenant === undefined || account === undefined) {
      throw new AuthenticationError('unauthenticated');
    }
    const person = await dependencies.directory.findPerson(context, account.personId);
    if (person === undefined) {
      throw new AuthenticationError('unauthenticated');
    }
    if (
      tenant.status !== 'active' ||
      account.status !== 'active' ||
      person.status !== 'active' ||
      session.accountSessionRevision !== account.sessionRevision
    ) {
      throw new AuthenticationError('unauthenticated');
    }
    let touched = false;
    const nextTouchDue = session.lastSeenAt.add({ seconds: SESSION_POLICY.touchWindowSeconds });
    if (Temporal.Instant.compare(now, nextTouchDue) >= 0) {
      await dependencies.sessions.touchLastSeen(context, session.id, now);
      touched = true;
    }
    return {
      principal: {
        tenantId: session.tenantId,
        accountId: session.accountId,
        personId: account.personId,
        sessionRevision: session.accountSessionRevision,
        authenticationMethod: session.authenticationMethod,
      },
      session,
      tenant,
      account,
      person,
      touched,
    };
  });
}

export interface LogoutDependencies {
  readonly sessions: SessionRepository;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

export async function logoutSession(
  context: TenantTransactionContext,
  session: SessionRecord,
  requestId: string,
  dependencies: LogoutDependencies,
): Promise<void> {
  const now = dependencies.clock.now();
  await dependencies.sessions.revokeSession(context, session.id, 'logout', now);
  await dependencies.audit.append(context, {
    action: 'auth.logout',
    actorKind: 'account',
    actorId: session.accountId,
    targetKind: 'auth_session',
    targetId: session.id,
    outcome: 'success',
    occurredAt: now,
    requestId,
  });
}

export async function logoutAllSessions(
  context: TenantTransactionContext,
  session: SessionRecord,
  requestId: string,
  dependencies: LogoutDependencies & { readonly directory: IdentityDirectory },
): Promise<void> {
  const now = dependencies.clock.now();
  await dependencies.directory.incrementSessionRevision(context, session.accountId);
  await dependencies.sessions.revokeAllForAccount(context, session.accountId, 'logout-all', now);
  await dependencies.audit.append(context, {
    action: 'auth.logout_all',
    actorKind: 'account',
    actorId: session.accountId,
    targetKind: 'account',
    targetId: session.accountId,
    outcome: 'success',
    occurredAt: now,
    requestId,
  });
}
