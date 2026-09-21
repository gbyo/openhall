import type { Temporal } from '@js-temporal/polyfill';
import type { DestinationId, OrganizationId, PassId, PersonId, TenantId } from '@openhall/domain';
import type { TenantTransactionContext } from '../persistence.js';

export interface PassDestinationRecord {
  readonly id: DestinationId;
  readonly tenantId: TenantId;
  readonly organizationId: OrganizationId;
  readonly locationId: string;
  readonly serviceType: string;
  readonly displayName: string;
  readonly status: 'active' | 'closed' | 'archived';
}

export interface ActiveStudentRecord {
  readonly personId: PersonId;
  readonly organizationId: OrganizationId;
}

export interface PassRow {
  readonly id: PassId;
  readonly tenantId: TenantId;
  readonly organizationId: OrganizationId;
  readonly studentId: PersonId;
  readonly originLocationId: string | null;
  readonly originSectionId: string | null;
  readonly originScheduleBlockId: string | null;
  readonly destinationId: DestinationId;
  readonly returnLocationId: string | null;
  readonly requestSource: string;
  readonly requestedByPersonId: PersonId | null;
  readonly requestedAt: Temporal.Instant;
  readonly lifecycleState: string;
  readonly expectedReturnAt: Temporal.Instant | null;
  readonly scheduledAuthorizationId: string | null;
  readonly revision: bigint;
  readonly destinationDisplayName: string;
  readonly destinationServiceType: string;
  readonly originBlock: { id: string; code: string; displayName: string } | null;
  readonly originSection: { id: string; code: string | null; title: string } | null;
  readonly originLocation: { id: string; name: string } | null;
}

export interface NewPassRow {
  readonly id: PassId;
  readonly organizationId: OrganizationId;
  readonly studentId: PersonId;
  readonly originLocationId: string | null;
  readonly originSectionId: string | null;
  readonly originScheduleBlockId: string | null;
  readonly destinationId: DestinationId;
  readonly requestSource: 'student_web' | 'staff_web';
  readonly requestedByPersonId: PersonId;
  readonly requestedAt: Temporal.Instant;
}

export interface PassEventInput {
  readonly passId: PassId;
  readonly sequence: bigint;
  readonly eventType: string;
  /** System actors record automated policy outcomes with a null person. */
  readonly actorKind: 'person' | 'system';
  readonly actorPersonId: PersonId | null;
  readonly occurredAt: Temporal.Instant;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface PassOutboxInput {
  readonly aggregateId: PassId;
  readonly eventType: string;
  readonly organizationId: OrganizationId;
  readonly occurredAt: Temporal.Instant;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Purpose-built pass persistence port. Methods are use-case shaped; there
 * is no generic SQL escape hatch.
 */
export interface PassRepository {
  loadDestination(
    context: TenantTransactionContext,
    destinationId: DestinationId,
  ): Promise<PassDestinationRecord | null>;
  loadActiveStudent(
    context: TenantTransactionContext,
    organizationId: OrganizationId,
    studentId: PersonId,
    date: Temporal.PlainDate,
  ): Promise<ActiveStudentRecord | null>;
  findActivePassForStudent(
    context: TenantTransactionContext,
    studentId: PersonId,
  ): Promise<PassRow | null>;
  insertRequestedPass(context: TenantTransactionContext, input: NewPassRow): Promise<PassRow>;
  loadPassForUpdate(context: TenantTransactionContext, passId: PassId): Promise<PassRow | null>;
  /**
   * Transitions a locked pass to cancelled, incrementing revision once.
   * Returns null when the row no longer matches the expected revision.
   */
  updatePassToCancelled(
    context: TenantTransactionContext,
    passId: PassId,
    expectedRevision: bigint,
    at: Temporal.Instant,
  ): Promise<PassRow | null>;
  /**
   * Workflow revision bump without a lifecycle change: records a policy
   * workflow mutation (approval/override) so the ETag moves and stale UI
   * actions are rejected. Exactly one increment per workflow mutation.
   */
  touchPassRevision(
    context: TenantTransactionContext,
    passId: PassId,
    expectedRevision: bigint,
    at: Temporal.Instant,
  ): Promise<PassRow | null>;
  /**
   * Transitions a locked pass to denied, incrementing revision once.
   * Returns null when the row no longer matches the expected revision.
   */
  updatePassToDenied(
    context: TenantTransactionContext,
    passId: PassId,
    expectedRevision: bigint,
    at: Temporal.Instant,
  ): Promise<PassRow | null>;
  appendPassEvent(context: TenantTransactionContext, input: PassEventInput): Promise<void>;
}
