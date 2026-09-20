import { Temporal } from '@js-temporal/polyfill';

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
