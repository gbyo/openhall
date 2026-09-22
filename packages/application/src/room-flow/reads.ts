import type { Clock } from '@openhall/domain';
import type { Principal } from '../authentication/principal.js';
import type { RelationshipAuthorizationService } from '../authorization/index.js';
import { PassApplicationError } from '../passes/errors.js';
import type { RoomCheckInMode, PassRepository } from '../passes/ports.js';
import { etagForPass } from '../passes/representations.js';
import type { TenantTransactionRunner } from '../persistence.js';
import type { RoomFlowRepository, StationAggregates } from './ports.js';

export interface FlowReadDependencies {
  readonly clock: Clock;
  readonly runner: TenantTransactionRunner;
  readonly passes: PassRepository;
  readonly flow: RoomFlowRepository;
  readonly authorization: RelationshipAuthorizationService;
}

export interface QueueStatusResult {
  readonly position: number;
  readonly ahead: number;
  readonly enteredAt: string;
  readonly expiresAt: string;
}

/**
 * GET /api/v1/me/passes/:passId/queue-status — the caller's own derived
 * queue position. Position is computed from active entries on every read and
 * never stored; other students' passes stay concealed as 404. No pass ETag:
 * this dynamic resource changes when other students move.
 */
export async function getOwnQueueStatus(
  principal: Principal,
  passId: string,
  dependencies: FlowReadDependencies,
): Promise<QueueStatusResult> {
  if (principal.authenticationMethod === 'recovery') {
    throw new PassApplicationError(
      'recovery_session_restricted',
      'Recovery sessions cannot read queue status.',
    );
  }
  const loaded = await dependencies.runner.run(principal.tenantId, async (context) => {
    const pass = await dependencies.passes.loadPass(context, passId);
    if (pass === null) return null;
    const entry = await dependencies.flow.loadActiveQueueEntryForPass(context, pass.id);
    if (entry === null) return { pass, entry: null };
    const position = await dependencies.flow.queuePosition(context, pass.destinationRoomId, entry.id);
    return { pass, entry, position };
  });
  if (loaded?.pass.tenantId !== principal.tenantId) {
    throw new PassApplicationError('pass_not_found', 'Pass not found.');
  }
  if (loaded.pass.studentId !== principal.personId) {
    throw new PassApplicationError('pass_not_found', 'Pass not found.');
  }
  if (loaded.pass.lifecycleState !== 'queued' || loaded.entry === null) {
    throw new PassApplicationError(
      'queue_status_unavailable',
      'This pass is not currently queued.',
    );
  }
  return {
    position: loaded.position.position,
    ahead: loaded.position.ahead,
    enteredAt: loaded.entry.enteredAt.toString(),
    expiresAt: loaded.entry.flowExpiresAt.toString(),
  };
}

export interface StationViewResult {
  readonly room: {
    readonly id: string;
    readonly name: string;
    readonly checkInMode: RoomCheckInMode;
    readonly capacity: number | null;
  };
  readonly occupancy: {
    readonly consumingReservations: number;
    readonly availableCapacity: number | null;
  };
  readonly queueCount: number;
  readonly ready: {
    readonly passId: string;
    readonly passRevision: string;
    readonly passEtag: string;
    readonly student: { readonly id: string; readonly displayName: string };
    readonly readyUntil: string;
  }[];
  readonly outbound: {
    readonly passId: string;
    readonly passRevision: string;
    readonly passEtag: string;
    readonly student: { readonly id: string; readonly displayName: string };
    readonly departedAt: string;
    readonly expectedReturnAt: string | null;
  }[];
  readonly atDestination: {
    readonly passId: string;
    readonly passRevision: string;
    readonly passEtag: string;
    readonly student: { readonly id: string; readonly displayName: string };
    readonly expectedReturnAt: string | null;
  }[];
  readonly queued: {
    readonly passId: string;
    readonly passRevision: string;
    readonly passEtag: string;
    readonly student: { readonly id: string; readonly displayName: string };
    readonly enteredAt: string;
  }[];
}

/**
 * GET /api/v1/rooms/:roomId/station — minimized operational
 * view for authorized station staff. No grants, rule JSON, override
 * categories, OIDC data, or schedule history. No ETag: aggregates change
 * when any pass moves.
 */
export async function getStationView(
  principal: Principal,
  roomId: string,
  dependencies: FlowReadDependencies,
): Promise<StationViewResult> {
  if (principal.authenticationMethod === 'recovery') {
    throw new PassApplicationError(
      'recovery_session_restricted',
      'Recovery sessions cannot read the station view.',
    );
  }
  const at = dependencies.clock.now();
  const aggregates: StationAggregates | null = await dependencies.runner.run(
    principal.tenantId,
    async (context) => {
      const decision = await dependencies.authorization.decideWithContext(context, {
        principal,
        capability: 'room.station.manage',
        resource: { kind: 'room', roomId },
        at,
      });
      if (!decision.allowed) return null;
      return dependencies.flow.loadStationAggregates(context, roomId, at);
    },
  );
  if (aggregates === null) {
    // Unknown, cross-tenant, or unauthorized station resource: concealed.
    throw new PassApplicationError('room_not_found', 'Room not found.');
  }
  const availableCapacity =
    aggregates.config.capacity === null
      ? null
      : Math.max(0, aggregates.config.capacity - aggregates.consumingReservations);
  return {
    room: {
      id: aggregates.config.id,
      name: aggregates.roomName,
      
      checkInMode: aggregates.config.checkInMode,
      capacity: aggregates.config.capacity,
    },
    occupancy: {
      consumingReservations: aggregates.consumingReservations,
      availableCapacity,
    },
    queueCount: aggregates.queueCount,
    ready: aggregates.ready.map((entry) => ({
      passId: entry.passId,
      passRevision: entry.passRevision.toString(10),
      passEtag: etagForPass(entry.passId, entry.passRevision),
      student: { id: entry.studentId, displayName: entry.studentDisplayName },
      readyUntil: entry.readyUntil.toString(),
    })),
    outbound: aggregates.outbound.map((entry) => ({
      passId: entry.passId,
      passRevision: entry.passRevision.toString(10),
      passEtag: etagForPass(entry.passId, entry.passRevision),
      student: { id: entry.studentId, displayName: entry.studentDisplayName },
      departedAt: entry.departedAt.toString(),
      expectedReturnAt: entry.expectedReturnAt?.toString() ?? null,
    })),
    atDestination: aggregates.atDestination.map((entry) => ({
      passId: entry.passId,
      passRevision: entry.passRevision.toString(10),
      passEtag: etagForPass(entry.passId, entry.passRevision),
      student: { id: entry.studentId, displayName: entry.studentDisplayName },
      expectedReturnAt: entry.expectedReturnAt?.toString() ?? null,
    })),
    queued: aggregates.queued.map((entry) => ({
      passId: entry.passId,
      passRevision: entry.passRevision.toString(10),
      passEtag: etagForPass(entry.passId, entry.passRevision),
      student: { id: entry.studentId, displayName: entry.studentDisplayName },
      enteredAt: entry.enteredAt.toString(),
    })),
  };
}
