import { Temporal } from '@js-temporal/polyfill';
import type { Clock } from '@openhall/domain';
import type { AuditWriter } from '../auditing/audit.js';
import type { Principal } from '../authentication/principal.js';
import type {
  CredentialDigester,
  IdentityDirectory,
  SecureRandomSource,
} from '../authentication/ports.js';
import type { RelationshipAuthorizationService } from '../authorization/service.js';
import type { IdempotencyTransactionStore } from '../idempotency/coordinator.js';
import type {
  OutboxWriter,
  TenantTransactionContext,
  TenantTransactionRunner,
} from '../persistence.js';
import { toBase64Url } from '../authentication/validation.js';
import { ControlPlaneError } from './errors.js';
import { etagForResource, parseResourceIfMatch } from './etags.js';
import {
  controlPlaneLockKey,
  fingerprintControlPlane,
  requireControlPlaneIdempotencyKey,
  runControlPlaneCommand,
} from './idempotency.js';
import type { EnrollmentRecord, EnrollmentRepository } from './ports.js';
import { requireNormalSession, requireOrganizationCapability, schoolDateFor } from './shared.js';

export interface EnrollmentDependencies {
  readonly clock: Clock;
  readonly runner: TenantTransactionRunner;
  readonly authorization: RelationshipAuthorizationService;
  readonly enrollments: EnrollmentRepository;
  readonly directory: IdentityDirectory;
  readonly random: SecureRandomSource;
  readonly digester: CredentialDigester;
  readonly idempotency: IdempotencyTransactionStore;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
}

/** One-time invitations live for 24 hours. */
export const ENROLLMENT_GRANT_TTL_HOURS = 24;

export interface EnrollmentView {
  readonly id: string;
  readonly organizationId: string;
  readonly personId: string;
  readonly accountId: string;
  readonly identityProviderId: string;
  readonly status: 'active' | 'consumed' | 'revoked' | 'expired';
  readonly expiresAt: string;
  readonly revision: string;
  readonly createdByAccountId: string | null;
  readonly createdAt: string;
  readonly consumedAt: string | null;
  readonly revokedAt: string | null;
  readonly revokedByAccountId: string | null;
}

export function enrollmentStatus(
  row: EnrollmentRecord,
  now: Temporal.Instant,
): EnrollmentView['status'] {
  if (row.consumedAt !== null) return 'consumed';
  if (row.revokedAt !== null) return 'revoked';
  if (Temporal.Instant.compare(row.expiresAt, now) <= 0) return 'expired';
  return 'active';
}

export function toEnrollmentView(row: EnrollmentRecord, now: Temporal.Instant): EnrollmentView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    personId: row.personId,
    accountId: row.accountId,
    identityProviderId: row.identityProviderId,
    status: enrollmentStatus(row, now),
    expiresAt: row.expiresAt.toString(),
    revision: row.revision.toString(10),
    createdByAccountId: row.createdByAccountId,
    createdAt: row.createdAt.toString(),
    consumedAt: row.consumedAt === null ? null : row.consumedAt.toString(),
    revokedAt: row.revokedAt === null ? null : row.revokedAt.toString(),
    revokedByAccountId: row.revokedByAccountId,
  };
}

export function etagForEnrollment(enrollmentId: string, revision: bigint): string {
  return etagForResource('identity-enrollment', enrollmentId, revision);
}

export interface EnrollmentCommandInput {
  readonly principal: Principal;
  readonly idempotencyKey: unknown;
  readonly requestId: string;
}

export interface IssueEnrollmentInput extends EnrollmentCommandInput {
  readonly organizationId: string;
  readonly personId: string;
  readonly providerKey: unknown;
}

export interface RevokeEnrollmentInput extends EnrollmentCommandInput {
  readonly enrollmentId: string;
  readonly ifMatch: unknown;
}

export interface IssuedEnrollment {
  readonly enrollment: EnrollmentView;
  readonly enrollmentToken: string;
  readonly provider: { readonly key: string; readonly displayName: string };
  readonly etag: string;
  readonly status: 201;
  readonly replayed: boolean;
}

