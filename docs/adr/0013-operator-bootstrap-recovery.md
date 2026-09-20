# ADR 0013: Operator bootstrap and break-glass recovery

Status: accepted.

## Context

An installation starts from an empty database: no tenant, no account, no
session. The first administrator must be created through an operator-mediated
ceremony that cannot be triggered remotely, and a later lockout (lost
provider, misconfiguration) must be recoverable by a human operator without
weakening the session or identity model.

## Decision

Bootstrap and recovery are one-time bearer grants whose raw values exist
only at issuance. Storage keeps HMAC digests; issuance returns the raw
token once for the operator to carry out of band. Bootstrap grants are
tenant-less and refused once any canonical tenant exists; recovery grants
are tenant- and account-scoped and require an eligible target (active
tenant, active account, active person, live `system_admin` grant) at both
issuance and consumption. Consumption is atomic on read: any use, eligible
or not, burns the grant. Lifetimes are short (60-minute bootstrap,
30-minute recovery).

Bootstrap prepares a single setup draft per grant: retrying or correcting
the draft updates the one row instead of creating unrelated drafts. Draft
validation (slugs, time zone, provider shape, no `offline_access`) runs
before any canonical write, and provider failures leave no canonical rows.
Completion finalizes inside one system transaction (tenant, school,
person, account, provider, identity, admin grant, session, audit); failure
anywhere rolls everything back and the grant stays reusable.

The installed administrator links by `(issuer, subject)` from the verified
ID token; the email is stored as a snapshot. Initial membership is `staff`
with a tenant-scoped `system_admin` grant. Completion issues a normal OIDC
session and redirects to `/`.

Recovery consumes the grant into a short-lived session (15-minute idle,
30-minute absolute) with `authentication_method: 'recovery'`, audited as
`auth.recovery_session_created`. Recovery sessions authenticate the same `/me`
surface; elevation policy beyond that belongs to later phases.

Operator surfaces (bootstrap prepare/status, recovery consume) travel in
the `Authorization` header (`Bootstrap`/`Recovery` schemes), never the
query string, and are rate-limited with the operator-token bucket. The
operator CLI wraps grant issuance for `docker compose` deployments; the
same compiled CLI ships in the production image.

## Consequences

Two concurrent bootstrap callbacks cannot create two installations: the
one-time transaction claim admits exactly one. Expired, consumed, disabled,
or ineligible grants fail with `bootstrap_token_invalid` /
`recovery_token_invalid` without distinguishing which, and provider
failures surface as `auth_provider_unavailable` without raw OAuth payloads.
Tests prove digest-only storage, expiry, one-draft-per-grant correction,
token-time rollback with grant retry, concurrent-callback exactly-once, and
the full eligibility matrix.
