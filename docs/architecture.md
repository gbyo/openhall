# Architecture

OpenHall is a small pnpm workspace with one-way dependencies:

```text
domain <- application <- db <- api
                  contracts <- api
                     config <- api

web (independent HTTP client shell)
test-support -> domain
```

`domain` contains closed states, errors, and Temporal-based time primitives. `application` owns use
case boundaries, principal/authorization contracts, tenant-required repository ports,
transactions, idempotency, integrations, and outbox publication. `db` is PostgreSQL/Kysely
infrastructure. `contracts` owns public JSON Schema DTOs; neither database rows nor vendor objects
are API contracts. `api` composes those pieces and keeps route handlers free of business policy.

Expected Placement is the first implemented domain/application service. Its purpose-built read
port loads a school, applicable membership, authoritative calendar day, template slots and blocks,
student section meetings, locations, and every applicable teacher. The PostgreSQL adapter scopes
every query by tenant and every school-local query by organization; application packages never
receive Kysely rows. The resolver is intentionally not exposed over HTTP before authentication and
authorization exist.

The tenant is the hard security boundary. Ordinary persistence access is constructed with a
tenant ID through `TenantDatabase`; unscoped access is deliberately named
`SystemDatabaseAccess.explicitlyUnscoped`. Composite foreign keys enforce tenant agreement for
relational links. RLS is deferred until authenticated tenant context can be set reliably on every
database session.

PostgreSQL is the durable system of record. Transactions update aggregates and append outbox events
atomically. A same-transaction `NOTIFY` containing only the outbox UUID wakes a dedicated listener
on every API replica after commit; each listener loads the durable row and sends only authorized SSE
invalidation topics. SSE never replaces the outbox, never carries resource DTOs, and never consumes
`published_at`. The HTTP API remains the authoritative, schema-first interface under `/api/v1`.

Times are modeled as instants (`timestamptz`/Temporal.Instant), school dates (`date`/
Temporal.PlainDate), wall times (`time`/Temporal.PlainTime), and explicit IANA zones. Schedule-derived
placement remains an expectation, never an observation.

PostgreSQL date/time scalars cross the database boundary as text through per-pool parsers and are
converted explicitly by `db` Temporal helpers. This prevents the Node process timezone from turning
a school-local date into a different calendar day and keeps JavaScript `Date` out of scheduling
domain/application code.

## Identity, sessions, and operator flows (Phase 3)

Login is OpenID Connect Authorization Code + PKCE (S256) through a generic
adapter (`openid-client`) that lives in the API composition root behind the
`OidcProtocolAdapter` port. Application services never import OIDC, HTTP,
Fastify, Kysely, `pg`, or React code; the architecture boundary test enforces
this. Discovery runs live on every flow with signature verification
(`enableNonRepudiationChecks`); providers without S256 support are refused.

Every login starts with a persisted one-time OIDC transaction claimed
atomically on callback, so replays and concurrent callbacks fail closed.
Canonical identity is `(issuer, subject)`; email is a snapshot, never a
lookup key. Sessions are opaque server-side records (HMAC digests only,
12-hour idle / 7-day absolute lifetimes) presented in `HttpOnly`
`SameSite=Lax` cookies. SPA mutations require a stable per-session CSRF
token (domain-separated HMAC of the session credential; `GET /auth/session`
is read-only) plus an exact `Origin` (or same-origin `Referer`); OIDC
redirects rely on transaction protections instead.

The first installation is created by an operator bootstrap ceremony
(one-time digested grant, setup draft, OIDC sign-in as founding admin with a
tenant-scoped `system_admin` grant), and lockouts are recoverable through
one-time recovery grants into short-lived sessions. Operator Bearer [REDACTED] travel
in the `Authorization` header under strict per-process rate limits, which are
abuse resistance rather than the security boundary. See ADR 0012 and ADR 0013.

## Authorization and user context (Phase 4)

Authentication owns the Principal; authorization consumes it. The Phase 3
deny-all stub is replaced by an in-process typed evaluator
(`RelationshipAuthorizationService`) backed by canonical PostgreSQL facts
through a purpose-built `AuthorizationFactsRepository` port. Ordinary
queries use `TenantTransactionContext` with `connectionFor`; there is no
system/unscoped authorization access, no external authorization service,
and no cross-request grant cache.

