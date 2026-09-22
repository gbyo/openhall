import type { Capability } from './capabilities.js';
import type { ResourceByCapability } from './resources.js';
import type { Principal } from '../authentication/principal.js';
import type { Temporal } from '@js-temporal/polyfill';

/**
 * Typed authorization request. The capability statically determines the
 * permitted resource type, so mismatched pairs fail compilation at the
 * normal call site. The calling use case provides one instant.
 */
export interface AuthorizationRequest<C extends Capability = Capability> {
  readonly principal: Principal;
  readonly capability: C;
  readonly resource: ResourceByCapability[C];
  readonly at: Temporal.Instant;
}

export type ExplicitRole =
  'room_staff' | 'counselor' | 'office_staff' | 'school_admin' | 'system_admin';

export type AuthorizationBasis =
  | { readonly kind: 'self' }
  | { readonly kind: 'organization_membership' }
  | { readonly kind: 'student_membership' }
  | { readonly kind: 'teacher_section_relationship' }
  | {
      readonly kind: 'explicit_grant';
      readonly grantId: string;
      readonly role: ExplicitRole;
      readonly scopeKind: 'tenant' | 'organization' | 'room';
      readonly organizationId: string | null;
      readonly roomId: string | null;
    }
  | { readonly kind: 'system_admin'; readonly grantId: string };

export type AuthorizationDenialReason =
  | 'recovery_session_restricted'
  | 'tenant_mismatch'
  | 'resource_not_found'
  | 'resource_inactive'
  | 'organization_not_school'
  | 'invalid_school_time_zone'
  | 'no_active_organization_membership'
  | 'target_not_active_student'
  | 'teacher_not_assigned'
  | 'target_not_in_section'
  | 'no_applicable_grant'
  | 'staff_membership_required'
  | 'capability_not_applicable';

export type AuthorizationDecision =
  | { readonly allowed: true; readonly basis: AuthorizationBasis }
  | { readonly allowed: false; readonly reason: AuthorizationDenialReason };
