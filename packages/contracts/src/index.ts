import { Type } from 'typebox';

export const UuidSchema = Type.String({ format: 'uuid' });
export const InstantSchema = Type.String({ format: 'date-time' });

export const ProblemDetailsSchema = Type.Object(
  {
    type: Type.String({ format: 'uri-reference' }),
    title: Type.String(),
    status: Type.Integer({ minimum: 400, maximum: 599 }),
    detail: Type.Optional(Type.String()),
    instance: Type.Optional(Type.String()),
    code: Type.String({ pattern: '^[a-z][a-z0-9_]*$' }),
    requestId: Type.String(),
  },
  { $id: 'ProblemDetails', additionalProperties: false },
);

export const LivenessSchema = Type.Object(
  { status: Type.Literal('ok') },
  { $id: 'Liveness', additionalProperties: false },
);

export const ReadinessSchema = Type.Object(
  {
    status: Type.Literal('ready'),
    database: Type.Literal('ready'),
    migration: Type.String(),
  },
  { $id: 'Readiness', additionalProperties: false },
);

export const SystemInfoSchema = Type.Object(
  {
    name: Type.Literal('OpenHall'),
    version: Type.String(),
    apiVersion: Type.Literal('v1'),
    status: Type.Literal('foundation'),
  },
  { $id: 'SystemInfo', additionalProperties: false },
);

export const SlugSchema = Type.String({ pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 63 });

export const AuthSessionSchema = Type.Union(
  [
    Type.Object({ authenticated: Type.Literal(false) }, { additionalProperties: false }),
    Type.Object(
      {
        authenticated: Type.Literal(true),
        csrfToken: Type.String({ minLength: 1 }),
        absoluteExpiresAt: InstantSchema,
        authenticationMethod: Type.Union([Type.Literal('oidc'), Type.Literal('recovery')]),
      },
      { additionalProperties: false },
    ),
  ],
  { $id: 'AuthSession' },
);

export const MeSchema = Type.Object(
  {
    person: Type.Object(
      {
        id: UuidSchema,
        givenName: Type.String(),
        familyName: Type.String(),
        displayName: Type.String(),
      },
      { additionalProperties: false },
    ),
    tenant: Type.Object(
      {
        id: UuidSchema,
        name: Type.String(),
        slug: SlugSchema,
      },
      { additionalProperties: false },
    ),
  },
  { $id: 'Me' },
);

export const ProviderSummarySchema = Type.Object(
  {
    key: SlugSchema,
    displayName: Type.String(),
  },
  { additionalProperties: false },
);

export const AuthDiscoverySchema = Type.Union(
  [
    Type.Object({ tenantSelectionRequired: Type.Literal(true) }, { additionalProperties: false }),
    Type.Object(
      {
        tenantSelectionRequired: Type.Literal(false),
        tenant: Type.Object(
          {
            id: UuidSchema,
            name: Type.String(),
            slug: SlugSchema,
          },
          { additionalProperties: false },
        ),
        providers: Type.Array(ProviderSummarySchema),
      },
      { additionalProperties: false },
    ),
  ],
  { $id: 'AuthDiscovery' },
);

export const BootstrapStatusSchema = Type.Object(
  { initialized: Type.Boolean() },
  { $id: 'BootstrapStatus' },
);

export const BootstrapPrepareSchema = Type.Object(
  {
    tenantName: Type.String({ minLength: 1, maxLength: 200 }),
    tenantSlug: SlugSchema,
    schoolName: Type.String({ minLength: 1, maxLength: 200 }),
    schoolSlug: SlugSchema,
    schoolTimeZone: Type.String({ minLength: 1, maxLength: 100 }),
    adminGivenName: Type.String({ minLength: 1, maxLength: 200 }),
    adminFamilyName: Type.String({ minLength: 1, maxLength: 200 }),
    adminDisplayName: Type.String({ minLength: 1, maxLength: 200 }),
    providerKey: SlugSchema,
    providerDisplayName: Type.String({ minLength: 1, maxLength: 200 }),
    providerPreset: Type.Optional(Type.Union([Type.Literal('google'), Type.Literal('generic')])),
    providerIssuer: Type.String({ minLength: 1, maxLength: 500 }),
    providerClientId: Type.String({ minLength: 1, maxLength: 500 }),
    providerClientSecret: Type.String({ minLength: 1, maxLength: 2000 }),
    providerAuthMethod: Type.Union([
      Type.Literal('client_secret_post'),
      Type.Literal('client_secret_basic'),
    ]),
    providerScopes: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
      minItems: 1,
      maxItems: 20,
    }),
  },
  { $id: 'BootstrapPrepare', additionalProperties: false },
);

