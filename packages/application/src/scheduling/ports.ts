import type {
  CalendarDayReference,
  OrganizationId,
  PersonId,
  ScheduleSlotReference,
  ScheduleTemplateId,
  SchoolMembershipReference,
  SectionId,
  SectionMeetingReference,
  SectionMembershipReference,
  TeacherReference,
  TenantId,
} from '@openhall/domain';
import type { Temporal } from '@js-temporal/polyfill';

export interface ScheduleResolutionContext {
  readonly tenantId: TenantId;
  readonly organizationId: OrganizationId;
}

export interface SchedulingOrganizationRecord {
  readonly id: OrganizationId;
  readonly name: string;
  readonly kind: 'district' | 'school';
  readonly timeZone: string | null;
}

export interface StudentSectionMeetingRecord {
  readonly membership: SectionMembershipReference;
  readonly meeting: SectionMeetingReference;
}

export interface SectionTeacherRecord {
  readonly membership: SectionMembershipReference;
  readonly teacher: TeacherReference;
}

/** A purpose-built, tenant-and-school-scoped read model for expected placement. */
export interface ExpectedPlacementRepository {
  loadOrganization(
    context: ScheduleResolutionContext,
  ): Promise<SchedulingOrganizationRecord | null>;
  loadSchoolMemberships(
    context: ScheduleResolutionContext,
    personId: PersonId,
  ): Promise<readonly SchoolMembershipReference[]>;
  loadCalendarDay(
    context: ScheduleResolutionContext,
    date: Temporal.PlainDate,
  ): Promise<CalendarDayReference | null>;
  loadScheduleSlots(
    context: ScheduleResolutionContext,
    templateId: ScheduleTemplateId,
  ): Promise<readonly ScheduleSlotReference[]>;
  loadStudentSectionMeetings(
    context: ScheduleResolutionContext,
    personId: PersonId,
  ): Promise<readonly StudentSectionMeetingRecord[]>;
  loadSectionTeachers(
    context: ScheduleResolutionContext,
    sectionId: SectionId,
  ): Promise<readonly SectionTeacherRecord[]>;
}
