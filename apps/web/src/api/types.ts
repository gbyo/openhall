import type { operations } from './generated/openapi.js';

type JsonResponse<TOperation extends keyof operations, TStatus extends number = 200> =
  operations[TOperation]['responses'] extends Record<TStatus, infer TResponse>
    ? TResponse extends { content: { 'application/json': infer TBody } }
      ? TBody
      : never
    : never;

export type BootstrapStatus = JsonResponse<'getBootstrapStatus'>;
export type AuthSession = JsonResponse<'getAuthSession'>;
export type Me = JsonResponse<'getMe'>;
export type Organizations = JsonResponse<'listMyOrganizations'>;
export type OrganizationContext = JsonResponse<'getMyOrganizationContext'>;
export type ActivePassResponse = JsonResponse<'getMyActivePass'>;
export type Pass = NonNullable<ActivePassResponse['pass']>;
export type DestinationCatalog = JsonResponse<'listMyDestinations'>;
export type StudentDestinationCatalog = JsonResponse<'listMyStudentDestinationCatalog'>;
export type DestinationCategoryList = JsonResponse<'listDestinationCategories'>;
export type DestinationCategory = DestinationCategoryList['categories'][number];
export type ScheduledStudentList = JsonResponse<'listMyScheduledAuthorizations'>;
export type PendingApprovals = JsonResponse<'listMyPendingPassApprovals'>;
export type PendingOverrides = JsonResponse<'listMyPendingPassOverrides'>;
export type LivePassList = JsonResponse<'listSchoolLivePasses'>;
export type SectionStudents = JsonResponse<'listSectionStudents'>;
export type StationView = JsonResponse<'getDestinationStation'>;
export type DestinationList = JsonResponse<'listDestinations'>;
export type LocationList = JsonResponse<'listLocations'>;
export type PolicyList = JsonResponse<'listPolicyRules'>;
export type PolicyRule = JsonResponse<'getPolicyRule'>['rule'];
export type GrantList = JsonResponse<'listAuthorizationGrants'>;
export type ScheduledAdminList = JsonResponse<'listScheduledAuthorizations'>;
export type PeopleResult = JsonResponse<'searchOrganizationPeople'>;
export type AuditResult = JsonResponse<'listAuditEvents'>;
