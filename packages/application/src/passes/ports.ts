import type { Temporal } from '@js-temporal/polyfill';
import type { RoomId, OrganizationId, PassId, PersonId, TenantId } from '@openhall/domain';
import type { TenantTransactionContext } from '../persistence.js';

export type RoomCheckInMode = 'none' | 'optional' | 'required';

export interface PassRoomRecord {
  readonly id: RoomId;
  readonly tenantId: TenantId;
  readonly organizationId: OrganizationId;
  readonly categoryId: string | null;
  readonly studentSelfRequestable: boolean;
  /** Active/archived state of the room's category at read time. */
  readonly categoryStatus: 'active' | 'archived';
  /** Student launcher surface of the room's category at read time. */
  readonly categorySurface: 'primary' | 'secondary' | 'hidden';
  /**
   * Current category presentation (joined, never snapshotted). Null when the
   * room has no category; reads fall back to room-only display.
   */
  readonly categoryPresentation: {
    readonly name: string;
    readonly iconKey: string;
    readonly toneKey: string;
  } | null;
  readonly name: string;
  readonly status: 'open' | 'closed' | 'archived';
  readonly revision: bigint;
  readonly checkInMode: RoomCheckInMode;
  readonly capacity: number | null;
  readonly queueEnabled: boolean;
  readonly readyClaimTimeoutSeconds: number;
  readonly queueTimeoutSeconds: number;
  readonly defaultDurationSeconds: number | null;
  readonly maxDurationSeconds: number | null;
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
  readonly originRoomId: string | null;
  readonly originSectionId: string | null;
  readonly originScheduleBlockId: string | null;
  readonly destinationRoomId: RoomId;
  readonly returnRoomId: string | null;
  readonly requestSource: string;
  readonly requestedByPersonId: PersonId | null;
  readonly requestedAt: Temporal.Instant;
  readonly lifecycleState: string;
  readonly expectedReturnAt: Temporal.Instant | null;
  readonly scheduledAuthorizationId: string | null;
  readonly revision: bigint;
  /** Departure-time check-in snapshot; null for passes that departed before Phase 8. */
  readonly departureCheckInMode: RoomCheckInMode | null;
  readonly departureDestinationRevision: bigint | null;
  readonly destinationRoomName: string;
  readonly destinationCheckInMode: RoomCheckInMode;
  /**
   * Current category presentation for the destination (joined, never
   * snapshotted into the pass row). Null when the category is missing,
   * which reads handle by falling back to destination-only display.
   */
  readonly roomCategory: {
    readonly id: string;
    readonly name: string;
    readonly iconKey: string;
    readonly toneKey: string;
  } | null;
  readonly originBlock: { id: string; code: string; displayName: string } | null;
  readonly originSection: { id: string; code: string | null; title: string } | null;
  readonly originRoom: { id: string; name: string } | null;
}

export interface NewPassRow {
  readonly id: PassId;
  readonly organizationId: OrganizationId;
  readonly studentId: PersonId;
  readonly originRoomId: string | null;
  readonly originSectionId: string | null;
  readonly originScheduleBlockId: string | null;
  readonly destinationRoomId: RoomId;
  readonly requestSource: 'student_web' | 'staff_web' | 'scheduled';
  readonly scheduledAuthorizationId: string | null;
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
  loadRoom(
    context: TenantTransactionContext,
    roomId: RoomId,
  ): Promise<PassRoomRecord | null>;
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
  /** Non-locking read for status views; mutations use loadPassForUpdate. */
  loadPass(context: TenantTransactionContext, passId: PassId): Promise<PassRow | null>;
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
  /**
   * Phase 7 semantic lifecycle persistence. Each method transitions a locked
   * pass to exactly one state, incrementing revision once, and returns null
   * when the row no longer matches the expected revision. Callers validate
   * against the central domain lifecycle matrix first; there is no generic
   * set-state method.
   */
  updatePassToRequested(
    context: TenantTransactionContext,
    passId: PassId,
    expectedRevision: bigint,
    at: Temporal.Instant,
  ): Promise<PassRow | null>;
  updatePassToQueued(
    context: TenantTransactionContext,
    passId: PassId,
    expectedRevision: bigint,
    at: Temporal.Instant,
  ): Promise<PassRow | null>;
  updatePassToReady(
    context: TenantTransactionContext,
    passId: PassId,
    expectedRevision: bigint,
    at: Temporal.Instant,
  ): Promise<PassRow | null>;
  updatePassToOutbound(
    context: TenantTransactionContext,
    passId: PassId,
    expectedRevision: bigint,
    at: Temporal.Instant,
    expectedReturnAt: Temporal.Instant | null,
    departure: {
      readonly checkInMode: RoomCheckInMode;
      readonly destinationRevision: bigint;
    },
  ): Promise<PassRow | null>;
  updatePassToAtDestination(
    context: TenantTransactionContext,
    passId: PassId,
    expectedRevision: bigint,
    at: Temporal.Instant,
  ): Promise<PassRow | null>;
  updatePassToReturning(
    context: TenantTransactionContext,
    passId: PassId,
    expectedRevision: bigint,
    at: Temporal.Instant,
    returnRoomId: string | null,
  ): Promise<PassRow | null>;
  updatePassToCompleted(
    context: TenantTransactionContext,
    passId: PassId,
    expectedRevision: bigint,
    at: Temporal.Instant,
  ): Promise<PassRow | null>;
  updatePassToExpired(
    context: TenantTransactionContext,
    passId: PassId,
    expectedRevision: bigint,
    at: Temporal.Instant,
  ): Promise<PassRow | null>;
  appendPassEvent(context: TenantTransactionContext, input: PassEventInput): Promise<void>;
  /**
   * Latest immutable pass event (highest sequence), or null when the pass
   * has no recorded events. Used to derive the current operational reason
   * for terminal flow transitions without a second lifecycle column.
   */
  loadLatestPassEvent(
    context: TenantTransactionContext,
    passId: PassId,
  ): Promise<{ readonly eventType: string; readonly metadata: Record<string, unknown> } | null>;
}
