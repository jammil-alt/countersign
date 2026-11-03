-- Runtime grants, row-level security and immutability for the platform tables (docs/plan.md §1.2
-- "DB roles and RLS", "Global tables", "Immutability"). Hand-written: drizzle-kit cannot express it.
-- A later migration that adds a table adds its grants, and its RLS if it has a tenant_id, itself;
-- packages/db/src/migrations.test.ts fails on a tenant table without forced RLS.

GRANT USAGE ON SCHEMA public TO cs_runtime;
--> statement-breakpoint

-- Global tables: no tenant_id and no RLS. Read by packages/auth at sign-in and to build sessions;
-- the operator's back office creates clients.
GRANT SELECT, INSERT, UPDATE ON tenant, app_user TO cs_runtime;
--> statement-breakpoint

-- Immutable or append-only tables: no DELETE for the runtime (the triggers below refuse it anyway).
GRANT SELECT, INSERT, UPDATE ON agent_version, skill_version, raw_record, event TO cs_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON connection_change, agent_change TO cs_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON
  membership, connection, external_action, tenant_pack, skill, agent, run, step_run, tool_call,
  thread, message, inbox_item, memory_note, usage_daily
TO cs_runtime;
--> statement-breakpoint

-- The RLS loop. Every tenant table: enable + force (so the owning role is held to it too unless it
-- has BYPASSRLS), and one policy for every command. Rows of templates and shared skills have
-- tenant_id null and are visible only in operator sessions (ARCHITECTURE §4).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'membership', 'connection', 'connection_change', 'raw_record', 'external_action', 'tenant_pack',
    'run', 'step_run', 'tool_call', 'event', 'thread', 'message', 'inbox_item', 'memory_note',
    'usage_daily'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO PUBLIC '
      'USING (tenant_id = any(app_tenant_ids())) '
      'WITH CHECK (tenant_id = any(app_tenant_ids()))', t);
  END LOOP;

  FOREACH t IN ARRAY ARRAY['skill', 'skill_version', 'agent', 'agent_version', 'agent_change'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO PUBLIC '
      'USING (tenant_id = any(app_tenant_ids()) OR (tenant_id IS NULL AND app_is_operator())) '
      'WITH CHECK (tenant_id = any(app_tenant_ids()) OR (tenant_id IS NULL AND app_is_operator()))',
      t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- DECISION: sign-in must learn which clients a user belongs to before any client is chosen, so a
-- transaction that names the user (app.user_id, set only by the sign-in path) may read that
-- user's own memberships, and nothing else of them. Policies combine with OR.
CREATE POLICY own_memberships ON membership FOR SELECT TO PUBLIC USING (user_id = app_user_id());
--> statement-breakpoint

-- Immutable history (CLAUDE.md invariant 3): only the named columns may change; DELETE is refused.
CREATE TRIGGER agent_version_immutable BEFORE UPDATE OR DELETE ON agent_version
  FOR EACH ROW EXECUTE FUNCTION forbid_update_except('status');
--> statement-breakpoint
CREATE TRIGGER skill_version_immutable BEFORE UPDATE OR DELETE ON skill_version
  FOR EACH ROW EXECUTE FUNCTION forbid_update_except('status');
--> statement-breakpoint
CREATE TRIGGER raw_record_immutable BEFORE UPDATE OR DELETE ON raw_record
  FOR EACH ROW EXECUTE FUNCTION forbid_update_except('is_deleted');
--> statement-breakpoint
-- The logs of operational changes are append-only too.
CREATE TRIGGER connection_change_append_only BEFORE UPDATE OR DELETE ON connection_change
  FOR EACH ROW EXECUTE FUNCTION forbid_update_except();
--> statement-breakpoint
CREATE TRIGGER agent_change_append_only BEFORE UPDATE OR DELETE ON agent_change
  FOR EACH ROW EXECUTE FUNCTION forbid_update_except();
