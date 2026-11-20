-- PLATFORM_QA SEC-6: every operator session read every audit row with no client (0017's
-- `audit_read`), and those include client people's sign-ins, second-factor events and refusals,
-- with their email, IP and user agent. Invariant 1: an operator session now sees a no-client row
-- only when the row has no actor, the actor is the session's own user, the actor belongs to a
-- client the session serves, or the actor is in no client at all (an operator, or someone not yet
-- in any client). Rows with a client keep their rule; inserts (`audit_write`) and the append-only
-- trigger are untouched.
-- DECISION: policy and one helper only, no table change, so the previous Worker keeps working.
-- DECISION: an operator scope over no clients (`withOperator(db, [])`) keeps reading every no-client
-- row. Only server code opens it: a person's back-office session always names at least one client
-- (packages/auth `tenantScope`). The second-factor and Claude-approval rate limits count a person's
-- tries there (`claimSend`, `claimAttempt`, `checkConfirm`), in this Worker and the previous one;
-- hiding the rows from it would quietly turn those limits off.

-- Membership's row-level security hides the clients this session doesn't serve, so "is this person
-- in some other client?" can't be asked in the policy itself. This answers only that boolean, for
-- client roles (an `operator` membership is not a client's person). SECURITY DEFINER, so it runs as
-- the migrating owner, which bypasses row-level security; `row_security = off` makes it fail with an
-- error rather than answer from a filtered view if that is ever not so.
CREATE FUNCTION app_user_in_client_outside(p_user_id uuid, p_tenant_ids uuid[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.membership m
    WHERE m.user_id = p_user_id
      AND m.role <> 'operator'
      AND NOT (m.tenant_id = any(coalesce(p_tenant_ids, '{}'::uuid[]))))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_user_in_client_outside(uuid, uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_user_in_client_outside(uuid, uuid[]) TO cs_runtime;
--> statement-breakpoint
DROP POLICY audit_read ON audit_event;
--> statement-breakpoint
CREATE POLICY audit_read ON audit_event FOR SELECT TO PUBLIC
  USING (tenant_id = any(app_tenant_ids()) OR (tenant_id IS NULL AND app_is_operator() AND (
    cardinality(app_tenant_ids()) = 0
    OR actor_user_id IS NULL
    OR actor_user_id = app_user_id()
    OR EXISTS (
      SELECT 1 FROM membership m
      WHERE m.user_id = audit_event.actor_user_id AND m.tenant_id = any(app_tenant_ids()))
    OR NOT app_user_in_client_outside(actor_user_id, app_tenant_ids()))));
