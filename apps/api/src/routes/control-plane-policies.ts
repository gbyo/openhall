import {
  activatePolicyRule,
  archivePolicyRule,
  createPolicyRule,
  deactivatePolicyRule,
  getPolicyRule,
  listPolicyRules,
  updatePolicyRule,
  type Principal,
} from '@openhall/application';
import {
  PolicyRuleListSchema,
  PolicyRuleResponseSchema,
  PolicyRuleWriteBodySchema,
  UuidSchema,
} from '@openhall/contracts';
import { Type } from 'typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { AuthDependencies } from '../auth/dependencies.js';
import { requireCsrf, requirePrincipal } from '../auth/session-context.js';
import type { ControlPlaneDependencies } from '../control-plane/dependencies.js';
import {
  CONTROL_PLANE_ERRORS,
  COOKIE_CSRF_SECURITY,
  COOKIE_SECURITY,
  MutationHeadersSchema,
  OrganizationIdParamsSchema,
  unauthenticated,
  type ControlPlaneHandler,
} from './control-plane-shared.js';

const RuleIdParamsSchema = Type.Object(
  { policyRuleId: UuidSchema },
  { additionalProperties: false },
);

const POLICY_ERRORS = {
  400: CONTROL_PLANE_ERRORS[400],
  401: CONTROL_PLANE_ERRORS[401],
  403: CONTROL_PLANE_ERRORS[403],
  404: CONTROL_PLANE_ERRORS[404],
  409: CONTROL_PLANE_ERRORS[409],
  412: CONTROL_PLANE_ERRORS[412],
  428: CONTROL_PLANE_ERRORS[428],
};

