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
        authenticationMethod: Type.Union([
          Type.Literal('oidc'),
          Type.Literal('recovery'),
          Type.Literal('setup'),
        ]),
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

export const BootstrapValidateResponseSchema = Type.Object(
  { valid: Type.Literal(true) },
  { $id: 'BootstrapValidateResponse', additionalProperties: false },
);

export const BootstrapInitializeSchema = Type.Object(
  {
    tenantName: Type.String({ maxLength: 200 }),
    tenantSlug: Type.Optional(SlugSchema),
    schoolName: Type.String({ minLength: 1, maxLength: 200 }),
    schoolSlug: Type.Optional(SlugSchema),
    schoolTimeZone: Type.String({ minLength: 1, maxLength: 100 }),
    adminGivenName: Type.String({ minLength: 1, maxLength: 200 }),
    adminFamilyName: Type.String({ minLength: 1, maxLength: 200 }),
    adminDisplayName: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { $id: 'BootstrapInitialize', additionalProperties: false },
);

export const BootstrapInitializeResponseSchema = Type.Object(
  {
    authenticated: Type.Literal(true),
    authenticationMethod: Type.Literal('setup'),
    absoluteExpiresAt: InstantSchema,
  },
  { $id: 'BootstrapInitializeResponse', additionalProperties: false },
);

export const SetupIdentityProviderPrepareSchema = Type.Object(
  {
    providerPreset: Type.Union([Type.Literal('google'), Type.Literal('generic')]),
    clientId: Type.String({ minLength: 1, maxLength: 500 }),
    clientSecret: Type.String({ minLength: 1, maxLength: 2000 }),
    providerName: Type.Optional(Type.String({ maxLength: 200 })),
    issuerUrl: Type.Optional(Type.String({ maxLength: 500 })),
    providerKey: Type.Optional(SlugSchema),
    authMethod: Type.Optional(
      Type.Union([Type.Literal('client_secret_post'), Type.Literal('client_secret_basic')]),
    ),
    scopes: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 20 }),
    ),
  },
  { $id: 'SetupIdentityProviderPrepare', additionalProperties: false },
);

