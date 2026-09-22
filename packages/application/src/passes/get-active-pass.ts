import type { Principal } from '../authentication/principal.js';
import type { TenantTransactionRunner } from '../persistence.js';
import type { RoomFlowRepository } from '../room-flow/ports.js';
import { loadMovementForRow } from '../room-flow/projections.js';
import { buildPolicyProjection, type PolicyRepository } from '../policy/index.js';
import { PassApplicationError } from './errors.js';
import type { PassRepository } from './ports.js';
import { etagForPass, toPassRepresentation, type PassRepresentation } from './representations.js';

export interface ActivePassDependencies {
  readonly runner: TenantTransactionRunner;
  readonly passes: PassRepository;
  readonly flow: RoomFlowRepository;
  readonly policy: PolicyRepository;
}

export interface ActivePassResult {
  readonly pass: PassRepresentation | null;
  readonly etag: string | null;
}

/**
 * GET /api/v1/me/passes/active — the caller's own active pass, or null.
 * Never accepts a studentId; searches student_id = principal.personId.
 * Recovery sessions are rejected; no pass existence leaks across students.
 * Attaches the latest safe policy projection without re-evaluating: reads
 * stay reads, and legacy passes without an evaluation project policy:null.
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
  const loaded = await dependencies.runner.run(principal.tenantId, async (context) => {
    const row = await dependencies.passes.findActivePassForStudent(context, principal.personId);
    if (row === null) return null;
    return {
      row,
      evaluation: await dependencies.policy.loadLatestEvaluation(context, row.id),
      approvals: await dependencies.policy.listApprovalsForPass(context, row.id),
      overrides: await dependencies.policy.listOverridesForPass(context, row.id),
      movement: await loadMovementForRow(context, dependencies.passes, dependencies.flow, row),
    };
  });
  if (loaded === null) return { pass: null, etag: null };
  const { row } = loaded;
  if (row.tenantId !== principal.tenantId || row.studentId !== principal.personId) {
    return { pass: null, etag: null };
  }
  const pass: PassRepresentation = toPassRepresentation(
    row,
    loaded.evaluation === null
      ? null
      : buildPolicyProjection(loaded.evaluation, loaded.approvals, loaded.overrides),
    loaded.movement,
  );
  return { pass, etag: etagForPass(row.id, row.revision) };
}
