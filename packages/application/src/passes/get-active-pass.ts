import type { Principal } from '../authentication/principal.js';
import type { TenantTransactionRunner } from '../persistence.js';
import { PassApplicationError } from './errors.js';
import type { PassRepository } from './ports.js';
import { etagForPass, placementKindFromRow, type PassRepresentation } from './representations.js';

export interface ActivePassDependencies {
  readonly runner: TenantTransactionRunner;
  readonly passes: PassRepository;
}

export interface ActivePassResult {
  readonly pass: PassRepresentation | null;
  readonly etag: string | null;
}

/**
 * GET /api/v1/me/passes/active — the caller's own active pass, or null.
 * Never accepts a studentId; searches student_id = principal.personId.
 * Recovery sessions are rejected; no pass existence leaks across students.
 */
export async function getActiveSelfPass(
  principal: Principal,
  dependencies: ActivePassDependencies,
): Promise<ActivePassResult> {
  if (principal.authenticationMethod === 'recovery') {
    throw new PassApplicationError(
      'recovery_session_restricted',
      'Recovery sessions cannot read passes.',
    );
  }
  const row = await dependencies.runner.run(principal.tenantId, (context) =>
    dependencies.passes.findActivePassForStudent(context, principal.personId),
  );
  if (row?.tenantId !== principal.tenantId || row.studentId !== principal.personId) {
    return { pass: null, etag: null };
  }
  const pass: PassRepresentation = {
    id: row.id,
    organizationId: row.organizationId,
    studentId: row.studentId,
    destination: {
      id: row.destinationId,
      displayName: row.destinationDisplayName,
      serviceType: row.destinationServiceType,
    },
    origin: {
      placementKind: placementKindFromRow(row),
      block: row.originBlock,
      section: row.originSection,
      location: row.originLocation,
    },
    requestSource: row.requestSource,
    requestedAt: row.requestedAt.toString(),
    lifecycleState: row.lifecycleState,
    revision: row.revision.toString(10),
  };
  return { pass, etag: etagForPass(row.id, row.revision) };
}