export const BootstrapPrepareResponseSchema = Type.Object(
  { authorizationUrl: Type.String({ format: 'uri' }) },
  { $id: 'BootstrapPrepareResponse', additionalProperties: false },
);

export const RecoveryResponseSchema = Type.Object(
  {
    authenticated: Type.Literal(true),
    authenticationMethod: Type.Literal('recovery'),
  },
  { $id: 'RecoveryResponse', additionalProperties: false },
);

export const OkSchema = Type.Object({ ok: Type.Literal(true) }, { $id: 'Ok' });

/**
 * Closed public capability vocabulary. The application owns the canonical
 * list; a parity test proves these literals stay identical. Never weaken
 * this to an arbitrary string to avoid that test.
 */
export const CapabilitySchema = Type.Union(
  [
    Type.Literal('self.read'),
    Type.Literal('organization.context.read'),
    Type.Literal('pass.request.self'),
    Type.Literal('pass.view.self'),
    Type.Literal('pass.cancel.self'),
    Type.Literal('pass.create.student'),
    Type.Literal('pass.approve.section'),
    Type.Literal('pass.view.section_live'),
    Type.Literal('pass.view.school_live'),
    Type.Literal('pass.view.school_history'),
    Type.Literal('scheduled_authorization.manage'),
    Type.Literal('destination.station.manage'),
    Type.Literal('destination.manage'),
    Type.Literal('schedule.view'),
    Type.Literal('schedule.manage'),
    Type.Literal('people.view'),
    Type.Literal('people.manage'),
    Type.Literal('policy.manage'),
    Type.Literal('authorization.manage'),
    Type.Literal('integration.manage'),
    Type.Literal('incident.view'),
    Type.Literal('incident.manage'),
    Type.Literal('audit.view'),
    Type.Literal('identity.manage'),
    Type.Literal('system.manage'),
  ],
  // No $id: this schema is embedded several times inside one response
  // schema, and Fastify rejects duplicate $id definitions.
);

export const AffiliationSchema = Type.Union([
  Type.Literal('student'),
  Type.Literal('staff'),
  Type.Literal('other'),
]);

export const MyOrganizationEntrySchema = Type.Object(
  {
    id: UuidSchema,
    name: Type.String(),
    slug: SlugSchema,
    timeZone: Type.String(),
    affiliations: Type.Array(AffiliationSchema),
  },
  { $id: 'MyOrganizationEntry', additionalProperties: false },
);

export const MyOrganizationsSchema = Type.Object(
  { organizations: Type.Array(MyOrganizationEntrySchema) },
  { $id: 'MyOrganizations', additionalProperties: false },
);

export const TeachingSectionContextSchema = Type.Object(
  {
    id: UuidSchema,
    code: Type.Union([Type.String(), Type.Null()]),
    title: Type.String(),
    capabilities: Type.Array(CapabilitySchema),
  },
  { $id: 'TeachingSectionContext', additionalProperties: false },
);

export const StaffedDestinationContextSchema = Type.Object(
  {
    id: UuidSchema,
    displayName: Type.String(),
    serviceType: Type.String(),
    capabilities: Type.Array(CapabilitySchema),
  },
  { $id: 'StaffedDestinationContext', additionalProperties: false },
);

const PlacementBlockSchema = Type.Object(
  {
    id: UuidSchema,
    code: Type.String(),
    displayName: Type.String(),
    kind: Type.String(),
  },
  { additionalProperties: false },
);

const PlacementSectionSchema = Type.Object(
  {
    id: UuidSchema,
    code: Type.Union([Type.String(), Type.Null()]),
    title: Type.String(),
  },
  { additionalProperties: false },
);

const PlacementLocationSchema = Type.Object(
  {
    id: UuidSchema,
    name: Type.String(),
    code: Type.Union([Type.String(), Type.Null()]),
    kind: Type.String(),
  },
  { additionalProperties: false },
);

/**
 * Data-minimized public projection of the Phase 2 ExpectedPlacementResolver
 * result. Internal diagnostics (candidate IDs, configuration messages,
 * teacher lists, grant/account details) never reach the wire.
 */
