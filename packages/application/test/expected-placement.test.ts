import { Temporal } from '@js-temporal/polyfill';
import type {
  ExpectedPlacementRepository,
  ScheduleResolutionContext,
  SchedulingOrganizationRecord,
  SectionTeacherRecord,
  StudentSectionMeetingRecord,
} from '../src/scheduling/ports.js';
import { ExpectedPlacementResolver } from '../src/scheduling/expected-placement.js';
import type {
  CalendarDayReference,
  PersonId,
  ScheduleBlockKind,
  ScheduleSlotReference,
  ScheduleTemplateId,
  SchoolMembershipReference,
} from '@openhall/domain';
import { describe, expect, it } from 'vitest';

const pd = (value: string) => Temporal.PlainDate.from(value);
const pt = (value: string) => Temporal.PlainTime.from(value);
const instant = (value: string) => Temporal.Instant.from(value);

const organization: SchedulingOrganizationRecord = {
  id: 'school-1',
  name: 'OpenHall School',
  kind: 'school',
  timeZone: 'America/New_York',
};
const membership: SchoolMembershipReference = {
  personId: 'student-1',
  affiliation: 'student',
  validFrom: null,
  validUntil: null,
};
const calendarDay: CalendarDayReference = {
  id: 'day-1',
  date: pd('2026-09-21'),
  dayKind: 'instructional',
  cycleCode: 'A',
  operationalNote: null,
  template: { id: 'regular', name: 'Regular' },
};

function slot(
  id = 'slot-p3',
  startsAt = '10:00',
  endsAt = '11:00',
  blockId = 'p3',
  kind: ScheduleBlockKind = 'instructional',
): ScheduleSlotReference {
  return {
    id,
    startsAt: pt(startsAt),
    endsAt: pt(endsAt),
    ordinal: 3,
    block: { id: blockId, code: 'P3', displayName: 'Period 3', kind },
  };
}

function placement(
  meetingId = 'meeting-1',
  cycleCode: string | null = null,
): StudentSectionMeetingRecord {
  return {
    membership: {
      sectionId: 'section-1',
      personId: 'student-1',
      role: 'student',
      startsOn: null,
      endsOn: null,
    },
    meeting: {
      id: meetingId,
      section: { id: 'section-1', code: 'MATH-1', title: 'Mathematics' },
      blockId: 'p3',
      cycleCode,
      effectiveFrom: null,
      effectiveUntil: null,
      location: { id: 'room-101', name: 'Room 101', code: '101', kind: 'classroom' },
    },
  };
}

class FakeRepository implements ExpectedPlacementRepository {
  organization: SchedulingOrganizationRecord | null = organization;
  memberships: readonly SchoolMembershipReference[] = [membership];
  calendarDay: CalendarDayReference | null = calendarDay;
  slots: readonly ScheduleSlotReference[] = [slot()];
  placements: readonly StudentSectionMeetingRecord[] = [placement()];
  teachers: readonly SectionTeacherRecord[] = [];
  loadedTemplateId: string | null = null;

  loadOrganization(): Promise<SchedulingOrganizationRecord | null> {
    return Promise.resolve(this.organization);
  }
  loadSchoolMemberships(): Promise<readonly SchoolMembershipReference[]> {
    return Promise.resolve(this.memberships);
  }
  loadCalendarDay(): Promise<CalendarDayReference | null> {
    return Promise.resolve(this.calendarDay);
  }
  loadScheduleSlots(
    _context: ScheduleResolutionContext,
    templateId: ScheduleTemplateId,
  ): Promise<readonly ScheduleSlotReference[]> {
    this.loadedTemplateId = templateId;
    return Promise.resolve(this.slots);
  }
  loadStudentSectionMeetings(): Promise<readonly StudentSectionMeetingRecord[]> {
    return Promise.resolve(this.placements);
  }
  loadSectionTeachers(): Promise<readonly SectionTeacherRecord[]> {
    return Promise.resolve(this.teachers);
  }
}

const request = (at = '2026-09-21T14:30:00Z', organizationId = 'school-1') => ({
  tenantId: 'tenant-1',
  organizationId,
  personId: 'student-1' as PersonId,
  at: instant(at),
});

