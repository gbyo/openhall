# Data model

The foundation migration creates 36 domain tables plus Kysely's migration metadata. UUID primary
keys use PostgreSQL 18 `uuidv7()` defaults.

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

Locations are physical hierarchy nodes. Destinations are services that can accept movements.
Sections meet in logical schedule blocks; templates give those blocks local wall-clock slots for a
specific calendar day. No stored column claims a person's inferred current location.
