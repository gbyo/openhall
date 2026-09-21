import { Temporal } from '@js-temporal/polyfill';
import { transitionPass, type Clock, type PassAggregate } from '@openhall/domain';
import { PassApplicationError } from '../passes/errors.js';
import type { PassRepository, PassRow } from '../passes/ports.js';
import type {
  OutboxWriter,
  TenantTransactionContext,
  TenantTransactionRunner,
} from '../persistence.js';
import {
  evaluateAndPersistPolicy,
  reconcilePendingApprovals,
  type PolicyRepository,
} from '../policy/index.js';
import type { ExpectedPlacementResolver } from '../scheduling/index.js';
import { destinationFlowLockKey } from './locks.js';
import type { DestinationFlowRepository, FlowReservationRow } from './ports.js';

export interface ReconcilerDependencies {
  readonly clock: Clock;
  readonly runner: TenantTransactionRunner;
  readonly passes: PassRepository;
  readonly flow: DestinationFlowRepository;
  readonly policy: PolicyRepository;
  readonly placement: ExpectedPlacementResolver;
  readonly outbox: OutboxWriter;
}

function toAggregate(row: PassRow, requestSource: string): PassAggregate {
  return {
    id: row.id,
    tenantId: row.tenantId,
    organizationId: row.organizationId,
    studentId: row.studentId,
    originLocationId: row.originLocationId,
    originSectionId: row.originSectionId,
    originScheduleBlockId: row.originScheduleBlockId,
    destinationId: row.destinationId,
    returnLocationId: row.returnLocationId,
    requestSource: requestSource as PassAggregate['requestSource'],
    requestedByPersonId: row.requestedByPersonId,
    requestedAt: row.requestedAt,
    lifecycleState: row.lifecycleState as PassAggregate['lifecycleState'],
    expectedReturnAt: row.expectedReturnAt,
    scheduledAuthorizationId: row.scheduledAuthorizationId,
    revision: row.revision,
  };
}

function staleRevision(): PassApplicationError {
  return new PassApplicationError(
    'stale_pass_revision',
    'The pass has changed since this client last read it.',
  );
}

type PromotionAttempt = 'done' | 'deferred';

const QUEUE_SCAN_LIMIT = 20;

/**
 * Durable destination-flow worker. The database is the work source: every
 * action re-reads under the pass row lock (then the destination-flow lock),
 * so correctness survives process crashes, multiple API replicas, and worker
 * restarts. Never mutates outbound/at_destination/returning passes: once an
 * explicit departure is recorded, only explicit movement actions resolve it.
 * One pass transition per transaction; system provenance throughout.
 */
export class DestinationFlowReconciler {
  constructor(private readonly dependencies: ReconcilerDependencies) {}

  /** Runs a single candidate action. Returns true when work was done. */
  async runOne(): Promise<boolean> {
    const now = this.dependencies.clock.now();
    const tenants = await this.dependencies.flow.listTenantIds();
    for (const tenantId of tenants) {
      if (await this.runOneForTenant(tenantId, now)) return true;
    }
    return false;
  }

  /** Runs up to `limit` actions. Returns the number completed. */
  async runBatch(limit: number): Promise<number> {
    if (!Number.isInteger(limit) || limit <= 0) return 0;
    const now = this.dependencies.clock.now();
    // One tenant scan per batch. A tenant that just did work rotates to the
    // back, so an early productive tenant cannot starve later tenants.
    const pending = [...(await this.dependencies.flow.listTenantIds())];
    let completed = 0;
    while (completed < limit && pending.length > 0) {
      const tenantId = pending.shift();
      if (tenantId === undefined) break;
      if (await this.runOneForTenant(tenantId, now)) {
        completed += 1;
        pending.push(tenantId);
      }
    }
    return completed;
  }

