# ADR 0004: Dependency boundaries

Status: accepted.

Domain is pure. Application depends on domain and defines ports. Contracts define public JSON
shapes. Database and API are outward adapters; the API is the composition root. The web shell is a
separate HTTP client. An automated import test prevents inward layers from acquiring framework,
database, UI, or vendor dependencies.
