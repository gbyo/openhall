# ADR 0015: Pass aggregate, idempotent commands, concurrency, and outbox

Status: accepted.

## Context

Phase 4 ends with trustworthy authorization but no way to record a
student's movement request. Phase 5 must turn an authenticated,
authorized request into one durable pass aggregate exactly once, under
retries, races, stale clients, process failure, and concurrent users,
while preserving truthful historical origin context and without
deciding movement policy (Phase 6).

## Decision

`pass` is the authoritative current aggregate state; `pass_event` is
immutable domain history; `outbox_event` is the pending
external/realtime notification. Current state is never reconstructed by
replaying `pass_event`: there is no event store, projection database,
event-sourcing framework, broker, or queue worker in Phase 5.

Migration 005 hardens integrity forward-only (001-004 untouched): a new
nullable `pass.origin_schedule_block_id` snapshots the active logical
schedule block; `destination` (plus `location`, `section`,
`schedule_block` to support the references) gains
`UNIQUE (tenant_id, organization_id, id)`; pass child references become
same-school composite foreign keys
`(tenant_id, organization_id, resource_id)`. `student_id` stays
tenant-bound because Person is tenant-wide. Preflight refuses the
migration when an existing pass references another school instead of
rewriting history.

## Aggregate and revision model

The pure domain (`packages/domain/src/passes/`) owns the lifecycle
matrix (`requested -> queued/ready/denied/cancelled/expired`, `queued
-> ...`, `ready -> outbound/cancelled/expired`, `outbound ->
at_destination`, `at_destination -> returning/completed`, `returning ->
completed`; terminal `completed/denied/cancelled/expired` have no
exits) with semantic transition functions only, no generic
`setState`. Creation is `requested` at `revision = 1n`; every
successful mutation adds exactly `1n`. Reads, denials, replays, and
stale preconditions never increment. `pass_event.sequence` equals the
resulting revision. Revision stays `bigint` end to end and crosses JSON
as a decimal string, never a number. Semantic event names are
`pass.requested/queued/ready/denied/cancelled/expired/departed/arrived/return_started/completed`;
`ready` is deliberately not `approved`, since a future pass may become
ready by automatic allowance, human approval, or preauthorization.

## Command boundary

Every successful mutation commits idempotency serialization,
authorization facts, the pass row, the domain event, the audit event,
the outbox event, and the idempotency result in one tenant PostgreSQL
transaction, or rolls all of it back. One injected `Clock` instant per
command drives authorization validity, Expected Placement, `requested_at`,
event/outbox/audit timestamps, and idempotency expiry, so a command
never straddles a schedule boundary. Expected Placement resolves
immediately before the mutation transaction at that instant as
historical origin context (not movement policy); the transaction
revalidates destination, student, school, and authorization
transactionally. Only the safe intake surface is exposed:
`POST /me/passes`, `POST /students/:studentId/passes`,
`GET /me/passes/active`, `POST /me/passes/:passId/cancel`. Future
approve/depart/queue/ready transitions exist only in the domain matrix.

## Idempotency as an OpenHall API contract

`Idempotency-Key` (1-255 visible ASCII characters, no normalization;
UUIDv7 recommended) is required on mutating pass endpoints under stable
command namespaces (`pass.request.self:v1`, `pass.request.student:v1`,
`pass.cancel.self:v1`) with SHA-256 fingerprints over semantic inputs
only. Same key plus same fingerprint returns the stored success without
re-running authorization or appending rows; same key plus different
intent is `409 idempotency_key_reused`; expired rows (24-hour
retention) are removed by exact identity inside the serialized
transaction, never by broad cleanup. Concurrency serializes on a
transaction-level `pg_advisory_xact_lock` over the scoped identity, so
replicas are safe; only successful mutations are stored, so denials and
failures are re-evaluated. This documents OpenHall behavior; the IETF
Idempotency-Key document is an expired draft, not a finalized RFC.

## Concurrency and lost updates

`pass_one_active_per_student` stays the final authority with an early
read for clearer errors; concurrent keys for one student yield one pass
and one `409 active_pass_exists`. Existing-pass mutations use
`SELECT ... FOR UPDATE` (never `SKIP LOCKED`). Every representation
carries a strong ETag `"pass:<id>:<revision>"`; cancellation requires
the exact tag in `If-Match` (`428` when missing, `412` when stale).
Idempotency replay is checked before current-revision validation, so a
lost response returns its committed result instead of a spurious 412.

## Deferred

Movement policy, approval/denial workflows, capacity, reservations,
queues, departure/arrival/return/completion HTTP commands, scheduled
authorization consumption, `policy_evaluation` writes, station/student/
teacher UIs, SSE, the outbox publisher, SIS integrations, emergency
mode, grant administration, and RLS all remain later phases. New passes
start `requested` with `expected_return_at`, `scheduled_authorization_id`,
and `return_location_id` null. OpenHall remains not production-ready.
