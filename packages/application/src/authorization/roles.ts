import type { Capability } from './capabilities.js';
import type { ExplicitRole } from './decisions.js';

/**
 * Reviewed static mapping of explicit duties to capabilities. Canonical
 * school relationships (student/staff/teacher) are evaluated separately in
 * the authorization service; this table covers only authorization_grant
 * roles, which exist solely for duties without a canonical relationship.
 */
export const ROLE_CAPABILITIES: Record<ExplicitRole, readonly Capability[]> = {
  destination_staff: ['destination.station.manage'],
  counselor: [
    'pass.create.student',
    'pass.depart.student',
    'pass.view.school_live',
    'scheduled_authorization.manage',
    'pass.override.request.student',
    'pass.override.resolve.school',
  ],
  office_staff: [
    'pass.create.student',
    'pass.depart.student',
    'pass.view.school_live',
    'scheduled_authorization.manage',
    'pass.override.request.student',
    'pass.override.resolve.school',
  ],
  school_admin: [
    'pass.create.student',
    'pass.depart.student',
    'pass.approve.section',
    'pass.override.request.student',
    'pass.override.resolve.school',
    'pass.view.section_live',
    'pass.view.school_live',
    'pass.view.school_history',
    'scheduled_authorization.manage',
    'destination.station.manage',
    'destination.manage',
    'schedule.view',
    'schedule.manage',
    'people.view',
    'people.manage',
    'policy.manage',
    'authorization.manage',
    'integration.manage',
    'incident.view',
    'incident.manage',
    'audit.view',
  ],
  // system_admin is handled structurally in the service (tenant-wide, all
  // capabilities except relationship-specific self semantics), not via this
  // table, so it cannot drift from the tenant-wide rule.
  system_admin: [],
};

/** Capabilities a tenant system_admin may exercise (everything but self-gated). */
export const SYSTEM_ADMIN_CAPABILITIES: readonly Capability[] = [
  'organization.context.read',
  'pass.create.student',
  'pass.depart.student',
  'pass.approve.section',
  'pass.override.request.student',
  'pass.override.resolve.section',
  'pass.override.resolve.school',
  'pass.view.section_live',
  'pass.view.school_live',
  'pass.view.school_history',
  'scheduled_authorization.manage',
  'destination.station.manage',
  'destination.manage',
  'schedule.view',
  'schedule.manage',
  'people.view',
  'people.manage',
  'policy.manage',
  'authorization.manage',
  'integration.manage',
  'incident.view',
  'incident.manage',
  'audit.view',
  'identity.manage',
  'system.manage',
];

const ROLE_SET = new Set<string>([
  'destination_staff',
  'counselor',
  'office_staff',
  'school_admin',
  'system_admin',
]);

export function isExplicitRole(value: string): value is ExplicitRole {
  return ROLE_SET.has(value);
}
