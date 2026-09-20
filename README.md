# OpenHall

OpenHall is an open-source, self-hosted school presence and movement platform. This repository is
currently an **early development release and is not production-ready**. School-local expected
placement, OIDC login with opaque sessions, operator bootstrap/recovery, relationship-aware
authorization with user school context, and reliable pass request intake with idempotent commands
are implemented; movement policy and execution are intentionally incomplete (see ADR 0015).

First run creates the installation through an operator bootstrap ceremony: issue a bootstrap
grant with the operator CLI, prepare the setup draft, and complete OIDC sign-in as the founding
administrator. See [docs/architecture.md](docs/architecture.md) and
[docs/adr/0013-operator-bootstrap-recovery.md](docs/adr/0013-operator-bootstrap-recovery.md).

The architecture distinguishes three facts that must never be conflated:

- expected placement, derived from academics and the school-local schedule;
- actual movement, represented by explicit pass events; and
- observed presence, represented by explicit human observations.

Policy decisions will later consume those facts but must not conflate them.

## Requirements

- Node.js 24 LTS and pnpm 11
- PostgreSQL 18
- Docker with Compose (optional, recommended for evaluation)

## Local setup

```sh
cp .env.example .env
pnpm install
docker compose up -d postgres
set -a && source .env && set +a
pnpm db:migrate
pnpm dev
```

The API listens on port 3000 and Vite on port 5173. Vite proxies `/api` and `/health` to Fastify.
The production image serves the built web shell from the API origin.

For the containerized evaluation path, run `docker compose up --build`. Compose runs migrations as
an explicit one-shot job before it starts the application. Advanced deployments can run
`node node_modules/@openhall/db/dist/cli.js` from the application image as a separate release step.

The first run needs an operator bootstrap grant (raw token on stdout, shown once, never logged):

```sh
docker compose exec app node dist/operator-cli.js operator bootstrap issue
docker compose exec app node dist/operator-cli.js operator recovery issue --tenant <slug> --account <uuid>
```

Open the setup page, paste the bootstrap token when asked, and complete OIDC sign-in as the
founding administrator. Recovery grants are break-glass only: they mint a 30-minute session for
an existing `system_admin` account.

## Verification

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm db:types:check
pnpm openapi:check
```

See [docs/architecture.md](docs/architecture.md), [docs/data-model.md](docs/data-model.md), and
[SECURITY.md](SECURITY.md) before contributing domain or infrastructure code.

## Reverse proxies

OpenHall does not depend on a particular proxy or tunnel. Caddy, nginx, Traefik, Cloudflare Tunnel,
or an ordinary HTTPS reverse proxy may terminate TLS and forward to port 3000. Keep
`TRUST_PROXY=false` unless every direct route to OpenHall is restricted to a trusted proxy. When it
is enabled, configure the network so clients cannot connect directly and forge forwarded headers.
Set `APP_BASE_URL` to the exact public HTTPS origin. Same-origin deployment is the default.

## License

Apache-2.0. See [LICENSE](LICENSE).
