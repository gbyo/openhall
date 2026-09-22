import type { Capability } from '@openhall/application';
import type { ObservedOutboxEvent } from '@openhall/db';

export interface RealtimeSubscriberContext {
  readonly tenantId: string;
  readonly personId: string;
  readonly organizationId: string;
  readonly affiliations: readonly string[];
  readonly capabilities: readonly Capability[];
  readonly teachingSectionIds: readonly string[];
  readonly staffedRoomIds: readonly string[];
  readonly teachingRoomIds: readonly string[];
}

export type RealtimeMessage =
  | { readonly event: 'resync'; readonly data: Record<string, never> }
  | { readonly event: 'invalidate'; readonly data: { readonly topics: readonly string[] } }
  | { readonly event: 'realtime-unavailable'; readonly data: Record<string, never> };

interface Subscriber {
  readonly context: RealtimeSubscriberContext;
  readonly send: (message: RealtimeMessage) => void;
}

function stringField(payload: Readonly<Record<string, unknown>>, name: string): string | null {
  const value = payload[name];
  return typeof value === 'string' ? value : null;
}

export class RealtimeHub {
  private readonly subscribers = new Set<Subscriber>();
  private listenerHealthy = false;

  get healthy(): boolean {
    return this.listenerHealthy;
  }

  subscribe(
    context: RealtimeSubscriberContext,
    send: (message: RealtimeMessage) => void,
  ): () => void {
    const subscriber = { context, send };
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  observe(event: ObservedOutboxEvent): void {
    for (const subscriber of this.subscribers) {
      const topics = topicsFor(event, subscriber.context);
      if (topics.length > 0) subscriber.send({ event: 'invalidate', data: { topics } });
    }
  }

  setListenerHealthy(healthy: boolean): void {
    this.listenerHealthy = healthy;
    for (const subscriber of this.subscribers) {
      subscriber.send(
        healthy ? { event: 'resync', data: {} } : { event: 'realtime-unavailable', data: {} },
      );
    }
  }
}

export function topicsFor(
  event: ObservedOutboxEvent,
  subscriber: RealtimeSubscriberContext,
): string[] {
  if (
    event.tenantId !== subscriber.tenantId ||
    event.organizationId !== subscriber.organizationId
  ) {
    return [];
  }
  const topics = new Set<string>();
  const payload = event.payload;
  const studentId = stringField(payload, 'studentId');
  const destinationRoomId = stringField(payload, 'destinationRoomId');
  const originSectionId = stringField(payload, 'originSectionId');
  const requiredSectionId = stringField(payload, 'requiredSectionId');
  const requiredRoomId = stringField(payload, 'requiredRoomId');

  if (event.aggregateKind === 'pass') {
    if (studentId === subscriber.personId) topics.add('self-pass');
    if (subscriber.capabilities.includes('pass.view.school_live')) topics.add('school-live');
    if (originSectionId !== null && subscriber.teachingSectionIds.includes(originSectionId)) {
      topics.add(`section-live:${originSectionId}`);
    } else if (originSectionId === null) {
      // Older/internal pass events may not yet carry the snapshotted origin.
      // Invalidate only this subscriber's already-authorized sections; this
      // is broader but reveals no inaccessible section identifier.
      for (const sectionId of subscriber.teachingSectionIds) {
        topics.add(`section-live:${sectionId}`);
      }
    }
    if (destinationRoomId !== null && subscriber.staffedRoomIds.includes(destinationRoomId)) {
      topics.add(`station:${destinationRoomId}`);
    }
    if (requiredSectionId !== null && subscriber.teachingSectionIds.includes(requiredSectionId)) {
      topics.add('requests');
    }
    if (
      requiredRoomId !== null &&
      (subscriber.staffedRoomIds.includes(requiredRoomId) ||
        subscriber.teachingRoomIds.includes(requiredRoomId))
    ) {
      // Room-responsible approvals reach explicit room staff and
      // schedule-derived classroom teachers alike. Invalidation only;
      // the pending-approvals endpoint stays the exact eligibility gate.
      topics.add('requests');
    }
  } else if (event.aggregateKind === 'scheduled_authorization') {
    if (studentId === subscriber.personId) topics.add('self-scheduled');
    if (subscriber.capabilities.includes('scheduled_authorization.manage')) {
      topics.add('scheduled-passes');
    }
  } else if (event.aggregateKind === 'room' || event.aggregateKind === 'room_category') {
    topics.add('rooms');
  } else if (
    event.aggregateKind === 'schedule' ||
    event.aggregateKind === 'schedule_configuration' ||
    event.aggregateKind === 'calendar_day'
  ) {
    topics.add('organization-context');
    if (subscriber.capabilities.includes('schedule.view')) topics.add('schedule');
  } else if (event.aggregateKind === 'policy_rule') {
    if (subscriber.capabilities.includes('policy.manage')) topics.add('policies');
  } else if (event.aggregateKind === 'authorization_grant') {
    if (subscriber.capabilities.includes('authorization.manage')) topics.add('staff-access');
    topics.add('organization-context');
  } else if (event.aggregateKind === 'identity_enrollment_grant') {
    if (subscriber.capabilities.includes('people.view')) topics.add('people');
    if (subscriber.capabilities.includes('identity.enroll')) topics.add('enrollment');
  }
  if (subscriber.capabilities.includes('audit.view')) topics.add('audit');
  return [...topics];
}
