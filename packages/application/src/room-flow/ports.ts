import type { Temporal } from '@js-temporal/polyfill';
import type { TenantTransactionContext } from '../persistence.js';
import type { RoomCheckInMode } from '../passes/ports.js';
import type { QueueReleaseReason, ReservationReleaseReason } from './errors.js';

export interface RoomFlowConfig {
  readonly id: string;
  readonly tenantId: string;
  readonly organizationId: string;
  readonly status: 'open' | 'closed' | 'archived';
  readonly checkInMode: RoomCheckInMode;
  readonly capacity: number | null;
  readonly queueEnabled: boolean;
  readonly readyClaimTimeoutSeconds: number;
  readonly queueTimeoutSeconds: number;
  readonly defaultDurationSeconds: number | null;
  readonly maxDurationSeconds: number | null;
}

export interface FlowReservationRow {
  readonly id: string;
  readonly tenantId: string;
  readonly organizationId: string;
  readonly roomId: string;
  readonly passId: string;
  readonly policyEvaluationId: string;
  readonly reservedAt: Temporal.Instant;
  readonly readyExpiresAt: Temporal.Instant;
  readonly claimedAt: Temporal.Instant | null;
  readonly flowExpiresAt: Temporal.Instant;
  readonly releasedAt: Temporal.Instant | null;
  readonly releaseReason: string | null;
}

export interface FlowQueueEntryRow {
  readonly id: string;
  readonly tenantId: string;
  readonly organizationId: string;
  readonly roomId: string;
  readonly passId: string;
  readonly policyEvaluationId: string;
  readonly enteredAt: Temporal.Instant;
  readonly flowExpiresAt: Temporal.Instant;
  readonly releasedAt: Temporal.Instant | null;
  readonly releaseReason: string | null;
  readonly priority: number;
}

export interface NewFlowReservation {
  readonly organizationId: string;
  readonly roomId: string;
  readonly passId: string;
  readonly policyEvaluationId: string;
  readonly reservedAt: Temporal.Instant;
  readonly readyExpiresAt: Temporal.Instant;
  readonly flowExpiresAt: Temporal.Instant;
}

export interface NewFlowQueueEntry {
  readonly organizationId: string;
  readonly roomId: string;
  readonly passId: string;
  readonly policyEvaluationId: string;
  readonly enteredAt: Temporal.Instant;
  readonly flowExpiresAt: Temporal.Instant;
}

/** Queue head with its pass lifecycle state for FIFO promotion decisions. */
export interface QueueHeadCandidate {
  readonly entry: FlowQueueEntryRow;
  readonly passId: string;
  readonly organizationId: string;
  readonly studentId: string;
  readonly passLifecycleState: string;
}

/** Stale ready offer: unclaimed reservation whose claim window has passed. */
export interface StaleReadyCandidate {
  readonly reservation: FlowReservationRow;
  readonly passLifecycleState: string;
}

/** Queued attempt whose overall flow deadline has passed. */
export interface ExpiredQueueCandidate {
  readonly entry: FlowQueueEntryRow;
}

/** Pre-departure pass parked at a destination that is no longer usable. */
export interface UnavailableFlowCandidate {
  readonly passId: string;
  readonly lifecycleState: string;
  readonly roomId: string;
}

/** Active flow rows attached to a pass that is already terminal. */
export interface OrphanedFlowRows {
  readonly passId: string;
  readonly reservationId: string | null;
  readonly queueEntryId: string | null;
}

/**
 * Purpose-built room-flow persistence port. Methods are use-case
 * shaped; there is no generic SQL escape hatch. Capacity mutations must run
 * under the room-flow advisory lock with the pass row already locked.
 */
