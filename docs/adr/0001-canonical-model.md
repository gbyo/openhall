# ADR 0001: Canonical model and external adapters

Status: accepted.

OpenHall owns a vendor-neutral internal model. OneRoster, PowerSchool, Clever, Google, Microsoft,
and CSV implementations map through integration adapters and `external_reference`; provider IDs
never become entity identity or domain columns. This permits multiple providers and controlled
mapping changes without rewriting core behavior.
