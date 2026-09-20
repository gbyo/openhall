import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import {
  instantToPostgres,
  plainDateTimeToPostgres,
  plainDateToPostgres,
  plainTimeToPostgres,
  postgresDateToPlainDate,
  postgresTimestampToPlainDateTime,
  postgresTimestamptzToInstant,
  postgresTimeToPlainTime,
} from '../src/temporal-types.js';

describe('PostgreSQL Temporal boundary conversions', () => {
  it('converts date, wall time, local timestamp, and instant text explicitly', () => {
    expect(postgresDateToPlainDate('2026-09-21').toString()).toBe('2026-09-21');
    expect(postgresTimeToPlainTime('10:15:30.123456').toString()).toBe('10:15:30.123456');
    expect(postgresTimestampToPlainDateTime('2026-09-21 10:15:30').toString()).toBe(
      '2026-09-21T10:15:30',
    );
    expect(postgresTimestamptzToInstant('2026-09-21 14:15:30+00').toString()).toBe(
      '2026-09-21T14:15:30Z',
    );
  });

  it('writes PostgreSQL-safe strings without JavaScript Date', () => {
    expect(plainDateToPostgres(Temporal.PlainDate.from('2026-09-21'))).toBe('2026-09-21');
    expect(plainTimeToPostgres(Temporal.PlainTime.from('10:15'))).toBe('10:15:00.000000000');
    expect(plainDateTimeToPostgres(Temporal.PlainDateTime.from('2026-09-21T10:15'))).toBe(
      '2026-09-21 10:15:00.000000000',
    );
    expect(instantToPostgres(Temporal.Instant.from('2026-09-21T14:15:00Z'))).toBe(
      '2026-09-21T14:15:00.000000000Z',
    );
  });
});
