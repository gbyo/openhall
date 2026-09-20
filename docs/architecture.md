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

PostgreSQL is the durable system of record. Transactions will update aggregates and append outbox
events atomically. LISTEN/NOTIFY may later reduce latency but cannot replace the outbox. The HTTP API
is command-oriented and schema-first under `/api/v1`; SSE, not WebSockets, is the planned realtime
transport.

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
`SameSite=Lax` cookies. SPA mutations require a rotating per-session CSRF
token plus an exact `Origin` (or same-origin `Referer`); OIDC redirects rely
on transaction protections instead.

The first installation is created by an operator bootstrap ceremony
(one-time digested grant, setup draft, OIDC sign-in as founding admin with a
tenant-scoped `system_admin` grant), and lockouts are recoverable through
one-time recovery grants into short-lived sessions. Operator Bearer [REDACTED] travel
in the `Authorization` header under strict per-process rate limits, which are
abuse resistance rather than the security boundary. See ADR 0012 and ADR 0013.