  private async runOneForTenant(tenantId: string, now: Temporal.Instant): Promise<boolean> {
    const { runner } = this.dependencies;
    const staleReady = await runner.run(tenantId, (context) =>
      this.dependencies.flow.findStaleReadyCandidate(context, now),
    );
    if (
      staleReady !== null &&
      (await this.handleStaleReady(tenantId, staleReady.reservation, now))
    ) {
      return true;
    }
    const expiredQueue = await runner.run(tenantId, (context) =>
      this.dependencies.flow.findExpiredQueueCandidate(context, now),
    );
    if (
      expiredQueue !== null &&
      (await this.handleExpiredQueue(tenantId, expiredQueue.entry.passId, now))
    ) {
      return true;
    }
    const unavailable = await runner.run(tenantId, (context) =>
      this.dependencies.flow.findUnavailableFlowCandidate(context),
    );
    if (
      unavailable !== null &&
      (await this.handleUnavailableFlow(tenantId, unavailable.passId, now))
    ) {
      return true;
    }
    const destinations = await runner.run(tenantId, (context) =>
      this.dependencies.flow.listQueuedDestinationIds(context, QUEUE_SCAN_LIMIT),
    );
    for (const destinationId of destinations) {
      if ((await this.tryPromoteDestination(tenantId, destinationId, now)) === 'done') return true;
    }
    const orphaned = await runner.run(tenantId, (context) =>
      this.dependencies.flow.findOrphanedFlowRows(context),
    );
    if (orphaned !== null && (await this.handleOrphanedRows(tenantId, orphaned.passId, now))) {
      return true;
    }
    return false;
  }

  /**
   * Missed ready offer. Flow expired or queue disabled or nobody waiting:
   * expire. Another waiter: release the offer and move this student to the
   * back of the queue with the ORIGINAL flow deadline preserved.
   */
  private async handleStaleReady(
    tenantId: string,
    candidate: FlowReservationRow,
    now: Temporal.Instant,
  ): Promise<boolean> {
    const { runner, passes, flow, outbox } = this.dependencies;
    return runner.run(tenantId, async (context) => {
      const pass = await passes.loadPassForUpdate(context, candidate.passId);
      if (pass?.tenantId !== tenantId || pass.lifecycleState !== 'ready') return false;
      const reservation = await flow.loadActiveReservationForPass(context, pass.id);
      if (
        reservation?.id !== candidate.id ||
        reservation.claimedAt !== null ||
        Temporal.Instant.compare(now, reservation.readyExpiresAt) < 0
      ) {
        return false;
      }
      await flow.acquireDestinationLock(
        context,
        destinationFlowLockKey(tenantId, pass.destinationId),
      );
      const config = await flow.loadDestinationConfig(context, pass.destinationId);
      if (config === null) return false;
      if (config.status === 'closed' || config.status === 'archived') {
        await this.denyPreDeparture(
          context,
          pass,
          { kind: 'reservation', id: reservation.id },
          'destination_unavailable',
          now,
        );
        return true;
      }
      if (Temporal.Instant.compare(now, reservation.flowExpiresAt) >= 0 || !config.queueEnabled) {
        await this.expireReadyOffer(context, pass, reservation, now);
        return true;
      }
      const waiting = await flow.countActiveQueueEntries(context, pass.destinationId, pass.id);
      if (waiting > 0) {
        await flow.releaseReservation(context, reservation.id, 'ready_claim_expired', now);
        const entry = await flow.createQueueEntry(context, {
          organizationId: pass.organizationId,
          destinationId: pass.destinationId,
          passId: pass.id,
          policyEvaluationId: reservation.policyEvaluationId,
          enteredAt: now,
          flowExpiresAt: reservation.flowExpiresAt,
        });
        try {
          transitionPass(toAggregate(pass, pass.requestSource), 'queued');
        } catch {
          throw new PassApplicationError(
            'invalid_pass_transition',
            'This ready offer cannot be requeued.',
          );
        }
        const queued = await passes.updatePassToQueued(context, pass.id, pass.revision, now);
        if (queued === null) throw staleRevision();
        await passes.appendPassEvent(context, {
          passId: pass.id,
          sequence: queued.revision,
          eventType: 'pass.queued',
          actorKind: 'system',
          actorPersonId: null,
          occurredAt: now,
          metadata: {
            schemaVersion: 1,
            state: 'queued',
            revision: queued.revision.toString(10),
            reasonCode: 'ready_claim_expired',
            queueExpiresAt: entry.flowExpiresAt.toString(),
          },
        });
        await outbox.append(context, {
          tenantId: pass.tenantId,
          organizationId: pass.organizationId,
          aggregateKind: 'pass',
          aggregateId: pass.id,
          eventType: 'pass.queued',
          occurredAt: now.toString(),
          payload: {
            schemaVersion: 1,
            passId: pass.id,
            organizationId: pass.organizationId,
            studentId: pass.studentId,
            lifecycleState: 'queued',
            revision: queued.revision.toString(10),
            destinationId: pass.destinationId,
            reasonCode: 'ready_claim_expired',
          },
        });
        return true;
      }
      // Queue enabled but nobody else waits: expire rather than offering the
      // same unused slot forever.
      await this.expireReadyOffer(context, pass, reservation, now);
      return true;
    });
  }

