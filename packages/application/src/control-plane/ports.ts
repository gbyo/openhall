import type { Temporal } from '@js-temporal/polyfill';
import type { CalendarDayKind, ScheduleBlockKind } from '@openhall/domain';
import type { TenantTransactionContext } from '../persistence.js';
import type { RoomCheckInMode } from '../passes/ports.js';

export type RoomStatus = 'open' | 'closed' | 'archived';
export type { RoomCheckInMode };

export type ScheduleBlockStatus = 'active' | 'archived';

export type PolicyScopeKind = 'organization' | 'section' | 'room' | 'room_category';

/** Server-owned policy rule projection. Revision is a positive integer. */
export interface PolicyRuleRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly organizationId: string;
  readonly name: string;
  readonly ruleType: string;
  readonly scopeKind: PolicyScopeKind;
  readonly scopeOrganizationId: string | null;
  readonly scopeSectionId: string | null;
  readonly scopeRoomId: string | null;
  readonly scopeRoomCategoryId: string | null;
  readonly priority: number;
  readonly configuration: unknown;
  readonly overrideMode: string;
  readonly enabled: boolean;
  readonly validFrom: Temporal.Instant | null;
  readonly validUntil: Temporal.Instant | null;
  readonly revision: number;
  readonly archivedAt: Temporal.Instant | null;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
}

export interface PolicyRuleWrite {
  readonly name: string;
  readonly ruleType: string;
  readonly scopeKind: PolicyScopeKind;
  readonly scopeOrganizationId: string | null;
  readonly scopeSectionId: string | null;
  readonly scopeRoomId: string | null;
  readonly scopeRoomCategoryId: string | null;
  readonly priority: number;
  readonly configuration: unknown;
  readonly overrideMode: string;
  readonly validFrom: Temporal.Instant | null;
  readonly validUntil: Temporal.Instant | null;
}

/** Purpose-built policy rule administration port; no generic SQL escape hatch. */
export interface PolicyAdminRepository {
  listByOrganization(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<readonly PolicyRuleRecord[]>;
  loadById(context: TenantTransactionContext, ruleId: string): Promise<PolicyRuleRecord | null>;
  loadForUpdate(
    context: TenantTransactionContext,
    ruleId: string,
  ): Promise<PolicyRuleRecord | null>;
  insert(
    context: TenantTransactionContext,
    input: PolicyRuleWrite & { readonly organizationId: string },
  ): Promise<PolicyRuleRecord>;
  /**
   * Full replacement of mutable configuration, incrementing revision once.
   * Returns null when the row no longer matches the expected revision.
   */
  updateToRevision(
    context: TenantTransactionContext,
    ruleId: string,
    expectedRevision: number,
    input: PolicyRuleWrite,
    at: Temporal.Instant,
  ): Promise<PolicyRuleRecord | null>;
  /** Semantic enabled toggle, incrementing revision once. */
  setEnabledToRevision(
    context: TenantTransactionContext,
    ruleId: string,
    expectedRevision: number,
    enabled: boolean,
    at: Temporal.Instant,
  ): Promise<PolicyRuleRecord | null>;
  /** Semantic archive (enabled=false, archived_at set), incrementing revision once. */
  archiveToRevision(
    context: TenantTransactionContext,
    ruleId: string,
    expectedRevision: number,
    at: Temporal.Instant,
  ): Promise<PolicyRuleRecord | null>;
  /** Canonical school and status of a section, for scope validation. */
  loadSectionSchool(
    context: TenantTransactionContext,
    sectionId: string,
  ): Promise<{ readonly organizationId: string; readonly status: string } | null>;
}

/** Server-owned schedule block projection (no per-block revision; the aggregate owns concurrency). */
export interface ScheduleBlockRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly organizationId: string;
  readonly code: string;
  readonly displayName: string;
  readonly kind: ScheduleBlockKind;
  readonly status: ScheduleBlockStatus;
}

export interface ScheduleTemplateRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly organizationId: string;
  readonly name: string;
  readonly status: ScheduleBlockStatus;
}

