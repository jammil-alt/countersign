#!/usr/bin/env bash
# Prepares a plain Postgres (CI's runner, or your own) the way Neon is set up, so database tests
# run locally at full speed but against the same roles as production. Pattern from Plenary Labs.
#
# Roles (docs/plan.md §1.2):
#   neon_superuser  Neon's role for everything made in its console/API. An empty stand-in here,
#                   so the privilege test "cs_worker is not a member" is a real assertion.
#   cs_owner        Owns the database, runs migrations and the seed. CREATEROLE and BYPASSRLS,
#                   like Neon's owner, but not a superuser.
#   cs_runtime      NOLOGIN, holds every runtime grant. Created by the first migration.
#   cs_worker       The Worker's login role: member of cs_runtime only, no BYPASSRLS. Created by
#                   packages/db/scripts/provision-worker-role.mjs, the same script used on Neon.
#
# Usage: PGHOST=… PGPORT=… PGUSER=postgres PGPASSWORD=… scripts/setup-postgres.sh
# Locally, set CS_OWNER_PASSWORD / CS_WORKER_PASSWORD for fixed passwords (docs/local-development.md);
# CI leaves them unset and gets random ones. Safe to run again: it creates what is missing, resets
# the two passwords, migrates and seeds (both idempotent). Set CS_SEED=0 to skip the seed.
# Prints the cs_owner URL on stdout; everything else goes to stderr.

set -euo pipefail

: "${PGHOST:?}" "${PGPORT:?}" "${PGUSER:?}" "${PGPASSWORD:?}"
owner_password=${CS_OWNER_PASSWORD:-$(openssl rand -hex 24)}

# The test helper (packages/db/src/testing.ts) may have made neon_superuser and cs_owner already, and
# docker-compose.yml creates the countersign database itself, so each step looks before it creates.
psql -v ON_ERROR_STOP=1 -q -v pw="$owner_password" >&2 <<'SQL'
SELECT 'CREATE ROLE neon_superuser NOLOGIN'
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'neon_superuser') \gexec
SELECT 'CREATE ROLE cs_owner'
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cs_owner') \gexec
SELECT format('ALTER ROLE cs_owner LOGIN PASSWORD %L CREATEROLE BYPASSRLS', :'pw') \gexec
SELECT 'CREATE DATABASE countersign OWNER cs_owner'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'countersign') \gexec
ALTER DATABASE countersign OWNER TO cs_owner;
SQL
psql -v ON_ERROR_STOP=1 -q -d countersign >&2 <<SQL
SET client_min_messages = warning;
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

if [ "${CS_SEED:-1}" = 1 ]; then
  DIRECT_DATABASE_URL="$owner_url" pnpm --filter @countersign/db run --if-present db:seed >&2
fi

printf '%s' "$owner_url"
