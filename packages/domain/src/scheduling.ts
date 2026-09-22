import type { Temporal } from '@js-temporal/polyfill';
import type {
  CalendarDayId,
  OrganizationId,
  PersonId,
  RoomId,
  ScheduleBlockId,
  ScheduleSlotId,
  ScheduleTemplateId,
  SectionId,
  SectionMeetingId,
} from './ids.js';

export const SCHEDULE_BLOCK_KINDS = [
  'instructional',
  'lunch',
  'advisory',
  'transition',
  'other',
] as const;
export type ScheduleBlockKind = (typeof SCHEDULE_BLOCK_KINDS)[number];

export type CalendarDayKind = 'instructional' | 'non_instructional' | 'closed';

export interface SchoolReference {
  readonly id: OrganizationId;
  readonly name: string;
  readonly kind: 'school';
  readonly timeZone: string;
}

export interface ScheduleTemplateReference {
  readonly id: ScheduleTemplateId;
  readonly name: string;
}

export interface CalendarDayReference {
  readonly id: CalendarDayId;
  readonly date: Temporal.PlainDate;
  readonly dayKind: CalendarDayKind;
  readonly cycleCode: string | null;
  readonly operationalNote: string | null;
  readonly template: ScheduleTemplateReference | null;
}

export interface ScheduleBlockReference {
  readonly id: ScheduleBlockId;
  readonly code: string;
  readonly displayName: string;
  readonly kind: ScheduleBlockKind;
}

export interface ScheduleSlotReference {
  readonly id: ScheduleSlotId;
  readonly startsAt: Temporal.PlainTime;
  readonly endsAt: Temporal.PlainTime;
  readonly ordinal: number;
  readonly block: ScheduleBlockReference;
}

export interface SectionReference {
  readonly id: SectionId;
  readonly code: string | null;
  readonly title: string;
}

export interface SectionMeetingReference {
  readonly id: SectionMeetingId;
  readonly section: SectionReference;
  readonly blockId: ScheduleBlockId;
  readonly cycleCode: string | null;
  readonly effectiveFrom: Temporal.PlainDate | null;
  readonly effectiveUntil: Temporal.PlainDate | null;
  readonly room: RoomReference | null;
}

export interface RoomReference {
  readonly id: RoomId;
  readonly name: string;
  readonly code: string | null;
}

export interface PersonReference {
  readonly id: PersonId;
  readonly displayName: string;
}

export type TeacherReference = PersonReference;

export interface SchoolMembershipReference {
  readonly personId: PersonId;
  readonly affiliation: 'student' | 'staff' | 'other';
  readonly validFrom: Temporal.PlainDate | null;
  readonly validUntil: Temporal.PlainDate | null;
}

export interface SectionMembershipReference {
  readonly sectionId: SectionId;
  readonly personId: PersonId;
  readonly role: 'student' | 'teacher';
  readonly startsOn: Temporal.PlainDate | null;
  readonly endsOn: Temporal.PlainDate | null;
}

export interface PlacementCandidateReference {
  readonly slotId: ScheduleSlotId;
  readonly blockId: ScheduleBlockId;
  readonly sectionId: SectionId;
  readonly sectionMeetingId: SectionMeetingId;
}