export interface EnrollmentResult {
  readonly enrollment: EnrollmentView;
  readonly etag: string;
  readonly status: 200 | 201;
  readonly replayed: boolean;
}

export interface ActiveEnrollmentStatus {
  readonly id: string;
  readonly organizationId: string;
  readonly personId: string;
  readonly status: 'active';
  readonly expiresAt: string;
  readonly revision: string;
}

/**
 * GET /organizations/:id/people/:personId/enrollment — narrow active
 * invitation status. Raw token, digest, provider internals, account/session
 * data, and historical invitations never cross this boundary.
 */
export async function getIdentityEnrollmentStatus(
  principal: Principal,
  organizationId: string,
  personId: string,
  dependencies: EnrollmentDependencies,
): Promise<{ readonly enrollment: ActiveEnrollmentStatus | null; readonly etag?: string }> {
  requireNormalSession(principal);
  const now = dependencies.clock.now();
  return dependencies.runner.run(principal.tenantId, async (context) => {
    await requireOrganizationCapability(
      context,
      dependencies.authorization,
      principal,
      'identity.enroll',
      organizationId,
      now,
      'identity_enrollment_not_found',
    );
    const row = await dependencies.enrollments.loadActiveGrantForPerson(
      context,
      organizationId,
      personId,
      now,
    );
    if (row === null) return { enrollment: null };
    return {
      enrollment: {
        id: row.id,
        organizationId: row.organizationId,
        personId: row.personId,
        status: 'active',
        expiresAt: row.expiresAt.toString(),
        revision: row.revision.toString(10),
      },
      etag: etagForEnrollment(row.id, row.revision),
    };
  });
}

async function appendEnrollmentAudit(
  dependencies: EnrollmentDependencies,
  context: TenantTransactionContext,
  principal: Principal,
  row: EnrollmentRecord,
  action: string,
  requestId: string,
  now: Temporal.Instant,
): Promise<void> {
  // The raw token is never logged, audited, or placed on the outbox.
  await dependencies.audit.append(context, {
    action,
    actorKind: 'account',
    actorId: principal.accountId,
    organizationId: row.organizationId,
    targetKind: 'identity_enrollment_grant',
    targetId: row.id,
    outcome: 'success',
    occurredAt: now,
    requestId,
    metadata: {
      identityEnrollmentGrantId: row.id,
      personId: row.personId,
      accountId: row.accountId,
      revision: row.revision.toString(10),
      requestId,
    },
  });
}

async function appendEnrollmentOutbox(
  dependencies: EnrollmentDependencies,
  context: TenantTransactionContext,
  row: EnrollmentRecord,
  eventType: string,
  now: Temporal.Instant,
): Promise<void> {
  await dependencies.outbox.append(context, {
    tenantId: row.tenantId,
    organizationId: row.organizationId,
    aggregateKind: 'identity_enrollment_grant',
    aggregateId: row.id,
    eventType,
    occurredAt: now.toString(),
    payload: {
      schemaVersion: 1,
      organizationId: row.organizationId,
      identityEnrollmentGrantId: row.id,
      personId: row.personId,
      accountId: row.accountId,
      status: row.consumedAt !== null ? 'consumed' : row.revokedAt !== null ? 'revoked' : 'active',
      revision: row.revision.toString(10),
    },
  });
}

/**
 * POST /organizations/:id/people/:personId/enrollments — issues a one-time
 * OIDC invitation for a canonical person. The raw token is returned exactly
 * once; only its digest is persisted.
 */
