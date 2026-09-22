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
  staffedDestinationIds: ['destination-a'],
  teachingLocationIds: ['location-a'],
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
      destinationId: 'destination-a',
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
      'station:destination-a',
      'audit',
    ]);
  });

  it('reveals nothing across tenant or school boundaries', () => {
    expect(topicsFor(event({ tenantId: 'tenant-b' }), subscriber)).toEqual([]);
    expect(topicsFor(event({ organizationId: 'school-b' }), subscriber)).toEqual([]);
  });

  it('invalidates requests for the required destination staff', () => {
    const approval = event({
      eventType: 'pass.approval_required',
      payload: {
        studentId: 'other-student',
        originSectionId: 'section-other',
        requiredSectionId: null,
        requiredDestinationId: 'destination-a',
      },
    });
    expect(topicsFor(approval, subscriber)).toContain('requests');
    const unstaffed = { ...subscriber, staffedDestinationIds: [] as string[] };
    expect(topicsFor(approval, unstaffed)).not.toContain('requests');
  });

  it('invalidates requests for schedule-derived classroom teachers', () => {
    // A classroom teacher with no explicit destination grant still
    // approves when their sections meet at the destination's location.
    const scheduleTeacher: RealtimeSubscriberContext = {
      ...subscriber,
      teachingSectionIds: ['section-b'],
      staffedDestinationIds: [],
      teachingLocationIds: ['location-room-214'],
    };
    const approval = event({
      eventType: 'pass.approval_required',
      payload: {
        studentId: 'other-student',
        originSectionId: 'section-other',
        requiredSectionId: null,
        requiredDestinationId: 'destination-room-214',
        requiredDestinationLocationId: 'location-room-214',
      },
    });
    expect(topicsFor(approval, scheduleTeacher)).toContain('requests');
    const elsewhere = {
      ...scheduleTeacher,
      teachingLocationIds: ['location-gym'],
    };
    expect(topicsFor(approval, elsewhere)).not.toContain('requests');
  });

  it('uses authorized broad section invalidation when legacy pass metadata lacks origin', () => {
    expect(topicsFor(event({ payload: { studentId: 'other-student' } }), subscriber)).toContain(
      'section-live:section-a',
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
