import { Temporal } from '@js-temporal/polyfill';
import type { Clock } from '@openhall/domain';
import type { AuditWriter } from '../auditing/audit.js';
import type { Principal } from '../authentication/principal.js';
import type { RelationshipAuthorizationService } from '../authorization/service.js';
import type { IdempotencyTransactionStore } from '../idempotency/coordinator.js';
import type {
  OutboxWriter,
  TenantTransactionContext,
  TenantTransactionRunner,
} from '../persistence.js';
import { ControlPlaneError } from './errors.js';
import { etagForResource, parseResourceIfMatch } from './etags.js';
import {
  controlPlaneLockKey,
  fingerprintControlPlane,
  requireControlPlaneIdempotencyKey,
  runControlPlaneCommand,
} from './idempotency.js';
import {
  isSchoolGrantRole,
  type DestinationRepository,
  type GrantAdminRepository,
  type GrantRecord,
  type NewGrant,
  type SchoolGrantRole,
} from './ports.js';
import { requireNormalSession, requireOrganizationCapability, schoolDateFor } from './shared.js';

export interface GrantDependencies {
  readonly clock: Clock;
  readonly runner: TenantTransactionRunner;
  readonly authorization: RelationshipAuthorizationService;
  readonly grants: GrantAdminRepository;
  readonly destinations: DestinationRepository;
  readonly idempotency: IdempotencyTransactionStore;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
}

export interface GrantView {
  readonly id: string;
  readonly personId: string;
  readonly person: { readonly id: string; readonly displayName: string };
  readonly accountId: string;
  readonly role: string;
  readonly scopeKind: string;
  readonly organizationId: string | null;
  readonly destinationId: string | null;
  readonly destination: { readonly id: string; readonly displayName: string } | null;
  readonly status: string;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly revision: string;
  readonly createdByAccountId: string | null;
  readonly revokedAt: string | null;
  readonly revokedByAccountId: string | null;
  readonly createdAt: string;
}

export function etagForGrant(grantId: string, revision: bigint): string {
  return etagForResource('grant', grantId, revision);
}

export function toGrantView(row: GrantRecord): GrantView {
  return {
    id: row.id,
    personId: row.personId,
    person: { id: row.personId, displayName: row.personDisplayName },
    accountId: row.accountId,
    role: row.role,
    scopeKind: row.scopeKind,
    organizationId: row.organizationId,
    destinationId: row.destinationId,
    destination:
      row.destinationId === null
        ? null
        : {
            id: row.destinationId,
            displayName: row.destinationDisplayName ?? 'Destination',
          },
    status: row.status,
    validFrom: row.validFrom === null ? null : row.validFrom.toString(),
    validUntil: row.validUntil === null ? null : row.validUntil.toString(),
    revision: row.revision.toString(10),
    createdByAccountId: row.createdByAccountId,
    revokedAt: row.revokedAt === null ? null : row.revokedAt.toString(),
    revokedByAccountId: row.revokedByAccountId,
    createdAt: row.createdAt.toString(),
  };
}

export interface GrantCommandInput {
  readonly principal: Principal;
  readonly idempotencyKey: unknown;
  readonly requestId: string;
}

export interface GrantIssueBody {
  readonly personId: unknown;
  readonly role: unknown;
  readonly destinationId: unknown;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
}

export interface IssueGrantInput extends GrantCommandInput {
  readonly organizationId: string;
  readonly body: GrantIssueBody;
}

export interface RevokeGrantInput extends GrantCommandInput {
  readonly grantId: string;
  readonly ifMatch: unknown;
}

export interface GrantResult {
  readonly grant: GrantView;
  readonly etag: string;
  readonly status: 200 | 201;
  readonly replayed: boolean;
}

interface CanonicalGrantIssue {
  readonly personId: string;
  readonly role: SchoolGrantRole;
  readonly scopeKind: 'organization' | 'destination';
  readonly destinationId: string | null;
  readonly validFrom: Temporal.Instant | null;
  readonly validUntil: Temporal.Instant | null;
}

function cleanPersonId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ControlPlaneError('target_not_active_staff', 'Grant target is not active staff.');
  }
  return value;
}

function cleanInstant(value: string | null, field: string): Temporal.Instant | null {
  if (value === null) return null;
  try {
    return Temporal.Instant.from(value);
  } catch {
    throw new ControlPlaneError('invalid_authorization_grant_state', `Invalid ${field}.`);
  }
}

