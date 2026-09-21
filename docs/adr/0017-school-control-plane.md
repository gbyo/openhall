# ADR 0017: School control plane, versioned configuration, identity enrollment, and scheduled authorizations

Status: accepted.

## Context

Phases 1-7 built passes, movement policy, and destination flow, but the
backend was operable only through direct SQL fixtures. Phase 8 must make
the backend operable without SQL while preserving tenant isolation,
deterministic policy behavior, and the existing pass lifecycle. It is the
last major backend phase before the real WayPass UI.

## Decision

One additive migration (`008_school_control_plane`) carries all Phase 8
persistence; migrations 001-007 are untouched. The control plane lives in
`packages/application/src/control-plane/` as small per-area modules
(locations, destinations, schedules, policies, grants, people, enrollment,
scheduled, audit) behind purpose-built repository ports; no Kysely outside
`packages/db`.

## OpenHall-owned config vs SIS-owned roster

The control plane owns school configuration (locations, destinations,
schedule blocks/templates/calendar, policy rules, grants, scheduled
authorizations). It never owns the roster: people and section membership
are read-only directory surfaces. Enrollment links an existing account to
an external identity; it never creates people.

## Versioned configuration and concurrency

Every versioned resource carries a per-resource ETag over its revision.
Mutations require `If-Match` (428 when absent, 412 on stale revision) and
an `Idempotency-Key` (translating envelope: a reused key with a different
fingerprint is a conflict, never a silent replay). Schedule mutations take
an aggregate lock and bump the schedule revision exactly once per mutation,
after validation. Archive/deactivate paths use conservative in-use guards
that fail closed instead of cascading.

## Policy administration

Policy rule bodies are closed exact shapes validated by a shared runtime
parser (`parsePolicyRuleConfiguration`); unknown rule types or unknown keys
on in-scope rules fail closed, and out-of-scope rows stay not applicable.
The persisted reason vocabulary is closed by CHECK constraint; Phase 8
rebuilds it in 008 to add `scheduled_preapproval_satisfied` and nothing
else.

## Identity enrollment

Enrollment grants store only a digest of the one-time token; the raw token
is returned once, never persisted, audited, or emitted. The OIDC
transaction purpose is extended to `enrollment` with a structural CHECK
covering exactly the fields each purpose may carry.

## Scheduled authorizations

Appointment windows sit within one school day in the school's timezone,
last at most 12 hours, and start within 366 days. Start and cancel race
under an authoritative lock: one wins and the other sees 412 or an
equivalent state conflict. Preapproval satisfies only the classroom
(`current_section_teacher`) approval for the exact scheduled movement;
deny contributions, overrides, and every other rule type are untouched.

## Audit and outbox

Every successful control-plane mutation appends audit and a minimized
outbox fact in the same transaction. The read surface
(`GET /organizations/:id/audit-events`, capability `audit.view`) is
keyset-paginated over `(occurred_at DESC, id DESC)` and projects minimized
fields only: `audit_event.metadata` is durable internal evidence and is
never selected or dumped to clients.

## Consequences

Admin UI work can proceed against TypeBox contracts and regenerated
`openapi/openapi.json` without SQL fixtures. Cross-tenant access uses real
valid IDs from another tenant in tests: reads conceal (404) and writes are
denied (403/404), never leaked.