export const ExpectedPlacementContextSchema = Type.Union(
  [
    Type.Object(
      {
        kind: Type.Literal('resolved'),
        block: PlacementBlockSchema,
        section: PlacementSectionSchema,
        expectedLocation: Type.Union([PlacementLocationSchema, Type.Null()]),
        beginsAt: InstantSchema,
        endsAt: InstantSchema,
        elapsedSeconds: Type.Number(),
        remainingSeconds: Type.Number(),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal('block_only'),
        block: PlacementBlockSchema,
        beginsAt: InstantSchema,
        endsAt: InstantSchema,
        elapsedSeconds: Type.Number(),
        remainingSeconds: Type.Number(),
      },
      { additionalProperties: false },
    ),
    Type.Object({ kind: Type.Literal('outside_schedule') }, { additionalProperties: false }),
    Type.Object(
      {
        kind: Type.Literal('non_instructional_day'),
        dayKind: Type.Union([Type.Literal('non_instructional'), Type.Literal('closed')]),
      },
      { additionalProperties: false },
    ),
    Type.Object({ kind: Type.Literal('calendar_not_configured') }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('not_member') }, { additionalProperties: false }),
    Type.Object(
      {
        kind: Type.Literal('ambiguous'),
        reason: Type.Union([
          Type.Literal('multiple_placements'),
          Type.Literal('overlapping_unassigned_slots'),
        ]),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal('configuration_error'),
        code: Type.Union([
          Type.Literal('school_not_found'),
          Type.Literal('organization_not_school'),
          Type.Literal('invalid_school_time_zone'),
          Type.Literal('instructional_day_missing_template'),
          Type.Literal('invalid_slot_wall_time'),
        ]),
      },
      { additionalProperties: false },
    ),
  ],
  { $id: 'ExpectedPlacementContext' },
);

export const MyOrganizationContextSchema = Type.Object(
  {
    organization: Type.Object(
      {
        id: UuidSchema,
        name: Type.String(),
        slug: SlugSchema,
        timeZone: Type.String(),
      },
      { additionalProperties: false },
    ),
    affiliations: Type.Array(AffiliationSchema),
    capabilities: Type.Array(CapabilitySchema),
    expectedPlacement: Type.Union([ExpectedPlacementContextSchema, Type.Null()]),
    teachingSections: Type.Array(TeachingSectionContextSchema),
    staffedDestinations: Type.Array(StaffedDestinationContextSchema),
  },
  { $id: 'MyOrganizationContext', additionalProperties: false },
);

/** POST /api/v1/me/passes and POST /api/v1/students/:studentId/passes body. */
export const PassRequestBodySchema = Type.Object(
  { destinationId: UuidSchema },
  { $id: 'PassRequestBody', additionalProperties: false },
);

const PassOriginBlockSchema = Type.Object(
  {
    id: UuidSchema,
    code: Type.String(),
    displayName: Type.String(),
  },
  { additionalProperties: false },
);

const PassOriginSectionSchema = Type.Object(
  {
    id: UuidSchema,
    code: Type.Union([Type.String(), Type.Null()]),
    title: Type.String(),
  },
  { additionalProperties: false },
);

const PassOriginLocationSchema = Type.Object(
  {
    id: UuidSchema,
    name: Type.String(),
  },
  { additionalProperties: false },
);

/**
 * Small safe pass representation. Revision is a decimal string because the
 * underlying value is PostgreSQL bigint, never a JSON number.
 */
export const PassSchema = Type.Object(
  {
    id: UuidSchema,
    organizationId: UuidSchema,
    studentId: UuidSchema,
    destination: Type.Object(
      {
        id: UuidSchema,
        displayName: Type.String(),
        serviceType: Type.String(),
      },
      { additionalProperties: false },
    ),
    origin: Type.Object(
      {
        placementKind: Type.String(),
        block: Type.Union([PassOriginBlockSchema, Type.Null()]),
        section: Type.Union([PassOriginSectionSchema, Type.Null()]),
        location: Type.Union([PassOriginLocationSchema, Type.Null()]),
      },
      { additionalProperties: false },
    ),
    requestSource: Type.String(),
    requestedAt: InstantSchema,
    lifecycleState: Type.String(),
    revision: Type.String({ pattern: '^[1-9][0-9]*$' }),
  },
  { $id: 'Pass', additionalProperties: false },
);

export const ActiveSelfPassSchema = Type.Object(
  { pass: Type.Union([PassSchema, Type.Null()]) },
  { $id: 'ActiveSelfPass', additionalProperties: false },
);

export const PassResponseSchema = Type.Object(
  { pass: PassSchema },
  { $id: 'PassResponse', additionalProperties: false },
);

/**
 * OpenHall Idempotency-Key contract: opaque caller-generated value, 1-255
 * visible ASCII characters. UUIDv4/UUIDv7 recommended, not required.
 * This documents OpenHall API behavior, not a finalized IETF RFC.
 */
export const IdempotencyKeyHeaderSchema = Type.String({ minLength: 1, maxLength: 255 });

/** Exact OpenHall strong ETag required for If-Match on cancellation. */
export const IfMatchHeaderSchema = Type.String({ minLength: 1 });