/**
 * Canonicalizes the closed grant issue body. Scope is derived from role:
 * destination_staff requires a destination; organization-scoped roles reject
 * one. accountId/scopeKind/organizationId/tenantId/status/revision are never
 * accepted from the caller.
 */
function canonicalIssue(body: GrantIssueBody): CanonicalGrantIssue {
  const personId = cleanPersonId(body.personId);
  if (typeof body.role !== 'string' || !isSchoolGrantRole(body.role)) {
    throw new ControlPlaneError('invalid_authorization_grant_state', 'Invalid grant role.');
  }
  const validFrom = cleanInstant(body.validFrom, 'validFrom');
  const validUntil = cleanInstant(body.validUntil, 'validUntil');
  if (
    validFrom !== null &&
    validUntil !== null &&
    Temporal.Instant.compare(validUntil, validFrom) <= 0
  ) {
    throw new ControlPlaneError('invalid_authorization_grant_state', 'Invalid validity interval.');
  }
  if (body.role === 'destination_staff') {
    if (typeof body.destinationId !== 'string' || body.destinationId.length === 0) {
      throw new ControlPlaneError(
        'invalid_authorization_grant_state',
        'Destination staff requires a destination.',
      );
    }
    return {
      personId,
      role: body.role,
      scopeKind: 'destination',
      destinationId: body.destinationId,
      validFrom,
      validUntil,
    };
  }
  if (body.destinationId !== null) {
    throw new ControlPlaneError(
      'invalid_authorization_grant_state',
      'Organization-scoped roles reject a destination.',
    );
  }
  return {
    personId,
    role: body.role,
    scopeKind: 'organization',
    destinationId: null,
    validFrom,
    validUntil,
  };
}

/**
 * Resolves the canonical school of a grant: organization scope carries it
 * directly; destination scope resolves through the destination.
 */
async function canonicalGrantOrganization(
  context: TenantTransactionContext,
  dependencies: GrantDependencies,
  row: GrantRecord,
): Promise<string | null> {
  if (row.organizationId !== null) return row.organizationId;
  if (row.destinationId === null) return null;
  const destination = await dependencies.destinations.loadById(context, row.destinationId);
  if (destination?.tenantId !== row.tenantId) return null;
  return destination.organizationId;
}

async function appendGrantAudit(
  dependencies: GrantDependencies,
  context: TenantTransactionContext,
  principal: Principal,
  row: GrantRecord,
  canonicalOrganizationId: string,
  action: string,
  requestId: string,
  now: Temporal.Instant,
): Promise<void> {
  await dependencies.audit.append(context, {
    action,
    actorKind: 'account',
    actorId: principal.accountId,
    organizationId: canonicalOrganizationId,
    targetKind: 'authorization_grant',
    targetId: row.id,
    outcome: 'success',
    occurredAt: now,
    requestId,
    metadata: {
      authorizationGrantId: row.id,
      personId: row.personId,
      accountId: row.accountId,
      role: row.role,
      revision: row.revision.toString(10),
      requestId,
    },
  });
}

async function appendGrantOutbox(
  dependencies: GrantDependencies,
  context: TenantTransactionContext,
  row: GrantRecord,
  canonicalOrganizationId: string,
  eventType: string,
  now: Temporal.Instant,
): Promise<void> {
  await dependencies.outbox.append(context, {
    tenantId: row.tenantId,
    organizationId: canonicalOrganizationId,
    aggregateKind: 'authorization_grant',
    aggregateId: row.id,
    eventType,
    occurredAt: now.toString(),
    payload: {
      schemaVersion: 1,
      organizationId: row.organizationId,
      authorizationGrantId: row.id,
      personId: row.personId,
      accountId: row.accountId,
      role: row.role,
      status: row.status,
      revision: row.revision.toString(10),
    },
  });
}

/** GET /organizations/:id/authorization-grants — authorization.manage read of the exact school. */
export async function listAuthorizationGrants(
  principal: Principal,
  organizationId: string,
  dependencies: GrantDependencies,
): Promise<{ readonly grants: readonly GrantView[] }> {
  const now = dependencies.clock.now();
  return dependencies.runner.run(principal.tenantId, async (context) => {
    await requireOrganizationCapability(
      context,
      dependencies.authorization,
      principal,
      'authorization.manage',
      organizationId,
      now,
      'authorization_grant_not_found',
    );
    const rows = await dependencies.grants.listByOrganization(context, organizationId);
    return { grants: rows.map(toGrantView) };
  });
}

