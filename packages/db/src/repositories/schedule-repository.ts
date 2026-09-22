import type {
  ExpectedPlacementRepository,
  ScheduleResolutionContext,
  SchedulingOrganizationRecord,
  SectionTeacherRecord,
  StudentSectionMeetingRecord,
} from '@openhall/application';
import type {
  CalendarDayKind,
  CalendarDayReference,
  PersonId,
  ScheduleBlockKind,
  ScheduleSlotReference,
  ScheduleTemplateId,
  SchoolMembershipReference,
  SectionId,
} from '@openhall/domain';
import type { Temporal } from '@js-temporal/polyfill';
import { sql, type Kysely } from 'kysely';
import type { DB } from '../database.generated.js';
import {
  plainDateToPostgres,
  postgresDateToPlainDate,
  postgresTimeToPlainTime,
} from '../temporal-types.js';

type NullableDate = string | null;

function date(value: NullableDate): Temporal.PlainDate | null {
  return value === null ? null : postgresDateToPlainDate(value);
}

export class PostgresExpectedPlacementRepository implements ExpectedPlacementRepository {
  constructor(private readonly database: Kysely<DB>) {}

  async loadOrganization(
    context: ScheduleResolutionContext,
  ): Promise<SchedulingOrganizationRecord | null> {
    const result = await sql<SchedulingOrganizationRecord>`
      SELECT id, name, kind, time_zone AS "timeZone"
      FROM organization
      WHERE tenant_id = ${context.tenantId}
        AND id = ${context.organizationId}
        AND status = 'active'
    `.execute(this.database);
    return result.rows[0] ?? null;
  }

  async loadSchoolMemberships(
    context: ScheduleResolutionContext,
    personId: PersonId,
  ): Promise<readonly SchoolMembershipReference[]> {
    const result = await sql<{
      personId: string;
      affiliation: 'student' | 'staff' | 'other';
      validFrom: NullableDate;
      validUntil: NullableDate;
    }>`
      SELECT person_id AS "personId", affiliation,
             valid_from AS "validFrom", valid_until AS "validUntil"
      FROM organization_membership
      WHERE tenant_id = ${context.tenantId}
        AND organization_id = ${context.organizationId}
        AND person_id = ${personId}
        AND status = 'active'
    `.execute(this.database);
    return result.rows.map((row) => ({
      ...row,
      validFrom: date(row.validFrom),
      validUntil: date(row.validUntil),
    }));
  }