export async function issueIdentityEnrollment(
  input: IssueEnrollmentInput,
  dependencies: EnrollmentDependencies,
): Promise<IssuedEnrollment> {
  requireNormalSession(input.principal);
  const key = requireControlPlaneIdempotencyKey(input.idempotencyKey);
  if (typeof input.providerKey !== 'string' || input.providerKey.length === 0) {
    throw new ControlPlaneError('identity_enrollment_invalid', 'Invalid provider key.');
  }
  const providerKey = input.providerKey.trim().toLowerCase();
  const now = dependencies.clock.now();
  const tokenBytes = dependencies.random.randomBytes(32);
  const tokenHash = dependencies.digester.digest(tokenBytes);
  const fingerprint = fingerprintControlPlane('identity.enrollment.issue:v1', [
    input.organizationId,
    input.personId,
    providerKey,
  ]);
  const outcome = await runControlPlaneCommand(dependencies.runner, dependencies.idempotency, now, {
    identity: {
      tenantId: input.principal.tenantId,
      actorAccountId: input.principal.accountId,
      command: 'identity.enrollment.issue:v1',
      key,
      fingerprint,
    },
    lockKey: controlPlaneLockKey(
      input.principal.tenantId,
      input.principal.accountId,
      'identity.enrollment.issue:v1',
      key,
    ),
    execute: async (context) => {
      await requireOrganizationCapability(
        context,
        dependencies.authorization,
        input.principal,
        'identity.enroll',
        input.organizationId,
        now,
        'identity_enrollment_not_found',
      );
      const person = await dependencies.enrollments.loadPerson(context, input.personId);
      if (person?.tenantId !== input.principal.tenantId || person.status !== 'active') {
        throw new ControlPlaneError(
          'identity_enrollment_invalid',
          'Enrollment target is not eligible.',
        );
      }
      const timeZone = await dependencies.enrollments.loadSchoolTimeZone(
        context,
        input.organizationId,
      );
      if (timeZone === null) {
        throw new ControlPlaneError('identity_enrollment_not_found', 'Not found.');
      }
      const today = schoolDateFor(now, timeZone);
      if (today === null) {
        throw new ControlPlaneError('identity_enrollment_invalid', 'School timezone is unusable.');
      }
      const membership = await dependencies.enrollments.loadActiveMembership(
        context,
        input.personId,
        input.organizationId,
        today.toString(),
      );
      if (membership === null) {
        throw new ControlPlaneError(
          'identity_enrollment_invalid',
          'Enrollment target is not eligible.',
        );
      }
      const provider = await dependencies.directory.findProviderByKey(context, providerKey);
      if (provider?.tenantId !== input.principal.tenantId || provider.status !== 'active') {
        throw new ControlPlaneError('identity_enrollment_invalid', 'Unknown provider.');
      }
      const existing = await dependencies.enrollments.loadAccountForPerson(context, input.personId);
      const accountId =
        existing === null
          ? (await dependencies.enrollments.insertAccount(context, input.personId)).id
          : existing.id;
      if (await dependencies.enrollments.hasProviderIdentity(context, accountId, provider.id)) {
        throw new ControlPlaneError(
          'identity_already_enrolled',
          'This account already has an identity on this provider.',
        );
      }
      const row = await dependencies.enrollments.insertGrant(context, {
        organizationId: input.organizationId,
        accountId,
        identityProviderId: provider.id,
        tokenHash,
        expiresAt: now.add({ hours: ENROLLMENT_GRANT_TTL_HOURS }),
        createdByAccountId: input.principal.accountId,
      });
      if (row === null) {
        throw new ControlPlaneError(
          'identity_enrollment_invalid',
          'A live enrollment already exists for this account and provider.',
        );
      }
      await appendEnrollmentAudit(
        dependencies,
        context,
        input.principal,
        row,
        'identity_enrollment.issued',
        input.requestId,
        now,
      );
      await appendEnrollmentOutbox(dependencies, context, row, 'identity_enrollment.issued', now);
      return {
        enrollment: toEnrollmentView(row, now),
        provider: { key: provider.key, displayName: provider.displayName },
        etag: etagForEnrollment(row.id, row.revision),
      };
    },
    toStored: (value) => ({
      responseStatus: 201,
      responseBody: { enrollment: value.enrollment, provider: value.provider },
    }),
    fromStored: (record) => {
      const body = record.responseBody as {
        enrollment: EnrollmentView;
        provider: { key: string; displayName: string };
      };
      return {
        enrollment: body.enrollment,
        provider: body.provider,
        etag: etagForEnrollment(body.enrollment.id, BigInt(body.enrollment.revision)),
      };
    },
  });
  return {
    enrollment: outcome.value.enrollment,
    // The raw token is returned exactly once, on the live execution only.
    // A replayed request must never re-emit invitation material.
    enrollmentToken: outcome.replayed ? '' : toBase64Url(tokenBytes),
    provider: outcome.value.provider,
    etag: outcome.value.etag,
    status: 201,
    replayed: outcome.replayed,
  };
}

