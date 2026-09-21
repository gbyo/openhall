import type { Temporal } from '@js-temporal/polyfill';
import type { Capability } from '../authorization/capabilities.js';
import type { AuthorizationDenialReason } from '../authorization/decisions.js';
import type { RelationshipAuthorizationService } from '../authorization/service.js';
import type { Principal } from '../authentication/principal.js';
import type { TenantTransactionContext } from '../persistence.js';
import { ControlPlaneError, type ControlPlaneErrorCode } from './errors.js';

/** School-local calendar date for a command instant; null on unusable zones. */
export function schoolDateFor(at: Temporal.Instant, timeZone: string): Temporal.PlainDate | null {
  try {
    return at.toZonedDateTimeISO(timeZone).toPlainDate();
  } catch {
    return null;
  }
}

/** Maps an authorization denial to a safe control-plane error. */
export function denialToError(
  reason: AuthorizationDenialReason,
  notFound: ControlPlaneErrorCode,
): ControlPlaneError {
  switch (reason) {
    case 'recovery_session_restricted':
      return new ControlPlaneError(
        'recovery_session_restricted',
        'Recovery sessions cannot use the school control plane.',
      );
    case 'tenant_mismatch':
    case 'resource_not_found':
      return new ControlPlaneError(notFound, 'Not found.');
    case 'capability_not_applicable':
      return new ControlPlaneError('invalid_precondition', 'Capability not applicable.');
    default:
      return new ControlPlaneError('forbidden', 'Forbidden.');
  }
}

/**
 * Authorizes an organization-scoped control-plane capability against the
 * exact school. Cross-tenant and cross-school references are concealed as
 * the caller-supplied not-found error.
 */
export async function requireOrganizationCapability(
  context: TenantTransactionContext,
  authorization: RelationshipAuthorizationService,
  principal: Principal,
  capability: Capability,
  organizationId: string,
  at: Temporal.Instant,
  notFound: ControlPlaneErrorCode,
): Promise<void> {
  const decision = await authorization.decideWithContext(context, {
    principal,
    capability,
    resource: { kind: 'organization', organizationId },
    at,
  });
  if (!decision.allowed) {
    throw denialToError(decision.reason, notFound);
  }
}

/** Rejects recovery sessions before any school control-plane mutation. */
export function requireNormalSession(principal: Principal): void {
  if (principal.authenticationMethod === 'recovery') {
    throw new ControlPlaneError(
      'recovery_session_restricted',
      'Recovery sessions cannot use the school control plane.',
    );
  }
}
