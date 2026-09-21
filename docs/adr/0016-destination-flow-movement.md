# ADR 0016: Destination flow, capacity leases, queues, and explicit movement

Status: accepted.

## Context

Phase 6 answers whether movement policy is currently satisfied; it
intentionally leaves a policy-cleared pass in `requested` without
deciding anything physical. Phase 7 must answer whether a destination
can accept the movement now, and must record only movement that someone
explicitly reports. Three facts stay separate: policy cleared,
capacity reserved, and the student actually departed, arrived, or
returned. A policy-cleared pass must never automatically become an
active movement.

## Decision

Policy clearance, capacity allocation, and movement facts are three
separate questions answered by three separate mechanisms: the Phase 6
policy evaluation, the destination-flow allocator, and explicit
departure/progress commands. Migration 007 hardens the dormant
`destination_reservation` and `queue_entry` tables into operational
flow state (001-006 untouched, contradictory legacy rows fail the
preflight instead of being rewritten), and adds
`destination.ready_claim_timeout_seconds` (default 60, bounds 5-600)
plus `destination.queue_timeout_seconds` (default 600, bounds
60-14400).

## Reservation as capacity source of truth

There is no mutable occupancy counter. A reservation consumes capacity
exactly while `released_at IS NULL AND (claimed_at IS NOT NULL OR
ready_expires_at > at)`, so an expired unclaimed offer stops consuming
capacity even before the worker writes its release metadata. Coherence
is CHECK-enforced: `ready_expires_at > reserved_at`,
`flow_expires_at > reserved_at`, `ready_expires_at <= flow_expires_at`,
claim inside the offer window, and `released_at` paired with a closed
release vocabulary (`ready_claim_expired`, `cancelled`,
`return_started`, `completed`, `destination_unavailable`,
`pass_terminal`). Unlimited destinations (`capacity IS NULL`) still get
a reservation so the ready lease and movement provenance stay uniform.

## Allocation and the ready lease

`allocateDestinationFlow` runs inside the request and
approval/override transactions immediately after a fresh allow, never
as its own transaction, and the policy module stays unaware of
capacity. A usable destination with a free slot creates a reservation
and transitions `requested -> ready` (`pass.ready`); a full
queue-enabled destination creates a queue entry (`requested ->
queued`, `pass.queued`); a full queue-less destination denies with
`destination_capacity_full` while policy history still truthfully says
allow; a closed/archived destination denies with
`destination_unavailable`. Ready is a short-lived capacity offer
ending at `readyUntil = min(at + ready_claim_timeout_seconds,
flowExpiresAt)` with half-open semantics (`at < readyUntil`);
departure additionally requires an unreleased, unclaimed reservation
and a still-usable destination, never pass state alone.

## Queue semantics and derived position

Ordering is strict FIFO (`priority DESC, entered_at ASC, id ASC`)
with every insert at `priority = 0`; no API sets priority and no
override bypasses physical capacity. The overall attempt deadline
`flowExpiresAt = min(at + queue_timeout_seconds, current slot end)`
is inherited unchanged across requeues, so missing a ready offer sends
the student behind the queue without granting fresh time. A missed
claim with waiters becomes `ready -> queued` (new `pass.queued` with
`reasonCode = ready_claim_expired`); with nobody waiting, or past the
flow deadline, it becomes `ready -> expired`. Position is derived
(1 + entries ahead) through `GET
/api/v1/me/passes/:passId/queue-status` (`no-store`, no ETag, 409
`queue_status_unavailable` when not queued, other students concealed
as 404) because another student's departure can change my position
without changing my revision; embedding it in the strong-ETag pass
representation would let the body change under a constant ETag.

## Promotion rechecks policy

The reconciler re-runs the full Phase 6 evaluation (new instant,
current placement, rules, approval/override evidence) before every
`queued -> ready` and persists it; the new reservation references the
fresh allow evaluation, never the queue-time one. Deny terminalizes
the queue row; approval/override-required releases it as
`policy_changed`, returns the pass to `requested` with
`pass.readiness_revoked` (no second `pass.requested`), and lets Phase 6
reconciliation raise the fresh approval. Expiry needs no reevaluation.

## Reconciler durability and ordering

`DestinationFlowReconciler.runOne/runBatch` (one candidate, one
transaction, one outcome) treats the database as the durable work
source: pass row lock, state predicates, revision, destination
advisory lock, constraints. Approximate discovery never leapfrogs a
locked head; FIFO fairness is per destination. The API composition
root polls every `destinationFlowPollMs` (default 2000, bounds
250-60000, stopped on shutdown, `unref`d); tests drive
runOne/runBatch directly. Global lock order is idempotency lock, pass
row, destination-flow advisory lock (`destination-flow:v1` over
tenant+destination via `pg_advisory_xact_lock`), then flow rows; the
worker omits the HTTP idempotency step but never reverses pass before
destination. Active movement (`outbound`, `at_destination`,
`returning`) is never timer-mutated: no auto-completion, no claim
release from elapsed durations; capacity frees only on explicit
events (ready expiry/cancel, `at_destination -> returning`,
completions, terminal pre-departure failures).

## Explicit movement and stations

`pass.depart.self` (owner plus active school membership),
`pass.depart.student` (org authority or current-section teacher
fallback), and `pass.progress.self` (ownership-scoped, no fresh
membership needed to finish) join the closed capability vocabulary
with compile-time resource mapping. Departure claims the reservation,
snapshots `expected_return_at` (departure instant plus
`default_duration_seconds`, never reinterpreted) with duration
metadata into `pass.departed`, and moves `ready -> outbound`.
`destination.check_in_mode` governs the rest: `none` gives the
first-class restroom path `ready -> outbound -> completed` with no
fabricated checkpoints; `optional` additionally allows self arrival
and one-way or return completions; `required` rejects self arrival
and direct self completion so nurse/office flows stay station-owned
(`outbound -> at_destination -> returning/completed`). Station
commands (`check-in`, `begin-return`, `complete`) plus the minimized
`GET .../station` view require `destination.station.manage` on the
exact route destination, and the pass's canonical destination must
match. `at_destination` records an explicit workflow fact, never
emergency presence. Every movement command keeps the Phase 5 envelope
(CSRF, namespaced `Idempotency-Key`, `If-Match` with 428/412,
replay-before-staleness, audit, outbox); the reconciler uses
`actor_kind = system` and no idempotency records. OpenHall remains
not production-ready.