/** GET /authorization-grants/:id — authoritative detail and strong ETag. */
export async function getAuthorizationGrant(
  principal: Principal,
  grantId: string,
  dependencies: GrantDependencies,
): Promise<{ readonly grant: GrantView; readonly etag: string }> {
  const now = dependencies.clock.now();
  return dependencies.runner.run(principal.tenantId, async (context) => {
    const row = await dependencies.grants.loadById(context, grantId);
    if (row?.tenantId !== principal.tenantId) {
      throw new ControlPlaneError('authorization_grant_not_found', 'Grant not found.');
    }
    const organizationId = await canonicalGrantOrganization(context, dependencies, row);
    if (organizationId === null) {
      throw new ControlPlaneError('authorization_grant_not_found', 'Grant not found.');
    }
    await requireOrganizationCapability(
      context,
      dependencies.authorization,
      principal,
      'authorization.manage',
      organizationId,
      now,
      'authorization_grant_not_found',
    );
    return { grant: toGrantView(row), etag: etagForGrant(row.id, row.revision) };
  });
}

/**
 * POST /organizations/:id/authorization-grants — issues an explicit staff
 * duty. The target must be an active person with active staff membership in
 * the exact school on the school-local date; students can never receive
 * staff duties. A missing account is created login-less so duties can be
 * configured before enrollment completes. Duplicate active duties report
 * authorization_grant_exists; no email is ever used to find targets.
 */
export async function issueAuthorizationGrant(
  input: IssueGrantInput,
  dependencies: GrantDependencies,
): Promise<GrantResult> {
  requireNormalSession(input.principal);
  const key = requireControlPlaneIdempotencyKey(input.idempotencyKey);
  const now = dependencies.clock.now();
  const issue = canonicalIssue(input.body);
  const fingerprint = fingerprintControlPlane('authorization.grant.issue:v1', [
    input.organizationId,
    issue.personId,
    issue.role,
    issue.destinationId ?? '',
    issue.validFrom?.toString() ?? '',
    issue.validUntil?.toString() ?? '',
  ]);
  const outcome = await runControlPlaneCommand(dependencies.runner, dependencies.idempotency, now, {
    identity: {
      tenantId: input.principal.tenantId,
      actorAccountId: input.principal.accountId,
      command: 'authorization.grant.issue:v1',
      key,
      fingerprint,
    },
    lockKey: controlPlaneLockKey(
      input.principal.tenantId,
      input.principal.accountId,
      'authorization.grant.issue:v1',
      key,
    ),
    execute: async (context) => {
      await requireOrganizationCapability(
        context,
        dependencies.authorization,
        input.principal,
        'authorization.manage',
        input.organizationId,
        now,
        'authorization_grant_not_found',
      );
      const person = await dependencies.grants.loadPerson(context, issue.personId);
      if (person?.tenantId !== input.principal.tenantId || person.status !== 'active') {
        throw new ControlPlaneError('target_not_active_staff', 'Grant target is not active staff.');
      }
      const timeZone = await dependencies.grants.loadSchoolTimeZone(context, input.organizationId);
      if (timeZone === null) {
        throw new ControlPlaneError('authorization_grant_not_found', 'Not found.');
      }
      const today = schoolDateFor(now, timeZone);
      if (today === null) {
        throw new ControlPlaneError(
          'invalid_authorization_grant_state',
          'School timezone is unusable.',
        );
      }
      const membership = await dependencies.grants.loadActiveStaffMembership(
        context,
        issue.personId,
        input.organizationId,
        today.toString(),
      );
      if (membership === null) {
        throw new ControlPlaneError('target_not_active_staff', 'Grant target is not active staff.');
      }
      let organizationId: string | null = input.organizationId;
      if (issue.scopeKind === 'destination') {
        const destination = await dependencies.destinations.loadById(
          context,
          issue.destinationId ?? '',
        );
        if (
          destination?.tenantId !== input.principal.tenantId ||
          destination.organizationId !== input.organizationId ||
          destination.status === 'archived'
        ) {
          throw new ControlPlaneError(
            'invalid_authorization_grant_state',
            'Grant destination is not usable.',
          );
        }
        organizationId = null;
      }
      const existing = await dependencies.grants.loadAccountForPerson(context, issue.personId);
      const accountId =
        existing === null
          ? (await dependencies.grants.insertAccount(context, issue.personId)).id
          : existing.id;
      const grantInput: NewGrant = {
        accountId,
        personId: issue.personId,
        role: issue.role,
        scopeKind: issue.scopeKind,
        organizationId,
        destinationId: issue.destinationId,
        validFrom: issue.validFrom,
        validUntil: issue.validUntil,
        createdByAccountId: input.principal.accountId,
      };
      const row = await dependencies.grants.insertActive(context, grantInput);
      if (row === null) {
        throw new ControlPlaneError(
          'authorization_grant_exists',
          'This active duty already exists.',
        );
      }
      await appendGrantAudit(
        dependencies,
        context,
        input.principal,
        row,
        input.organizationId,
        'authorization_grant.issued',
        input.requestId,
        now,
      );
      await appendGrantOutbox(
        dependencies,
        context,
        row,
        input.organizationId,
        'authorization_grant.issued',
        now,
      );
      const grant = toGrantView(row);
      return { grant, etag: etagForGrant(row.id, row.revision) };
    },
    toStored: (value) => ({ responseStatus: 201, responseBody: { grant: value.grant } }),
    fromStored: (record) => {
      const body = record.responseBody as { grant: GrantView };
      return {
        grant: body.grant,
        etag: etagForGrant(body.grant.id, BigInt(body.grant.revision)),
      };
    },
  });
  return {
    grant: outcome.value.grant,
    etag: outcome.value.etag,
    status: 201,
    replayed: outcome.replayed,
  };
}