export const SetupIdentityProviderPrepareResponseSchema = Type.Object(
  { authorizationUrl: Type.String({ format: 'uri' }) },
  { $id: 'SetupIdentityProviderPrepareResponse', additionalProperties: false },
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
    Type.Literal('pass.depart.self'),
    Type.Literal('pass.depart.student'),
    Type.Literal('pass.progress.self'),
    Type.Literal('pass.create.student'),
    Type.Literal('pass.approve.section'),
    Type.Literal('pass.override.request.self'),
    Type.Literal('pass.override.request.student'),
    Type.Literal('pass.override.resolve.section'),
    Type.Literal('pass.override.resolve.school'),
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
    Type.Literal('identity.enroll'),
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
 * Latest safe movement-policy projection. Null for legacy passes that
 * predate Phase 6 evaluation; reads never fabricate a historical decision.
 */
export const PassPolicySchema = Type.Object(
  {
    decision: Type.String(),
    evaluatedAt: InstantSchema,
    reasonCodes: Type.Array(Type.String()),
    approvalPending: Type.Boolean(),
    overrideAvailable: Type.Boolean(),
    overridePending: Type.Boolean(),
  },
  { additionalProperties: false },
);

/**
 * Non-dynamic destination-flow facts tied to the pass revision. Live queue
 * position, live capacity, and wall-clock overdue flags are excluded: they
 * change without a revision bump and must never sit under the strong ETag.
 */
export const PassMovementProjectionSchema = Type.Object(
  {
    readyUntil: Type.Union([InstantSchema, Type.Null()]),
    queueEnteredAt: Type.Union([InstantSchema, Type.Null()]),
    queueExpiresAt: Type.Union([InstantSchema, Type.Null()]),
    expectedReturnAt: Type.Union([InstantSchema, Type.Null()]),
    effectiveCheckInMode: Type.Union([
      Type.Literal('none'),
      Type.Literal('optional'),
      Type.Literal('required'),
      Type.Null(),
    ]),
    reasonCode: Type.Union([Type.String(), Type.Null()]),
  },
  { $id: 'PassMovementProjection', additionalProperties: false },
);

/**
 * Small safe pass representation. Revision is a decimal string because the
 * underlying value is PostgreSQL bigint, never a JSON number.
 */
/** Current category presentation joined onto pass/scheduled projections (never snapshotted). */
export const PassDestinationCategorySchema = Type.Object(
  {
    id: UuidSchema,
    name: Type.String(),
    iconKey: Type.String(),
    toneKey: Type.String(),
  },
  { additionalProperties: false },
);

export const PassSchema = Type.Object(
  {
    id: UuidSchema,
    organizationId: UuidSchema,
    studentId: UuidSchema,
    policy: Type.Union([PassPolicySchema, Type.Null()]),
    destination: Type.Object(
      {
        id: UuidSchema,
        displayName: Type.String(),
        serviceType: Type.String(),
        checkInMode: Type.Union([
          Type.Literal('none'),
          Type.Literal('optional'),
          Type.Literal('required'),
        ]),
        category: Type.Union([PassDestinationCategorySchema, Type.Null()]),
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
    scheduledAuthorizationId: Type.Union([UuidSchema, Type.Null()]),
    requestedAt: InstantSchema,
    lifecycleState: Type.String(),
    revision: Type.String({ pattern: '^[1-9][0-9]*$' }),
    movement: PassMovementProjectionSchema,
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

/** POST override request body: category only, nothing else. */
export const OverrideRequestBodySchema = Type.Object(
  {
    category: Type.Union([
      Type.Literal('urgent'),
      Type.Literal('private'),
      Type.Literal('safety'),
      Type.Literal('staff_directed'),
    ]),
  },
  { $id: 'OverrideRequestBody', additionalProperties: false },
);

const PendingApprovalSectionSchema = Type.Object(
  {
    id: UuidSchema,
    code: Type.Union([Type.String(), Type.Null()]),
    title: Type.String(),
  },
  { additionalProperties: false },
);

const PersonDisplaySchema = Type.Object(
  {
    id: UuidSchema,
    displayName: Type.String(),
  },
  { additionalProperties: false },
);

const DestinationDisplaySchema = Type.Object(
  {
    id: UuidSchema,
    displayName: Type.String(),
    serviceType: Type.String(),
  },
  { additionalProperties: false },
);

/** Staff-facing pending approval: useful data only, no rule JSON or grants. */
export const PendingApprovalSchema = Type.Object(
  {
    organizationId: UuidSchema,
    approvalId: UuidSchema,
    passId: UuidSchema,
    passRevision: Type.String({ pattern: '^[1-9][0-9]*$' }),
    passEtag: Type.String({ minLength: 1 }),
    student: PersonDisplaySchema,
    destination: DestinationDisplaySchema,
    requiredSection: PendingApprovalSectionSchema,
    requestedAt: InstantSchema,
  },
  { $id: 'PendingApproval', additionalProperties: false },
);

export const PendingApprovalListSchema = Type.Object(
  { approvals: Type.Array(PendingApprovalSchema) },
  { $id: 'PendingApprovalList', additionalProperties: false },
);

/** Staff-facing pending override: no rule configuration, no explanations. */
export const PendingOverrideSchema = Type.Object(
  {
    organizationId: UuidSchema,
    overrideId: UuidSchema,
    passId: UuidSchema,
    passRevision: Type.String({ pattern: '^[1-9][0-9]*$' }),
    passEtag: Type.String({ minLength: 1 }),
    student: PersonDisplaySchema,
    destination: DestinationDisplaySchema,
    category: Type.Union([
      Type.Literal('urgent'),
      Type.Literal('private'),
      Type.Literal('safety'),
      Type.Literal('staff_directed'),
    ]),
    overrideMode: Type.Union([
      Type.Literal('never'),
      Type.Literal('authorized'),
      Type.Literal('approval_required'),
    ]),
    reasonCode: Type.Union([
      Type.Literal('no_violation'),
      Type.Literal('schedule_boundary_blackout'),
      Type.Literal('current_section_teacher_approval_required'),
      Type.Literal('approval_context_unavailable'),
      Type.Literal('approval_satisfied'),
      Type.Literal('scheduled_preapproval_satisfied'),
      Type.Literal('approval_denied'),
      Type.Literal('override_denied'),
      Type.Literal('rule_overridden'),
      Type.Literal('policy_configuration_error'),
    ]),
    requestedAt: InstantSchema,
  },
  { $id: 'PendingOverride', additionalProperties: false },
);

export const PendingOverrideListSchema = Type.Object(
  { overrides: Type.Array(PendingOverrideSchema) },
  { $id: 'PendingOverrideList', additionalProperties: false },
);

/**
 * OpenHall Idempotency-Key contract: opaque caller-generated value, 1-255
 * visible ASCII characters. UUIDv4/UUIDv7 recommended, not required.
 * This documents OpenHall API behavior, not a finalized IETF RFC.
 */
export const IdempotencyKeyHeaderSchema = Type.String({ minLength: 1, maxLength: 255 });

/** Exact OpenHall strong ETag required for If-Match on cancellation. */
export const IfMatchHeaderSchema = Type.String({ minLength: 1 });

/**
 * Derived queue position for one owned queued pass. Computed on every read
 * from active entries; never stored. No other student's data is included.
 */
export const QueueStatusSchema = Type.Object(
  {
    position: Type.Integer({ minimum: 1 }),
    ahead: Type.Integer({ minimum: 0 }),
    enteredAt: InstantSchema,
    expiresAt: InstantSchema,
  },
  { $id: 'QueueStatus', additionalProperties: false },
);

export const LivePassSchema = Type.Object(
  {
    passId: UuidSchema,
    passRevision: Type.String({ pattern: '^[1-9][0-9]*$' }),
    passEtag: Type.String({ minLength: 1 }),
    student: Type.Object(
      { id: UuidSchema, displayName: Type.String() },
      { additionalProperties: false },
    ),
    destination: Type.Object(
      { id: UuidSchema, displayName: Type.String(), serviceType: Type.String() },
      { additionalProperties: false },
    ),
    lifecycleState: Type.Union([
      Type.Literal('requested'),
      Type.Literal('queued'),
      Type.Literal('ready'),
      Type.Literal('outbound'),
      Type.Literal('at_destination'),
      Type.Literal('returning'),
    ]),
    requestedAt: InstantSchema,
    movement: Type.Object(
      {
        readyUntil: Type.Union([InstantSchema, Type.Null()]),
        expectedReturnAt: Type.Union([InstantSchema, Type.Null()]),
      },
      { additionalProperties: false },
    ),
    origin: Type.Object(
      { sectionId: Type.Union([UuidSchema, Type.Null()]) },
      { additionalProperties: false },
    ),
  },
  { $id: 'LivePass', additionalProperties: false },
);

export const LivePassListSchema = Type.Object(
  { passes: Type.Array(LivePassSchema) },
  { $id: 'LivePassList', additionalProperties: false },
);

export const SectionStudentListSchema = Type.Object(
  {
    students: Type.Array(
      Type.Object({ id: UuidSchema, displayName: Type.String() }, { additionalProperties: false }),
    ),
  },
  { $id: 'SectionStudentList', additionalProperties: false },
);

const StationPersonSchema = Type.Object(
  {
    id: UuidSchema,
    displayName: Type.String(),
  },
  { additionalProperties: false },
);

/** School control-plane location: server owns tenant, organization, status, and revision. */
export const LocationSchema = Type.Object(
  {
    id: UuidSchema,
    organizationId: UuidSchema,
    parentLocationId: Type.Union([UuidSchema, Type.Null()]),
    kind: Type.String({ minLength: 1, maxLength: 100 }),
    name: Type.String({ minLength: 1, maxLength: 200 }),
    code: Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()]),
    floorLabel: Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()]),
    status: Type.Union([
      Type.Literal('active'),
      Type.Literal('inactive'),
      Type.Literal('archived'),
    ]),
    revision: Type.String({ pattern: '^[1-9][0-9]*$' }),
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
  },
  { $id: 'Location', additionalProperties: false },
);

export const LocationListSchema = Type.Object(
  { locations: Type.Array(LocationSchema) },
  { $id: 'LocationList', additionalProperties: false },
);

export const LocationResponseSchema = Type.Object(
  { location: LocationSchema },
  { $id: 'LocationResponse', additionalProperties: false },
);

export const LocationWriteBodySchema = Type.Object(
  {
    parentLocationId: Type.Union([UuidSchema, Type.Null()]),
    kind: Type.String({ minLength: 1, maxLength: 100 }),
    name: Type.String({ minLength: 1, maxLength: 200 }),
    code: Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()]),
    floorLabel: Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()]),
  },
  { $id: 'LocationWriteBody', additionalProperties: false },
);

