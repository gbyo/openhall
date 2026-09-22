import type { Clock } from '@openhall/domain';
import type { Principal } from '../authentication/principal.js';
import type {
  AuthorizationFactsRepository,
  OrganizationAuthorizationSnapshot,
  RelationshipAuthorizationService,
} from '../authorization/index.js';
import type { TenantTransactionRunner } from '../persistence.js';
import type { ExpectedPlacementResolver, ExpectedPlacementResult } from '../scheduling/index.js';
import { UserContextError } from './errors.js';

export interface AccessibleOrganization {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly timeZone: string;
  readonly affiliations: readonly ('student' | 'staff' | 'other')[];
}

export interface OrganizationContext {
  readonly organization: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly timeZone: string;
  };
  readonly affiliations: readonly ('student' | 'staff' | 'other')[];
  readonly capabilities: OrganizationAuthorizationSnapshot['capabilities'];
  readonly teachingSections: OrganizationAuthorizationSnapshot['teachingSections'];
  readonly staffedDestinations: OrganizationAuthorizationSnapshot['staffedDestinations'];
  /**
   * Internal only: Place locations where the caller's active teaching
   * sections meet. Feeds realtime request invalidation; never mapped to
   * the public DTO.
   */
  readonly teachingMeetingLocationIds: readonly string[];
  /** Raw resolver result; the HTTP layer maps it to the minimized public DTO. */
  readonly expectedPlacement: ExpectedPlacementResult | null;
}

export interface UserContextDependencies {
  readonly authorization: RelationshipAuthorizationService;
  readonly facts: AuthorizationFactsRepository;
  readonly placement: ExpectedPlacementResolver;
  readonly clock: Clock;
  readonly runner: TenantTransactionRunner;
}

/**
 * Application use cases behind GET /api/v1/me/organizations[.]. Routes
 * authenticate, call here with the Principal, and map the result to the
 * public DTO. One clock read per call; the same instant drives
 * authorization validity, membership validity, and expected placement.
 */
export class UserContextService {
  constructor(private readonly dependencies: UserContextDependencies) {}

  async listMyOrganizations(principal: Principal): Promise<readonly AccessibleOrganization[]> {
    if (principal.authenticationMethod === 'recovery') {
      throw new UserContextError(
        'recovery_session_restricted',
        'Recovery sessions cannot list operational school contexts.',
      );
    }
    const { authorization, clock, runner } = this.dependencies;
    const at = clock.now();
    return runner.run(principal.tenantId, (context) =>
      authorization.listAccessibleOrganizations(context, principal, at),
    );
  }

  async getMyOrganizationContext(
    principal: Principal,
    organizationId: string,
  ): Promise<OrganizationContext> {
    if (principal.authenticationMethod === 'recovery') {
      throw new UserContextError(
        'recovery_session_restricted',
        'Recovery sessions cannot access operational school contexts.',
      );
    }
    const { authorization, facts, placement, clock, runner } = this.dependencies;
    const at = clock.now();
    const snapshot = await runner.run(principal.tenantId, (context) =>
      authorization.evaluateOrganizationSnapshot(context, principal, organizationId, at),
    );
    if (snapshot === null) {
      // Unknown, cross-tenant, archived, or non-school organization. The
      // HTTP layer conceals all of these as 404.
      throw new UserContextError(
        'organization_not_found',
        'Organization context is not accessible.',
      );
    }
    if (!snapshot.capabilities.includes('organization.context.read')) {
      // The principal holds no current membership in this school (and no
      // tenant system_admin grant): inaccessible, concealed as 404. The
      // gate reuses the same enforcement decision that produces the hints.
      throw new UserContextError(
        'organization_not_found',
        'Organization context is not accessible.',
      );
    }
    const organization = await runner.run(principal.tenantId, (context) =>
      facts.loadOrganization(context, organizationId),
    );
    // Own teaching locations for realtime invalidation. Runs only after
    // the context.read gate above: no inaccessible school is probed.
    const teachingMeetingLocationIds = await runner.run(principal.tenantId, (context) =>
      facts.listTeachingMeetingLocations(context, principal.personId, organizationId),
    );
    if (organization === null) {
      throw new UserContextError(
        'organization_not_found',
        'Organization context is not accessible.',
      );
    }

    // Expected placement only for a current active student affiliation;
    // staff-only users receive null rather than a fabricated placement.
    // A person holding both student and staff affiliations is a student here.
    const expectedPlacement = snapshot.isActiveStudent
      ? await placement.resolve({
          tenantId: principal.tenantId,
          organizationId,
          personId: principal.personId,
          at,
        })
      : null;

    return {
      organization: {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        timeZone: organization.timeZone ?? '',
      },
      affiliations: snapshot.affiliations,
      capabilities: snapshot.capabilities,
      teachingSections: snapshot.teachingSections,
      staffedDestinations: snapshot.staffedDestinations,
      teachingMeetingLocationIds,
      expectedPlacement,
    };
  }
}
