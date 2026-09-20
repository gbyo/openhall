# Contributing

Use Node 24, pnpm 11, and PostgreSQL 18. Read the architecture and ADRs before changing package
boundaries or persistence semantics. New schema changes are forward-only migrations; never edit an
already released migration or use schema push/synchronization in production.

Before submitting a change, run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
`pnpm db:types:check`, and `pnpm openapi:check`. Database behavior must be tested against real
PostgreSQL 18. Public HTTP types come from TypeBox route schemas, and generated artifacts must be
committed. Keep vendor adapters outside the canonical domain and collect only data required by a
defined feature.
