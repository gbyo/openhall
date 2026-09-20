import { Temporal } from '@js-temporal/polyfill';

export type TenantId = string;
export type OrganizationId = string;
export type PersonId = string;
export type AccountId = string;
export type PassId = string;

export const PASS_LIFECYCLE_STATES = [
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
] as const;

export type PassLifecycleState = (typeof PASS_LIFECYCLE_STATES)[number];

export const ACTIVE_PASS_STATES = [
  'requested',
  'queued',
  'ready',
  'outbound',
  'at_destination',
  'returning',
] as const satisfies readonly PassLifecycleState[];

export interface Clock {
  now(): Temporal.Instant;
}

export class SystemClock implements Clock {
  now(): Temporal.Instant {
    return Temporal.Now.instant();
  }
}

export function schoolLocalDate(instant: Temporal.Instant, timeZone: string): Temporal.PlainDate {
  return instant.toZonedDateTimeISO(timeZone).toPlainDate();
}

export function schoolLocalTime(instant: Temporal.Instant, timeZone: string): Temporal.PlainTime {
  return instant.toZonedDateTimeISO(timeZone).toPlainTime();
}

export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidDomainStateError extends DomainError {
  readonly code = 'invalid_domain_state';
}

export function assertNever(value: never): never {
  throw new InvalidDomainStateError(`Unhandled closed-state value: ${String(value)}`);
}
