# ADR 0009: Privacy and data minimization

Status: accepted.

OpenHall stores only attributes needed by defined movement and safety workflows. Demographics,
grades, addresses, health narratives, and risk scoring are excluded. Metadata is purpose-specific,
sanitized, and never an escape hatch for known relational data. Presence observations never arise
from schedule inference.
