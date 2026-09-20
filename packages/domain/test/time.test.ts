import { describe, expect, it } from 'vitest';
import { schoolLocalDate, schoolLocalTime } from '../src/index.js';
import { FakeClock } from '../../test-support/src/index.js';

describe('Clock and school-local time', () => {
  it('is deterministic and resolves through an explicit IANA time zone', () => {
    const clock = new FakeClock('2026-03-08T06:30:00Z');

    expect(clock.now().toString()).toBe('2026-03-08T06:30:00Z');
    expect(schoolLocalDate(clock.now(), 'America/New_York').toString()).toBe('2026-03-08');
    expect(schoolLocalTime(clock.now(), 'America/New_York').toString()).toBe('01:30:00');

    clock.advance({ hours: 1 });
    expect(schoolLocalTime(clock.now(), 'America/New_York').toString()).toBe('03:30:00');
  });
});