The model is a hybrid: relationship facts (student/staff membership,
teacher section relationships), attributes (grant instants, school-local
dates, resource status, session authentication method), and small explicit
grants for duties without a canonical relationship. A closed capability
vocabulary with compile-time capability/resource compatibility replaces
permission strings; enforcement and UI hints share the same mapping, and
decisions are structured (allow basis or denial reason) defaulting to
deny. See ADR 0014.

`GET /api/v1/me/organizations` and
`GET /api/v1/me/organizations/:organizationId/context` are thin use-case
wrappers (`UserContextService`) combining the Principal, authorization
snapshot, and the Phase 2 `ExpectedPlacementResolver` at one clock
instant, mapped to minimized public DTOs. Object existence stays
concealed as 404; recovery-session restrictions stay 403. Capability
hints are never accepted back as authority, and no generic `/authorize`
oracle exists.

## Pass aggregate and idempotent commands (Phase 5)

`pass` is the authoritative current aggregate; `pass_event` is immutable
history and `outbox_event` the pending notification, committed together
in one tenant transaction per successful command. The pure domain owns
the lifecycle matrix and the revision invariant (creation `1n`, plus
exactly `1n` per mutation, mirrored by `pass_event.sequence`); there is
no event sourcing. Request intake (`POST /me/passes`,
`POST /students/:studentId/passes`), self reads
(`GET /me/passes/active`), and self cancellation
(`POST /me/passes/:passId/cancel`) compose Phase 3 sessions, Phase 4
authorization (org-level `pass.create.student` plus teacher fallback
against the resolved current section), and one-clock-instant Expected
Placement snapshots. `Idempotency-Key` semantics are an OpenHall API
contract (stable command namespaces, SHA-256 semantic fingerprints,
24-hour retention, transaction advisory locks); strong ETags
(`"pass:<id>:<revision>"`) with `If-Match` prevent lost updates, and the
partial unique index keeps one active pass per student. Outbox rows stay
pending; no publisher exists yet. See ADR 0015.

## Destination flow, queues, and movement execution (Phase 7)

Phase 6 policy clearance leaves a pass in `requested`; Phase 7 decides
whether the destination can accept it now. `allocateDestinationFlow`
runs inside the request and approval/override transactions right after
a fresh allow and yields `ready` (reservation created), `queued`
(queue entry created), or an operational denial
(`destination_capacity_full`, `destination_unavailable`) while policy
history keeps saying allow. Capacity is derived from
`destination_reservation` rows, never a counter, and destination
decisions serialize on a `destination-flow:v1` advisory lock taken
after the pass row lock. `DestinationFlowReconciler` (polled from the
API composition root, one candidate per transaction) expires stale
queue attempts and ready offers, requeues missed claims behind the
queue with the original flow deadline, and promotes the head only
after a fresh persisted policy evaluation bound to the new
reservation. Active movement is never timer-mutated.

Explicit commands record physical facts: self/staff departure
(`ready -> outbound`, reservation claimed, `expected_return_at`
snapshotted), self arrival/return/completion gated by
`destination.check_in_mode` (`none` gives the lightweight restroom
path with no fabricated checkpoints; `required` keeps nurse/office
flows station-owned), station check-in/begin-return/completion under
`destination.station.manage` on the exact destination, and a
minimized station view plus a per-student derived queue-status
endpoint kept outside the strong-ETag pass representation. New
capabilities `pass.depart.self`, `pass.depart.student`, and
`pass.progress.self` keep compile-time resource mapping and parity
coverage. See ADR 0016. OpenHall remains not production-ready.

## WayPass browser product and realtime (Phase 9)

WayPass is the user-facing name for the OpenHall-backed product. React Router Data Mode owns stable
URLs and route boundaries; TanStack Query owns the memory-only server-state cache; and
`openapi-typescript` plus `openapi-fetch` keep the browser on the public HTTP contract. Session CSRF
state remains runtime-only. One same-origin EventSource per active school shell accelerates refetches
without becoming state authority. Student, teacher, school-operations, station, and capability-gated
administrator shells expose different task-focused navigation. See ADR 0018.
