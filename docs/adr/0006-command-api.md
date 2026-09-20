# ADR 0006: Command API and pass lifecycle

Status: accepted.

The API will expose intent such as approve, depart, arrive, return, and complete rather than a
client-controlled state field. The pass row is authoritative current state while append-only pass
events preserve movement history. Closed state types and optimistic revisions will guard future
transitions; full workflow implementation is deferred.
