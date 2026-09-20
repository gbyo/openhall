# ADR 0014: Authorization, relationships, capabilities, and user context

Status: accepted.

## Context

Phase 3 ends with a trustworthy Principal (who is this user?) but only a
deny-all authorization stub. Phase 4 must answer whether that Principal may
perform an action on an exact resource in an exact context, for multi-school
tenants, without an external authorization service, without confusing
authorization with movement policy, and without beginning pass workflows.

## Decision

OpenHall authorization is a hybrid evaluated in-process against canonical
PostgreSQL facts:

- ReBAC: student, staff, and teacher authority derives from
  `organization_membership` and `section_membership`, never from grants.
- ABAC: grant half-open instant validity, school-local membership dates,
  resource status, organization kind, and the session authentication method.
- Small explicit grants: only duties without a canonical relationship
  (`destination_staff`, `counselor`, `office_staff`, `school_admin`,
  `system_admin`).

`student` and `teacher` are not `authorization_grant` roles. Migration 004
refuses schemas containing them instead of reinterpreting rows, narrows the
role CHECK to the five explicit duties, and adds a role/scope CHECK so
`system_admin` is tenant-scoped, `school_admin`/`counselor`/`office_staff`
are organization-scoped, and `destination_staff` is destination-scoped. No
valid Phase 4 grant uses section scope.

## Capability vocabulary and typing

A closed, centrally owned capability list (23 names, from `self.read` to
`system.manage`) replaces arbitrary permission strings. Capability/resource
compatibility is a TypeScript mapping (`ResourceByCapability`), so nonsense
such as `schedule.manage` on `self` fails compilation. The contracts
package mirrors the literals for wire validation, with a parity test
keeping the two sets identical.

Capability names are authorization capabilities, not movement decisions:
`pass.approve.section` means the actor may attempt approval for a
student/section relationship; future movement policy still decides
first/last-N-minutes, capacity, and emergency behavior independently.

## Relationship rules

- Teacher authority requires active staff membership at the section's
  school plus an active teacher `section_membership` in that exact section,
  and targets a student with an active student membership in the same
  section. Section scope never becomes organization-wide power.
- School-specific explicit roles additionally require active staff
  organization membership on the school local date, so stale grants stop
  working when the canonical relationship ends.
- `system_admin` is tenant-scoped and covers operational capabilities
  across active schools in the same tenant, but never fabricates
  `pass.request.self`, which still requires real student membership.
- Organization scope is exact; district grants never inherit to schools.
- Recovery sessions allow only `self.read` and (with an effective
  `system_admin` grant) `identity.manage`; the restriction is evaluated
  before normal grants.
- Grant validity is half-open `[valid_from, valid_until)` on
  `Temporal.Instant`; membership validity is inclusive on the school-local
  date derived from the request instant and the school IANA zone, failing
  closed on unusable zones. JavaScript `Date` never appears in
  authorization logic.

## Evaluation

One tenant transaction per decision loads the related facts; enforcement
and UI capability hints share the same mapping code, so they cannot drift.
The service returns structured decisions (allow basis or denial reason)
and defaults to deny. No explicit-deny ACLs exist; movement restrictions
belong to policy. No cross-request grant cache exists; changes apply on
the next request.

Object-level authorization is the BOLA defense: canonical rows resolve
tenant, school, and status server-side, client-supplied ownership is never
trusted, and inaccessible objects are concealed as 404 while session-mode
restrictions stay 403. There is no generic `/authorize` oracle endpoint,
and context capability hints are never accepted back as authority.

## User context

`GET /api/v1/me/organizations` lists schools with current affiliations
(membership-local dates; system admins see all active schools).
`GET /api/v1/me/organizations/:id/context` gates on
`organization.context.read`, then returns affiliations, effective
organization/self capabilities in registry order, actual teaching
sections, explicit destination assignments, and the caller's own expected
placement (students only; staff-only users receive null) through a
data-minimized DTO. The same request instant drives authorization,
membership, and placement. `GET /api/v1/me` stays minimal identity.

## Deferred

Grant administration (CRUD/UI), pass commands, movement policy,
scheduled-authorization workflows, admin UIs, SIS integrations, SSE,
PostgreSQL RLS (defense remains tenant-bound Principals, tenant
transactions, scoped repositories, composite keys, and application
authorization), district inheritance, external authorization services,
and arbitrary authorization scripts are all explicitly out of scope.
