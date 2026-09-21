import { describe, expect, it } from 'vitest';
import { formatScheduledWhen, formatSchoolTime } from './student-time.js';

const ZONE = 'America/New_York';
const NOW = Date.parse('2026-09-21T15:00:00Z');

describe('school-local time', () => {
  it('formats in the school timezone, not the browser timezone', () => {
    // 15:00 UTC is 11:00 AM in New York (EDT).
    expect(formatSchoolTime('2026-09-21T15:00:00Z', ZONE)).toBe('11:00 AM');
  });

  it('returns null for missing or invalid input', () => {
    expect(formatSchoolTime(null, ZONE)).toBeNull();
    expect(formatSchoolTime('not-a-date', ZONE)).toBeNull();
  });

  it('labels same-day appointments as today', () => {
    expect(formatScheduledWhen('2026-09-21T18:14:00Z', ZONE, NOW)).toBe('Today · 2:14 PM');
  });

  it('labels next-day appointments as tomorrow', () => {
    expect(formatScheduledWhen('2026-09-22T13:30:00Z', ZONE, NOW)).toBe('Tomorrow · 9:30 AM');
  });
});