  private async expireReadyOffer(
    context: TenantTransactionContext,
    pass: PassRow,
    reservation: FlowReservationRow,
    now: Temporal.Instant,
  ): Promise<void> {
    const { passes, flow, policy, outbox } = this.dependencies;
    await flow.releaseReservation(context, reservation.id, 'ready_claim_expired', now);
    try {
      transitionPass(toAggregate(pass, pass.requestSource), 'expired');
    } catch {
      throw new PassApplicationError('invalid_pass_transition', 'This ready offer cannot expire.');
    }
    const expired = await passes.updatePassToExpired(context, pass.id, pass.revision, now);
    if (expired === null) throw staleRevision();
    await passes.appendPassEvent(context, {
      passId: pass.id,
      sequence: expired.revision,
      eventType: 'pass.expired',
      actorKind: 'system',
      actorPersonId: null,
      occurredAt: now,
      metadata: {
        schemaVersion: 1,
        state: 'expired',
        revision: expired.revision.toString(10),
        reasonCode: 'ready_claim_expired',
      },
    });
    await outbox.append(context, {
      tenantId: pass.tenantId,
      organizationId: pass.organizationId,
      aggregateKind: 'pass',
      aggregateId: pass.id,
      eventType: 'pass.expired',
      occurredAt: now.toString(),
      payload: {
        schemaVersion: 1,
        passId: pass.id,
        organizationId: pass.organizationId,
        studentId: pass.studentId,
        lifecycleState: 'expired',
        revision: expired.revision.toString(10),
        destinationId: pass.destinationId,
        reasonCode: 'ready_claim_expired',
      },
    });
    await policy.cancelAllPendingWorkflows(context, pass.id, now);
  }

