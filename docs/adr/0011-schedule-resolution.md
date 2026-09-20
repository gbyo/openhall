# ADR 0011: School-local expected-placement resolution

Status: accepted.

## Context

Pass policy will eventually need a trustworthy answer to “where does the configured academic
schedule expect this person to be at this instant?” That answer is neither evidence of physical
presence nor a record of movement. It must remain deterministic across tenants, schools, time
zones, bell boundaries, imports, and contradictory configuration.

## Decision

Expected placement is resolved for an explicit tenant, school organization, person, and
`Temporal.Instant`. The supplied organization must be a school with a usable IANA time zone. The
instant is converted to that school's `Temporal.PlainDate` and `Temporal.PlainTime`; a school is
never inferred when a person belongs to multiple organizations.

The school's `calendar_day` row is authoritative for the local date. Missing data produces
`calendar_not_configured`; the resolver never silently assumes a Regular template.
`non_instructional` and `closed` days produce an explicit non-instructional result. An
instructional day uses exactly its referenced template.

Slots use half-open `[start, end)` wall-time intervals. A bell at the exact start is included and a
bell at the exact end is excluded. Membership and meeting date ranges are inclusive, with null
bounds open-ended, and are compared to the school-local date. A meeting with null `cycle_code`
applies to every cycle; a non-null meeting code applies only when it equals the calendar day's
non-null code.

Overlapping slots remain allowed. The resolver considers every active slot and every applicable
student membership/meeting combination. One applicable combination resolves; multiple applicable
combinations are `ambiguous`. Multiple overlapping unassigned blocks are also ambiguous. Row order
and slot ordinal never break ties. One unassigned active block returns `block_only`, including the
block kind, without fabricating a section or room. A meeting without a location resolves with
`expectedLocation: null`. Every date-applicable teacher membership is returned.

Slot boundaries are constructed explicitly from local date, wall time, and IANA zone using
Temporal with `disambiguation: 'reject'`. Nonexistent and ambiguous DST wall times are configuration
errors, not silently shifted instants. Results expose exact `beginsAt`, `endsAt`,
`elapsedSeconds`, and `remainingSeconds`; later policy may compare those seconds to configured
durations.

At the PostgreSQL boundary, `date`, `time`, `timestamp`, and `timestamptz` values use pool-local
text parsers. Explicit helpers convert those database representations to Temporal types. Scheduling
domain and application code never receives a JavaScript `Date`, and no process-wide UTC setting is
used to reinterpret school dates.

## Result model

The resolver returns a discriminated union:

- `resolved`: school/calendar/template/slot/block context, section, optional expected location,
  all applicable teachers, absolute boundaries, and elapsed/remaining seconds;
- `block_only`: the same active schedule context without an invented section or location;
- `outside_schedule`;
- `non_instructional_day`;
- `calendar_not_configured`;
- `not_member`;
- `ambiguous`, with privacy-safe IDs explaining competing candidates; or
- `configuration_error`, with a stable machine-readable code.

Ordinary outcomes are values, not exceptions. Infrastructure and programming failures may throw.

## Consequences

The resolver evaluates the configured academic and schedule data presented at query time. It does
not prove historical or current physical presence and does not produce an observed location.
Future pass creation may snapshot a resolved origin so movement history remains meaningful after
roster changes. HTTP exposure is deferred until authenticated session and authorization work is
complete.
