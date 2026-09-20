import type { ExpectedPlacementResult } from '@openhall/application';
import { describe, expect, it } from 'vitest';
import { toPublicExpectedPlacement } from './me.js';

// Apps/api does not depend on the Temporal polyfill directly; the mapper
// only reads beginsAt/endsAt via toString(), so minimal fakes suffice.
const beginsAt = { toString: () => '2026-09-21T14:00:00Z' };
const endsAt = { toString: () => '2026-09-21T15:00:00Z' };

const block = {
  id: 'block-1',
  code: 'P3',
  displayName: 'Period 3',
  kind: 'instructional',
} as const;

function base() {
  return {
    school: { id: 'school-a', name: 'A', kind: 'school', timeZone: 'America/New_York' },
    schoolDate: '2026-09-21',
    schoolTime: '10:00',
    calendarDay: {
      id: 'day-1',
      date: '2026-09-21',
      dayKind: 'instructional',
      cycleCode: null,
      operationalNote: null,
      template: { id: 't', name: 'Regular' },
    },
    slot: {
      id: 'slot-1',
      startsAt: '10:00',
      endsAt: '11:00',
      ordinal: 3,
      block: { ...block },
    },
    block: { ...block },
    beginsAt,
    endsAt,
    elapsedSeconds: 1,
    remainingSeconds: 2,
  };
}

describe('expected placement public mapping', () => {
  it('maps resolved without teacher identities', () => {
    const result = {
      ...base(),
      kind: 'resolved',
      section: { id: 'sec-1', code: 'HIST-3', title: 'US History' },
      expectedLocation: { id: 'room-1', name: 'Room 101', code: '101', kind: 'classroom' },
      teachers: [{ id: 't1', displayName: 'Teacher One' }],
    } as unknown as ExpectedPlacementResult;
    const body = toPublicExpectedPlacement(result);
    expect(body).toMatchObject({
      kind: 'resolved',
      block: { id: 'block-1', code: 'P3' },
      section: { id: 'sec-1', code: 'HIST-3', title: 'US History' },
      expectedLocation: { id: 'room-1', name: 'Room 101' },
    });
    expect(JSON.stringify(body)).not.toContain('Teacher One');
    expect(JSON.stringify(body)).not.toContain('t1');
  });

  it('maps block_only without fabricating section or location', () => {
    const result = { ...base(), kind: 'block_only' } as unknown as ExpectedPlacementResult;
    const body = toPublicExpectedPlacement(result);
    expect(body).toMatchObject({ kind: 'block_only', block: { id: 'block-1' } });
    expect(body).not.toHaveProperty('section');
    expect(body).not.toHaveProperty('expectedLocation');
  });

  it('maps every remaining state and hides internals', () => {
    const states: ExpectedPlacementResult[] = [
      { ...base(), kind: 'outside_schedule' } as unknown as ExpectedPlacementResult,
      {
        ...base(),
        kind: 'non_instructional_day',
        dayKind: 'closed',
      } as unknown as ExpectedPlacementResult,
      { ...base(), kind: 'calendar_not_configured' } as unknown as ExpectedPlacementResult,
      { ...base(), kind: 'not_member' } as unknown as ExpectedPlacementResult,
      {
        ...base(),
        kind: 'ambiguous',
        reason: 'multiple_placements',
        candidates: [{ slotId: 's', blockId: 'b', sectionId: 'sec', sectionMeetingId: 'm' }],
      } as unknown as ExpectedPlacementResult,
      {
        kind: 'configuration_error',
        code: 'instructional_day_missing_template',
        message: 'internal diagnostic that must never reach the wire',
      } as unknown as ExpectedPlacementResult,
    ];
    const bodies = states.map((state) => toPublicExpectedPlacement(state));
    expect(bodies.map((body) => body?.kind)).toEqual([
      'outside_schedule',
      'non_instructional_day',
      'calendar_not_configured',
      'not_member',
      'ambiguous',
      'configuration_error',
    ]);
    const raw = JSON.stringify(bodies);
    // Ambiguous candidate IDs and configuration diagnostics stay internal.
    expect(raw).not.toContain('sectionMeetingId');
    expect(raw).not.toContain('internal diagnostic');
    expect(raw).not.toContain('message');
    expect(bodies[5]).toEqual({
      kind: 'configuration_error',
      code: 'instructional_day_missing_template',
    });
  });

  it('maps null placement for staff-only users', () => {
    expect(toPublicExpectedPlacement(null)).toBeNull();
  });
});
