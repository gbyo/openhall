import { Temporal } from '@js-temporal/polyfill';

export type PostgresDate = string;
export type PostgresTime = string;
export type PostgresTimestamp = string;
export type PostgresTimestamptz = string;

export function postgresDateToPlainDate(value: PostgresDate): Temporal.PlainDate {
  return Temporal.PlainDate.from(value);
}

export function postgresTimeToPlainTime(value: PostgresTime): Temporal.PlainTime {
  return Temporal.PlainTime.from(value);
}

export function postgresTimestampToPlainDateTime(value: PostgresTimestamp): Temporal.PlainDateTime {
  return Temporal.PlainDateTime.from(value.replace(' ', 'T'));
}

export function postgresTimestamptzToInstant(value: PostgresTimestamptz): Temporal.Instant {
  return Temporal.Instant.from(value.replace(' ', 'T'));
}

export function plainDateToPostgres(value: Temporal.PlainDate): PostgresDate {
  return value.toString();
}

export function plainTimeToPostgres(value: Temporal.PlainTime): PostgresTime {
  return value.toString({ smallestUnit: 'nanosecond' });
}

export function plainDateTimeToPostgres(value: Temporal.PlainDateTime): PostgresTimestamp {
  return value.toString({ smallestUnit: 'nanosecond' }).replace('T', ' ');
}

export function instantToPostgres(value: Temporal.Instant): PostgresTimestamptz {
  return value.toString({ smallestUnit: 'nanosecond' });
}
