# ADR 0003: Tenant and organization hierarchy

Status: accepted.

A tenant is the security boundary and may contain a district/school organization tree. Every
tenant-owned table repeats `tenant_id`; composite foreign keys enforce matching tenants. This small
intentional redundancy makes isolation auditable and prepares for later RLS without pretending RLS
is safe before authenticated session context exists.
