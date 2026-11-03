-- Track B foundation fixes (docs/plan.md §1.5). Each change keeps the previous Worker working:
-- - inbox_item.run_received_at: when the run took a resolved item's resolution; the cron re-sends
--   the event of a resolved item whose run has not taken it (durable approval resume).
-- - step_run (run_id, node_id) unique: the step log upserts, so a retried step never writes two
--   rows. No step_run rows exist outside local databases yet, so there are no duplicates to merge.
-- - agent.test_copy: a template's test copy in the Sandbox client, at most one per template.
ALTER TABLE "agent" ADD COLUMN "test_copy" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "inbox_item" ADD COLUMN "run_received_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_test_copy_key" ON "agent" USING btree ("tenant_id","template_id") WHERE "agent"."test_copy";--> statement-breakpoint
CREATE INDEX "inbox_item_undelivered_idx" ON "inbox_item" USING btree ("tenant_id","resolved_at") WHERE "inbox_item"."status" = 'resolved' and "inbox_item"."run_id" is not null and "inbox_item"."run_received_at" is null;--> statement-breakpoint
ALTER TABLE "step_run" ADD CONSTRAINT "step_run_run_node_key" UNIQUE("run_id","node_id");--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_test_copy_check" CHECK (not "agent"."test_copy" or ("agent"."kind" = 'client' and "agent"."template_id" is not null));