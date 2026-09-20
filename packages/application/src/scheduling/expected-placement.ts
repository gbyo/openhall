import { Temporal } from '@js-temporal/polyfill';
import type {
  CalendarDayReference,
  LocationReference,
  OrganizationId,
  PersonId,
  PlacementCandidateReference,
  ScheduleBlockReference,
  ScheduleSlotReference,
  SchoolReference,
  SectionReference,
  TeacherReference,
  TenantId,
} from '@openhall/domain';
import type {
  ExpectedPlacementRepository,
  ScheduleResolutionContext,
  StudentSectionMeetingRecord,
} from './ports.js';

export interface ResolveExpectedPlacementRequest {
  readonly tenantId: TenantId;
  readonly organizationId: OrganizationId;
  readonly personId: PersonId;
  readonly at: Temporal.Instant;
}

interface LocalContext {
  readonly school: SchoolReference;
  readonly schoolDate: Temporal.PlainDate;
  readonly schoolTime: Temporal.PlainTime;
}

interface CalendarContext extends LocalContext {
  readonly calendarDay: CalendarDayReference;
}

export interface ActiveSlotContext extends CalendarContext {
  readonly slot: ScheduleSlotReference;
  readonly block: ScheduleBlockReference;
  readonly beginsAt: Temporal.Instant;
  readonly endsAt: Temporal.Instant;
  readonly elapsedSeconds: number;
  readonly remainingSeconds: number;
}

export type ExpectedPlacementResult =
  | (ActiveSlotContext & {
      readonly kind: 'resolved';
      readonly section: SectionReference;
      readonly expectedLocation: LocationReference | null;
      readonly teachers: readonly TeacherReference[];
    })
  | (ActiveSlotContext & { readonly kind: 'block_only' })
  | (CalendarContext & { readonly kind: 'outside_schedule' })
  | (CalendarContext & {
      readonly kind: 'non_instructional_day';
      readonly dayKind: 'non_instructional' | 'closed';
    })
  | (LocalContext & { readonly kind: 'calendar_not_configured' })
  | (LocalContext & { readonly kind: 'not_member' })
  | (CalendarContext & {
      readonly kind: 'ambiguous';
      readonly reason: 'multiple_placements' | 'overlapping_unassigned_slots';
      readonly candidates: readonly PlacementCandidateReference[];
    })
  | {
      readonly kind: 'configuration_error';
      readonly code:
        | 'school_not_found'
        | 'organization_not_school'
        | 'invalid_school_time_zone'
        | 'instructional_day_missing_template'
        | 'invalid_slot_wall_time';
      readonly message: string;
    };

function dateApplies(
  date: Temporal.PlainDate,
  from: Temporal.PlainDate | null,
  until: Temporal.PlainDate | null,
): boolean {
  return (
    (from === null || Temporal.PlainDate.compare(from, date) <= 0) &&
    (until === null || Temporal.PlainDate.compare(date, until) <= 0)
  );
}

function activeAt(slot: ScheduleSlotReference, time: Temporal.PlainTime): boolean {
  return (
    Temporal.PlainTime.compare(slot.startsAt, time) <= 0 &&
    Temporal.PlainTime.compare(time, slot.endsAt) < 0
  );
}

function meetingApplies(
  record: StudentSectionMeetingRecord,
  slot: ScheduleSlotReference,
  day: CalendarDayReference,
): boolean {
  const { membership, meeting } = record;
  return (
    membership.role === 'student' &&
    membership.sectionId === meeting.section.id &&
    meeting.blockId === slot.block.id &&
    dateApplies(day.date, membership.startsOn, membership.endsOn) &&
    dateApplies(day.date, meeting.effectiveFrom, meeting.effectiveUntil) &&
    (meeting.cycleCode === null || meeting.cycleCode === day.cycleCode)
  );
}

function boundaryInstant(
  date: Temporal.PlainDate,
  time: Temporal.PlainTime,
  timeZone: string,
): Temporal.Instant {
  return Temporal.ZonedDateTime.from(
    {
      timeZone,
      year: date.year,
      month: date.month,
      day: date.day,
      hour: time.hour,
      minute: time.minute,
      second: time.second,
      millisecond: time.millisecond,
      microsecond: time.microsecond,
      nanosecond: time.nanosecond,
    },
    { disambiguation: 'reject' },
  ).toInstant();
}

function activeSlotContext(
  local: LocalContext,
  calendarDay: CalendarDayReference,
  slot: ScheduleSlotReference,
  at: Temporal.Instant,
): ActiveSlotContext | null {
  try {
    const beginsAt = boundaryInstant(local.schoolDate, slot.startsAt, local.school.timeZone);
    const endsAt = boundaryInstant(local.schoolDate, slot.endsAt, local.school.timeZone);
    return {
      ...local,
      calendarDay,
      slot,
      block: slot.block,
      beginsAt,
      endsAt,
      elapsedSeconds: beginsAt.until(at).total('seconds'),
      remainingSeconds: at.until(endsAt).total('seconds'),
    };
  } catch {
    return null;
  }
}

