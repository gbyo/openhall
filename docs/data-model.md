# Data model

The foundation plus scheduling migration creates 36 domain tables plus Kysely's migration
metadata. UUID primary keys use PostgreSQL 18 `uuidv7()` defaults.

| Area                      | Tables                                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenancy and identity      | `tenant`, `organization`, `person`, `organization_membership`, `account`, `auth_identity`, `authorization_grant`                                         |
| Academics and schedules   | `academic_session`, `course`, `section`, `section_membership`, `schedule_block`, `section_meeting`, `schedule_template`, `schedule_slot`, `calendar_day` |
| Places and services       | `location`, `destination`                                                                                                                                |
| Integrations              | `integration`, `external_reference`, `sync_run`                                                                                                          |
| Policy and authorization  | `policy_rule`, `scheduled_authorization`, `policy_evaluation`, `policy_evaluation_result`, `pass_override`                                               |
| Movement                  | `pass`, `pass_event`, `destination_reservation`, `queue_entry`                                                                                           |
| Incidents and observation | `operational_incident`, `incident_affected_pass`, `incident_presence_report`                                                                             |
| Infrastructure            | `audit_event`, `outbox_event`, `idempotency_record`                                                                                                      |

Important invariants are database-enforced: tenant-consistent composite references, valid ranges,
one active pass per student, one active reservation and queue entry per pass, one active incident
per school, immutable event sequence uniqueness, and conflict-free external mappings. Foreign keys
preserve history by default; there are no cascading deletes or generic soft-delete columns.

`organization_membership` and `section_membership` have UUIDv7 primary identities. Their semantic
keys remain unique (`tenant + organization + person + affiliation` and
`tenant + section + person + role` respectively). Stable membership identities allow a future
external enrollment record to reference a canonical membership without treating its mutable
relationship fields as identity.

The following schedule-facing entities are school-local: sections, locations, schedule blocks,
schedule templates, section meetings, schedule slots, calendar days, and destinations. Composite
uniqueness and foreign keys enforce the same tenant and organization for location parentage,
section/meeting/block/location relationships, template/slot/block relationships, calendar-day
templates, and destination locations. `section_meeting` and `schedule_slot` store their authoritative
`organization_id` explicitly. Migration 002 backfills it from section and template respectively and
fails rather than normalizing contradictory preexisting cross-school data.

Resolver access is supported by an index on `section_membership (tenant_id, person_id)` and an
index on `section_meeting (tenant_id, organization_id, section_id)`. Existing unique indexes already
cover calendar-day lookup by tenant/school/date and slot lookup by tenant/template, so no redundant
indexes were added.

Locations are physical hierarchy nodes. Destinations are services that can accept movements.
Sections meet in logical schedule blocks; templates give those blocks local wall-clock slots for a
specific calendar day. No stored column claims a person's inferred current location.

## Identity and secure sessions (migration 003)

Migration 003 adds tenant slugs (backfilled from existing ids, unique,
lowercase shape), identity providers (closed status/scopes/auth-method
enums, revision-guarded), provider-linked identities keyed by
`(issuer, subject)`, opaque sessions (token/CSRF digests, bigint revision,
idle/absolute expiry, revocation with reason), one-time operator grants
(digest-only, short lifetimes, atomic consumption on read), single setup
drafts per grant, and one-time OIDC transactions (state/binding digests,
encrypted PKCE secrets, purpose CHECKs, composite tenant/provider keys so a
transaction cannot pair a tenant with another tenant's provider). Expiry
columns carry `expires_at > created_at` CHECKs; session and grant digests
carry uniqueness indexes. Temporal values cross the boundary as text with a
UTC-pinned session for deterministic rendering.