/**
 * POST /authorization-grants/:id/revoke — semantic revoke only; rows are
 * never deleted. Already-revoked grants report
 * invalid_authorization_grant_state for a new key and replay for the
 * original key.
 */
export async function revokeAuthorizationGrant(
  input: RevokeGrantInput,
  dependencies: GrantDependencies,
): Promise<GrantResult> {
  requireNormalSession(input.principal);
  const key = requireControlPlaneIdempotencyKey(input.idempotencyKey);
  const expected = parseResourceIfMatch(input.ifMatch, { kind: 'grant', id: input.grantId });
  const now = dependencies.clock.now();
  const fingerprint = fingerprintControlPlane('authorization.grant.revoke:v1', [
    input.grantId,
    expected.revision.toString(10),
  ]);
  const outcome = await runControlPlaneCommand(dependencies.runner, dependencies.idempotency, now, {
    identity: {
      tenantId: input.principal.tenantId,
      actorAccountId: input.principal.accountId,
      command: 'authorization.grant.revoke:v1',
      key,
      fingerprint,
    },
    lockKey: controlPlaneLockKey(
      input.principal.tenantId,
      input.principal.accountId,
      'authorization.grant.revoke:v1',
      key,
    ),
    execute: async (context) => {
      const current = await dependencies.grants.loadForUpdate(context, input.grantId);
      if (current?.tenantId !== input.principal.tenantId) {
        throw new ControlPlaneError('authorization_grant_not_found', 'Grant not found.');
      }
      const organizationId = await canonicalGrantOrganization(context, dependencies, current);
      if (organizationId === null) {
        throw new ControlPlaneError('authorization_grant_not_found', 'Grant not found.');
      }
      await requireOrganizationCapability(
        context,
        dependencies.authorization,
        input.principal,
        'authorization.manage',
        organizationId,
        now,
        'authorization_grant_not_found',
      );
      if (current.revision !== expected.revision) {
        throw new ControlPlaneError(
          'stale_resource_revision',
          'The grant has changed since this client last read it.',
        );
      }
      if (current.status !== 'active') {
        throw new ControlPlaneError(
          'invalid_authorization_grant_state',
          'The grant is not active.',
        );
      }
      const row = await dependencies.grants.revokeToRevision(
        context,
        current.id,
        current.revision,
        input.principal.accountId,
        now,
      );
      if (row === null) {
        throw new ControlPlaneError(
          'stale_resource_revision',
          'The grant has changed since this client last read it.',
        );
      }
      await appendGrantAudit(
        dependencies,
        context,
        input.principal,
        row,
        organizationId,
        'authorization_grant.revoked',
        input.requestId,
        now,
      );
      await appendGrantOutbox(
        dependencies,
        context,
        row,
        organizationId,
        'authorization_grant.revoked',
        now,
      );
      const grant = toGrantView(row);
      return { grant, etag: etagForGrant(row.id, row.revision) };
    },
    toStored: (value) => ({ responseStatus: 200, responseBody: { grant: value.grant } }),
    fromStored: (record) => {
      const body = record.responseBody as { grant: GrantView };
      return {
        grant: body.grant,
        etag: etagForGrant(body.grant.id, BigInt(body.grant.revision)),
      };
    },
  });
  return {
    grant: outcome.value.grant,
    etag: outcome.value.etag,
    status: 200,
    replayed: outcome.replayed,
  };
}