const CheckInModeSchema = Type.Union([
  Type.Literal('none'),
  Type.Literal('optional'),
  Type.Literal('required'),
]);

/** School control-plane destination: server owns status lifecycle and revision. */
export const DestinationSchema = Type.Object(
  {
    id: UuidSchema,
    organizationId: UuidSchema,
    locationId: UuidSchema,
    categoryId: UuidSchema,
    studentSelfRequestable: Type.Boolean(),
    serviceType: Type.String({ minLength: 1, maxLength: 100 }),
    displayName: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
    capacity: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    queueEnabled: Type.Boolean(),
    checkInMode: CheckInModeSchema,
    defaultDurationSeconds: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    maxDurationSeconds: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    readyClaimTimeoutSeconds: Type.Integer({ minimum: 5, maximum: 600 }),
    queueTimeoutSeconds: Type.Integer({ minimum: 60, maximum: 14400 }),
    status: Type.Union([Type.Literal('active'), Type.Literal('closed'), Type.Literal('archived')]),
    revision: Type.String({ pattern: '^[1-9][0-9]*$' }),
    updatedAt: InstantSchema,
  },
  { $id: 'Destination', additionalProperties: false },
);

export const DestinationListSchema = Type.Object(
  { destinations: Type.Array(DestinationSchema) },
  { $id: 'DestinationList', additionalProperties: false },
);

export const DestinationResponseSchema = Type.Object(
  { destination: DestinationSchema },
  { $id: 'DestinationResponse', additionalProperties: false },
);

export const DestinationWriteBodySchema = Type.Object(
  {
    locationId: UuidSchema,
    categoryId: UuidSchema,
    studentSelfRequestable: Type.Boolean(),
    serviceType: Type.String({ minLength: 1, maxLength: 100 }),
    displayName: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
    capacity: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    queueEnabled: Type.Boolean(),
    checkInMode: CheckInModeSchema,
    defaultDurationSeconds: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    maxDurationSeconds: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    readyClaimTimeoutSeconds: Type.Integer({ minimum: 5, maximum: 600 }),
    queueTimeoutSeconds: Type.Integer({ minimum: 60, maximum: 14400 }),
  },
  { $id: 'DestinationWriteBody', additionalProperties: false },
);

export const BlockKindSchema = Type.Union([
  Type.Literal('instructional'),
  Type.Literal('lunch'),
  Type.Literal('advisory'),
  Type.Literal('transition'),
  Type.Literal('other'),
]);

export const DayKindSchema = Type.Union([
  Type.Literal('instructional'),
  Type.Literal('non_instructional'),
  Type.Literal('closed'),
]);

const TimeSchema = Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' });
const DateSchema = Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' });

/** School schedule block: server owns status; the aggregate owns concurrency. */
export const ScheduleBlockSchema = Type.Object(
  {
    id: UuidSchema,
    code: Type.String({ minLength: 1, maxLength: 50 }),
    displayName: Type.String({ minLength: 1, maxLength: 200 }),
    kind: BlockKindSchema,
    status: Type.Union([Type.Literal('active'), Type.Literal('archived')]),
  },
  { $id: 'ScheduleBlock', additionalProperties: false },
);

