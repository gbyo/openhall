#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

temporary_file="$(mktemp)"
trap 'rm -f "$temporary_file"' EXIT
pnpm --filter @openhall/db exec kysely-codegen --dialect postgres --url "$DATABASE_URL" --out-file "$temporary_file"
diff -u packages/db/src/database.generated.ts "$temporary_file"
