# ADR 0007: Durable PostgreSQL outbox

Status: accepted.

State changes and domain-event records share a PostgreSQL transaction. Consumers can retry from
the durable outbox; LISTEN/NOTIFY may only wake workers. Redis and Kafka add operational burden and
are not required for the expected Phase 1 scale or correctness model.