export interface RoomFlowRepository {
  /** All tenant ids, for per-tenant worker sweeps. No tenant scoping needed. */
  listTenantIds(): Promise<string[]>;
  acquireRoomLock(context: TenantTransactionContext, lockKey: bigint): Promise<void>;
  loadRoomConfig(context: TenantTransactionContext, roomId: string): Promise<RoomFlowConfig | null>;
  /**
   * Reservations consuming capacity at `at`: released_at IS NULL AND
   * (claimed OR still within the ready claim window). An expired unclaimed
   * offer stops consuming capacity even before the reconciler releases it.
   */
  countConsumingReservations(
    context: TenantTransactionContext,
    roomId: string,
    at: Temporal.Instant,
  ): Promise<number>;
  createReservation(
    context: TenantTransactionContext,
    input: NewFlowReservation,
  ): Promise<FlowReservationRow>;
  loadActiveReservationForPass(
    context: TenantTransactionContext,
    passId: string,
  ): Promise<FlowReservationRow | null>;
  /**
   * Marks claimed_at on an active unclaimed reservation. Returns false when
   * the row is already claimed or released (lost a race).
   */
  claimReservation(
    context: TenantTransactionContext,
    reservationId: string,
    at: Temporal.Instant,
  ): Promise<boolean>;
  /**
   * Releases an active reservation. Returns false when already released.
   */
  releaseReservation(
    context: TenantTransactionContext,
    reservationId: string,
    reason: ReservationReleaseReason,
    at: Temporal.Instant,
  ): Promise<boolean>;
  createQueueEntry(
    context: TenantTransactionContext,
    input: NewFlowQueueEntry,
  ): Promise<FlowQueueEntryRow>;
  loadActiveQueueEntryForPass(
    context: TenantTransactionContext,
    passId: string,
  ): Promise<FlowQueueEntryRow | null>;
  /**
   * Releases an active queue entry. Returns false when already released.
   */
  releaseQueueEntry(
    context: TenantTransactionContext,
    entryId: string,
    reason: QueueReleaseReason,
    at: Temporal.Instant,
  ): Promise<boolean>;
  /**
   * Exact queue head: active entry ordered priority DESC, entered_at ASC,
   * id ASC, with its current pass state. Only the head may be promoted.
   */
  loadQueueHead(
    context: TenantTransactionContext,
    roomId: string,
  ): Promise<QueueHeadCandidate | null>;
  /** Active queue entries for a destination, optionally excluding one pass. */
  countActiveQueueEntries(
    context: TenantTransactionContext,
    roomId: string,
    excludePassId?: string,
  ): Promise<number>;
  /**
   * Derived queue position: 1 + active entries ordered ahead of the given
   * entry under the same FIFO ordering. Never stored.
   */
  queuePosition(
    context: TenantTransactionContext,
    roomId: string,
    entryId: string,
  ): Promise<{ readonly position: number; readonly ahead: number }>;
  /** Approximate candidate discovery; every mutation re-reads under locks. */
  listQueuedRoomIds(context: TenantTransactionContext, limit: number): Promise<string[]>;
  findStaleReadyCandidate(
    context: TenantTransactionContext,
    at: Temporal.Instant,
  ): Promise<StaleReadyCandidate | null>;
  findExpiredQueueCandidate(
    context: TenantTransactionContext,
    at: Temporal.Instant,
  ): Promise<ExpiredQueueCandidate | null>;
  findUnavailableFlowCandidate(
    context: TenantTransactionContext,
  ): Promise<UnavailableFlowCandidate | null>;
  findOrphanedFlowRows(context: TenantTransactionContext): Promise<OrphanedFlowRows | null>;
  /** Station view aggregates for one destination. */
  loadStationAggregates(
    context: TenantTransactionContext,
    roomId: string,
    at: Temporal.Instant,
  ): Promise<StationAggregates>;
}

export interface StationPassEntry {
  readonly passId: string;
  readonly passRevision: bigint;
  readonly studentId: string;
  readonly studentDisplayName: string;
  readonly expectedReturnAt: Temporal.Instant | null;
}

export interface StationReadyEntry extends StationPassEntry {
  readonly readyUntil: Temporal.Instant;
}

export interface StationOutboundEntry extends StationPassEntry {
  readonly departedAt: Temporal.Instant;
}

export interface StationQueuedEntry extends StationPassEntry {
  readonly enteredAt: Temporal.Instant;
}

export interface StationAggregates {
  readonly config: RoomFlowConfig;
  readonly roomName: string;
  readonly consumingReservations: number;
  readonly queueCount: number;
  readonly ready: readonly StationReadyEntry[];
  readonly outbound: readonly StationOutboundEntry[];
  readonly atDestination: readonly StationPassEntry[];
  readonly queued: readonly StationQueuedEntry[];
}
