# ADR 0012: OIDC login, opaque sessions, and CSRF/origin enforcement

Status: accepted.

## Context

Phase 3 adds login over OpenID Connect plus first-class server-side sessions.
The threat model includes provider mix-up, transaction replay and fixation,
session theft, cross-site request forgery against the SPA, and secret leakage
through logs, errors, and API responses. The design must keep provider
protocol details behind a port so application services stay testable without
HTTP, and must keep every credential opaque outside its single use.

## Decision

OIDC is Authorization Code + PKCE with S256 required. Providers that do not
advertise S256 are refused during discovery validation. The `openid-client`
adapter lives in the API composition root behind the `OidcProtocolAdapter`
port; `openid-client`, Fastify, Kysely, `pg`, React, and Node HTTP imports
are banned from `packages/application` by the architecture boundary test.
Discovery runs live on every flow (no cached metadata), with
`enableNonRepudiationChecks` so ID tokens are signature-verified against the
provider JWKS instead of trusted on TLS alone.

Each login starts with a persisted one-time transaction (state digest,
browser-binding digest, encrypted PKCE verifier/nonce) created in a short
database transaction before any network call; failed starts leave an
unguessable orphan that expires. The callback claims the transaction
atomically (`pending` → `processing`); replays and concurrent callbacks fail
closed. Mix-up protection is layered: the transaction binds the exact
provider, the adapter enforces the RFC 9207 `iss` binding and the token
`iss` claim on exchange, and the use case re-checks the verified issuer.
The callback `iss` parameter is documented but never trusted.

Canonical identity is `(issuer, subject)` only. Email is an updateable
snapshot, never a lookup key; the application ports expose no email-based
identity lookup. Unknown identities, disabled accounts, and inactive people
all map to the generic `identity_not_linked` denial so login never oracles
account existence.

Sessions are opaque: only HMAC digests rest server-side, bearer material
lives in `HttpOnly` `SameSite=Lax` cookies (`__Host-` + `Secure` in
production), and digests cover the raw credential bytes on both sides.
Resolution re-validates tenant/account/person status and the bigint
`session_revision` on every request; logout bumps nothing (single revoke)
while logout-all bumps the revision and revokes all account sessions.
`last_seen_at` is rewritten only after a five-minute touch window, never on
every request. Idle lifetime is 12 hours, absolute lifetime 7 days.

SPA mutations require a per-session CSRF token (rotated on every session
read, digest-stored) plus an exact-match `Origin` or a same-origin `Referer`
fallback; missing origin fails closed in every environment. OIDC redirects
are exempt from the SPA header and rely on transaction protections instead.
The login binding cookie is `HttpOnly` `SameSite=Lax` and never `Secure`-
gated in a way that would break local development; production cookie flags
are asserted by tests.

Rate limiting is abuse resistance, not the security boundary: strict
per-process buckets (10/minute, `operator-token` group) guard the
operator-token endpoints while login traffic gets a generous bucket. The
global error handler preserves carried 4xx/5xx statuses (notably 429 with a
`rate_limited` problem body) instead of collapsing everything to 500, and
scrubs protocol-secret fragments from 500 error logs as a backstop.

Time travels as text with a UTC-pinned session so rendering is deterministic
regardless of server timezone; instants carry explicit offsets end to end.

## Consequences

Login, bootstrap, and recovery share one callback that dispatches on the
transaction purpose after a non-consuming peek; single consumption is still
enforced by the atomic claim. Tests prove mix-up rejection at both the
request (`iss` parameter) and token (`iss` claim) layers, concurrent-callback
exactly-once behavior, the full session policy matrix at unit level, and
secret absence from logs, errors, audit metadata, and responses.