export const ScheduleBlockResponseSchema = Type.Object(
  { block: ScheduleBlockSchema },
  { $id: 'ScheduleBlockResponse', additionalProperties: false },
);

export const ScheduleBlockWriteBodySchema = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 50 }),
    displayName: Type.String({ minLength: 1, maxLength: 200 }),
    kind: BlockKindSchema,
  },
  { $id: 'ScheduleBlockWriteBody', additionalProperties: false },
);

export const ScheduleSlotSchema = Type.Object(
  {
    id: UuidSchema,
    blockId: UuidSchema,
    blockCode: Type.String(),
    blockDisplayName: Type.String(),
    blockKind: BlockKindSchema,
    startsAt: TimeSchema,
    endsAt: TimeSchema,
    ordinal: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const ScheduleSlotWriteSchema = Type.Object(
  {
    blockId: UuidSchema,
    startsAt: TimeSchema,
    endsAt: TimeSchema,
  },
  { additionalProperties: false },
);

/** School schedule template with its full slot set (never a merge). */
export const ScheduleTemplateSchema = Type.Object(
  {
    id: UuidSchema,
    name: Type.String({ minLength: 1, maxLength: 200 }),
    status: Type.Union([Type.Literal('active'), Type.Literal('archived')]),
    slots: Type.Array(ScheduleSlotSchema),
  },
  { $id: 'ScheduleTemplate', additionalProperties: false },
);

export const ScheduleTemplateResponseSchema = Type.Object(
  { template: ScheduleTemplateSchema },
  { $id: 'ScheduleTemplateResponse', additionalProperties: false },
);

export const ScheduleTemplateWriteBodySchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
    slots: Type.Array(ScheduleSlotWriteSchema),
  },
  { $id: 'ScheduleTemplateWriteBody', additionalProperties: false },
);

export const CalendarDaySchema = Type.Object(
  {
    date: DateSchema,
    dayKind: DayKindSchema,
    templateId: Type.Union([UuidSchema, Type.Null()]),
    templateName: Type.Union([Type.String(), Type.Null()]),
    cycleCode: Type.Union([Type.String({ minLength: 1, maxLength: 50 }), Type.Null()]),
    operationalNote: Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()]),
  },
  { $id: 'CalendarDay', additionalProperties: false },
);

export const CalendarDayResponseSchema = Type.Object(
  { day: CalendarDaySchema },
  { $id: 'CalendarDayResponse', additionalProperties: false },
);

export const CalendarDayWriteBodySchema = Type.Object(
  {
    dayKind: DayKindSchema,
    templateId: Type.Union([UuidSchema, Type.Null()]),
    cycleCode: Type.Union([Type.String({ minLength: 1, maxLength: 50 }), Type.Null()]),
    operationalNote: Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()]),
  },
  { $id: 'CalendarDayWriteBody', additionalProperties: false },
);

/** Schedule reads expose the aggregate revision alongside the same strong schedule ETag. */
export const ScheduleBlockListSchema = Type.Object(
  {
    blocks: Type.Array(ScheduleBlockSchema),
    revision: Type.String({ pattern: '^[1-9][0-9]*$' }),
  },
  { $id: 'ScheduleBlockList', additionalProperties: false },
);

export const ScheduleTemplateListSchema = Type.Object(
  {
    templates: Type.Array(ScheduleTemplateSchema),
    revision: Type.String({ pattern: '^[1-9][0-9]*$' }),
  },
  { $id: 'ScheduleTemplateList', additionalProperties: false },
);

export const CalendarDayListSchema = Type.Object(
  {
    days: Type.Array(CalendarDaySchema),
    revision: Type.String({ pattern: '^[1-9][0-9]*$' }),
  },
  { $id: 'CalendarDayList', additionalProperties: false },
);

