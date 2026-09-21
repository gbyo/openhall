import type { Clock } from '@openhall/domain';
import type { Principal } from '../authentication/principal.js';
import type { RelationshipAuthorizationService } from '../authorization/service.js';
import { PassApplicationError } from '../passes/errors.js';
import { etagForPass } from '../passes/representations.js';
import type { TenantTransactionRunner } from '../persistence.js';
import type { OperationalLivePassRow, OperationalReadRepository } from './ports.js';

export interface OperationalReadDependencies {
  readonly clock: Clock;
  readonly runner: TenantTransactionRunner;
  readonly authorization: RelationshipAuthorizationService;
  readonly operations: OperationalReadRepository;
}

export interface LivePassView {
  readonly passId: string;
  readonly passRevision: string;
  readonly passEtag: string;
  readonly student: { readonly id: string; readonly displayName: string };
  readonly destination: {
    readonly id: string;
    readonly displayName: string;
    readonly serviceType: string;
  };
  readonly lifecycleState: OperationalLivePassRow['lifecycleState'];
  readonly requestedAt: string;
  readonly movement: {
    readonly readyUntil: string | null;
    readonly expectedReturnAt: string | null;
  };
  readonly origin: { readonly sectionId: string | null };
}

function toLivePass(row: OperationalLivePassRow): LivePassView {
  return {
    passId: row.passId,
    passRevision: row.passRevision.toString(10),
    passEtag: etagForPass(row.passId, row.passRevision),
    student: { id: row.studentId, displayName: row.studentDisplayName },
    destination: {
      id: row.destinationId,
      displayName: row.destinationDisplayName,
      serviceType: row.destinationServiceType,
    },
    lifecycleState: row.lifecycleState,
    requestedAt: row.requestedAt.toString(),
    movement: {
      readyUntil: row.readyUntil?.toString() ?? null,
      expectedReturnAt: row.expectedReturnAt?.toString() ?? null,
    },
    origin: { sectionId: row.originSectionId },
  };
}

function requireNormal(principal: Principal): void {
  if (principal.authenticationMethod === 'recovery') {
    throw new PassApplicationError(
      'recovery_session_restricted',
      'Recovery sessions cannot read operational movement.',
    );
  }
}

/** Section-live authorization is relationship-based and concealed on denial. */
async function requireSectionAccess(
  principal: Principal,
  sectionId: string,
  dependencies: OperationalReadDependencies,
): Promise<void> {
  const decision = await dependencies.authorization.decide({
    principal,
    capability: 'pass.view.section_live',
    resource: { kind: 'section', sectionId },
    at: dependencies.clock.now(),
  });
  if (!decision.allowed) {
    if (decision.reason === 'recovery_session_restricted') requireNormal(principal);
    throw new PassApplicationError('pass_not_found', 'Section not found.');
  }
}

export async function listSectionLivePasses(
  principal: Principal,
  sectionId: string,
  dependencies: OperationalReadDependencies,
): Promise<{ readonly passes: readonly LivePassView[] }> {
  requireNormal(principal);
  await requireSectionAccess(principal, sectionId, dependencies);
  const rows = await dependencies.runner.run(principal.tenantId, (context) =>
    dependencies.operations.listLiveBySection(context, sectionId),
  );
  return { passes: rows.map(toLivePass) };
}

export async function listSectionStudents(
  principal: Principal,
  sectionId: string,
  dependencies: OperationalReadDependencies,
): Promise<{
  readonly students: readonly { readonly id: string; readonly displayName: string }[];
}> {
  requireNormal(principal);
  await requireSectionAccess(principal, sectionId, dependencies);
  return dependencies.runner.run(principal.tenantId, async (context) => {
    const section = await dependencies.operations.loadSection(context, sectionId);
    if (section === null) throw new PassApplicationError('pass_not_found', 'Section not found.');
    let onDate: string;
    try {
      onDate = dependencies.clock
        .now()
        .toZonedDateTimeISO(section.timeZone)
        .toPlainDate()
        .toString();
    } catch {
      throw new PassApplicationError('pass_not_found', 'Section not found.');
    }
    return {
      students: await dependencies.operations.listActiveSectionStudents(context, sectionId, onDate),
    };
  });
}

export async function listSchoolLivePasses(
  principal: Principal,
  organizationId: string,
  dependencies: OperationalReadDependencies,
): Promise<{ readonly passes: readonly LivePassView[] }> {
  requireNormal(principal);
  const decision = await dependencies.authorization.decide({
    principal,
    capability: 'pass.view.school_live',
    resource: { kind: 'organization', organizationId },
    at: dependencies.clock.now(),
  });
  if (!decision.allowed) {
    if (decision.reason === 'recovery_session_restricted') requireNormal(principal);
    throw new PassApplicationError('pass_not_found', 'School not found.');
  }
  const rows = await dependencies.runner.run(principal.tenantId, (context) =>
    dependencies.operations.listLiveByOrganization(context, organizationId),
  );
  return { passes: rows.map(toLivePass) };
}