describe('ExpectedPlacementResolver', () => {
  it('resolves the regular schedule with exact timing, location, and every applicable teacher', async () => {
    const repository = new FakeRepository();
    repository.teachers = [
      {
        membership: {
          sectionId: 'section-1',
          personId: 'teacher-1',
          role: 'teacher',
          startsOn: pd('2026-09-21'),
          endsOn: pd('2026-09-21'),
        },
        teacher: { id: 'teacher-1', displayName: 'Ada Teacher' },
      },
      {
        membership: {
          sectionId: 'section-1',
          personId: 'teacher-2',
          role: 'teacher',
          startsOn: null,
          endsOn: null,
        },
        teacher: { id: 'teacher-2', displayName: 'Grace Teacher' },
      },
      {
        membership: {
          sectionId: 'section-1',
          personId: 'old-teacher',
          role: 'teacher',
          startsOn: null,
          endsOn: pd('2026-09-20'),
        },
        teacher: { id: 'old-teacher', displayName: 'Old Teacher' },
      },
    ];
    const result = await new ExpectedPlacementResolver(repository).resolve(request());
    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') return;
    expect(result.section.title).toBe('Mathematics');
    expect(result.expectedLocation?.name).toBe('Room 101');
    expect(result.teachers.map((teacher) => teacher.id)).toEqual(['teacher-1', 'teacher-2']);
    expect(result.beginsAt.toString()).toBe('2026-09-21T14:00:00Z');
    expect(result.endsAt.toString()).toBe('2026-09-21T15:00:00Z');
    expect(result.elapsedSeconds).toBe(1800);
    expect(result.remainingSeconds).toBe(1800);
  });

  it('uses the calendar day template, including the same logical P3 on a Canteen schedule', async () => {
    const repository = new FakeRepository();
    repository.calendarDay = {
      ...calendarDay,
      template: { id: 'canteen', name: 'Canteen' },
    };
    repository.slots = [slot('canteen-p3', '10:15', '11:15')];
    const result = await new ExpectedPlacementResolver(repository).resolve(request());
    expect(repository.loadedTemplateId).toBe('canteen');
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') expect(result.slot.id).toBe('canteen-p3');
  });

  it.each([
    ['cycle-specific match', 'A', 'A', 'resolved'],
    ['cycle-specific mismatch', 'B', 'A', 'block_only'],
    ['non-null meeting with null day cycle', 'A', null, 'block_only'],
    ['cycle-null meeting applies to every cycle', null, 'Z', 'resolved'],
  ])('%s', async (_name, meetingCycle, dayCycle, expectedKind) => {
    const repository = new FakeRepository();
    repository.placements = [placement('meeting-cycle', meetingCycle)];
    repository.calendarDay = { ...calendarDay, cycleCode: dayCycle };
    const result = await new ExpectedPlacementResolver(repository).resolve(request());
    expect(result.kind).toBe(expectedKind);
  });

  it('treats membership and meeting date endpoints as inclusive', async () => {
    const repository = new FakeRepository();
    const record = placement();
    repository.memberships = [
      { ...membership, validFrom: pd('2026-09-21'), validUntil: pd('2026-09-21') },
    ];
    repository.placements = [
      {
        membership: { ...record.membership, startsOn: pd('2026-09-21'), endsOn: pd('2026-09-21') },
        meeting: {
          ...record.meeting,
          effectiveFrom: pd('2026-09-21'),
          effectiveUntil: pd('2026-09-21'),
        },
      },
    ];
    await expect(
      new ExpectedPlacementResolver(repository).resolve(request()),
    ).resolves.toMatchObject({ kind: 'resolved' });
  });

  it.each([
    ['student membership ended', { membership: { endsOn: pd('2026-09-20') } }],
    ['meeting starts later', { meeting: { effectiveFrom: pd('2026-09-22') } }],
    ['meeting ended earlier', { meeting: { effectiveUntil: pd('2026-09-20') } }],
  ])('returns block-only when the %s', async (_name, change) => {
    const repository = new FakeRepository();
    const record = placement();
    repository.placements = [
      {
        membership: { ...record.membership, ...('membership' in change ? change.membership : {}) },
        meeting: { ...record.meeting, ...('meeting' in change ? change.meeting : {}) },
      },
    ];
    await expect(
      new ExpectedPlacementResolver(repository).resolve(request()),
    ).resolves.toMatchObject({ kind: 'block_only' });
  });

  it('resolves a roomless section without inventing a location', async () => {
    const repository = new FakeRepository();
    const record = placement();
    repository.placements = [{ ...record, meeting: { ...record.meeting, location: null } }];
    const result = await new ExpectedPlacementResolver(repository).resolve(request());
    expect(result).toMatchObject({ kind: 'resolved', expectedLocation: null });
  });

  it.each(['instructional', 'lunch', 'advisory', 'transition'] as const)(
    'returns block-only for an unassigned %s block',
    async (kind) => {
      const repository = new FakeRepository();
      repository.slots = [slot('slot', '10:00', '11:00', 'p3', kind)];
      repository.placements = [];
      const result = await new ExpectedPlacementResolver(repository).resolve(request());
      expect(result).toMatchObject({ kind: 'block_only', block: { kind } });
    },
  );

  it.each([
    ['before school', '2026-09-21T13:59:59Z'],
    ['exact slot end', '2026-09-21T15:00:00Z'],
    ['after school', '2026-09-21T20:00:00Z'],
    ['between-period gap', '2026-09-21T15:05:00Z'],
  ])('is outside schedule %s', async (_name, at) => {
    const repository = new FakeRepository();
    await expect(
      new ExpectedPlacementResolver(repository).resolve(request(at)),
    ).resolves.toMatchObject({ kind: 'outside_schedule' });
  });

  it('includes exact slot start and excludes exact slot end', async () => {
    const repository = new FakeRepository();
    await expect(
      new ExpectedPlacementResolver(repository).resolve(request('2026-09-21T14:00:00Z')),
    ).resolves.toMatchObject({ kind: 'resolved', elapsedSeconds: 0, remainingSeconds: 3600 });
  });

  it.each(['non_instructional', 'closed'] as const)('returns explicit %s day', async (dayKind) => {
    const repository = new FakeRepository();
    repository.calendarDay = { ...calendarDay, dayKind, template: null };
    await expect(
      new ExpectedPlacementResolver(repository).resolve(request()),
    ).resolves.toMatchObject({ kind: 'non_instructional_day', dayKind });
  });

  it('does not assume a default template when the calendar day is missing', async () => {
    const repository = new FakeRepository();
    repository.calendarDay = null;
    await expect(
      new ExpectedPlacementResolver(repository).resolve(request()),
    ).resolves.toMatchObject({ kind: 'calendar_not_configured' });
  });

  it('returns not-member before normal placement resolution', async () => {
    const repository = new FakeRepository();
    repository.memberships = [];
    await expect(
      new ExpectedPlacementResolver(repository).resolve(request()),
    ).resolves.toMatchObject({ kind: 'not_member' });
  });

  it('does not count teacher section membership as a student placement', async () => {
    const repository = new FakeRepository();
    const record = placement();
    repository.placements = [{ ...record, membership: { ...record.membership, role: 'teacher' } }];
    await expect(
      new ExpectedPlacementResolver(repository).resolve(request()),
    ).resolves.toMatchObject({ kind: 'block_only' });
  });

  it('returns privacy-safe ambiguity instead of choosing between simultaneous sections', async () => {
    const repository = new FakeRepository();
    const second = placement('meeting-2');
    repository.placements = [
      placement(),
      {
        membership: { ...second.membership, sectionId: 'section-2' },
        meeting: { ...second.meeting, section: { id: 'section-2', code: null, title: 'Science' } },
      },
    ];
    const result = await new ExpectedPlacementResolver(repository).resolve(request());
    expect(result).toMatchObject({ kind: 'ambiguous', reason: 'multiple_placements' });
    if (result.kind === 'ambiguous') {
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates[0]).not.toHaveProperty('title');
    }
  });

  it('allows overlapping slots when only one is applicable to the person', async () => {
    const repository = new FakeRepository();
    repository.slots = [slot(), slot('advisory-slot', '10:15', '10:45', 'advisory', 'advisory')];
    const result = await new ExpectedPlacementResolver(repository).resolve(request());
    expect(result).toMatchObject({ kind: 'resolved', slot: { id: 'slot-p3' } });
  });

  it('does not use ordinal to choose between overlapping unassigned slots', async () => {
    const repository = new FakeRepository();
    repository.slots = [slot(), slot('overlap', '10:15', '10:45', 'other', 'other')];
    repository.placements = [];
    await expect(
      new ExpectedPlacementResolver(repository).resolve(request()),
    ).resolves.toMatchObject({ kind: 'ambiguous', reason: 'overlapping_unassigned_slots' });
  });

  it('uses each school timezone independently within one tenant', async () => {
    const eastern = new FakeRepository();
    const central = new FakeRepository();
    central.organization = { ...organization, id: 'school-2', timeZone: 'America/Chicago' };
    const eastResult = await new ExpectedPlacementResolver(eastern).resolve(request());
    const centralResult = await new ExpectedPlacementResolver(central).resolve(
      request(undefined, 'school-2'),
    );
    expect(eastResult.kind).toBe('resolved');
    expect(centralResult.kind).toBe('outside_schedule');
  });

  it.each([
    ['spring-forward nonexistent end', '2026-03-08', '2026-03-08T06:45:00Z', '01:30', '02:30'],
    ['fall-back ambiguous start', '2026-11-01', '2026-11-01T05:30:00Z', '01:00', '02:00'],
  ])('surfaces %s as configuration error', async (_name, day, at, starts, ends) => {
    const repository = new FakeRepository();
    repository.calendarDay = { ...calendarDay, date: pd(day) };
    repository.slots = [slot('dst', starts, ends)];
    await expect(
      new ExpectedPlacementResolver(repository).resolve(request(at)),
    ).resolves.toMatchObject({ kind: 'configuration_error', code: 'invalid_slot_wall_time' });
  });

  it.each([
    [null, 'school_not_found'],
    [{ ...organization, kind: 'district' as const }, 'organization_not_school'],
    [{ ...organization, timeZone: 'Not/A_Zone' }, 'invalid_school_time_zone'],
  ])('reports invalid school configuration', async (configured, code) => {
    const repository = new FakeRepository();
    repository.organization = configured;
    await expect(
      new ExpectedPlacementResolver(repository).resolve(request()),
    ).resolves.toMatchObject({ kind: 'configuration_error', code });
  });
});