export function registerPolicyRoutes(
  app: FastifyInstance,
  controlPlane: ControlPlaneDependencies,
  auth: AuthDependencies,
  handle: ControlPlaneHandler,
): void {
  const typedApp = app.withTypeProvider<TypeBoxTypeProvider>();

  function policyInput(request: FastifyRequest, principal: Principal) {
    return {
      principal,
      ifMatch: request.headers['if-match'],
      idempotencyKey: request.headers['idempotency-key'],
      requestId: request.id,
    };
  }

  typedApp.get(
    '/api/v1/organizations/:organizationId/policy-rules',
    {
      schema: {
        operationId: 'listPolicyRules',
        tags: ['control-plane'],
        description:
          'List policy rules for administration. Requires policy.manage on the exact school. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: OrganizationIdParamsSchema,
        response: {
          200: PolicyRuleListSchema,
          401: CONTROL_PLANE_ERRORS[401],
          403: CONTROL_PLANE_ERRORS[403],
          404: CONTROL_PLANE_ERRORS[404],
        },
      },
      preHandler: async (request, reply) => requirePrincipal(request, reply),
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) return unauthenticated(reply, request);
      await handle(request, reply, async () => ({
        body: await listPolicyRules(
          principal,
          request.params.organizationId,
          controlPlane.policies,
        ),
        status: 200,
      }));
    },
  );

  typedApp.post(
    '/api/v1/organizations/:organizationId/policy-rules',
    {
      schema: {
        operationId: 'createPolicyRule',
        tags: ['control-plane'],
        description:
          'Create a policy rule starting disabled at revision 1. Configuration is validated by the Phase 6 parser; creation alone never affects students. Requires Idempotency-Key. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: OrganizationIdParamsSchema,
        body: PolicyRuleWriteBodySchema,
        headers: MutationHeadersSchema,
        response: { 201: PolicyRuleResponseSchema, ...POLICY_ERRORS },
      },
      preValidation: [
        async (request, reply) => requirePrincipal(request, reply),
        async (request, reply) => requireCsrf(request, reply, auth),
      ],
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) return unauthenticated(reply, request);
      await handle(request, reply, async () => {
        const result = await createPolicyRule(
          {
            ...policyInput(request, principal),
            organizationId: request.params.organizationId,
            body: {
              name: request.body.name,
              ruleType: request.body.ruleType,
              scope: request.body.scope,
              priority: request.body.priority,
              configuration: request.body.configuration,
              overrideMode: request.body.overrideMode,
              validFrom: request.body.validFrom,
              validUntil: request.body.validUntil,
            },
          },
          controlPlane.policies,
        );
        return {
          body: { rule: result.rule },
          etag: result.etag,
          status: result.status,
        };
      });
    },
  );

  typedApp.get(
    '/api/v1/policy-rules/:policyRuleId',
    {
      schema: {
        operationId: 'getPolicyRule',
        tags: ['control-plane'],
        description:
          'Read one policy rule with its strong ETag. Authorized against the canonical school. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: RuleIdParamsSchema,
        response: {
          200: PolicyRuleResponseSchema,
          401: CONTROL_PLANE_ERRORS[401],
          403: CONTROL_PLANE_ERRORS[403],
          404: CONTROL_PLANE_ERRORS[404],
        },
      },
      preHandler: async (request, reply) => requirePrincipal(request, reply),
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) return unauthenticated(reply, request);
      await handle(request, reply, async () => {
        const result = await getPolicyRule(
          principal,
          request.params.policyRuleId,
          controlPlane.policies,
        );
        return { body: { rule: result.rule }, etag: result.etag, status: 200 };
      });
    },
  );

  typedApp.put(
    '/api/v1/policy-rules/:policyRuleId',
    {
      schema: {
        operationId: 'updatePolicyRule',
        tags: ['control-plane'],
        description:
          'Replace policy configuration (revision + 1). Active rules may be edited; the new revision governs future evaluations while old snapshots stay authoritative. Requires Idempotency-Key and If-Match. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: RuleIdParamsSchema,
        body: PolicyRuleWriteBodySchema,
        headers: MutationHeadersSchema,
        response: { 200: PolicyRuleResponseSchema, ...POLICY_ERRORS },
      },
      preValidation: [
        async (request, reply) => requirePrincipal(request, reply),
        async (request, reply) => requireCsrf(request, reply, auth),
      ],
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) return unauthenticated(reply, request);
      await handle(request, reply, async () => {
        const result = await updatePolicyRule(
          {
            ...policyInput(request, principal),
            ruleId: request.params.policyRuleId,
            body: {
              name: request.body.name,
              ruleType: request.body.ruleType,
              scope: request.body.scope,
              priority: request.body.priority,
              configuration: request.body.configuration,
              overrideMode: request.body.overrideMode,
              validFrom: request.body.validFrom,
              validUntil: request.body.validUntil,
            },
          },
          controlPlane.policies,
        );
        return {
          body: { rule: result.rule },
          etag: result.etag,
          status: result.status,
        };
      });
    },
  );

  for (const verb of ['activate', 'deactivate', 'archive'] as const) {
    typedApp.post(
      `/api/v1/policy-rules/:policyRuleId/${verb}`,
      {
        schema: {
          operationId:
            verb === 'activate'
              ? 'activatePolicyRule'
              : verb === 'deactivate'
                ? 'deactivatePolicyRule'
                : 'archivePolicyRule',
          tags: ['control-plane'],
          description:
            verb === 'activate'
              ? 'Activate a rule (revalidates configuration and scope, then enabled at a new revision). Requires Idempotency-Key and If-Match. Cache-Control: no-store.'
              : verb === 'deactivate'
                ? 'Deactivate a rule (enabled=false at a new revision; never rewrites passes). Requires Idempotency-Key and If-Match. Cache-Control: no-store.'
                : 'Archive a rule atomically (enabled=false, archived_at set, revision + 1). Reactivation is refused; there is no delete. Requires Idempotency-Key and If-Match. Cache-Control: no-store.',
          security: COOKIE_CSRF_SECURITY,
          params: RuleIdParamsSchema,
          headers: MutationHeadersSchema,
          response: { 200: PolicyRuleResponseSchema, ...POLICY_ERRORS },
        },
        preValidation: [
          async (request, reply) => requirePrincipal(request, reply),
          async (request, reply) => requireCsrf(request, reply, auth),
        ],
      },
      async (request, reply) => {
        const principal = request.principal;
        if (principal === undefined) return unauthenticated(reply, request);
        await handle(request, reply, async () => {
          const input = {
            ...policyInput(request, principal),
            ruleId: request.params.policyRuleId,
          };
          const result =
            verb === 'activate'
              ? await activatePolicyRule(input, controlPlane.policies)
              : verb === 'deactivate'
                ? await deactivatePolicyRule(input, controlPlane.policies)
                : await archivePolicyRule(input, controlPlane.policies);
          return {
            body: { rule: result.rule },
            etag: result.etag,
            status: result.status,
          };
        });
      },
    );
  }
}
