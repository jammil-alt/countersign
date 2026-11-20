-- PLATFORM_QA SEC-2 (docs/plan.md §1.157): an operator session saw every person's second factors,
-- recovery code hashes and Claude and phone approvals, including people of clients that operator
-- doesn't serve (invariant 1). Now an operator session sees a person's rows only when that person
-- belongs to a client the session serves; membership's own row-level security decides which
-- memberships the session can see. The person signing in still sees only their own rows.
-- DECISION: policies only, no table change, so the previous Worker keeps working. Its one operator
-- path to these tables, the second-factor reset (`opsSecondFactorReset`), already requires that
-- membership before it reads or deletes anything; every other path reads as the person (withUser).
DROP POLICY own_or_operator ON user_factor;
--> statement-breakpoint
CREATE POLICY own_or_serving_operator ON user_factor FOR ALL TO PUBLIC
  USING (user_id = app_user_id() OR (app_is_operator() AND EXISTS (
    SELECT 1 FROM membership m
    WHERE m.user_id = user_factor.user_id AND m.tenant_id = any(app_tenant_ids()))))
  WITH CHECK (user_id = app_user_id() OR (app_is_operator() AND EXISTS (
    SELECT 1 FROM membership m
    WHERE m.user_id = user_factor.user_id AND m.tenant_id = any(app_tenant_ids()))));
--> statement-breakpoint
DROP POLICY own_or_operator ON user_recovery_code;
--> statement-breakpoint
CREATE POLICY own_or_serving_operator ON user_recovery_code FOR ALL TO PUBLIC
  USING (user_id = app_user_id() OR (app_is_operator() AND EXISTS (
    SELECT 1 FROM membership m
    WHERE m.user_id = user_recovery_code.user_id AND m.tenant_id = any(app_tenant_ids()))))
  WITH CHECK (user_id = app_user_id() OR (app_is_operator() AND EXISTS (
    SELECT 1 FROM membership m
    WHERE m.user_id = user_recovery_code.user_id AND m.tenant_id = any(app_tenant_ids()))));
--> statement-breakpoint
DROP POLICY own_or_operator ON mcp_session_approval;
--> statement-breakpoint
CREATE POLICY own_or_serving_operator ON mcp_session_approval FOR ALL TO PUBLIC
  USING (user_id = app_user_id() OR (app_is_operator() AND EXISTS (
    SELECT 1 FROM membership m
    WHERE m.user_id = mcp_session_approval.user_id AND m.tenant_id = any(app_tenant_ids()))))
  WITH CHECK (user_id = app_user_id() OR (app_is_operator() AND EXISTS (
    SELECT 1 FROM membership m
    WHERE m.user_id = mcp_session_approval.user_id AND m.tenant_id = any(app_tenant_ids()))));
--> statement-breakpoint
DROP POLICY own_or_operator ON sign_in_approval;
--> statement-breakpoint
CREATE POLICY own_or_serving_operator ON sign_in_approval FOR ALL TO PUBLIC
  USING (user_id = app_user_id() OR (app_is_operator() AND EXISTS (
    SELECT 1 FROM membership m
    WHERE m.user_id = sign_in_approval.user_id AND m.tenant_id = any(app_tenant_ids()))))
  WITH CHECK (user_id = app_user_id() OR (app_is_operator() AND EXISTS (
    SELECT 1 FROM membership m
    WHERE m.user_id = sign_in_approval.user_id AND m.tenant_id = any(app_tenant_ids()))));
