import type { Temporal } from '@js-temporal/polyfill';
import type {
  OrganizationId,
  PassId,
  PersonId,
  RoomId,
  ScheduleBlockId,
  SectionId,
  TenantId,
} from '../ids.js';
import { InvalidPassTransitionError } from './errors.js';
import { STATE_EVENT, type PassDomainEvent } from './events.js';
import { canTransition, type PassLifecycleState } from './lifecycle.js';

export type PassRequestSource =
  'student_web' | 'staff_web' | 'scheduled' | 'integration' | 'system';

/**
 * Authoritative in-memory pass aggregate. `pass` remains the current truth;
 * `pass_event` is immutable history, never replayed to reconstruct this.
 * Revision is the aggregate version: creation is 1n, every successful
 * lifecycle mutation adds exactly 1n. Reads, denials, replays, and stale
 * preconditions never increment it.
 */
export interface PassAggregate {
  readonly id: PassId;
  readonly tenantId: TenantId;
  readonly organizationId: OrganizationId;
  readonly studentId: PersonId;

  readonly originRoomId: RoomId | null;
  readonly originSectionId: SectionId | null;
  readonly originScheduleBlockId: ScheduleBlockId | null;

  readonly destinationRoomId: RoomId;
  readonly returnRoomId: RoomId | null;

  readonly requestSource: PassRequestSource;
  readonly requestedByPersonId: PersonId | null;
  readonly requestedAt: Temporal.Instant;

  readonly lifecycleState: PassLifecycleState;

  readonly expectedReturnAt: Temporal.Instant | null;
  readonly scheduledAuthorizationId: string | null;

  readonly revision: bigint;
}

export interface RequestedPassInput {
  readonly id: PassId;
  readonly tenantId: TenantId;
  readonly organizationId: OrganizationId;
  readonly studentId: PersonId;
  readonly originRoomId?: RoomId | null;
  readonly originSectionId?: SectionId | null;
  readonly originScheduleBlockId?: ScheduleBlockId | null;
  readonly destinationRoomId: RoomId;
  readonly requestSource: PassRequestSource;
  readonly requestedByPersonId?: PersonId | null;
  readonly requestedAt: Temporal.Instant;
}

/** Phase 5 creation: always `requested` at revision 1, never auto-ready. */
export function createRequestedPass(input: RequestedPassInput): PassAggregate {
  return {
    id: input.id,
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    studentId: input.studentId,
    originRoomId: input.originRoomId ?? null,
    originSectionId: input.originSectionId ?? null,
    originScheduleBlockId: input.originScheduleBlockId ?? null,
    destinationRoomId: input.destinationRoomId,
    returnRoomId: null,
    requestSource: input.requestSource,
    requestedByPersonId: input.requestedByPersonId ?? null,
    requestedAt: input.requestedAt,
    lifecycleState: 'requested',
    expectedReturnAt: null,
    scheduledAuthorizationId: null,
    revision: 1n,
  };
}

export interface PassTransitionResult {
  readonly aggregate: PassAggregate;
  /** Semantic domain event for the transition (e.g. ready -> pass.ready). */
  readonly event: PassDomainEvent;
}

/**
 * Semantic lifecycle mutation. Validates centrally against the lifecycle
 * matrix and increments revision exactly once. Throws
 * {@link InvalidPassTransitionError} without mutating on invalid moves,
 * including any move out of a terminal state.
 */
export function transitionPass(
  aggregate: PassAggregate,
  to: PassLifecycleState,
): PassTransitionResult {
  if (!canTransition(aggregate.lifecycleState, to)) {
    throw new InvalidPassTransitionError(aggregate.lifecycleState, to);
  }
  return {
    aggregate: { ...aggregate, lifecycleState: to, revision: aggregate.revision + 1n },
    event: STATE_EVENT[to],
  };
}

/** Self-cancellation: requested/queued/ready student_web passes only. */
export function cancelPass(aggregate: PassAggregate): PassTransitionResult {
  return transitionPass(aggregate, 'cancelled');
}
