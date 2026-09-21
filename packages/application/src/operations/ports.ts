import type { Temporal } from '@js-temporal/polyfill';
import type { TenantTransactionContext } from '../persistence.js';

export interface OperationalSectionRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly timeZone: string;
}

export interface OperationalStudentRow {
  readonly id: string;
  readonly displayName: string;
}

export interface OperationalLivePassRow {
  readonly passId: string;
  readonly passRevision: bigint;
  readonly studentId: string;
  readonly studentDisplayName: string;
  readonly destinationId: string;
  readonly destinationDisplayName: string;
  readonly destinationServiceType: string;
  readonly lifecycleState:
    'requested' | 'queued' | 'ready' | 'outbound' | 'at_destination' | 'returning';
  readonly requestedAt: Temporal.Instant;
  readonly readyUntil: Temporal.Instant | null;
  readonly expectedReturnAt: Temporal.Instant | null;
  readonly originSectionId: string | null;
}

/** Purpose-built, minimized reads for teacher and school operations. */
export interface OperationalReadRepository {
  loadSection(
    context: TenantTransactionContext,
    sectionId: string,
  ): Promise<OperationalSectionRecord | null>;
  listActiveSectionStudents(
    context: TenantTransactionContext,
    sectionId: string,
    onDate: string,
  ): Promise<readonly OperationalStudentRow[]>;
  listLiveBySection(
    context: TenantTransactionContext,
    sectionId: string,
  ): Promise<readonly OperationalLivePassRow[]>;
  listLiveByOrganization(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<readonly OperationalLivePassRow[]>;
}