export class ExpectedPlacementResolver {
  constructor(private readonly repository: ExpectedPlacementRepository) {}

  async resolve(request: ResolveExpectedPlacementRequest): Promise<ExpectedPlacementResult> {
    const context: ScheduleResolutionContext = {
      tenantId: request.tenantId,
      organizationId: request.organizationId,
    };
    const organization = await this.repository.loadOrganization(context);
    if (organization === null) {
      return {
        kind: 'configuration_error',
        code: 'school_not_found',
        message: 'The requested organization does not exist in this tenant.',
      };
    }
    if (organization.kind !== 'school') {
      return {
        kind: 'configuration_error',
        code: 'organization_not_school',
        message: 'Expected placement can only be resolved for a school organization.',
      };
    }
    if (organization.timeZone === null || !isValidTimeZone(organization.timeZone)) {
      return {
        kind: 'configuration_error',
        code: 'invalid_school_time_zone',
        message: 'The school does not have a usable IANA time zone.',
      };
    }

    const school: SchoolReference = {
      id: organization.id,
      name: organization.name,
      kind: 'school',
      timeZone: organization.timeZone,
    };
    const zonedAt = request.at.toZonedDateTimeISO(school.timeZone);
    const local: LocalContext = {
      school,
      schoolDate: zonedAt.toPlainDate(),
      schoolTime: zonedAt.toPlainTime(),
    };

    const memberships = await this.repository.loadSchoolMemberships(context, request.personId);
    if (
      !memberships.some((membership) =>
        dateApplies(local.schoolDate, membership.validFrom, membership.validUntil),
      )
    ) {
      return { kind: 'not_member', ...local };
    }

    const calendarDay = await this.repository.loadCalendarDay(context, local.schoolDate);
    if (calendarDay === null) return { kind: 'calendar_not_configured', ...local };
    const calendar: CalendarContext = { ...local, calendarDay };
    if (calendarDay.dayKind !== 'instructional') {
      return { kind: 'non_instructional_day', dayKind: calendarDay.dayKind, ...calendar };
    }
    if (calendarDay.template === null) {
      return {
        kind: 'configuration_error',
        code: 'instructional_day_missing_template',
        message: 'The instructional calendar day has no schedule template.',
      };
    }

    const slots = await this.repository.loadScheduleSlots(context, calendarDay.template.id);
    const activeSlots = slots.filter((slot) => activeAt(slot, local.schoolTime));
    if (activeSlots.length === 0) return { kind: 'outside_schedule', ...calendar };

    const records = await this.repository.loadStudentSectionMeetings(context, request.personId);
    const candidates = activeSlots.flatMap((slot) =>
      records
        .filter((record) => meetingApplies(record, slot, calendarDay))
        .map((record) => ({
          slot,
          record,
        })),
    );

    if (candidates.length > 1) {
      return {
        kind: 'ambiguous',
        reason: 'multiple_placements',
        candidates: candidates.map(({ slot, record }) => ({
          slotId: slot.id,
          blockId: slot.block.id,
          sectionId: record.meeting.section.id,
          sectionMeetingId: record.meeting.id,
        })),
        ...calendar,
      };
    }
    if (candidates.length === 0 && activeSlots.length > 1) {
      return {
        kind: 'ambiguous',
        reason: 'overlapping_unassigned_slots',
        candidates: [],
        ...calendar,
      };
    }

    const selectedSlot = candidates[0]?.slot ?? activeSlots[0];
    if (!selectedSlot) throw new Error('Active slot selection invariant failed');
    const slotContext = activeSlotContext(local, calendarDay, selectedSlot, request.at);
    if (slotContext === null) {
      return {
        kind: 'configuration_error',
        code: 'invalid_slot_wall_time',
        message: 'An active slot boundary is nonexistent or ambiguous in the school time zone.',
      };
    }
    const selected = candidates[0];
    if (!selected) return { kind: 'block_only', ...slotContext };

    const teacherRecords = await this.repository.loadSectionTeachers(
      context,
      selected.record.meeting.section.id,
    );
    const teachers = teacherRecords
      .filter(({ membership }) =>
        dateApplies(local.schoolDate, membership.startsOn, membership.endsOn),
      )
      .map(({ teacher }) => teacher);
    return {
      kind: 'resolved',
      section: selected.record.meeting.section,
      expectedLocation: selected.record.meeting.location,
      teachers,
      ...slotContext,
    };
  }
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    Temporal.Instant.from('2000-01-01T00:00:00Z').toZonedDateTimeISO(timeZone);
    return true;
  } catch {
    return false;
  }
}