  /** Overall flow deadline passed while queued: expire, no replacement. */
  private async handleExpiredQueue(
    tenantId: string,
    passId: string,
    now: Temporal.Instant,
  ): Promise<boolean> {
    const { runner, passes, flow, policy, outbox } = this.dependencies;
    return runner.run(tenantId, async (context) => {
      const pass = await passes.loadPassForUpdate(context, passId);
      if (pass?.tenantId !== tenantId || pass.lifecycleState !== 'queued') return false;
      const entry = await flow.loadActiveQueueEntryForPass(context, pass.id);
      if (entry === null || Temporal.Instant.compare(now, entry.flowExpiresAt) < 0) return false;
      await flow.releaseQueueEntry(context, entry.id, 'expired', now);
      try {
        transitionPass(toAggregate(pass, pass.requestSource), 'expired');
      } catch {
        throw new PassApplicationError(
          'invalid_pass_transition',
          'This queued pass cannot expire.',
        );
      }
      const expired = await passes.updatePassToExpired(context, pass.id, pass.revision, now);
      if (expired === null) throw staleRevision();
      await passes.appendPassEvent(context, {
        passId: pass.id,
        sequence: expired.revision,
        eventType: 'pass.expired',
        actorKind: 'system',
        actorPersonId: null,
        occurredAt: now,
        metadata: {
          schemaVersion: 1,
          state: 'expired',
          revision: expired.revision.toString(10),
          reasonCode: 'queue_timeout',
        },
      });
      await outbox.append(context, {
        tenantId: pass.tenantId,
        organizationId: pass.organizationId,
        aggregateKind: 'pass',
        aggregateId: pass.id,
        eventType: 'pass.expired',
        occurredAt: now.toString(),
        payload: {
          schemaVersion: 1,
          passId: pass.id,
          organizationId: pass.organizationId,
          studentId: pass.studentId,
          lifecycleState: 'expired',
          revision: expired.revision.toString(10),
          destinationId: pass.destinationId,
          reasonCode: 'queue_timeout',
        },
      });
      await policy.cancelAllPendingWorkflows(context, pass.id, now);
      return true;
    });
  }

  /** Destination closed/archived before departure: operational denial. */
  private async handleUnavailableFlow(
    tenantId: string,
    passId: string,
    now: Temporal.Instant,
  ): Promise<boolean> {
    const { runner, passes, flow } = this.dependencies;
    return runner.run(tenantId, async (context) => {
      const pass = await passes.loadPassForUpdate(context, passId);
      if (
        pass?.tenantId !== tenantId ||
        (pass.lifecycleState !== 'queued' && pass.lifecycleState !== 'ready')
      ) {
        return false;
      }
      const config = await flow.loadDestinationConfig(context, pass.destinationId);
      if (config === null || (config.status !== 'closed' && config.status !== 'archived')) {
        return false;
      }
      await flow.acquireDestinationLock(
        context,
        destinationFlowLockKey(tenantId, pass.destinationId),
      );
      if (pass.lifecycleState === 'queued') {
        const entry = await flow.loadActiveQueueEntryForPass(context, pass.id);
        if (entry === null) return false;
        await this.denyPreDeparture(
          context,
          pass,
          { kind: 'queue', id: entry.id },
          'destination_unavailable',
          now,
        );
        return true;
      }
      const reservation = await flow.loadActiveReservationForPass(context, pass.id);
      if (reservation?.claimedAt !== null) return false;
      await this.denyPreDeparture(
        context,
        pass,
        { kind: 'reservation', id: reservation.id },
        'destination_unavailable',
        now,
      );
      return true;
    });
  }

  private async denyPreDeparture(
    context: TenantTransactionContext,
    pass: PassRow,
    active: { readonly kind: 'queue' | 'reservation'; readonly id: string },
    reasonCode: 'destination_unavailable',
    now: Temporal.Instant,
  ): Promise<void> {
    const { passes, flow, policy, outbox } = this.dependencies;
    if (active.kind === 'queue') {
      await flow.releaseQueueEntry(context, active.id, reasonCode, now);
    } else {
      await flow.releaseReservation(context, active.id, reasonCode, now);
    }
    try {
      transitionPass(toAggregate(pass, pass.requestSource), 'denied');
    } catch {
      throw new PassApplicationError('invalid_pass_transition', 'This pass cannot be denied.');
    }
    const denied = await passes.updatePassToDenied(context, pass.id, pass.revision, now);
    if (denied === null) throw staleRevision();
    await passes.appendPassEvent(context, {
      passId: pass.id,
      sequence: denied.revision,
      eventType: 'pass.denied',
      actorKind: 'system',
      actorPersonId: null,
      occurredAt: now,
      metadata: {
        schemaVersion: 1,
        state: 'denied',
        revision: denied.revision.toString(10),
        reasonCode,
      },
    });
    await outbox.append(context, {
      tenantId: pass.tenantId,
      organizationId: pass.organizationId,
      aggregateKind: 'pass',
      aggregateId: pass.id,
      eventType: 'pass.denied',
      occurredAt: now.toString(),
      payload: {
        schemaVersion: 1,
        passId: pass.id,
        organizationId: pass.organizationId,
        studentId: pass.studentId,
        lifecycleState: 'denied',
        revision: denied.revision.toString(10),
        destinationId: pass.destinationId,
        reasonCode,
      },
    });
    await policy.cancelAllPendingWorkflows(context, pass.id, now);
  }

