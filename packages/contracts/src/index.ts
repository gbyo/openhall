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