/**
 * POST /identity-enrollments/:id/revoke — revokes a live invitation.
 * Consumed, expired, or already-revoked grants report
 * identity_enrollment_invalid for a new key and replay for the original key.
 */
export async function revokeIdentityEnrollment(
  input: RevokeEnrollmentInput,
  dependencies: EnrollmentDependencies,
): Promise<EnrollmentResult> {
  requireNormalSession(input.principal);
  const key = requireControlPlaneIdempotencyKey(input.idempotencyKey);
  const expected = parseResourceIfMatch(input.ifMatch, {
    kind: 'identity-enrollment',
    id: input.enrollmentId,
  });
  const now = dependencies.clock.now();
  const fingerprint = fingerprintControlPlane('identity.enrollment.revoke:v1', [
    input.enrollmentId,
    expected.revision.toString(10),
  ]);
  const outcome = await runControlPlaneCommand(dependencies.runner, dependencies.idempotency, now, {
    identity: {
      tenantId: input.principal.tenantId,
      actorAccountId: input.principal.accountId,
      command: 'identity.enrollment.revoke:v1',
      key,
      fingerprint,
    },
    lockKey: controlPlaneLockKey(
      input.principal.tenantId,
      input.principal.accountId,
      'identity.enrollment.revoke:v1',
      key,
    ),
    execute: async (context) => {
      const current = await dependencies.enrollments.loadGrantForUpdate(
        context,
        input.enrollmentId,
      );
      if (current?.tenantId !== input.principal.tenantId) {
        throw new ControlPlaneError('identity_enrollment_not_found', 'Enrollment not found.');
      }
      await requireOrganizationCapability(
        context,
        dependencies.authorization,
        input.principal,
        'identity.enroll',
        current.organizationId,
        now,
        'identity_enrollment_not_found',
      );
      if (current.revision !== expected.revision) {
        throw new ControlPlaneError(
          'stale_resource_revision',
          'The enrollment has changed since this client last read it.',
        );
      }
      if (enrollmentStatus(current, now) !== 'active') {
        throw new ControlPlaneError(
          'identity_enrollment_invalid',
          'The enrollment is no longer live.',
        );
      }
      const row = await dependencies.enrollments.revokeGrant(
        context,
        current.id,
        current.revision,
        input.principal.accountId,
        now,
      );
      if (row === null) {
        throw new ControlPlaneError(
          'stale_resource_revision',
          'The enrollment has changed since this client last read it.',
        );
      }
      await appendEnrollmentAudit(
        dependencies,
        context,
        input.principal,
        row,
        'identity_enrollment.revoked',
        input.requestId,
        now,
      );
      await appendEnrollmentOutbox(dependencies, context, row, 'identity_enrollment.revoked', now);
      const enrollment = toEnrollmentView(row, now);
      return { enrollment, etag: etagForEnrollment(row.id, row.revision) };
    },
    toStored: (value) => ({ responseStatus: 200, responseBody: { enrollment: value.enrollment } }),
    fromStored: (record) => {
      const body = record.responseBody as { enrollment: EnrollmentView };
      return {
        enrollment: body.enrollment,
        etag: etagForEnrollment(body.enrollment.id, BigInt(body.enrollment.revision)),
      };
    },
  });
  return {
    enrollment: outcome.value.enrollment,
    etag: outcome.value.etag,
    status: 200,
    replayed: outcome.replayed,
  };
}