  /**
   * Queue-head promotion for one destination. Only the exact head is
   * eligible; when it cannot be safely processed this tick the destination
   * is skipped rather than leapfrogged. Fresh policy is evaluated at
   * promotion time and the new reservation binds that evaluation, never the
   * stale one from queue entry.
   */
  private async tryPromoteDestination(
    tenantId: string,
    destinationId: string,
    now: Temporal.Instant,
  ): Promise<PromotionAttempt> {
    const { runner, flow, placement } = this.dependencies;
    const discovered = await runner.run(tenantId, (context) =>
      flow.loadQueueHead(context, destinationId),
    );
    if (discovered?.passLifecycleState !== 'queued') return 'deferred';
    if (Temporal.Instant.compare(now, discovered.entry.flowExpiresAt) >= 0) return 'deferred';
    // Approximate capacity gate before the authoritative transaction.
    const approx = await runner.run(tenantId, (context) =>
      (async () => {
        const config = await flow.loadDestinationConfig(context, destinationId);
        if (config === null) return null;
        const consuming = await flow.countConsumingReservations(context, destinationId, now);
        return { config, consuming };
      })(),
    );
    if (
      approx === null ||
      approx.config.status === 'closed' ||
      approx.config.status === 'archived' ||
      (approx.config.capacity !== null && approx.consuming >= approx.config.capacity)
    ) {
      return 'deferred';
    }
    const current = await placement.resolve({
      tenantId,
      organizationId: discovered.organizationId,
      personId: discovered.studentId,
      at: now,
    });
    return runner.run(tenantId, async (context) => {
      const { passes, policy, outbox } = this.dependencies;
      const pass = await passes.loadPassForUpdate(context, discovered.entry.passId);
      if (pass?.tenantId !== tenantId || pass.lifecycleState !== 'queued') return 'deferred';
      const head = await flow.loadQueueHead(context, destinationId);
      if (head?.entry.id !== discovered.entry.id) return 'deferred';
      const entry = await flow.loadActiveQueueEntryForPass(context, pass.id);
      if (entry?.id !== discovered.entry.id) return 'deferred';
      if (Temporal.Instant.compare(now, entry.flowExpiresAt) >= 0) return 'deferred';
      await flow.acquireDestinationLock(context, destinationFlowLockKey(tenantId, destinationId));
      const config = await flow.loadDestinationConfig(context, destinationId);
      if (config === null) return 'deferred';
      if (config.status === 'closed' || config.status === 'archived') return 'deferred';
      const consuming = await flow.countConsumingReservations(context, destinationId, now);
      if (config.capacity !== null && consuming >= config.capacity) return 'deferred';
      const decided = await evaluateAndPersistPolicy(context, policy, {
        pass: {
          id: pass.id,
          revision: pass.revision,
          organizationId: pass.organizationId,
          studentId: pass.studentId,
          destinationId: pass.destinationId,
          requestSource: pass.requestSource,
          originBlockId: pass.originScheduleBlockId,
          originSectionId: pass.originSectionId,
          originLocationId: pass.originLocationId,
        },
        placement: current,
        at: now,
        stage: 'reevaluation',
      });
      const reconciled = await reconcilePendingApprovals(context, policy, {
        organizationId: pass.organizationId,
        passId: pass.id,
        outcome: decided.outcome,
        resultIdsByRule: decided.resultIdsByRule,
        at: now,
      });
      const reasonCodes: string[] = [];
      for (const result of decided.outcome.results) {
        if (!reasonCodes.includes(result.reasonCode)) reasonCodes.push(result.reasonCode);
      }
      await outbox.append(context, {
        tenantId: pass.tenantId,
        organizationId: pass.organizationId,
        aggregateKind: 'pass',
        aggregateId: pass.id,
        eventType: 'pass.policy_evaluated',
        occurredAt: now.toString(),
        payload: {
          schemaVersion: 1,
          passId: pass.id,
          organizationId: pass.organizationId,
          studentId: pass.studentId,
          passRevision: pass.revision.toString(10),
          decision: decided.outcome.decision,
          reasonCodes,
          approvalPending: reconciled.kept.length > 0,
          overrideAvailable: decided.outcome.results.some(
            (result) => result.contribution === 'override_required',
          ),
        },
      });
      for (const approval of reconciled.created) {
        await outbox.append(context, {
          tenantId: pass.tenantId,
          organizationId: pass.organizationId,
          aggregateKind: 'pass',
          aggregateId: pass.id,
          eventType: 'pass.approval_required',
          occurredAt: now.toString(),
          payload: {
            schemaVersion: 1,
            approvalId: approval.id,
            passId: pass.id,
            organizationId: pass.organizationId,
            studentId: pass.studentId,
            requiredSectionId: approval.requiredSectionId,
            passRevision: pass.revision.toString(10),
          },
        });
      }
      if (decided.outcome.decision === 'deny') {
        await flow.releaseQueueEntry(context, entry.id, 'pass_terminal', now);
        try {
          transitionPass(toAggregate(pass, pass.requestSource), 'denied');
        } catch {
          throw new PassApplicationError('invalid_pass_transition', 'This pass cannot be denied.');
        }
        const denied = await passes.updatePassToDenied(context, pass.id, pass.revision, now);
        if (denied === null) throw staleRevision();
        await passes.appendPassEvent(context, {
          passId: pass.id,
          sequence: denied.revision,
          eventType: 'pass.denied',
          actorKind: 'system',
          actorPersonId: null,
          occurredAt: now,
          metadata: {
            schemaVersion: 1,
            state: 'denied',
            revision: denied.revision.toString(10),
          },
        });
        await outbox.append(context, {
          tenantId: pass.tenantId,
          organizationId: pass.organizationId,
          aggregateKind: 'pass',
          aggregateId: pass.id,
          eventType: 'pass.denied',
          occurredAt: now.toString(),
          payload: {
            schemaVersion: 1,
            passId: pass.id,
            organizationId: pass.organizationId,
            studentId: pass.studentId,
            lifecycleState: 'denied',
            revision: denied.revision.toString(10),
            destinationId: pass.destinationId,
          },
        });
        await policy.cancelAllPendingWorkflows(context, pass.id, now);
        return 'done';
      }
      if (
        decided.outcome.decision === 'approval_required' ||
        decided.outcome.decision === 'override_required'
      ) {
        // Policy is no longer clear: leave the queue without occupying a
        // position. Current approvals were reconciled above.
        await flow.releaseQueueEntry(context, entry.id, 'policy_changed', now);
        try {
          transitionPass(toAggregate(pass, pass.requestSource), 'requested');
        } catch {
          throw new PassApplicationError(
            'invalid_pass_transition',
            'This queued pass cannot return to requested.',
          );
        }
        const requested = await passes.updatePassToRequested(context, pass.id, pass.revision, now);
        if (requested === null) throw staleRevision();
        await passes.appendPassEvent(context, {
          passId: pass.id,
          sequence: requested.revision,
          eventType: 'pass.readiness_revoked',
          actorKind: 'system',
          actorPersonId: null,
          occurredAt: now,
          metadata: {
            schemaVersion: 1,
            state: 'requested',
            revision: requested.revision.toString(10),
            reasonCode: 'policy_clearance_lost',
          },
        });
        await outbox.append(context, {
          tenantId: pass.tenantId,
          organizationId: pass.organizationId,
          aggregateKind: 'pass',
          aggregateId: pass.id,
          eventType: 'pass.readiness_revoked',
          occurredAt: now.toString(),
          payload: {
            schemaVersion: 1,
            passId: pass.id,
            organizationId: pass.organizationId,
            studentId: pass.studentId,
            lifecycleState: 'requested',
            revision: requested.revision.toString(10),
            destinationId: pass.destinationId,
            reasonCode: 'policy_clearance_lost',
          },
        });
        return 'done';
      }
      // Allow: promote with a reservation bound to the fresh evaluation.
      const claimDeadline = now.add({ seconds: config.readyClaimTimeoutSeconds });
      const readyExpiresAt =
        Temporal.Instant.compare(claimDeadline, entry.flowExpiresAt) < 0
          ? claimDeadline
          : entry.flowExpiresAt;
      await flow.releaseQueueEntry(context, entry.id, 'promoted', now);
      const reservation = await flow.createReservation(context, {
        organizationId: pass.organizationId,
        destinationId: pass.destinationId,
        passId: pass.id,
        policyEvaluationId: decided.evaluationId,
        reservedAt: now,
        readyExpiresAt,
        flowExpiresAt: entry.flowExpiresAt,
      });
      try {
        transitionPass(toAggregate(pass, pass.requestSource), 'ready');
      } catch {
        throw new PassApplicationError('invalid_pass_transition', 'This pass cannot become ready.');
      }
      const ready = await passes.updatePassToReady(context, pass.id, pass.revision, now);
      if (ready === null) throw staleRevision();
      await passes.appendPassEvent(context, {
        passId: pass.id,
        sequence: ready.revision,
        eventType: 'pass.ready',
        actorKind: 'system',
        actorPersonId: null,
        occurredAt: now,
        metadata: {
          schemaVersion: 1,
          state: 'ready',
          revision: ready.revision.toString(10),
          readyUntil: reservation.readyExpiresAt.toString(),
          flowExpiresAt: reservation.flowExpiresAt.toString(),
        },
      });
      await outbox.append(context, {
        tenantId: pass.tenantId,
        organizationId: pass.organizationId,
        aggregateKind: 'pass',
        aggregateId: pass.id,
        eventType: 'pass.ready',
        occurredAt: now.toString(),
        payload: {
          schemaVersion: 1,
          passId: pass.id,
          organizationId: pass.organizationId,
          studentId: pass.studentId,
          lifecycleState: 'ready',
          revision: ready.revision.toString(10),
          destinationId: pass.destinationId,
          readyUntil: reservation.readyExpiresAt.toString(),
        },
      });
      return 'done';
    });
  }

  /** Defensive release of flow rows stranded on an already-terminal pass. */
  private async handleOrphanedRows(
    tenantId: string,
    passId: string,
    now: Temporal.Instant,
  ): Promise<boolean> {
    const { runner, passes, flow } = this.dependencies;
    return runner.run(tenantId, async (context) => {
      const pass = await passes.loadPassForUpdate(context, passId);
      if (pass?.tenantId !== tenantId) return false;
      if (
        pass.lifecycleState !== 'completed' &&
        pass.lifecycleState !== 'denied' &&
        pass.lifecycleState !== 'cancelled' &&
        pass.lifecycleState !== 'expired'
      ) {
        return false;
      }
      const reservation = await flow.loadActiveReservationForPass(context, pass.id);
      const entry = await flow.loadActiveQueueEntryForPass(context, pass.id);
      if (reservation === null && entry === null) return false;
      if (reservation !== null) {
        await flow.releaseReservation(context, reservation.id, 'pass_terminal', now);
      }
      if (entry !== null) {
        await flow.releaseQueueEntry(context, entry.id, 'pass_terminal', now);
      }
      return true;
    });
  }
}
