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
