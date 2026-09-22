import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import {
  cancelPass,
  canTransition,
  createRequestedPass,
  InvalidPassTransitionError,
  isCancellableState,
  isTerminalState,
  STATE_EVENT,
  transitionPass,
  type PassLifecycleState,
} from '../src/index.js';

const ALL_STATES: readonly PassLifecycleState[] = [
  'requested',
  'queued',
  'ready',
  'outbound',
  'at_destination',
  'returning',
  'completed',
  'denied',
  'cancelled',
  'expired',
];

const EXPECTED_EDGES: Readonly<Record<PassLifecycleState, readonly PassLifecycleState[]>> = {
  requested: ['queued', 'ready', 'denied', 'cancelled', 'expired'],
  queued: ['requested', 'ready', 'denied', 'cancelled', 'expired'],
  ready: ['queued', 'outbound', 'denied', 'cancelled', 'expired'],
  outbound: ['at_destination', 'completed'],
  at_destination: ['returning', 'completed'],
  returning: ['completed'],
  completed: [],
  denied: [],
  cancelled: [],
  expired: [],
};

function requestedAggregate() {
  return createRequestedPass({
    id: '019abc00-0000-7000-8000-000000000001',
    tenantId: '019abc00-0000-7000-8000-000000000010',
    organizationId: '019abc00-0000-7000-8000-000000000020',
    studentId: '019abc00-0000-7000-8000-000000000030',
    destinationRoomId: '019abc00-0000-7000-8000-000000000040',
    requestSource: 'student_web',
    requestedByPersonId: '019abc00-0000-7000-8000-000000000030',
    requestedAt: Temporal.Instant.from('2026-09-20T14:00:00Z'),
  });
}

describe('pass lifecycle matrix', () => {
  it.each(ALL_STATES)('allows exactly the documented transitions from %s', (from) => {
    const allowed = ALL_STATES.filter((to) => canTransition(from, to));
    expect(allowed).toEqual([...EXPECTED_EDGES[from]]);
  });

  it('marks completed/denied/cancelled/expired terminal with no exits', () => {
    for (const terminal of ['completed', 'denied', 'cancelled', 'expired'] as const) {
      expect(isTerminalState(terminal)).toBe(true);
      expect(EXPECTED_EDGES[terminal]).toEqual([]);
    }
    for (const live of [
      'requested',
      'queued',
      'ready',
      'outbound',
      'at_destination',
      'returning',
    ] as const) {
      expect(isTerminalState(live)).toBe(false);
    }
  });

  it('defines cancellable pre-departure states as requested/queued/ready', () => {
    expect(isCancellableState('requested')).toBe(true);
    expect(isCancellableState('queued')).toBe(true);
    expect(isCancellableState('ready')).toBe(true);
    expect(isCancellableState('outbound')).toBe(false);
    expect(isCancellableState('completed')).toBe(false);
  });
});

describe('pass aggregate revision invariant', () => {
  it('creates requested passes at revision 1', () => {
    const aggregate = requestedAggregate();
    expect(aggregate.lifecycleState).toBe('requested');
    expect(aggregate.revision).toBe(1n);
    expect(aggregate.expectedReturnAt).toBeNull();
    expect(aggregate.scheduledAuthorizationId).toBeNull();
    expect(aggregate.returnRoomId).toBeNull();
  });

  it('increments revision exactly once per transition with matching event', () => {
    let aggregate = requestedAggregate();
    const path: PassLifecycleState[] = [
      'queued',
      'ready',
      'outbound',
      'at_destination',
      'returning',
      'completed',
    ];
    let expected = 1n;
    for (const next of path) {
      const result = transitionPass(aggregate, next);
      expected += 1n;
      expect(result.aggregate.revision).toBe(expected);
      expect(result.aggregate.lifecycleState).toBe(next);
      expect(result.event).toBe(STATE_EVENT[next]);
      // The input aggregate is untouched (pure transition).
      expect(aggregate.revision).toBe(expected - 1n);
      aggregate = result.aggregate;
    }
    expect(aggregate.revision).toBe(7n);
  });

  it('rejects invalid transitions without mutating the aggregate', () => {
    const aggregate = requestedAggregate();
    expect(() => transitionPass(aggregate, 'outbound')).toThrow(InvalidPassTransitionError);
    expect(() => transitionPass(aggregate, 'completed')).toThrow(InvalidPassTransitionError);
    expect(aggregate.lifecycleState).toBe('requested');
    expect(aggregate.revision).toBe(1n);
  });

  it('never transitions out of terminal states', () => {
    for (const terminal of ['completed', 'denied', 'cancelled', 'expired'] as const) {
      const aggregate = { ...requestedAggregate(), lifecycleState: terminal, revision: 4n };
      for (const next of ALL_STATES) {
        expect(() => transitionPass(aggregate, next)).toThrow(InvalidPassTransitionError);
      }
      expect(aggregate.revision).toBe(4n);
    }
  });

  it('cancels from requested/queued/ready but not from outbound or later', () => {
    for (const state of ['requested', 'queued', 'ready'] as const) {
      const aggregate = { ...requestedAggregate(), lifecycleState: state, revision: 2n };
      const result = cancelPass(aggregate);
      expect(result.aggregate.lifecycleState).toBe('cancelled');
      expect(result.aggregate.revision).toBe(3n);
      expect(result.event).toBe('pass.cancelled');
    }
    for (const state of ['outbound', 'at_destination', 'returning'] as const) {
      const aggregate = { ...requestedAggregate(), lifecycleState: state, revision: 2n };
      expect(() => cancelPass(aggregate)).toThrow(InvalidPassTransitionError);
      expect(aggregate.revision).toBe(2n);
    }
  });

  it('exposes no generic setState API', async () => {
    const module = await import('../src/passes/aggregate.js');
    expect('setState' in module).toBe(false);
    expect(typeof module.transitionPass).toBe('function');
    expect(typeof module.createRequestedPass).toBe('function');
  });
});
