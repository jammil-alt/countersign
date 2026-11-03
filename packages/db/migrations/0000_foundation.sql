-- Foundation (docs/plan.md §1.2 "IDs", "DB roles and RLS", "Immutability"): extensions, the uuid v7
-- default, the cs_runtime role, the session settings row-level security reads, and the immutability
-- trigger function. Hand-written: drizzle-kit cannot express any of it.

-- On Neon cs_owner may create these; locally and in CI scripts/setup-postgres.sh already has.
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint

-- RFC 9562 uuid v7: 48-bit Unix milliseconds, version and variant bits, random rest. Postgres 16
-- has no built-in v7. The random bytes come from gen_random_uuid() (core), so no extension is needed.
CREATE OR REPLACE FUNCTION uuid_generate_v7() RETURNS uuid
LANGUAGE plpgsql VOLATILE PARALLEL SAFE AS $$
DECLARE
  bytes bytea := uuid_send(gen_random_uuid());
  ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000);
BEGIN
  bytes := overlay(bytes PLACING substring(int8send(ms) FROM 3) FROM 1 FOR 6);
  bytes := set_byte(bytes, 6, (get_byte(bytes, 6) & 15) | 112);
  bytes := set_byte(bytes, 8, (get_byte(bytes, 8) & 63) | 128);
  RETURN encode(bytes, 'hex')::uuid;
END
$$;
--> statement-breakpoint

-- cs_runtime holds every runtime grant; cs_worker (the Worker's login) is a member of it and nothing
-- else. The bootstrap workflow may have made it already. Roles are cluster-wide, so two databases
-- migrating at once (parallel test files) can race to create it: the loser just carries on.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cs_runtime') THEN
    CREATE ROLE cs_runtime NOLOGIN;
  END IF;
EXCEPTION
  WHEN duplicate_object OR unique_violation THEN NULL;
END
$$;
--> statement-breakpoint

-- The settings withTenant() / withTenants() / withOperator() put on each transaction
-- (set_config(…, true): transaction-local, so a pooled connection carries nothing over).
-- Unset or empty means "no clients": every tenant table then reads as empty and refuses writes.
CREATE OR REPLACE FUNCTION app_tenant_ids() RETURNS uuid[]
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT coalesce(nullif(current_setting('app.tenant_ids', true), '')::uuid[], '{}'::uuid[])
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_is_operator() RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT coalesce(current_setting('app.operator', true), '') = 'on'
$$;
--> statement-breakpoint
-- Set only while signing in, so a user's own memberships can be read before any client is chosen.
CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;
--> statement-breakpoint

-- Immutable history (CLAUDE.md invariant 3). Attached with the columns that may still change as
-- trigger arguments: `forbid_update_except('status')`. Any other change, and any DELETE, raises.
-- (A trigger function takes its arguments through TG_ARGV, not a variadic parameter.)
CREATE OR REPLACE FUNCTION forbid_update_except() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed text[] := coalesce(TG_ARGV::text[], '{}'::text[]);
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed) THEN
    RAISE EXCEPTION '% rows are immutable; only % may change', TG_TABLE_NAME,
      CASE WHEN cardinality(allowed) = 0 THEN 'nothing' ELSE array_to_string(allowed, ', ') END
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
