# ADR 0018: WayPass web product and realtime invalidation

## Status

Accepted

## Context

OpenHall's Phase 5–8 APIs and Wayfinder reference needed to become one production-shaped browser product. The browser handles sensitive student movement and consequential, concurrent commands. Several API replicas may serve browsers, while PostgreSQL remains the only durable coordination point.

## Decision

The user-facing product is **WayPass**. OpenHall remains the internal platform, package, database, API, log, migration, and problem-URI name. This avoids an unsafe repository-wide rename while giving the browser one coherent identity.

React Router Data Mode owns URLs, route boundaries, redirects, deep links, and lazy loading. TanStack Query is the sole server-state cache. Loaders seed that same query client instead of creating a second cache. Browser DTOs and request shapes are generated from `openapi/openapi.json` and consumed through `openapi-fetch`; the web package does not import database or application repository types.

Session bootstrap stores the CSRF value in runtime memory only. Query state is memory-only and is cleared with session memory when authentication expires. There is no local-storage, IndexedDB, service-worker, analytics, or offline mutation persistence.

Every consequential user intent creates one logical command containing its UUID idempotency key, original body, and original `If-Match`. A lost response keeps that object available for an explicit retry. A confirmed result clears it. A 412 is never replayed blindly: the authoritative resource is fetched and the user reviews the changed state.

REST is authoritative. Same-origin SSE only carries `resync`, `invalidate`, and `realtime-unavailable` events. It never carries resource DTOs. The browser invalidates centralized query keys and a normal GET resolves the current truth. Each school shell owns one native `EventSource` authenticated by the existing HttpOnly session cookie.

Successful transactions insert a durable `outbox_event` row and call `pg_notify('openhall_outbox_v1', outbox_id)` on the same PostgreSQL transaction connection. PostgreSQL therefore exposes the wake-up only after commit. The notification contains only the outbox UUID; a dedicated `pg.Client` on each API replica loads the committed row. SSE observation does not set `published_at`; that remains reserved for a future durable integration publisher.

Every replica listens to the same channel and independently fans safe invalidation topics to browsers attached to that replica. Subscriber state contains only the minimal tenant, person/account, organization, affiliation, capability, teaching-section, and staffed-destination context. Listener loss makes streams visibly unavailable; bounded reconnect broadcasts a new `resync`. New subscribers also receive an immediate `resync`, so notifications are never treated as replayable history.

## Consequences

The product gets low-latency updates without introducing Redis, WebSockets, or a second state authority. A missed notification costs latency, not correctness, because connection/resync and ordinary refetch recover state. There are no offline mutations. Product routes remain independently refreshable, and heavy control-plane areas are separate lazy chunks.
