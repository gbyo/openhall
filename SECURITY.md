# Security policy

OpenHall is not yet production-ready. Do not deploy it with real student data until
authorization enforcement, workflow policy, and security review milestones are complete.
OIDC login, opaque session management, CSRF/origin protection, operator bootstrap,
break-glass recovery, and deny-by-default relationship/capability authorization with
concealed user school context are implemented (see ADR 0012, ADR 0013, and ADR 0014).

Report suspected vulnerabilities privately to the maintainers rather than opening a public issue.
Include affected versions, impact, reproduction steps, and any known mitigations. Do not include
real student or staff data.

## Security properties

- A tenant is a hard data and authorization boundary; all normal repository access requires tenant context.
- Login is OIDC Authorization Code + PKCE (S256); canonical identity is `(issuer, subject)` and email is never a lookup key.
- Sessions are opaque server-side records (digests only); bearer cookies are `HttpOnly`, `SameSite=Lax`, and `__Host-` + `Secure` in production.
- SPA mutations require a per-session CSRF token plus an exact `Origin` or same-origin `Referer`; OIDC redirects rely on transaction protections instead.
- Operator bootstrap/recovery grants are one-time digested bearer tokens over strict rate limits; provider failures never leak raw OAuth payloads.
- Rate limiting is abuse resistance only; 429 responses stay distinguishable from 500 failures and never carry secrets.
- Authorization defaults to deny and operates on an abstract principal, never provider-specific claims.
- Expected schedule placement, pass movement state, and human presence observations remain distinct.
- Secrets, cookies, authorization headers, tokens, request bodies, and sensitive student details are not logged.
- Public errors use sanitized Problem Details; SQL errors and stack traces are not returned.
- Production configuration requires explicit URLs, database credentials, and a strong application secret.
- Forwarded headers are ignored unless trusted-proxy handling is explicitly enabled.
- Integration secrets are modeled as ciphertext plus a key identifier; plaintext persistence is not supported.
- Policy JSON is data interpreted by typed evaluators; administrator-supplied code, SQL, and scripts are forbidden.
- Audit data and movement history are separate, privacy-minimized records.

RLS is intentionally deferred: enabling it before every authenticated transaction can reliably set
tenant session context would create false confidence. Composite foreign keys and tenant-scoped
application access are the current defense; RLS is a planned defense-in-depth layer.
