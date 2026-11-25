CREATE TABLE "custom_field" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid,
	"record_type" text NOT NULL,
	"name" text NOT NULL,
	"label" text NOT NULL,
	"type" text NOT NULL,
	"spec" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"about" text DEFAULT '' NOT NULL,
	"hidden_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_field_name_key" UNIQUE NULLS NOT DISTINCT("tenant_id","record_type","name"),
	CONSTRAINT "custom_field_id_tenant_key" UNIQUE("id","tenant_id"),
	CONSTRAINT "custom_field_type_check" CHECK ("custom_field"."type" in ('text', 'number', 'money', 'date', 'yes_no', 'list', 'group', 'record')),
	CONSTRAINT "custom_field_name_check" CHECK ("custom_field"."name" ~ '^[a-z][a-zA-Z0-9_]{0,39}$'),
	CONSTRAINT "custom_field_record_type_check" CHECK ("custom_field"."record_type" ~ '^[a-z][a-z0-9_]{0,39}$')
);
--> statement-breakpoint
CREATE TABLE "record_write" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"record_type" text NOT NULL,
	"record_id" uuid NOT NULL,
	"op" text NOT NULL,
	"key" text NOT NULL,
	"agent_version_id" uuid,
	"run_id" uuid,
	"step_run_id" uuid,
	"user_id" uuid,
	"before" jsonb,
	"after" jsonb NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "record_write_key" UNIQUE("tenant_id","key"),
	CONSTRAINT "record_write_op_check" CHECK ("record_write"."op" in ('create', 'update')),
	CONSTRAINT "record_write_by_check" CHECK (num_nonnulls("record_write"."agent_version_id", "record_write"."user_id") <= 1)
);
--> statement-breakpoint
ALTER TABLE "custom_field" ADD CONSTRAINT "custom_field_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field" ADD CONSTRAINT "custom_field_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_write" ADD CONSTRAINT "record_write_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_write" ADD CONSTRAINT "record_write_agent_version_id_agent_version_id_fk" FOREIGN KEY ("agent_version_id") REFERENCES "public"."agent_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_write" ADD CONSTRAINT "record_write_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_write" ADD CONSTRAINT "record_write_run_fk" FOREIGN KEY ("run_id","tenant_id") REFERENCES "public"."run"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_write" ADD CONSTRAINT "record_write_step_run_fk" FOREIGN KEY ("step_run_id","tenant_id") REFERENCES "public"."step_run"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "custom_field_record_type_idx" ON "custom_field" USING btree ("tenant_id","record_type");--> statement-breakpoint
CREATE INDEX "record_write_record_idx" ON "record_write" USING btree ("tenant_id","record_type","record_id");--> statement-breakpoint
-- Custom fields are defined, changed and hidden (hidden_at), never deleted: removing one keeps
-- the values records hold (step model §10f).
GRANT SELECT, INSERT, UPDATE ON custom_field TO cs_runtime;
--> statement-breakpoint
-- The standard writes to records are a log, as model_call: no UPDATE or DELETE grant, and a
-- trigger refuses both for everyone.
GRANT SELECT, INSERT ON record_write TO cs_runtime;
--> statement-breakpoint
CREATE TRIGGER record_write_insert_only BEFORE UPDATE OR DELETE ON record_write
  FOR EACH ROW EXECUTE FUNCTION forbid_update_except();
--> statement-breakpoint
ALTER TABLE custom_field ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE custom_field FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- A client's own fields in its scope; shared fields (no client) only to operator sessions, as
-- templates and shared skills (0002). A run reads the shared ones as the operator's catalogue.
CREATE POLICY tenant_isolation ON custom_field FOR ALL TO PUBLIC
  USING (tenant_id = any(app_tenant_ids()) OR (tenant_id IS NULL AND app_is_operator()))
  WITH CHECK (tenant_id = any(app_tenant_ids()) OR (tenant_id IS NULL AND app_is_operator()));
--> statement-breakpoint
ALTER TABLE record_write ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE record_write FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON record_write FOR ALL TO PUBLIC
  USING (tenant_id = any(app_tenant_ids()))
  WITH CHECK (tenant_id = any(app_tenant_ids()));