export interface ScheduleSlotRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly organizationId: string;
  readonly templateId: string;
  readonly blockId: string;
  readonly startsAt: Temporal.PlainTime;
  readonly endsAt: Temporal.PlainTime;
  readonly ordinal: number;
  readonly blockCode: string;
  readonly blockDisplayName: string;
  readonly blockKind: ScheduleBlockKind;
}

export interface CalendarDayRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly organizationId: string;
  readonly date: Temporal.PlainDate;
  readonly dayKind: CalendarDayKind;
  readonly templateId: string | null;
  readonly templateName: string | null;
  readonly cycleCode: string | null;
  readonly operationalNote: string | null;
}

export interface ScheduleConfigurationRecord {
  readonly organizationId: string;
  readonly revision: bigint;
  readonly updatedAt: Temporal.Instant;
}

/** Purpose-built schedule administration port; the aggregate row is the lock. */
export interface ScheduleAdminRepository {
  /** Reads the school schedule configuration without taking a write lock. */
  loadConfiguration(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<ScheduleConfigurationRecord | null>;
  /** Locks the school schedule configuration row; null when the school has none. */
  loadConfigurationForUpdate(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<ScheduleConfigurationRecord | null>;
  /** Unconditional revision bump; caller holds the aggregate lock. */
  bumpConfigurationRevision(
    context: TenantTransactionContext,
    organizationId: string,
    at: Temporal.Instant,
  ): Promise<ScheduleConfigurationRecord>;
  listBlocks(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<readonly ScheduleBlockRecord[]>;
  loadBlock(
    context: TenantTransactionContext,
    organizationId: string,
    blockId: string,
  ): Promise<ScheduleBlockRecord | null>;
  loadBlockByCode(
    context: TenantTransactionContext,
    organizationId: string,
    code: string,
  ): Promise<ScheduleBlockRecord | null>;
  insertBlock(
    context: TenantTransactionContext,
    input: {
      readonly organizationId: string;
      readonly code: string;
      readonly displayName: string;
      readonly kind: ScheduleBlockKind;
    },
  ): Promise<ScheduleBlockRecord>;
  updateBlock(
    context: TenantTransactionContext,
    organizationId: string,
    blockId: string,
    input: {
      readonly code: string;
      readonly displayName: string;
      readonly kind: ScheduleBlockKind;
    },
  ): Promise<ScheduleBlockRecord | null>;
  archiveBlock(
    context: TenantTransactionContext,
    organizationId: string,
    blockId: string,
  ): Promise<ScheduleBlockRecord | null>;
  /** Slots of non-archived templates referencing the block. */
  countTemplateSlotsForBlock(
    context: TenantTransactionContext,
    organizationId: string,
    blockId: string,
  ): Promise<number>;
  listTemplates(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<readonly ScheduleTemplateRecord[]>;
  loadTemplate(
    context: TenantTransactionContext,
    organizationId: string,
    templateId: string,
  ): Promise<ScheduleTemplateRecord | null>;
  insertTemplate(
    context: TenantTransactionContext,
    input: { readonly organizationId: string; readonly name: string },
  ): Promise<ScheduleTemplateRecord>;
  updateTemplateName(
    context: TenantTransactionContext,
    organizationId: string,
    templateId: string,
    name: string,
  ): Promise<ScheduleTemplateRecord | null>;
  archiveTemplate(
    context: TenantTransactionContext,
    organizationId: string,
    templateId: string,
  ): Promise<ScheduleTemplateRecord | null>;
  listSlotsByTemplate(
    context: TenantTransactionContext,
    organizationId: string,
    templateId: string,
  ): Promise<readonly ScheduleSlotRecord[]>;
  replaceTemplateSlots(
    context: TenantTransactionContext,
    input: {
      readonly organizationId: string;
      readonly templateId: string;
      readonly slots: readonly {
        readonly blockId: string;
        readonly startsAt: string;
        readonly endsAt: string;
        readonly ordinal: number;
      }[];
    },
  ): Promise<readonly ScheduleSlotRecord[]>;
  /**
   * Calendar days at or after the school-local date referencing the
   * template. Past references remain as truthful history and never block
   * archival.
   */
  countCurrentOrFutureCalendarAssignmentsForTemplate(
    context: TenantTransactionContext,
    organizationId: string,
    templateId: string,
    today: string,
  ): Promise<number>;
  loadDayByDate(
    context: TenantTransactionContext,
    organizationId: string,
    date: string,
  ): Promise<CalendarDayRecord | null>;
  listDaysInRange(
    context: TenantTransactionContext,
    organizationId: string,
    from: string,
    through: string,
  ): Promise<readonly CalendarDayRecord[]>;
  upsertDay(
    context: TenantTransactionContext,
    input: {
      readonly organizationId: string;
      readonly date: string;
      readonly dayKind: CalendarDayKind;
      readonly templateId: string | null;
      readonly cycleCode: string | null;
      readonly operationalNote: string | null;
    },
  ): Promise<CalendarDayRecord>;
}

/** Server-owned room row projection. Revisions are bigint end to end. */
export interface RoomRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly organizationId: string;
  readonly categoryId: string | null;
  readonly name: string;
  readonly code: string | null;
  readonly floorLabel: string | null;
  readonly status: RoomStatus;
  readonly studentSelfRequestable: boolean;
  readonly originSelectable: boolean;
  readonly capacity: number | null;
  readonly queueEnabled: boolean;
  readonly checkInMode: RoomCheckInMode;
  readonly defaultDurationSeconds: number | null;
  readonly maxDurationSeconds: number | null;
  readonly readyClaimTimeoutSeconds: number;
  readonly queueTimeoutSeconds: number;
  readonly revision: bigint;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
}

export interface NewRoom {
  readonly organizationId: string;
  readonly categoryId: string | null;
  readonly name: string;
  readonly code: string | null;
  readonly floorLabel: string | null;
  readonly studentSelfRequestable: boolean;
  readonly originSelectable: boolean;
  readonly capacity: number | null;
  readonly queueEnabled: boolean;
  readonly checkInMode: RoomCheckInMode;
  readonly defaultDurationSeconds: number | null;
  readonly maxDurationSeconds: number | null;
  readonly readyClaimTimeoutSeconds: number;
  readonly queueTimeoutSeconds: number;
}

export interface RoomUpdate {
  readonly categoryId: string | null;
  readonly name: string;
  readonly code: string | null;
  readonly floorLabel: string | null;
  readonly studentSelfRequestable: boolean;
  readonly originSelectable: boolean;
  readonly capacity: number | null;
  readonly queueEnabled: boolean;
  readonly checkInMode: RoomCheckInMode;
  readonly defaultDurationSeconds: number | null;
  readonly maxDurationSeconds: number | null;
  readonly readyClaimTimeoutSeconds: number;
  readonly queueTimeoutSeconds: number;
}

export type RoomCategoryPickerMode = 'auto' | 'list' | 'search';

/** Server-owned room-category row projection. Revisions are bigint end to end. */
export interface RoomCategoryRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly organizationId: string;
  readonly name: string;
  readonly iconKey: string;
  readonly toneKey: string;
  readonly studentSurface: 'primary' | 'secondary' | 'hidden';
  readonly pickerMode: RoomCategoryPickerMode;
  readonly sortOrder: number;
  readonly status: 'active' | 'archived';
  readonly revision: bigint;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
}

export interface NewRoomCategory {
  readonly organizationId: string;
  readonly name: string;
  readonly iconKey: string;
  readonly toneKey: string;
  readonly studentSurface: 'primary' | 'secondary' | 'hidden';
  readonly pickerMode: RoomCategoryPickerMode;
  readonly sortOrder: number;
}

export interface RoomCategoryUpdate {
  readonly name: string;
  readonly iconKey: string;
  readonly toneKey: string;
  readonly studentSurface: 'primary' | 'secondary' | 'hidden';
  readonly pickerMode: RoomCategoryPickerMode;
  readonly sortOrder: number;
}

/** Purpose-built destination-category persistence port; no generic SQL escape hatch. */
export interface RoomCategoryRepository {
  listByOrganization(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<readonly RoomCategoryRecord[]>;
  loadById(
    context: TenantTransactionContext,
    categoryId: string,
  ): Promise<RoomCategoryRecord | null>;
  loadForUpdate(
    context: TenantTransactionContext,
    categoryId: string,
  ): Promise<RoomCategoryRecord | null>;
  insert(context: TenantTransactionContext, input: NewRoomCategory): Promise<RoomCategoryRecord>;
  /**
   * Full replacement of mutable presentation metadata, incrementing revision
   * once. Returns null when the row no longer matches the expected revision.
   */
  updateToRevision(
    context: TenantTransactionContext,
    categoryId: string,
    expectedRevision: bigint,
    update: RoomCategoryUpdate,
    at: Temporal.Instant,
  ): Promise<RoomCategoryRecord | null>;
  /**
   * Semantic archive (status -> archived), incrementing revision once.
   * Returns null when the row no longer matches the expected revision.
   */
  archiveToRevision(
    context: TenantTransactionContext,
    categoryId: string,
    expectedRevision: bigint,
    at: Temporal.Instant,
  ): Promise<RoomCategoryRecord | null>;
  /**
   * Non-archived destinations referencing this category. Closed destinations
   * count: archiving their category would still silently alter student
   * grouping, so the guard is conservative by design.
   */
  countActiveRoomReferences(context: TenantTransactionContext, categoryId: string): Promise<number>;
}

/** Purpose-built room persistence port; no generic SQL escape hatch. */
export interface RoomRepository {
  /** Canonical school timezone for school-local date predicates, if the school exists. */
  loadSchoolTimeZone(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<string | null>;
  listByOrganization(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<readonly RoomRecord[]>;
  /** Open rooms of the school for catalogs and pickers. */
  listOpenCatalog(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<readonly RoomRecord[]>;
  loadById(context: TenantTransactionContext, roomId: string): Promise<RoomRecord | null>;
  loadForUpdate(context: TenantTransactionContext, roomId: string): Promise<RoomRecord | null>;
  insert(context: TenantTransactionContext, input: NewRoom): Promise<RoomRecord>;
  /**
   * Configuration replacement (never status), incrementing revision once.
   * Returns null when the row no longer matches the expected revision.
   */
  updateToRevision(
    context: TenantTransactionContext,
    roomId: string,
    expectedRevision: bigint,
    update: RoomUpdate,
    at: Temporal.Instant,
  ): Promise<RoomRecord | null>;
  /**
   * Semantic status transition (open/closed/archived), incrementing revision
   * once. Returns null when the row no longer matches the expected revision.
   */
  transitionStatusToRevision(
    context: TenantTransactionContext,
    roomId: string,
    expectedRevision: bigint,
    status: RoomStatus,
    at: Temporal.Instant,
  ): Promise<RoomRecord | null>;
  /** Passes in live workflow states bound to this room as destination. */
  countLivePasses(context: TenantTransactionContext, roomId: string): Promise<number>;
  /** Active explicit room_staff grants for this room. */
  countActiveStaffGrants(context: TenantTransactionContext, roomId: string): Promise<number>;
  /** Enabled room-scoped policy rules for this room. */
  countEnabledPolicyRules(context: TenantTransactionContext, roomId: string): Promise<number>;
  /** Active or future scheduled authorizations targeting this room. */
  countLiveScheduledAuthorizations(
    context: TenantTransactionContext,
    roomId: string,
    now: Temporal.Instant,
  ): Promise<number>;
  /** Section meetings referencing this room that are current or future. */
  countRelevantSectionMeetings(
    context: TenantTransactionContext,
    roomId: string,
    today: string,
  ): Promise<number>;
  /** Active scheduled authorizations using this room as specific origin. */
  countActiveScheduledOrigins(
    context: TenantTransactionContext,
    roomId: string,
    now: Temporal.Instant,
  ): Promise<number>;
  /**
   * Active explicit room_staff grants per room with staff display names.
   * Read-only here; category names never imply staffing.
   */
  listActiveRoomStaff(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<readonly { readonly roomId: string; readonly staffDisplayName: string }[]>;
  /**
   * Derived class context per room: active teacher memberships on sections
   * meeting at the room. Read-only here; teachers are never granted room
   * staff implicitly through this listing.
   */
  listRoomClassContexts(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<
    readonly {
      readonly roomId: string;
      readonly teacherDisplayName: string;
      readonly sectionTitle: string;
      readonly sectionCode: string | null;
    }[]
  >;
}

/** School-manageable explicit duty roles. Never student/teacher/system_admin. */
export const SCHOOL_GRANT_ROLES = [
  'room_staff',
  'counselor',
  'office_staff',
  'school_admin',
] as const;

export type SchoolGrantRole = (typeof SCHOOL_GRANT_ROLES)[number];

export function isSchoolGrantRole(value: string): value is SchoolGrantRole {
  return (SCHOOL_GRANT_ROLES as readonly string[]).includes(value);
}

/**
 * Server-owned authorization grant row projection. Revision is bigint end
 * to end. personId is resolved through the grant account (the grant table
 * is account-first); it is the invitation/enrollment handle, never email.
 */
export interface GrantRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly personId: string;
  readonly personDisplayName: string;
  readonly role: string;
  readonly scopeKind: string;
  readonly organizationId: string | null;
  readonly roomId: string | null;
  readonly roomName: string | null;
  readonly status: string;
  readonly validFrom: Temporal.Instant | null;
  readonly validUntil: Temporal.Instant | null;
  readonly revision: bigint;
  readonly createdByAccountId: string | null;
  readonly revokedAt: Temporal.Instant | null;
  readonly revokedByAccountId: string | null;
  readonly createdAt: Temporal.Instant;
}

export interface NewGrant {
  readonly accountId: string;
  readonly personId: string;
  readonly role: SchoolGrantRole;
  readonly scopeKind: 'organization' | 'room';
  readonly organizationId: string | null;
  readonly roomId: string | null;
  readonly validFrom: Temporal.Instant | null;
  readonly validUntil: Temporal.Instant | null;
  readonly createdByAccountId: string;
}

/** Target person with the active staff membership that qualifies a duty. */
export interface GrantTargetPerson {
  readonly id: string;
  readonly tenantId: string;
  readonly status: string;
}

/** Purpose-built authorization grant administration persistence port. */
export interface GrantAdminRepository {
  /** Canonical school timezone for school-local date predicates, if the school exists. */
  loadSchoolTimeZone(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<string | null>;
  /** Grants whose canonical school is the given organization, newest first. */
  listByOrganization(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<readonly GrantRecord[]>;
  loadById(context: TenantTransactionContext, grantId: string): Promise<GrantRecord | null>;
  loadForUpdate(context: TenantTransactionContext, grantId: string): Promise<GrantRecord | null>;
  /** Person row by id, any status; null when missing. */
  loadPerson(
    context: TenantTransactionContext,
    personId: string,
  ): Promise<GrantTargetPerson | null>;
  /**
   * Active staff membership of the person in the exact school covering the
   * school-local date (valid_from/valid_until are dates), if any.
   */
  loadActiveStaffMembership(
    context: TenantTransactionContext,
    personId: string,
    organizationId: string,
    onDate: string,
  ): Promise<{ readonly personId: string } | null>;
  /** Existing account for the person, if any. */
  loadAccountForPerson(
    context: TenantTransactionContext,
    personId: string,
  ): Promise<{ readonly id: string } | null>;
  /** Creates a login-less account so duties can be configured before enrollment. */
  insertAccount(
    context: TenantTransactionContext,
    personId: string,
  ): Promise<{ readonly id: string }>;
  /**
   * Inserts an active grant at revision 1. Returns null when a duplicate
   * active duty already exists (partial unique index), so the caller can
   * report authorization_grant_exists instead of leaking a driver error.
   */
  insertActive(context: TenantTransactionContext, input: NewGrant): Promise<GrantRecord | null>;
  /**
   * Semantic revoke (status -> revoked), incrementing revision once.
   * Returns null when the row no longer matches the expected revision.
   */
  revokeToRevision(
    context: TenantTransactionContext,
    grantId: string,
    expectedRevision: bigint,
    revokedByAccountId: string,
    at: Temporal.Instant,
  ): Promise<GrantRecord | null>;
}

/** One school-affiliated person with login/enrollment visibility. */
export interface PersonDirectoryRow {
  readonly personId: string;
  readonly displayName: string;
  readonly givenName: string;
  readonly familyName: string;
  readonly affiliation: string;
  readonly gradeLevel: string | null;
  readonly personStatus: string;
  readonly membershipStatus: string;
  readonly accountId: string | null;
  readonly accountStatus: string | null;
  readonly identityLinked: boolean;
}

export interface PersonSearchCursor {
  readonly displayName: string;
  readonly personId: string;
}

export interface PersonSearchInput {
  readonly q: string | null;
  readonly affiliation: 'student' | 'staff' | null;
  readonly limit: number;
  readonly cursor: PersonSearchCursor | null;
}

/** One section choice without membership rosters. */
export interface SectionChoiceRow {
  readonly id: string;
  readonly code: string | null;
  readonly title: string;
  readonly status: string;
}

export interface SectionSearchCursor {
  readonly title: string;
  readonly sectionId: string;
}

export interface SectionSearchInput {
  readonly q: string | null;
  readonly limit: number;
  readonly cursor: SectionSearchCursor | null;
}

/** Purpose-built read-only directory persistence port (tenant-scoped). */
export interface PeopleRepository {
  /**
   * Keyset search over the exact school's affiliations, ordered by
   * (display_name, person_id). Returns at most limit + 1 rows so the
   * caller can report whether another page exists.
   */
  searchPeople(
    context: TenantTransactionContext,
    organizationId: string,
    input: PersonSearchInput,
  ): Promise<readonly PersonDirectoryRow[]>;
  /**
   * Keyset search over the school's sections, ordered by (title, id).
   * Returns at most limit + 1 rows. Never includes membership rosters.
   */
  searchSections(
    context: TenantTransactionContext,
    organizationId: string,
    input: SectionSearchInput,
  ): Promise<readonly SectionChoiceRow[]>;
}

/** Server-owned identity enrollment grant row. Revision is bigint end to end. */
export interface EnrollmentRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly organizationId: string;
  readonly accountId: string;
  readonly personId: string;
  readonly identityProviderId: string;
  readonly tokenHash: Uint8Array;
  readonly revision: bigint;
  readonly createdByAccountId: string | null;
  readonly createdAt: Temporal.Instant;
  readonly expiresAt: Temporal.Instant;
  readonly consumedAt: Temporal.Instant | null;
  readonly revokedAt: Temporal.Instant | null;
  readonly revokedByAccountId: string | null;
}

export interface NewEnrollmentGrant {
  readonly organizationId: string;
  readonly accountId: string;
  readonly identityProviderId: string;
  readonly tokenHash: Uint8Array;
  readonly expiresAt: Temporal.Instant;
  readonly createdByAccountId: string;
}

/** Purpose-built identity enrollment persistence port. */
export interface EnrollmentRepository {
  /** Canonical school timezone for school-local date predicates, if the school exists. */
  loadSchoolTimeZone(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<string | null>;
  /** Person row by id, any status; null when missing. */
  loadPerson(
    context: TenantTransactionContext,
    personId: string,
  ): Promise<{ readonly id: string; readonly tenantId: string; readonly status: string } | null>;
  /**
   * Active student or staff membership of the person in the exact school
   * covering the school-local date, if any.
   */
  loadActiveMembership(
    context: TenantTransactionContext,
    personId: string,
    organizationId: string,
    onDate: string,
  ): Promise<{ readonly affiliation: string } | null>;
  /** Existing account for the person, if any. */
  loadAccountForPerson(
    context: TenantTransactionContext,
    personId: string,
  ): Promise<{ readonly id: string } | null>;
  /** Creates a login-less account so enrollment can precede first login. */
  insertAccount(
    context: TenantTransactionContext,
    personId: string,
  ): Promise<{ readonly id: string }>;
  /** Whether the account already has an identity on the provider. */
  hasProviderIdentity(
    context: TenantTransactionContext,
    accountId: string,
    identityProviderId: string,
  ): Promise<boolean>;
  /**
   * Inserts a live enrollment grant at revision 1. Returns null when a live
   * grant already exists for the account/provider (partial unique index).
   */
  insertGrant(
    context: TenantTransactionContext,
    input: NewEnrollmentGrant,
  ): Promise<EnrollmentRecord | null>;
  /**
   * System-level lookup of a grant by token digest for the unauthenticated
   * enrollment start. The digest is unguessable; the tenant is verified
   * from the row before any further action.
   */
  loadGrantByTokenDigest(tokenHash: Uint8Array): Promise<EnrollmentRecord | null>;
  loadGrantById(
    context: TenantTransactionContext,
    enrollmentId: string,
  ): Promise<EnrollmentRecord | null>;
  /** Latest still-live invitation for one person in one school, if any. */
  loadActiveGrantForPerson(
    context: TenantTransactionContext,
    organizationId: string,
    personId: string,
    at: Temporal.Instant,
  ): Promise<EnrollmentRecord | null>;
  loadGrantForUpdate(
    context: TenantTransactionContext,
    enrollmentId: string,
  ): Promise<EnrollmentRecord | null>;
  /**
   * Consumes a live grant (sets consumed_at, revision + 1). Returns null
   * when the row is no longer live at the expected revision.
   */
  consumeGrant(
    context: TenantTransactionContext,
    enrollmentId: string,
    expectedRevision: bigint,
    at: Temporal.Instant,
  ): Promise<EnrollmentRecord | null>;
  /**
   * Revokes a live grant (sets revoked_at/by, revision + 1). Returns null
   * when the row is no longer live at the expected revision.
   */
  revokeGrant(
    context: TenantTransactionContext,
    enrollmentId: string,
    expectedRevision: bigint,
    revokedByAccountId: string,
    at: Temporal.Instant,
  ): Promise<EnrollmentRecord | null>;
}

/** Server-owned scheduled authorization row. Revision is bigint end to end. */
export interface ScheduledAuthRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly organizationId: string;
  readonly studentId: string;
  readonly studentDisplayName: string;
  readonly studentGradeLevel: string | null;
  readonly destinationRoomId: string;
  readonly destinationRoomName: string;
  readonly createdByPersonId: string;
  readonly createdByAccountId: string | null;
  readonly validFrom: Temporal.Instant;
  readonly validUntil: Temporal.Instant;
  readonly status: string;
  readonly approvalMode: string;
  readonly originStrategy: string;
  readonly originRoomId: string | null;
  readonly originRoomName: string | null;
  readonly displayCategory: string | null;
  readonly revision: bigint;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
  readonly usedAt: Temporal.Instant | null;
  readonly usedByAccountId: string | null;
  readonly cancelledAt: Temporal.Instant | null;
  readonly cancelledByAccountId: string | null;
  readonly lastAttemptAt: Temporal.Instant | null;
}

export interface NewScheduledAuth {
  readonly organizationId: string;
  readonly studentId: string;
  readonly destinationRoomId: string;
  readonly createdByPersonId: string;
  readonly createdByAccountId: string;
  readonly validFrom: Temporal.Instant;
  readonly validUntil: Temporal.Instant;
  readonly approvalMode: 'preapproved' | 'approval_required';
  readonly originStrategy: 'expected' | 'specific';
  readonly originRoomId: string | null;
}

/** Purpose-built scheduled authorization persistence port. */
export interface ScheduledAuthRepository {
  /** Canonical school timezone for school-local date predicates, if the school exists. */
  loadSchoolTimeZone(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<string | null>;
  /** Student person row by id, any status; null when missing. */
  loadStudent(
    context: TenantTransactionContext,
    studentId: string,
  ): Promise<{ readonly id: string; readonly tenantId: string; readonly status: string } | null>;
  /**
   * Active student membership of the person in the exact school covering
   * the school-local date, if any.
   */
  loadActiveStudentMembership(
    context: TenantTransactionContext,
    studentId: string,
    organizationId: string,
    onDate: string,
  ): Promise<{ readonly personId: string } | null>;
  /**
   * Same-school open room by id with its name and origin selectability;
   * null when missing, elsewhere, or not open. Callers that create an
   * explicit origin must also honor `originSelectable`.
   */
  loadActiveRoom(
    context: TenantTransactionContext,
    organizationId: string,
    roomId: string,
  ): Promise<{
    readonly id: string;
    readonly name: string;
    readonly originSelectable: boolean;
  } | null>;
  /** Authorizations for the school, soonest window first. */
  listByOrganization(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<readonly ScheduledAuthRecord[]>;
  /**
   * The student's own authorizations across the tenant's schools, soonest
   * window first. Tenant plus student scoping makes cross-student
   * traversal impossible; no caller-supplied school is trusted.
   */
  listByStudent(
    context: TenantTransactionContext,
    studentId: string,
  ): Promise<readonly ScheduledAuthRecord[]>;
  loadById(
    context: TenantTransactionContext,
    scheduledAuthorizationId: string,
  ): Promise<ScheduledAuthRecord | null>;
  loadForUpdate(
    context: TenantTransactionContext,
    scheduledAuthorizationId: string,
  ): Promise<ScheduledAuthRecord | null>;
  /** Inserts an active authorization at revision 1. */
  insert(context: TenantTransactionContext, input: NewScheduledAuth): Promise<ScheduledAuthRecord>;
  /**
   * Marks a live authorization used, incrementing revision once. Returns
   * null when the row is no longer live at the expected revision.
   */
  markUsed(
    context: TenantTransactionContext,
    scheduledAuthorizationId: string,
    expectedRevision: bigint,
    usedByAccountId: string,
    at: Temporal.Instant,
  ): Promise<ScheduledAuthRecord | null>;
  /**
   * Records a terminal denied attempt (last_attempt_at, revision + 1)
   * without consuming the authorization. Returns null when the row is no
   * longer live at the expected revision.
   */
  recordAttempt(
    context: TenantTransactionContext,
    scheduledAuthorizationId: string,
    expectedRevision: bigint,
    at: Temporal.Instant,
  ): Promise<ScheduledAuthRecord | null>;
  /**
   * Cancels a live authorization with staff provenance, incrementing
   * revision once. Returns null when the row is no longer live at the
   * expected revision.
   */
  cancelToRevision(
    context: TenantTransactionContext,
    scheduledAuthorizationId: string,
    expectedRevision: bigint,
    cancelledByAccountId: string,
    at: Temporal.Instant,
  ): Promise<ScheduledAuthRecord | null>;
}

/** Minimized audit projection: durable evidence stays in metadata, never here. */
export interface AuditEventRow {
  readonly id: string;
  readonly occurredAt: Temporal.Instant;
  readonly action: string;
  readonly actorKind: string;
  readonly actorAccountId: string | null;
  readonly actorDisplayName: string | null;
  readonly targetKind: string;
  readonly targetId: string | null;
  readonly outcome: string;
  readonly requestId: string;
}

export interface AuditEventCursor {
  readonly occurredAt: Temporal.Instant;
  readonly id: string;
}

export interface AuditEventListInput {
  readonly limit: number;
  readonly cursor: AuditEventCursor | null;
}

/** School-scoped audit read port. */
export interface AuditRepository {
  /**
   * Keyset list over the exact school's audit events, ordered by
   * (occurred_at DESC, id DESC). Returns at most limit + 1 rows so the
   * caller can report whether another page exists. Never returns metadata.
   */
  listOrganizationEvents(
    context: TenantTransactionContext,
    organizationId: string,
    input: AuditEventListInput,
  ): Promise<readonly AuditEventRow[]>;
}
