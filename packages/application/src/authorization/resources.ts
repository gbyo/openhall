import type { DestinationId, OrganizationId, PersonId, SectionId } from '@openhall/domain';
import type { Capability } from './capabilities.js';

export interface SelfResource {
  readonly kind: 'self';
}

export interface TenantResource {
  readonly kind: 'tenant';
}

export interface OrganizationResource {
  readonly kind: 'organization';
  readonly organizationId: OrganizationId;
}

export interface SectionResource {
  readonly kind: 'section';
  readonly sectionId: SectionId;
}

export interface StudentResource {
  readonly kind: 'student';
  readonly organizationId: OrganizationId;
  readonly studentId: PersonId;
}

export interface StudentInSectionResource {
  readonly kind: 'student_in_section';
  readonly sectionId: SectionId;
  readonly studentId: PersonId;
}

export interface DestinationResource {
  readonly kind: 'destination';
  readonly destinationId: DestinationId;
}

export type AuthorizationResource =
  | SelfResource
  | TenantResource
  | OrganizationResource
  | SectionResource
  | StudentResource
  | StudentInSectionResource
  | DestinationResource;

/**
 * Compile-time capability/resource compatibility. Invalid combinations
 * (e.g. schedule.manage on self) fail TypeScript compilation instead of
 * becoming runtime string conventions.
 */
export interface ResourceByCapability {
  'self.read': SelfResource;
  'organization.context.read': OrganizationResource;

  'pass.request.self': StudentResource;
  'pass.view.self': SelfResource;
  'pass.cancel.self': SelfResource;
  'pass.create.student': StudentResource | StudentInSectionResource;
  'pass.approve.section': StudentInSectionResource;
  'pass.override.request.self': StudentResource;
  'pass.override.request.student': StudentResource | StudentInSectionResource;
  'pass.override.resolve.section': StudentInSectionResource;
  'pass.override.resolve.school': StudentResource;

  'pass.view.section_live': SectionResource;
  'pass.view.school_live': OrganizationResource;
  'pass.view.school_history': OrganizationResource;

  'scheduled_authorization.manage': OrganizationResource;

  'destination.station.manage': DestinationResource;
  'destination.manage': OrganizationResource | DestinationResource;

  'schedule.view': OrganizationResource;
  'schedule.manage': OrganizationResource;

  'people.view': OrganizationResource;
  'people.manage': OrganizationResource;

  'policy.manage': OrganizationResource;
  'authorization.manage': OrganizationResource;
  'integration.manage': OrganizationResource;

  'incident.view': OrganizationResource;
  'incident.manage': OrganizationResource;

  'audit.view': OrganizationResource;

  'identity.manage': TenantResource;
  'system.manage': TenantResource;
}

export type CapabilityResource<C extends Capability = Capability> = ResourceByCapability[C];