  async loadCalendarDay(
    context: ScheduleResolutionContext,
    localDate: Temporal.PlainDate,
  ): Promise<CalendarDayReference | null> {
    const result = await sql<{
      id: string;
      date: string;
      dayKind: CalendarDayKind;
      cycleCode: string | null;
      operationalNote: string | null;
      templateId: string | null;
      templateName: string | null;
    }>`
      SELECT day.id, day.date, day.day_kind AS "dayKind",
             day.cycle_code AS "cycleCode", day.operational_note AS "operationalNote",
             template.id AS "templateId", template.name AS "templateName"
      FROM calendar_day day
      LEFT JOIN schedule_template template
        ON template.tenant_id = day.tenant_id
       AND template.organization_id = day.organization_id
       AND template.id = day.schedule_template_id
      WHERE day.tenant_id = ${context.tenantId}
        AND day.organization_id = ${context.organizationId}
        AND day.date = ${plainDateToPostgres(localDate)}::date
    `.execute(this.database);
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      date: postgresDateToPlainDate(row.date),
      dayKind: row.dayKind,
      cycleCode: row.cycleCode,
      operationalNote: row.operationalNote,
      template:
        row.templateId === null || row.templateName === null
          ? null
          : { id: row.templateId, name: row.templateName },
    };
  }

  async loadScheduleSlots(
    context: ScheduleResolutionContext,
    templateId: ScheduleTemplateId,
  ): Promise<readonly ScheduleSlotReference[]> {
    const result = await sql<{
      id: string;
      startsAt: string;
      endsAt: string;
      ordinal: number;
      blockId: string;
      blockCode: string;
      blockDisplayName: string;
      blockKind: ScheduleBlockKind;
    }>`
      SELECT slot.id, slot.starts_at AS "startsAt", slot.ends_at AS "endsAt", slot.ordinal,
             block.id AS "blockId", block.code AS "blockCode",
             block.display_name AS "blockDisplayName", block.kind AS "blockKind"
      FROM schedule_slot slot
      JOIN schedule_block block
        ON block.tenant_id = slot.tenant_id
       AND block.organization_id = slot.organization_id
       AND block.id = slot.schedule_block_id
      WHERE slot.tenant_id = ${context.tenantId}
        AND slot.organization_id = ${context.organizationId}
        AND slot.schedule_template_id = ${templateId}
        AND block.status = 'active'
      ORDER BY slot.ordinal, slot.id
    `.execute(this.database);
    return result.rows.map((row) => ({
      id: row.id,
      startsAt: postgresTimeToPlainTime(row.startsAt),
      endsAt: postgresTimeToPlainTime(row.endsAt),
      ordinal: row.ordinal,
      block: {
        id: row.blockId,
        code: row.blockCode,
        displayName: row.blockDisplayName,
        kind: row.blockKind,
      },
    }));
  }

  async loadStudentSectionMeetings(
    context: ScheduleResolutionContext,
    personId: PersonId,
  ): Promise<readonly StudentSectionMeetingRecord[]> {
    const result = await sql<{
      membershipSectionId: string;
      membershipPersonId: string;
      startsOn: NullableDate;
      endsOn: NullableDate;
      meetingId: string;
      blockId: string;
      cycleCode: string | null;
      effectiveFrom: NullableDate;
      effectiveUntil: NullableDate;
      sectionId: string;
      sectionCode: string | null;
      sectionTitle: string;
      roomId: string | null;
      roomName: string | null;
      roomCode: string | null;
    }>`
      SELECT membership.section_id AS "membershipSectionId",
             membership.person_id AS "membershipPersonId",
             membership.starts_on AS "startsOn", membership.ends_on AS "endsOn",
             meeting.id AS "meetingId", meeting.schedule_block_id AS "blockId",
             meeting.cycle_code AS "cycleCode", meeting.effective_from AS "effectiveFrom",
             meeting.effective_until AS "effectiveUntil",
             section_row.id AS "sectionId", section_row.code AS "sectionCode",
             section_row.title AS "sectionTitle", room_row.id AS "roomId",
             room_row.name AS "roomName", room_row.code AS "roomCode"
      FROM section_membership membership
      JOIN section section_row
        ON section_row.tenant_id = membership.tenant_id
       AND section_row.id = membership.section_id
      JOIN section_meeting meeting
        ON meeting.tenant_id = section_row.tenant_id
       AND meeting.organization_id = section_row.organization_id
       AND meeting.section_id = section_row.id
      LEFT JOIN room room_row
        ON room_row.tenant_id = meeting.tenant_id
       AND room_row.organization_id = meeting.organization_id
       AND room_row.id = meeting.room_id
      WHERE membership.tenant_id = ${context.tenantId}
        AND section_row.organization_id = ${context.organizationId}
        AND meeting.organization_id = ${context.organizationId}
        AND membership.person_id = ${personId}
        AND membership.role = 'student'
        AND membership.status = 'active'
        AND section_row.status = 'active'
        -- Expected Placement answers "where is this class meeting", not
        -- "can this room receive new passes". A closed room still holds its
        -- scheduled class (and still works as an origin); only archived
        -- rooms leave the schedule.
        AND (room_row.id IS NULL OR room_row.status <> 'archived')
      ORDER BY meeting.id
    `.execute(this.database);
    return result.rows.map((row) => ({
      membership: {
        sectionId: row.membershipSectionId,
        personId: row.membershipPersonId,
        role: 'student',
        startsOn: date(row.startsOn),
        endsOn: date(row.endsOn),
      },
      meeting: {
        id: row.meetingId,
        section: { id: row.sectionId, code: row.sectionCode, title: row.sectionTitle },
        blockId: row.blockId,
        cycleCode: row.cycleCode,
        effectiveFrom: date(row.effectiveFrom),
        effectiveUntil: date(row.effectiveUntil),
        room:
          row.roomId === null || row.roomName === null
            ? null
            : {
                id: row.roomId,
                name: row.roomName,
                code: row.roomCode,
              },
      },
    }));
  }

  async loadSectionTeachers(
    context: ScheduleResolutionContext,
    sectionId: SectionId,
  ): Promise<readonly SectionTeacherRecord[]> {
    const result = await sql<{
      sectionId: string;
      personId: string;
      startsOn: NullableDate;
      endsOn: NullableDate;
      displayName: string;
    }>`
      SELECT membership.section_id AS "sectionId", membership.person_id AS "personId",
             membership.starts_on AS "startsOn", membership.ends_on AS "endsOn",
             person.display_name AS "displayName"
      FROM section_membership membership
      JOIN section section_row
        ON section_row.tenant_id = membership.tenant_id
       AND section_row.id = membership.section_id
      JOIN person
        ON person.tenant_id = membership.tenant_id
       AND person.id = membership.person_id
      WHERE membership.tenant_id = ${context.tenantId}
        AND section_row.organization_id = ${context.organizationId}
        AND membership.section_id = ${sectionId}
        AND membership.role = 'teacher'
        AND membership.status = 'active'
        AND person.status = 'active'
      ORDER BY person.display_name, person.id
    `.execute(this.database);
    return result.rows.map((row) => ({
      membership: {
        sectionId: row.sectionId,
        personId: row.personId,
        role: 'teacher',
        startsOn: date(row.startsOn),
        endsOn: date(row.endsOn),
      },
      teacher: { id: row.personId, displayName: row.displayName },
    }));
  }
}
