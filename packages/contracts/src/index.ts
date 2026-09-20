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
    Type.Object(
      { authenticated: Type.Literal(false) },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        authenticated: Type.Literal(true),
        csrfToken: Type.String({ minLength: 1 }),
        absoluteExpiresAt: InstantSchema,
        authenticationMethod: Type.Union([
          Type.Literal('oidc'),
          Type.Literal('recovery'),
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
    Type.Object(
      { tenantSelectionRequired: Type.Literal(true) },
      { additionalProperties: false },
    ),
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
