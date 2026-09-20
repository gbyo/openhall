# ADR 0008: API and OpenAPI contracts

Status: accepted.

Fastify 5 routes use TypeBox schemas as the single validation, response, and OpenAPI 3.1 source.
Operations have stable IDs, errors use RFC 9457-style Problem Details with application codes, and
database rows are never response types. Large collections will use cursors rather than offsets.