export const CalendarDayAssignmentSchema = Type.Object(
  {
    date: DateSchema,
    dayKind: DayKindSchema,
    templateId: Type.Union([UuidSchema, Type.Null()]),
    cycleCode: Type.Union([Type.String({ minLength: 1, maxLength: 50 }), Type.Null()]),
    operationalNote: Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const CalendarBulkWriteBodySchema = Type.Object(
  { days: Type.Array(CalendarDayAssignmentSchema, { minItems: 1, maxItems: 366 }) },
  { $id: 'CalendarBulkWriteBody', additionalProperties: false },
);

const PolicyScopeKindSchema = Type.Union([
  Type.Literal('organization'),
  Type.Literal('section'),
  Type.Literal('destination'),
]);

const PolicyScopeSchema = Type.Object(
  {
    kind: PolicyScopeKindSchema,
    organizationId: Type.Union([UuidSchema, Type.Null()]),
    sectionId: Type.Union([UuidSchema, Type.Null()]),
    destinationId: Type.Union([UuidSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

/** Policy rule: server owns enabled, revision, and archival; configuration is opaque JSON. */
export const PolicyRuleSchema = Type.Object(
  {
    id: UuidSchema,
    organizationId: UuidSchema,
    name: Type.String({ minLength: 1, maxLength: 200 }),
    ruleType: Type.Union([Type.Literal('schedule_boundary'), Type.Literal('approval_requirement')]),
    scope: PolicyScopeSchema,
    priority: Type.Integer(),
    configuration: Type.Record(Type.String(), Type.Unknown()),
    overrideMode: Type.Union([
      Type.Literal('never'),
      Type.Literal('authorized'),
      Type.Literal('approval_required'),
    ]),
    enabled: Type.Boolean(),
    validFrom: Type.Union([InstantSchema, Type.Null()]),
    validUntil: Type.Union([InstantSchema, Type.Null()]),
    revision: Type.Integer({ minimum: 1 }),
    archivedAt: Type.Union([InstantSchema, Type.Null()]),
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
  },
  { $id: 'PolicyRule', additionalProperties: false },
);

export const PolicyRuleListSchema = Type.Object(
  { rules: Type.Array(PolicyRuleSchema) },
  { $id: 'PolicyRuleList', additionalProperties: false },
);

export const PolicyRuleResponseSchema = Type.Object(
  { rule: PolicyRuleSchema },
  { $id: 'PolicyRuleResponse', additionalProperties: false },
);

/** Closed school-manageable duty roles. Never student/teacher/system_admin. */
export const AuthorizationGrantRoleSchema = Type.Union(
  [
    Type.Literal('destination_staff'),
    Type.Literal('counselor'),
    Type.Literal('office_staff'),
    Type.Literal('school_admin'),
  ],
  { $id: 'AuthorizationGrantRole' },
);

/**
 * Explicit staff duty: server owns account/scope/status/revision/provenance.
 * personId is the invitation handle; email is never accepted or returned.
 */
export const AuthorizationGrantSchema = Type.Object(
  {
    id: UuidSchema,
    personId: UuidSchema,
    person: Type.Object(
      { id: UuidSchema, displayName: Type.String() },
      { additionalProperties: false },
    ),
    accountId: UuidSchema,
    role: AuthorizationGrantRoleSchema,
    scopeKind: Type.Union([Type.Literal('organization'), Type.Literal('destination')]),
    organizationId: Type.Union([UuidSchema, Type.Null()]),
    destinationId: Type.Union([UuidSchema, Type.Null()]),
    destination: Type.Union([
      Type.Object({ id: UuidSchema, displayName: Type.String() }, { additionalProperties: false }),
      Type.Null(),
    ]),
    status: Type.Union([Type.Literal('active'), Type.Literal('revoked')]),
    validFrom: Type.Union([InstantSchema, Type.Null()]),
    validUntil: Type.Union([InstantSchema, Type.Null()]),
    revision: Type.String({ pattern: '^[1-9][0-9]*$' }),
    createdByAccountId: Type.Union([UuidSchema, Type.Null()]),
    revokedAt: Type.Union([InstantSchema, Type.Null()]),
    revokedByAccountId: Type.Union([UuidSchema, Type.Null()]),
    createdAt: InstantSchema,
  },
  { $id: 'AuthorizationGrant', additionalProperties: false },
);

export const AuthorizationGrantListSchema = Type.Object(
  { grants: Type.Array(AuthorizationGrantSchema) },
  { $id: 'AuthorizationGrantList', additionalProperties: false },
);

export const AuthorizationGrantResponseSchema = Type.Object(
  { grant: AuthorizationGrantSchema },
  { $id: 'AuthorizationGrantResponse', additionalProperties: false },
);

export const AuthorizationGrantIssueBodySchema = Type.Object(
  {
    personId: UuidSchema,
    role: AuthorizationGrantRoleSchema,
    destinationId: Type.Union([UuidSchema, Type.Null()]),
    validFrom: Type.Union([InstantSchema, Type.Null()]),
    validUntil: Type.Union([InstantSchema, Type.Null()]),
  },
  { $id: 'AuthorizationGrantIssueBody', additionalProperties: false },
);

/**
 * Administrative identity projection: enough to know whether enrollment is
 * needed, never provider subjects, issuers, session data, email snapshots,
 * or auth identity IDs.
 */
export const PersonDirectoryEntrySchema = Type.Object(
  {
    personId: UuidSchema,
    displayName: Type.String(),
    givenName: Type.String(),
    familyName: Type.String(),
    affiliation: Type.String(),
    gradeLevel: Type.Union([Type.String(), Type.Null()]),
    personStatus: Type.String(),
    membershipStatus: Type.String(),
    account: Type.Object(
      {
        exists: Type.Boolean(),
        status: Type.Union([Type.String(), Type.Null()]),
        identityLinked: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { $id: 'PersonDirectoryEntry', additionalProperties: false },
);

export const PeopleSearchQuerySchema = Type.Object(
  {
    q: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    affiliation: Type.Optional(Type.Union([Type.Literal('student'), Type.Literal('staff')])),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  },
  { additionalProperties: false },
);

export const PeopleSearchResultSchema = Type.Object(
  {
    people: Type.Array(PersonDirectoryEntrySchema),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
  },
  { $id: 'PeopleSearchResult', additionalProperties: false },
);

/** Read-only section chooser: no membership rosters. */
export const SectionChoiceSchema = Type.Object(
  {
    id: UuidSchema,
    code: Type.Union([Type.String(), Type.Null()]),
    title: Type.String(),
    status: Type.String(),
  },
  { $id: 'SectionChoice', additionalProperties: false },
);

export const SectionSearchQuerySchema = Type.Object(
  {
    q: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  },
  { additionalProperties: false },
);

export const SectionSearchResultSchema = Type.Object(
  {
    sections: Type.Array(SectionChoiceSchema),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
  },
  { $id: 'SectionSearchResult', additionalProperties: false },
);

/**
 * Minimized audit projection: stable identifiers plus actor display name.
 * audit_event.metadata is durable internal evidence and is never projected.
 */
export const AuditEventSchema = Type.Object(
  {
    id: UuidSchema,
    occurredAt: InstantSchema,
    action: Type.String(),
    actor: Type.Object(
      {
        kind: Type.String(),
        accountId: Type.Union([UuidSchema, Type.Null()]),
        displayName: Type.Union([Type.String(), Type.Null()]),
      },
      { additionalProperties: false },
    ),
    target: Type.Object(
      {
        kind: Type.String(),
        id: Type.Union([UuidSchema, Type.Null()]),
      },
      { additionalProperties: false },
    ),
    outcome: Type.String(),
    requestId: Type.String(),
  },
  { $id: 'AuditEvent', additionalProperties: false },
);

export const AuditEventListQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  },
  { additionalProperties: false },
);

export const AuditEventListResultSchema = Type.Object(
  {
    events: Type.Array(AuditEventSchema),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
  },
  { $id: 'AuditEventListResult', additionalProperties: false },
);

/**
 * One-time OIDC invitation. The raw token is returned exactly once at
 * issuance; only its digest is ever persisted, audited, or emitted.
 */
export const IdentityEnrollmentSchema = Type.Object(
  {
    id: UuidSchema,
    organizationId: UuidSchema,
    personId: UuidSchema,
    accountId: UuidSchema,
    identityProviderId: UuidSchema,
    status: Type.Union([
      Type.Literal('active'),
      Type.Literal('consumed'),
      Type.Literal('revoked'),
      Type.Literal('expired'),
    ]),
    expiresAt: InstantSchema,
    revision: Type.String({ pattern: '^[1-9][0-9]*$' }),
    createdByAccountId: Type.Union([UuidSchema, Type.Null()]),
    createdAt: InstantSchema,
    consumedAt: Type.Union([InstantSchema, Type.Null()]),
    revokedAt: Type.Union([InstantSchema, Type.Null()]),
    revokedByAccountId: Type.Union([UuidSchema, Type.Null()]),
  },
  { $id: 'IdentityEnrollment', additionalProperties: false },
);

export const IdentityEnrollmentIssueBodySchema = Type.Object(
  { providerKey: Type.String({ minLength: 1, maxLength: 63 }) },
  { $id: 'IdentityEnrollmentIssueBody', additionalProperties: false },
);

export const IdentityEnrollmentIssueResponseSchema = Type.Object(
  {
    enrollmentId: UuidSchema,
    // The raw token is returned exactly once. An idempotent replay carries
    // an empty token: revoke and reissue if the original response was lost.
    enrollmentToken: Type.String(),
    expiresAt: InstantSchema,
    provider: Type.Object(
      {
        key: Type.String(),
        displayName: Type.String(),
      },
      { additionalProperties: false },
    ),
  },
  { $id: 'IdentityEnrollmentIssueResponse', additionalProperties: false },
);

export const IdentityEnrollmentResponseSchema = Type.Object(
  { enrollment: IdentityEnrollmentSchema },
  { $id: 'IdentityEnrollmentResponse', additionalProperties: false },
);

export const IdentityEnrollmentStatusResponseSchema = Type.Object(
  {
    enrollment: Type.Union([
      Type.Object(
        {
          id: UuidSchema,
          organizationId: UuidSchema,
          personId: UuidSchema,
          status: Type.Literal('active'),
          expiresAt: InstantSchema,
          revision: Type.String({ pattern: '^[1-9][0-9]*$' }),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
  },
  { $id: 'IdentityEnrollmentStatusResponse', additionalProperties: false },
);

export const EnrollmentStartResponseSchema = Type.Object(
  { authorizationUrl: Type.String({ minLength: 1 }) },
  { $id: 'EnrollmentStartResponse', additionalProperties: false },
);

/**
 * Staff-directed appointment: server owns the link between a student, a
 * destination, and a bounded single-day window. Specific origins name a
 * server-owned location; expected origins resolve live at start.
 */
export const ScheduledAuthOriginSchema = Type.Union(
  [
    Type.Object({ strategy: Type.Literal('expected') }, { additionalProperties: false }),
    Type.Object(
      { strategy: Type.Literal('specific'), locationId: UuidSchema },
      { additionalProperties: false },
    ),
  ],
  { $id: 'ScheduledAuthOrigin' },
);

export const ScheduledAuthCreateBodySchema = Type.Object(
  {
    studentId: UuidSchema,
    destinationId: UuidSchema,
    validFrom: InstantSchema,
    validUntil: InstantSchema,
    approvalMode: Type.Union([Type.Literal('preapproved'), Type.Literal('approval_required')]),
    origin: ScheduledAuthOriginSchema,
  },
  { $id: 'ScheduledAuthCreateBody', additionalProperties: false },
);

export const ScheduledAuthSchema = Type.Object(
  {
    id: UuidSchema,
    organizationId: UuidSchema,
    studentId: UuidSchema,
    student: Type.Object(
      {
        id: UuidSchema,
        displayName: Type.String(),
        gradeLevel: Type.Union([Type.String(), Type.Null()]),
      },
      { additionalProperties: false },
    ),
    destinationId: UuidSchema,
    destination: Type.Object(
      { id: UuidSchema, displayName: Type.String(), serviceType: Type.String() },
      { additionalProperties: false },
    ),
    validFrom: InstantSchema,
    validUntil: InstantSchema,
    status: Type.Union([
      Type.Literal('active'),
      Type.Literal('used'),
      Type.Literal('cancelled'),
      Type.Literal('expired'),
    ]),
    approvalMode: Type.Union([Type.Literal('preapproved'), Type.Literal('approval_required')]),
    originStrategy: Type.Union([Type.Literal('expected'), Type.Literal('specific')]),
    originLocationId: Type.Union([UuidSchema, Type.Null()]),
    originLocation: Type.Union([
      Type.Object({ id: UuidSchema, name: Type.String() }, { additionalProperties: false }),
      Type.Null(),
    ]),
    revision: Type.String({ pattern: '^[1-9][0-9]*$' }),
    createdByAccountId: Type.Union([UuidSchema, Type.Null()]),
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
    usedAt: Type.Union([InstantSchema, Type.Null()]),
    usedByAccountId: Type.Union([UuidSchema, Type.Null()]),
    cancelledAt: Type.Union([InstantSchema, Type.Null()]),
    cancelledByAccountId: Type.Union([UuidSchema, Type.Null()]),
    lastAttemptAt: Type.Union([InstantSchema, Type.Null()]),
  },
  { $id: 'ScheduledAuth', additionalProperties: false },
);

export const ScheduledAuthListSchema = Type.Object(
  { authorizations: Type.Array(ScheduledAuthSchema) },
  { $id: 'ScheduledAuthList', additionalProperties: false },
);

export const ScheduledAuthResponseSchema = Type.Object(
  { authorization: ScheduledAuthSchema },
  { $id: 'ScheduledAuthResponse', additionalProperties: false },
);

/**
 * Student self-read projection: safe destination/origin metadata only, no
 * policy internals, occupants, or grant data.
 */
export const ScheduledAuthStudentViewSchema = Type.Object(
  {
    id: UuidSchema,
    organizationId: UuidSchema,
    validFrom: InstantSchema,
    validUntil: InstantSchema,
    status: Type.Union([
      Type.Literal('active'),
      Type.Literal('used'),
      Type.Literal('cancelled'),
      Type.Literal('expired'),
    ]),
    approvalMode: Type.Union([Type.Literal('preapproved'), Type.Literal('approval_required')]),
    originStrategy: Type.Union([Type.Literal('expected'), Type.Literal('specific')]),
    revision: Type.String({ pattern: '^[1-9][0-9]*$' }),
    authorizationEtag: Type.String(),
    destination: Type.Object(
      {
        id: UuidSchema,
        displayName: Type.String(),
        serviceType: Type.String(),
        category: Type.Union([PassDestinationCategorySchema, Type.Null()]),
      },
      { additionalProperties: false },
    ),
    originLocation: Type.Union([
      Type.Object({ id: UuidSchema, name: Type.String() }, { additionalProperties: false }),
      Type.Null(),
    ]),
  },
  { $id: 'ScheduledAuthStudentView', additionalProperties: false },
);

export const MyScheduledAuthListSchema = Type.Object(
  { authorizations: Type.Array(ScheduledAuthStudentViewSchema) },
  { $id: 'MyScheduledAuthList', additionalProperties: false },
);

/** Narrow student chooser for scheduled movement: no broad people data. */
export const ScheduledStudentSchema = Type.Object(
  {
    id: UuidSchema,
    displayName: Type.String(),
    gradeLevel: Type.Union([Type.String(), Type.Null()]),
  },
  { $id: 'ScheduledStudent', additionalProperties: false },
);

export const ScheduledStudentListSchema = Type.Object(
  {
    students: Type.Array(ScheduledStudentSchema),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
  },
  { $id: 'ScheduledStudentList', additionalProperties: false },
);

export const PolicyRuleWriteBodySchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
    ruleType: Type.Union([Type.Literal('schedule_boundary'), Type.Literal('approval_requirement')]),
    scope: PolicyScopeSchema,
    priority: Type.Integer(),
    configuration: Type.Record(Type.String(), Type.Unknown()),
    overrideMode: Type.Union([
      Type.Literal('never'),
      Type.Literal('authorized'),
      Type.Literal('approval_required'),
    ]),
    validFrom: Type.Union([InstantSchema, Type.Null()]),
    validUntil: Type.Union([InstantSchema, Type.Null()]),
  },
  { $id: 'PolicyRuleWriteBody', additionalProperties: false },
);

/** Stable picker-safe destination catalog: no occupants, identities, or policy internals. */
export const DestinationCatalogEntrySchema = Type.Object(
  {
    id: UuidSchema,
    displayName: Type.String(),
    serviceType: Type.String(),
    categoryId: UuidSchema,
    checkInMode: CheckInModeSchema,
  },
  { additionalProperties: false },
);

/**
 * School-defined destination category: the student-facing grouping for
 * destinations. Presentation travels as safe product keys; the frontend
 * owns the single centralized key -> icon/class mapping.
 */
/**
 * Generic destination picker mode: `auto` chooses a simple list for a few
 * choices and search for larger sets; `list` and `search` force one
 * presentation. Never derived from category names.
 */
export const DestinationCategoryPickerModeSchema = Type.Union([
  Type.Literal('auto'),
  Type.Literal('list'),
  Type.Literal('search'),
]);

export const DestinationCategorySchema = Type.Object(
  {
    id: UuidSchema,
    organizationId: UuidSchema,
    name: Type.String({ minLength: 1, maxLength: 100 }),
    iconKey: Type.String({ minLength: 1, maxLength: 40 }),
    toneKey: Type.String({ minLength: 1, maxLength: 40 }),
    studentSurface: Type.Union([
      Type.Literal('primary'),
      Type.Literal('secondary'),
      Type.Literal('hidden'),
    ]),
    pickerMode: DestinationCategoryPickerModeSchema,
    sortOrder: Type.Integer({ minimum: 0 }),
    status: Type.Union([Type.Literal('active'), Type.Literal('archived')]),
    revision: Type.String({ pattern: '^[1-9][0-9]*$' }),
    updatedAt: InstantSchema,
  },
  { $id: 'DestinationCategory', additionalProperties: false },
);

export const DestinationCategoryListSchema = Type.Object(
  { categories: Type.Array(DestinationCategorySchema) },
  { $id: 'DestinationCategoryList', additionalProperties: false },
);

export const DestinationCategoryResponseSchema = Type.Object(
  { category: DestinationCategorySchema },
  { $id: 'DestinationCategoryResponse', additionalProperties: false },
);

export const DestinationCategoryWriteBodySchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 100 }),
    iconKey: Type.String({ minLength: 1, maxLength: 40 }),
    toneKey: Type.String({ minLength: 1, maxLength: 40 }),
    studentSurface: Type.Union([
      Type.Literal('primary'),
      Type.Literal('secondary'),
      Type.Literal('hidden'),
    ]),
    pickerMode: Type.Optional(DestinationCategoryPickerModeSchema),
    sortOrder: Type.Integer({ minimum: 0, maximum: 100000 }),
  },
  { $id: 'DestinationCategoryWriteBody', additionalProperties: false },
);

/**
 * Purpose-built student launcher catalog: active primary/secondary
 * categories with their eligible destinations. Hidden/archived categories,
 * non-requestable destinations, and empty categories never appear.
 */
export const StudentDestinationCatalogDestinationSchema = Type.Object(
  {
    id: UuidSchema,
    displayName: Type.String(),
    location: Type.Object({ id: UuidSchema, name: Type.String() }, { additionalProperties: false }),
    checkInMode: CheckInModeSchema,
  },
  { additionalProperties: false },
);

export const StudentDestinationCatalogCategorySchema = Type.Object(
  {
    id: UuidSchema,
    name: Type.String(),
    iconKey: Type.String(),
    toneKey: Type.String(),
    studentSurface: Type.Union([Type.Literal('primary'), Type.Literal('secondary')]),
    pickerMode: DestinationCategoryPickerModeSchema,
    sortOrder: Type.Integer({ minimum: 0 }),
    destinations: Type.Array(StudentDestinationCatalogDestinationSchema),
  },
  { additionalProperties: false },
);

export const StudentDestinationCatalogSchema = Type.Object(
  { categories: Type.Array(StudentDestinationCatalogCategorySchema) },
  { $id: 'StudentDestinationCatalog', additionalProperties: false },
);

export const DestinationCatalogSchema = Type.Object(
  { destinations: Type.Array(DestinationCatalogEntrySchema) },
  { $id: 'DestinationCatalog', additionalProperties: false },
);

/**
 * Minimized operational station view. No grants, rule JSON, override
 * categories, OIDC data, or schedule history.
 */
export const DestinationStationViewSchema = Type.Object(
  {
    destination: Type.Object(
      {
        id: UuidSchema,
        displayName: Type.String(),
        serviceType: Type.String(),
        checkInMode: Type.Union([
          Type.Literal('none'),
          Type.Literal('optional'),
          Type.Literal('required'),
        ]),
        capacity: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
      },
      { additionalProperties: false },
    ),
    occupancy: Type.Object(
      {
        consumingReservations: Type.Integer({ minimum: 0 }),
        availableCapacity: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
      },
      { additionalProperties: false },
    ),
    queueCount: Type.Integer({ minimum: 0 }),
    ready: Type.Array(
      Type.Object(
        {
          passId: UuidSchema,
          passRevision: Type.String({ pattern: '^[1-9][0-9]*$' }),
          passEtag: Type.String({ minLength: 1 }),
          student: StationPersonSchema,
          readyUntil: InstantSchema,
        },
        { additionalProperties: false },
      ),
    ),
    outbound: Type.Array(
      Type.Object(
        {
          passId: UuidSchema,
          passRevision: Type.String({ pattern: '^[1-9][0-9]*$' }),
          passEtag: Type.String({ minLength: 1 }),
          student: StationPersonSchema,
          departedAt: InstantSchema,
          expectedReturnAt: Type.Union([InstantSchema, Type.Null()]),
        },
        { additionalProperties: false },
      ),
    ),
    atDestination: Type.Array(
      Type.Object(
        {
          passId: UuidSchema,
          passRevision: Type.String({ pattern: '^[1-9][0-9]*$' }),
          passEtag: Type.String({ minLength: 1 }),
          student: StationPersonSchema,
          expectedReturnAt: Type.Union([InstantSchema, Type.Null()]),
        },
        { additionalProperties: false },
      ),
    ),
    queued: Type.Array(
      Type.Object(
        {
          passId: UuidSchema,
          passRevision: Type.String({ pattern: '^[1-9][0-9]*$' }),
          passEtag: Type.String({ minLength: 1 }),
          student: StationPersonSchema,
          enteredAt: InstantSchema,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { $id: 'DestinationStationView', additionalProperties: false },
);
