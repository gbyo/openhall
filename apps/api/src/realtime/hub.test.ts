import { describe, expect, it } from 'vitest';
import type { ObservedOutboxEvent } from '@openhall/db';
import { RealtimeHub, topicsFor, type RealtimeSubscriberContext } from './hub.js';

const subscriber: RealtimeSubscriberContext = {
  tenantId: 'tenant-a',
  personId: 'student-a',
  organizationId: 'school-a',
  affiliations: ['student', 'staff'],
  capabilities: ['pass.view.school_live', 'schedule.view', 'audit.view'],
  teachingSectionIds: ['section-a'],
  staffedRoomIds: ['room-a'],
  teachingRoomIds: ['room-b'],
};

function event(overrides: Partial<ObservedOutboxEvent> = {}): ObservedOutboxEvent {
  return {
    id: 'event-a',
    tenantId: 'tenant-a',
    organizationId: 'school-a',
    aggregateKind: 'pass',
    aggregateId: 'pass-a',
    eventType: 'pass.departed',
    payload: {
      studentId: 'student-a',
      originSectionId: 'section-a',
      destinationRoomId: 'room-a',
    },
    ...overrides,
  };
}

describe('realtime topic isolation', () => {
  it('emits only topics already authorized by subscriber context', () => {
    expect(topicsFor(event(), subscriber)).toEqual([
      'self-pass',
      'school-live',
      'section-live:section-a',
      'station:room-a',
      'audit',
    ]);
  });

  it('reveals nothing across tenant or school boundaries', () => {
    expect(topicsFor(event({ tenantId: 'tenant-b' }), subscriber)).toEqual([]);
    expect(topicsFor(event({ organizationId: 'school-b' }), subscriber)).toEqual([]);
  });

  it('uses authorized broad section invalidation when legacy pass metadata lacks origin', () => {
    expect(topicsFor(event({ payload: { studentId: 'other-student' } }), subscriber)).toContain(
      'section-live:section-a',
    );
  });

  it('notifies explicit room staff of room-responsible approvals', () => {
    const topics = topicsFor(
      event({ payload: { studentId: 'other-student', requiredRoomId: 'room-a' } }),
      subscriber,
    );
    expect(topics).toContain('requests');
  });

  it('notifies schedule-derived classroom teachers of room-responsible approvals', () => {
    const topics = topicsFor(
      event({ payload: { studentId: 'other-student', requiredRoomId: 'room-b' } }),
      subscriber,
    );
    expect(topics).toContain('requests');
  });

  it('does not leak room approvals to unrelated staff', () => {
    const topics = topicsFor(
      event({ payload: { studentId: 'other-student', requiredRoomId: 'room-z' } }),
      subscriber,
    );
    expect(topics).not.toContain('requests');
  });

  it('maps room aggregates to the rooms topic', () => {
    expect(topicsFor(event({ aggregateKind: 'room', payload: {} }), subscriber)).toContain('rooms');
    expect(topicsFor(event({ aggregateKind: 'room_category', payload: {} }), subscriber)).toContain(
      'rooms',
    );
  });

  it('broadcasts listener health changes and stops after unsubscribe', () => {
    const hub = new RealtimeHub();
    const received: string[] = [];
    const unsubscribe = hub.subscribe(subscriber, (message) => received.push(message.event));
    hub.setListenerHealthy(true);
    hub.observe(event());
    hub.setListenerHealthy(false);
    unsubscribe();
    hub.setListenerHealthy(true);
    expect(received).toEqual(['resync', 'invalidate', 'realtime-unavailable']);
  });
});
