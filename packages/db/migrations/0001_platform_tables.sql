CREATE TABLE "agent" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid,
	"kind" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"role" text,
	"template_id" uuid,
	"linked" boolean DEFAULT true NOT NULL,
	"live_version_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"service_name" text,
	"service_description" text,
	"bindings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approver" text,
	"run_status" text,
	CONSTRAINT "agent_tenant_slug_key" UNIQUE NULLS NOT DISTINCT("tenant_id","slug"),
	CONSTRAINT "agent_id_tenant_key" UNIQUE("id","tenant_id"),
	CONSTRAINT "agent_kind_check" CHECK ("agent"."kind" in ('template', 'client')),
	CONSTRAINT "agent_kind_tenant_check" CHECK (("agent"."kind" = 'template') = ("agent"."tenant_id" is null)),
	CONSTRAINT "agent_status_check" CHECK ("agent"."status" in ('active', 'disabled')),
	CONSTRAINT "agent_approver_check" CHECK ("agent"."approver" is null or "agent"."approver" in ('client_admin', 'operator')),
	CONSTRAINT "agent_run_status_check" CHECK ("agent"."run_status" is null or "agent"."run_status" in ('draft', 'testing', 'active', 'paused', 'retired'))
);
--> statement-breakpoint
CREATE TABLE "agent_change" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid,
	"agent_id" uuid NOT NULL,
	"actor_id" uuid,
	"change" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_version" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid,
	"agent_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"bundle" jsonb NOT NULL,
	"bundle_hash" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"change_note" text,
	"release_note" text,
	"author_type" text NOT NULL,
	"author_id" uuid,
	"parent_version_id" uuid,
	"based_on_template_version_id" uuid,
	"merged_from_version_ids" uuid[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_version_agent_version_key" UNIQUE("agent_id","version"),
	CONSTRAINT "agent_version_id_tenant_key" UNIQUE("id","tenant_id"),
	CONSTRAINT "agent_version_status_check" CHECK ("agent_version"."status" in ('draft', 'live', 'retired')),
	CONSTRAINT "agent_version_author_type_check" CHECK ("agent_version"."author_type" in ('operator', 'builder', 'pack', 'merge', 'promote'))
);
--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"workos_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_user_email_unique" UNIQUE("email"),
	CONSTRAINT "app_user_workos_user_id_unique" UNIQUE("workos_user_id")
);
--> statement-breakpoint
CREATE TABLE "connection" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connector" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"external_account_id" text,
	"credentials_encrypted" jsonb,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"permissions" jsonb DEFAULT '{"read":"auto","create":"approval","update":"approval","delete":"off"}'::jsonb NOT NULL,
	"last_sync_at" timestamp with time zone,
	"sync_cursor" jsonb,
	"connected_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_id_tenant_key" UNIQUE("id","tenant_id"),
	CONSTRAINT "connection_status_check" CHECK ("connection"."status" in ('pending', 'connected', 'disconnected', 'error'))
);
--> statement-breakpoint
CREATE TABLE "connection_change" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"actor_id" uuid,
	"change" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"subject_type" text,
	"subject_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "external_action" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"run_id" uuid,
	"step_run_id" uuid,
	"agent_version_id" uuid,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"inbox_item_id" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"result" jsonb,
	"error" jsonb,
	"before" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"executed_at" timestamp with time zone,
	CONSTRAINT "external_action_idempotency_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "external_action_id_tenant_key" UNIQUE("id","tenant_id"),
	CONSTRAINT "external_action_status_check" CHECK ("external_action"."status" in ('proposed', 'approved', 'rejected', 'executing', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "inbox_item" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"pack" text,
	"agent_id" uuid,
	"subject_type" text,
	"subject_id" uuid,
	"run_id" uuid,
	"assignee_user_id" uuid,
	"assignee_role" text,
	"title" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" jsonb,
	"resolved_by" uuid,
	"due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "inbox_item_id_tenant_key" UNIQUE("id","tenant_id"),
	CONSTRAINT "inbox_item_kind_check" CHECK ("inbox_item"."kind" in ('approval', 'review', 'request', 'extraction_review', 'external_action', 'change_request')),
	CONSTRAINT "inbox_item_status_check" CHECK ("inbox_item"."status" in ('open', 'resolved', 'expired')),
	CONSTRAINT "inbox_item_assignee_role_check" CHECK ("inbox_item"."assignee_role" is null or "inbox_item"."assignee_role" in ('operator', 'client_admin', 'client_user'))
);
--> statement-breakpoint
CREATE TABLE "membership" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id"),
	CONSTRAINT "membership_role_check" CHECK ("membership"."role" in ('operator', 'client_admin', 'client_user'))
);
--> statement-breakpoint
CREATE TABLE "memory_note" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"scope" text DEFAULT 'agent' NOT NULL,
	"note" text NOT NULL,
	"source_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"sender_type" text NOT NULL,
	"sender_id" uuid,
	"agent_version_id" uuid,
	"kind" text DEFAULT 'text' NOT NULL,
	"command" text,
	"body" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"audience" text DEFAULT 'operator' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_id_tenant_key" UNIQUE("id","tenant_id"),
	CONSTRAINT "message_sender_type_check" CHECK ("message"."sender_type" in ('agent', 'user', 'system')),
	CONSTRAINT "message_kind_check" CHECK ("message"."kind" in ('text', 'command', 'result')),
	CONSTRAINT "message_audience_check" CHECK ("message"."audience" in ('client', 'operator'))
);
--> statement-breakpoint
CREATE TABLE "raw_record" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"connector" text NOT NULL,
	"entity_type" text NOT NULL,
	"external_id" text NOT NULL,
	"external_version" text,
	"payload" jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	CONSTRAINT "raw_record_version_key" UNIQUE NULLS NOT DISTINCT("connection_id","entity_type","external_id","external_version")
);
--> statement-breakpoint
CREATE TABLE "run" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"agent_version_id" uuid NOT NULL,
	"workflow_slug" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"mode" text DEFAULT 'live' NOT NULL,
	"trigger" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"cost_usd" numeric(14, 4) DEFAULT '0' NOT NULL,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_id_tenant_key" UNIQUE("id","tenant_id"),
	CONSTRAINT "run_mode_check" CHECK ("run"."mode" in ('live', 'test')),
	CONSTRAINT "run_status_check" CHECK ("run"."status" in ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "skill" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"live_version_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_tenant_slug_key" UNIQUE NULLS NOT DISTINCT("tenant_id","slug"),
	CONSTRAINT "skill_id_tenant_key" UNIQUE("id","tenant_id"),
	CONSTRAINT "skill_status_check" CHECK ("skill"."status" in ('active', 'retired'))
);
--> statement-breakpoint
CREATE TABLE "skill_version" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid,
	"skill_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"definition_hash" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"change_note" text,
	"author_id" uuid,
	"parent_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_version_skill_version_key" UNIQUE("skill_id","version"),
	CONSTRAINT "skill_version_status_check" CHECK ("skill_version"."status" in ('draft', 'live', 'retired'))
);
--> statement-breakpoint
CREATE TABLE "step_run" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"node_type" text NOT NULL,
	"skill_ref" text,
	"agent_version_id" uuid,
	"input" jsonb,
	"output" jsonb,
	"summary" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(14, 4) DEFAULT '0' NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "step_run_id_tenant_key" UNIQUE("id","tenant_id"),
	CONSTRAINT "step_run_status_check" CHECK ("step_run"."status" in ('pending', 'running', 'waiting', 'succeeded', 'failed', 'skipped', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "tenant" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"workos_organization_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_workos_organization_id_unique" UNIQUE("workos_organization_id")
);
--> statement-breakpoint
CREATE TABLE "tenant_pack" (
	"tenant_id" uuid NOT NULL,
	"pack" text NOT NULL,
	"version" text NOT NULL,
	"enabled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_pack_tenant_id_pack_pk" PRIMARY KEY("tenant_id","pack")
);
--> statement-breakpoint
CREATE TABLE "thread" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_type" text,
	"subject_id" uuid,
	"title" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"step_budget" integer DEFAULT 12 NOT NULL,
	"steps_used" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_id_tenant_key" UNIQUE("id","tenant_id"),
	CONSTRAINT "thread_status_check" CHECK ("thread"."status" in ('open', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "tool_call" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"step_run_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"status" text NOT NULL,
	"duration_ms" integer,
	"external_action_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_call_status_check" CHECK ("tool_call"."status" in ('running', 'succeeded', 'failed', 'refused', 'awaiting_approval'))
);
--> statement-breakpoint
CREATE TABLE "usage_daily" (
	"tenant_id" uuid NOT NULL,
	"day" date NOT NULL,
	"agent_id" uuid NOT NULL,
	"runs" integer DEFAULT 0 NOT NULL,
	"steps" integer DEFAULT 0 NOT NULL,
	"documents" integer DEFAULT 0 NOT NULL,
	"external_actions" integer DEFAULT 0 NOT NULL,
	"tokens_in" bigint DEFAULT 0 NOT NULL,
	"tokens_out" bigint DEFAULT 0 NOT NULL,
	"cost_usd" numeric(14, 4) DEFAULT '0' NOT NULL,
	CONSTRAINT "usage_daily_tenant_id_day_agent_id_pk" PRIMARY KEY("tenant_id","day","agent_id")
);
--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_template_id_agent_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."agent"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_live_version_id_agent_version_id_fk" FOREIGN KEY ("live_version_id") REFERENCES "public"."agent_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_change" ADD CONSTRAINT "agent_change_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_change" ADD CONSTRAINT "agent_change_actor_id_app_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_change" ADD CONSTRAINT "agent_change_agent_fk" FOREIGN KEY ("agent_id","tenant_id") REFERENCES "public"."agent"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_change" ADD CONSTRAINT "agent_change_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_version" ADD CONSTRAINT "agent_version_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_version" ADD CONSTRAINT "agent_version_author_id_app_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_version" ADD CONSTRAINT "agent_version_parent_version_id_agent_version_id_fk" FOREIGN KEY ("parent_version_id") REFERENCES "public"."agent_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_version" ADD CONSTRAINT "agent_version_based_on_template_version_id_agent_version_id_fk" FOREIGN KEY ("based_on_template_version_id") REFERENCES "public"."agent_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_version" ADD CONSTRAINT "agent_version_agent_fk" FOREIGN KEY ("agent_id","tenant_id") REFERENCES "public"."agent"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_version" ADD CONSTRAINT "agent_version_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_connected_by_app_user_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_change" ADD CONSTRAINT "connection_change_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_change" ADD CONSTRAINT "connection_change_actor_id_app_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_change" ADD CONSTRAINT "connection_change_connection_fk" FOREIGN KEY ("connection_id","tenant_id") REFERENCES "public"."connection"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_action" ADD CONSTRAINT "external_action_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_action" ADD CONSTRAINT "external_action_agent_version_id_agent_version_id_fk" FOREIGN KEY ("agent_version_id") REFERENCES "public"."agent_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_action" ADD CONSTRAINT "external_action_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_action" ADD CONSTRAINT "external_action_connection_fk" FOREIGN KEY ("connection_id","tenant_id") REFERENCES "public"."connection"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_action" ADD CONSTRAINT "external_action_run_fk" FOREIGN KEY ("run_id","tenant_id") REFERENCES "public"."run"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_action" ADD CONSTRAINT "external_action_step_run_fk" FOREIGN KEY ("step_run_id","tenant_id") REFERENCES "public"."step_run"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_action" ADD CONSTRAINT "external_action_inbox_item_fk" FOREIGN KEY ("inbox_item_id","tenant_id") REFERENCES "public"."inbox_item"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_item" ADD CONSTRAINT "inbox_item_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_item" ADD CONSTRAINT "inbox_item_assignee_user_id_app_user_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_item" ADD CONSTRAINT "inbox_item_resolved_by_app_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_item" ADD CONSTRAINT "inbox_item_agent_fk" FOREIGN KEY ("agent_id","tenant_id") REFERENCES "public"."agent"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_item" ADD CONSTRAINT "inbox_item_run_fk" FOREIGN KEY ("run_id","tenant_id") REFERENCES "public"."run"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_note" ADD CONSTRAINT "memory_note_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_note" ADD CONSTRAINT "memory_note_agent_fk" FOREIGN KEY ("agent_id","tenant_id") REFERENCES "public"."agent"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_note" ADD CONSTRAINT "memory_note_message_fk" FOREIGN KEY ("source_message_id","tenant_id") REFERENCES "public"."message"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_agent_version_id_agent_version_id_fk" FOREIGN KEY ("agent_version_id") REFERENCES "public"."agent_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_thread_fk" FOREIGN KEY ("thread_id","tenant_id") REFERENCES "public"."thread"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_record" ADD CONSTRAINT "raw_record_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_record" ADD CONSTRAINT "raw_record_connection_fk" FOREIGN KEY ("connection_id","tenant_id") REFERENCES "public"."connection"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_agent_fk" FOREIGN KEY ("agent_id","tenant_id") REFERENCES "public"."agent"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_agent_version_fk" FOREIGN KEY ("agent_version_id","tenant_id") REFERENCES "public"."agent_version"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill" ADD CONSTRAINT "skill_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill" ADD CONSTRAINT "skill_live_version_id_skill_version_id_fk" FOREIGN KEY ("live_version_id") REFERENCES "public"."skill_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_version" ADD CONSTRAINT "skill_version_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_version" ADD CONSTRAINT "skill_version_author_id_app_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_version" ADD CONSTRAINT "skill_version_parent_version_id_skill_version_id_fk" FOREIGN KEY ("parent_version_id") REFERENCES "public"."skill_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_version" ADD CONSTRAINT "skill_version_skill_fk" FOREIGN KEY ("skill_id","tenant_id") REFERENCES "public"."skill"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_version" ADD CONSTRAINT "skill_version_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_run" ADD CONSTRAINT "step_run_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_run" ADD CONSTRAINT "step_run_agent_version_id_agent_version_id_fk" FOREIGN KEY ("agent_version_id") REFERENCES "public"."agent_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_run" ADD CONSTRAINT "step_run_run_fk" FOREIGN KEY ("run_id","tenant_id") REFERENCES "public"."run"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_pack" ADD CONSTRAINT "tenant_pack_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call" ADD CONSTRAINT "tool_call_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call" ADD CONSTRAINT "tool_call_step_run_fk" FOREIGN KEY ("step_run_id","tenant_id") REFERENCES "public"."step_run"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call" ADD CONSTRAINT "tool_call_external_action_fk" FOREIGN KEY ("external_action_id","tenant_id") REFERENCES "public"."external_action"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_agent_fk" FOREIGN KEY ("agent_id","tenant_id") REFERENCES "public"."agent"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_template_idx" ON "agent" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "agent_change_agent_idx" ON "agent_change" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_change_tenant_idx" ON "agent_change" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "agent_version_tenant_idx" ON "agent_version" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "connection_tenant_idx" ON "connection" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "connection_change_connection_idx" ON "connection_change" USING btree ("connection_id","created_at");--> statement-breakpoint
CREATE INDEX "connection_change_tenant_idx" ON "connection_change" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "event_tenant_idx" ON "event" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "event_undispatched_idx" ON "event" USING btree ("created_at") WHERE "event"."dispatched_at" is null;--> statement-breakpoint
CREATE INDEX "external_action_run_idx" ON "external_action" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "inbox_item_open_idx" ON "inbox_item" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "inbox_item_run_idx" ON "inbox_item" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "membership_user_idx" ON "membership" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "memory_note_agent_idx" ON "memory_note" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "memory_note_tenant_idx" ON "memory_note" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "message_thread_idx" ON "message" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "raw_record_tenant_idx" ON "raw_record" USING btree ("tenant_id","entity_type");--> statement-breakpoint
CREATE INDEX "run_tenant_agent_idx" ON "run" USING btree ("tenant_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "run_status_idx" ON "run" USING btree ("status");--> statement-breakpoint
CREATE INDEX "skill_version_tenant_idx" ON "skill_version" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "step_run_run_idx" ON "step_run" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "step_run_tenant_idx" ON "step_run" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "thread_subject_idx" ON "thread" USING btree ("tenant_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "tool_call_step_run_idx" ON "tool_call" USING btree ("step_run_id");--> statement-breakpoint
CREATE INDEX "tool_call_tenant_idx" ON "tool_call" USING btree ("tenant_id");