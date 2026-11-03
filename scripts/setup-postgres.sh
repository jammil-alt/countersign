#!/usr/bin/env bash
# Prepares a plain Postgres (CI's runner, or your own) the way Neon is set up, so database tests
# run locally at full speed but against the same roles as production. Pattern from Plenary Labs.
#
# Roles (docs/plan.md §1.2):
#   neon_superuser  Neon's role for everything made in its console/API. An empty stand-in here,
#                   so the privilege test "cs_worker is not a member" is a real assertion.
#   cs_owner        Owns the database, runs migrations and the seed. CREATEROLE and BYPASSRLS,
#                   like Neon's owner, but not a superuser.
#   cs_runtime      NOLOGIN, holds every runtime grant. Created by the first migration (M0).
#   cs_worker       The Worker's login role: member of cs_runtime only, no BYPASSRLS. Created by
#                   packages/db/scripts/provision-worker-role.mjs (M0), the same script used on Neon.
#
# Usage: PGHOST=… PGPORT=… PGUSER=postgres PGPASSWORD=… scripts/setup-postgres.sh
# Locally, set CS_OWNER_PASSWORD / CS_WORKER_PASSWORD for fixed passwords (docs/local-development.md);
# CI leaves them unset and gets random ones.
# Prints the cs_owner URL on stdout; everything else goes to stderr.

set -euo pipefail

: "${PGHOST:?}" "${PGPORT:?}" "${PGUSER:?}" "${PGPASSWORD:?}"
owner_password=${CS_OWNER_PASSWORD:-$(openssl rand -hex 24)}

psql -v ON_ERROR_STOP=1 -q >&2 <<SQL
CREATE ROLE neon_superuser NOLOGIN;
CREATE ROLE cs_owner LOGIN PASSWORD '${owner_password}' CREATEROLE BYPASSRLS;
CREATE DATABASE countersign OWNER cs_owner;
SQL
psql -v ON_ERROR_STOP=1 -q -d countersign >&2 <<SQL
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SQL

owner_url="postgres://cs_owner:${owner_password}@${PGHOST}:${PGPORT}/countersign"

DIRECT_DATABASE_URL="$owner_url" pnpm --filter @countersign/db run --if-present db:migrate >&2

if [ -f packages/db/scripts/provision-worker-role.mjs ]; then
  OWNER_URL="$owner_url" WORKER_PASSWORD=${CS_WORKER_PASSWORD:-$(openssl rand -hex 24)} \
    node packages/db/scripts/provision-worker-role.mjs > /dev/null
fi

printf '%s' "$owner_url"
