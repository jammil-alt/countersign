// The platform tables (ARCHITECTURE §4, §5.1, §5.3). Shared business records (vendor, transaction,
// document…) and pack tables arrive with the tools that use them, in the same migration sequence.
//
// Hand-written SQL in ./migrations adds what Drizzle cannot express: the extensions, the
// `uuid_generate_v7()` default used below, the cs_runtime grants, row-level security on every
// table with a `tenant_id`, and the immutability triggers (docs/plan.md §1.2).
//
// This file imports only drizzle-orm at runtime, so drizzle-kit can load it on its own.

import type { AgentBundle, PermissionMatrix, SkillDefinition } from "@countersign/core";
import { type SQL, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ── Allowed values ───────────────────────────────────────────────────────────────────────────────
// DECISION: statuses and kinds are text columns with check constraints built from these lists, not
// Postgres enums: adding a value is then one migration that replaces a constraint, and the lists are
// importable by the packages that write them.

export const MEMBERSHIP_ROLES = ["operator", "client_admin", "client_user"] as const;
export const CONNECTION_STATUSES = ["pending", "connected", "disconnected", "error"] as const;
export const EXTERNAL_ACTION_STATUSES = [
  "proposed",
  "approved",
  "rejected",
  "executing",
  "done",
  "failed",
] as const;
export const SKILL_STATUSES = ["active", "retired"] as const;
export const VERSION_STATUSES = ["draft", "live", "retired"] as const;
export const AGENT_KINDS = ["template", "client"] as const;
export const AGENT_STATUSES = ["active", "disabled"] as const;
export const AGENT_APPROVERS = ["client_admin", "operator"] as const;
export const AGENT_RUN_STATUSES = ["draft", "testing", "active", "paused", "retired"] as const;
/** A client agent's go-live stage (ARCHITECTURE §10.9, migration 0019); null for templates. */
export const AGENT_STAGES = ["bench", "trial", "signoff", "live"] as const;
export type AgentStage = (typeof AGENT_STAGES)[number];
export const AUTHOR_TYPES = ["operator", "builder", "pack", "merge", "promote"] as const;
export const RUN_MODES = ["live", "test"] as const;
export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export const STEP_RUN_STATUSES = [
  "pending",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
] as const;
export const TOOL_CALL_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "refused",
  "awaiting_approval",
] as const;
export const THREAD_STATUSES = ["open", "closed"] as const;
/** `contact`: a person a client texts (inbound SMS and WhatsApp, migration 0006); sender_id = contact.id. */
export const MESSAGE_SENDER_TYPES = ["agent", "user", "system", "contact"] as const;
export const MESSAGE_KINDS = ["text", "command", "result"] as const;
export const MESSAGE_AUDIENCES = ["client", "operator"] as const;
export const INBOX_KINDS = [
  "approval",
  "review",
  "request",
  "extraction_review",
  "external_action",
  "change_request",
] as const;
export const INBOX_STATUSES = ["open", "resolved", "expired"] as const;

/** `col in ('a', 'b', …)`. Values are compile-time constants above, never user input. */
function oneOf(column: AnyPgColumn, values: readonly string[]): SQL {
  return sql`${column} in (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`;
}

// ── Column helpers ───────────────────────────────────────────────────────────────────────────────

// uuid v7 from the SQL function (migration 0000), so raw SQL, the seed and Drizzle all get v7.
const id = () => uuid("id").primaryKey().default(sql`uuid_generate_v7()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });
const json = <T = Record<string, unknown>>(name: string) => jsonb(name).$type<T>();
/** Money: numeric(14,4), a string in TypeScript (CLAUDE.md invariant 6). */
const usd = (name: string) => numeric(name, { precision: 14, scale: 4 }).notNull().default("0");

// ── Global tables (no tenant_id, no RLS; read by packages/auth) ────────────────────────────────

/** A client. */
export const tenant = pgTable("tenant", {
  id: id(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  /** e.g. `connectors_offered`, `approvals.external_actions`. */
  settings: json("settings").notNull().default({}),
  workosOrganizationId: text("workos_organization_id").unique(),
  createdAt: createdAt(),
  /**
   * When the operator retired the client (offboarding, docs/plan.md §1.35): nobody signs in to it,
   * no agent runs for it, and its data is purged once the retention period has passed.
   */
  retiredAt: ts("retired_at"),
});

export const appUser = pgTable("app_user", {
  id: id(),
  /** Stored lowercased. */
  email: text("email").notNull().unique(),
  name: text("name"),
  workosUserId: text("workos_user_id").unique(),
  createdAt: createdAt(),
});

// ── Tenant tables ────────────────────────────────────────────────────────────────────────────────

const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => tenant.id);
/** Templates and shared skills have no tenant (operator only, ARCHITECTURE §4). */
const optionalTenantId = () => uuid("tenant_id").references(() => tenant.id);

/** An operator's memberships list the clients they serve; a client user belongs to one client. */
export const membership = pgTable(
  "membership",
  {
    tenantId: tenantId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUser.id),
    role: text("role").$type<(typeof MEMBERSHIP_ROLES)[number]>().notNull(),
    createdAt: createdAt(),
    /**
     * Whether this person may sign (approve) on the Desk (migration 0022). False makes a client
     * user a viewer: they see the Desk, they don't sign.
     */
    canSign: boolean("can_sign").notNull().default(true),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.userId] }),
    index("membership_user_idx").on(t.userId),
    check("membership_role_check", oneOf(t.role, MEMBERSHIP_ROLES)),
  ],
);

export const connection = pgTable(
  "connection",
  {
    id: id(),
    tenantId: tenantId(),
    /** 'qbo' | 'gmail' | 'upload' | … (a connector manifest id). */
    connector: text("connector").notNull(),
    status: text("status")
      .$type<(typeof CONNECTION_STATUSES)[number]>()
      .notNull()
      .default("pending"),
    /** QBO realmId, Gmail address. */
    externalAccountId: text("external_account_id"),
    credentialsEncrypted: json("credentials_encrypted"),
    config: json("config").notNull().default({}),
    /** The ceiling for each verb (docs/plan.md §1.2 "Permission matrix"); defaults = core's DEFAULT_PERMISSIONS. */
    permissions: json<PermissionMatrix>("permissions")
      .notNull()
      .default({ read: "auto", create: "approval", update: "approval", delete: "off" }),
    lastSyncAt: ts("last_sync_at"),
    syncCursor: json("sync_cursor"),
    connectedBy: uuid("connected_by").references(() => appUser.id),
    createdAt: createdAt(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("connection_id_tenant_key").on(t.id, t.tenantId),
    index("connection_tenant_idx").on(t.tenantId),
    check("connection_status_check", oneOf(t.status, CONNECTION_STATUSES)),
  ],
);

/** Append-only log of connection changes (permissions, config, status). */
export const connectionChange = pgTable(
  "connection_change",
  {
    id: id(),
    tenantId: tenantId(),
    connectionId: uuid("connection_id").notNull(),
    /** Null for the system. */
    actorId: uuid("actor_id").references(() => appUser.id),
    change: json("change").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "connection_change_connection_fk",
      columns: [t.connectionId, t.tenantId],
      foreignColumns: [connection.id, connection.tenantId],
    }),
    index("connection_change_connection_idx").on(t.connectionId, t.createdAt),
    index("connection_change_tenant_idx").on(t.tenantId),
  ],
);

/** What a connector synced, as it came. Append-only (trigger): only `is_deleted` may change. */
export const rawRecord = pgTable(
  "raw_record",
  {
    id: id(),
    tenantId: tenantId(),
    connectionId: uuid("connection_id").notNull(),
    connector: text("connector").notNull(),
    entityType: text("entity_type").notNull(),
    externalId: text("external_id").notNull(),
    /** QBO SyncToken. */
    externalVersion: text("external_version"),
    payload: json("payload").notNull(),
    syncedAt: ts("synced_at").notNull().defaultNow(),
    isDeleted: boolean("is_deleted").notNull().default(false),
  },
  (t) => [
    foreignKey({
      name: "raw_record_connection_fk",
      columns: [t.connectionId, t.tenantId],
      foreignColumns: [connection.id, connection.tenantId],
    }),
    unique("raw_record_id_tenant_key").on(t.id, t.tenantId),
    unique("raw_record_version_key")
      .on(t.connectionId, t.entityType, t.externalId, t.externalVersion)
      .nullsNotDistinct(),
    index("raw_record_tenant_idx").on(t.tenantId, t.entityType),
  ],
);

/** Packs switched on for a client. */
export const tenantPack = pgTable(
  "tenant_pack",
  {
    tenantId: tenantId(),
    pack: text("pack").notNull(),
    version: text("version").notNull(),
    enabledAt: ts("enabled_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.pack] })],
);

// ── Skills (tenant_id null = shared by every agent; set = written for one client) ──────────────

export const skill = pgTable(
  "skill",
  {
    id: id(),
    tenantId: optionalTenantId(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    liveVersionId: uuid("live_version_id").references((): AnyPgColumn => skillVersion.id),
    status: text("status").$type<(typeof SKILL_STATUSES)[number]>().notNull().default("active"),
    /**
     * Publishing needs the latest suite run of that version to pass every required case (migration
     * 0028, ARCHITECTURE §9.10). Switched off only with a reason (logged in `agent_change`).
     */
    requireTests: boolean("require_tests").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    // Nulls not distinct: shared skills (tenant_id null) are unique among themselves too.
    unique("skill_tenant_slug_key").on(t.tenantId, t.slug).nullsNotDistinct(),
    unique("skill_id_tenant_key").on(t.id, t.tenantId),
    check("skill_status_check", oneOf(t.status, SKILL_STATUSES)),
  ],
);

/** Immutable except `status` (trigger). */
export const skillVersion = pgTable(
  "skill_version",
  {
    id: id(),
    tenantId: optionalTenantId(),
    skillId: uuid("skill_id").notNull(),
    version: integer("version").notNull(),
    definition: json<SkillDefinition>("definition").notNull(),
    definitionHash: text("definition_hash").notNull(),
    status: text("status").$type<(typeof VERSION_STATUSES)[number]>().notNull().default("draft"),
    changeNote: text("change_note"),
    authorId: uuid("author_id").references(() => appUser.id),
    parentVersionId: uuid("parent_version_id").references((): AnyPgColumn => skillVersion.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("skill_version_skill_version_key").on(t.skillId, t.version),
    // A version belongs to its skill's tenant (enforced whenever tenant_id is set).
    foreignKey({
      name: "skill_version_skill_fk",
      columns: [t.skillId, t.tenantId],
      foreignColumns: [skill.id, skill.tenantId],
    }),
    foreignKey({
      name: "skill_version_skill_id_fk",
      columns: [t.skillId],
      foreignColumns: [skill.id],
    }),
    index("skill_version_tenant_idx").on(t.tenantId),
    check("skill_version_status_check", oneOf(t.status, VERSION_STATUSES)),
  ],
);

// ── Agents: templates (tenant_id null) and client agents (tenant_id set) ─────────────────────────

export const agent = pgTable(
  "agent",
  {
    id: id(),
    tenantId: optionalTenantId(),
    kind: text("kind").$type<(typeof AGENT_KINDS)[number]>().notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    role: text("role"),
    /** Client agents: the template they were forked from. */
    templateId: uuid("template_id").references((): AnyPgColumn => agent.id),
    /** False = detached: no further template updates. */
    linked: boolean("linked").notNull().default(true),
    liveVersionId: uuid("live_version_id").references((): AnyPgColumn => agentVersion.id),
    status: text("status").$type<(typeof AGENT_STATUSES)[number]>().notNull().default("active"),
    createdAt: createdAt(),
    // Client agents only: operational, not part of the versioned bundle (changes go to agent_change).
    serviceName: text("service_name"),
    serviceDescription: text("service_description"),
    /** connector id → connection id. */
    bindings: json<Record<string, string>>("bindings").notNull().default({}),
    /**
     * The people this agent reaches (docs/plan.md §1.25): role (from the bundle's `people`) → the
     * contacts bound to it and the conditions for reaching them. Operational, never in a version.
     */
    people: json<Record<string, AgentPeopleBinding>>("people").notNull().default({}),
    /** The agent's own channels: `email` | `sms` | `whatsapp` | `voice` → connection id. */
    channels: json<Record<string, string>>("channels").notNull().default({}),
    /** Null = the client's setting. */
    approver: text("approver").$type<(typeof AGENT_APPROVERS)[number]>(),
    runStatus: text("run_status").$type<(typeof AGENT_RUN_STATUSES)[number]>(),
    /**
     * A template's test copy in the Sandbox client: what a template test run runs (docs/plan.md
     * §1.5). Never activated, never routed; one per template and client.
     */
    testCopy: boolean("test_copy").notNull().default(false),
    /**
     * The go-live stage (ARCHITECTURE §10.9, migration 0019): client agents only, never null for
     * them (a trigger starts a new one at `bench`); null for templates. Operational, never in a
     * version: a publish or a merged update keeps it.
     */
    stage: text("stage").$type<AgentStage>(),
    /** How the agent got to its stage: the trial's start and minimums, the sign-off ask, skips. */
    stageState: json<AgentStageState>("stage_state").notNull().default({}),
    /** Who paused it and why (the client, the operator or the system); null when not paused. */
    pause: json<AgentPause>("pause"),
  },
  (t) => [
    unique("agent_tenant_slug_key").on(t.tenantId, t.slug).nullsNotDistinct(),
    unique("agent_id_tenant_key").on(t.id, t.tenantId),
    index("agent_template_idx").on(t.templateId),
    uniqueIndex("agent_test_copy_key").on(t.tenantId, t.templateId).where(sql`${t.testCopy}`),
    check(
      "agent_test_copy_check",
      sql`not ${t.testCopy} or (${t.kind} = 'client' and ${t.templateId} is not null)`,
    ),
    check("agent_kind_check", oneOf(t.kind, AGENT_KINDS)),
    check("agent_kind_tenant_check", sql`(${t.kind} = 'template') = (${t.tenantId} is null)`),
    check("agent_status_check", oneOf(t.status, AGENT_STATUSES)),
    check(
      "agent_approver_check",
      sql`${t.approver} is null or ${oneOf(t.approver, AGENT_APPROVERS)}`,
    ),
    check(
      "agent_run_status_check",
      sql`${t.runStatus} is null or ${oneOf(t.runStatus, AGENT_RUN_STATUSES)}`,
    ),
    check("agent_stage_check", sql`${t.stage} is null or ${oneOf(t.stage, AGENT_STAGES)}`),
    check("agent_stage_kind_check", sql`(${t.kind} = 'client') = (${t.stage} is not null)`),
  ],
);

/** `agent.stage_state` (ARCHITECTURE §5.5); validated by core where it is written. */
export interface AgentStageState {
  trial?: { startedAt: string; minDays: number; minRuns: number; setBy: string | null };
  signoff?: { inboxItemId: string; askedAt: string };
  skipped?: { stage: AgentStage; reason: string; by: string | null; at: string }[];
}

/** `agent.pause` (ARCHITECTURE §5.5): one side's pause; `all` pauses every agent of the client. */
export interface AgentPause {
  side: "client" | "operator" | "system";
  by: string | null;
  reason: string;
  at: string;
  until?: string;
  all?: boolean;
}

/** One role's binding on a client agent: who fills it, and when and how they may be reached. */
export interface AgentPeopleBinding {
  contactIds: string[];
  /** Validated by core's ReachConditions; the defaults apply to anything missing. */
  conditions?: Record<string, unknown>;
}

/** One whole bundle. Immutable except `status` (trigger). */
export const agentVersion = pgTable(
  "agent_version",
  {
    id: id(),
    tenantId: optionalTenantId(),
    agentId: uuid("agent_id").notNull(),
    version: integer("version").notNull(),
    bundle: json<AgentBundle>("bundle").notNull(),
    /** sha256 of the canonical JSON of the parsed bundle (core's bundleHash). */
    bundleHash: text("bundle_hash").notNull(),
    status: text("status").$type<(typeof VERSION_STATUSES)[number]>().notNull().default("draft"),
    changeNote: text("change_note"),
    /** Templates: what clients' update reviews show. */
    releaseNote: text("release_note"),
    authorType: text("author_type").$type<(typeof AUTHOR_TYPES)[number]>().notNull(),
    authorId: uuid("author_id").references(() => appUser.id),
    /** The version it was edited from (same agent). */
    parentVersionId: uuid("parent_version_id").references((): AnyPgColumn => agentVersion.id),
    /** Client versions: the template version they reconcile with. */
    basedOnTemplateVersionId: uuid("based_on_template_version_id").references(
      (): AnyPgColumn => agentVersion.id,
    ),
    /** Update merges and promotions: the other inputs. */
    mergedFromVersionIds: uuid("merged_from_version_ids").array(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("agent_version_agent_version_key").on(t.agentId, t.version),
    unique("agent_version_id_tenant_key").on(t.id, t.tenantId),
    foreignKey({
      name: "agent_version_agent_fk",
      columns: [t.agentId, t.tenantId],
      foreignColumns: [agent.id, agent.tenantId],
    }),
    foreignKey({
      name: "agent_version_agent_id_fk",
      columns: [t.agentId],
      foreignColumns: [agent.id],
    }),
    index("agent_version_tenant_idx").on(t.tenantId),
    check("agent_version_status_check", oneOf(t.status, VERSION_STATUSES)),
    check("agent_version_author_type_check", oneOf(t.authorType, AUTHOR_TYPES)),
  ],
);

/** Append-only log of operational changes (bindings, approver, run_status). */
export const agentChange = pgTable(
  "agent_change",
  {
    id: id(),
    tenantId: optionalTenantId(),
    agentId: uuid("agent_id").notNull(),
    actorId: uuid("actor_id").references(() => appUser.id),
    change: json("change").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "agent_change_agent_fk",
      columns: [t.agentId, t.tenantId],
      foreignColumns: [agent.id, agent.tenantId],
    }),
    foreignKey({
      name: "agent_change_agent_id_fk",
      columns: [t.agentId],
      foreignColumns: [agent.id],
    }),
    index("agent_change_agent_idx").on(t.agentId, t.createdAt),
    index("agent_change_tenant_idx").on(t.tenantId),
  ],
);

// ── Runs ─────────────────────────────────────────────────────────────────────────────────────────

export const run = pgTable(
  "run",
  {
    // Triggered runs bring a deterministic v5 id (core's eventRunId / scheduleRunId); others take v7.
    id: id(),
    tenantId: tenantId(),
    agentId: uuid("agent_id").notNull(),
    agentVersionId: uuid("agent_version_id").notNull(),
    workflowSlug: text("workflow_slug").notNull(),
    /** Bindings + approver snapshot. */
    config: json("config").notNull().default({}),
    mode: text("mode").$type<(typeof RUN_MODES)[number]>().notNull().default("live"),
    trigger: json("trigger").notNull().default({}),
    status: text("status").$type<(typeof RUN_STATUSES)[number]>().notNull().default("queued"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    costUsd: usd("cost_usd"),
    error: json("error"),
    createdAt: createdAt(),
    /** The failed run this one retries (migration 0023, ARCHITECTURE §10.10). */
    retryOf: uuid("retry_of"),
    /** The step id the retry starts from; the steps before it are copied from `retry_of`. */
    resumeFrom: text("resume_from"),
  },
  (t) => [
    unique("run_id_tenant_key").on(t.id, t.tenantId),
    foreignKey({
      name: "run_retry_of_fk",
      columns: [t.retryOf, t.tenantId],
      foreignColumns: [t.id, t.tenantId],
    }),
    index("run_retry_of_idx").on(t.retryOf).where(sql`${t.retryOf} is not null`),
    check("run_resume_check", sql`${t.resumeFrom} is null or ${t.retryOf} is not null`),
    // Composite keys: a run can only use its own client's agent and version, never a template.
    foreignKey({
      name: "run_agent_fk",
      columns: [t.agentId, t.tenantId],
      foreignColumns: [agent.id, agent.tenantId],
    }),
    foreignKey({
      name: "run_agent_version_fk",
      columns: [t.agentVersionId, t.tenantId],
      foreignColumns: [agentVersion.id, agentVersion.tenantId],
    }),
    index("run_tenant_agent_idx").on(t.tenantId, t.agentId, t.createdAt),
    index("run_status_idx").on(t.status),
    check("run_mode_check", oneOf(t.mode, RUN_MODES)),
    check("run_status_check", oneOf(t.status, RUN_STATUSES)),
  ],
);

export const stepRun = pgTable(
  "step_run",
  {
    id: id(),
    tenantId: tenantId(),
    runId: uuid("run_id").notNull(),
    /** The step id; inside for_each `${stepId}:${index}:${childId}`. */
    nodeId: text("node_id").notNull(),
    /** A step kind, or 'trigger'. */
    nodeType: text("node_type").notNull(),
    skillRef: text("skill_ref"),
    agentVersionId: uuid("agent_version_id").references(() => agentVersion.id),
    input: json("input"),
    output: json("output"),
    /** Plain-language line for the client timeline, from the skill's or tool's summary template. */
    summary: text("summary"),
    status: text("status").$type<(typeof STEP_RUN_STATUSES)[number]>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    costUsd: usd("cost_usd"),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    unique("step_run_id_tenant_key").on(t.id, t.tenantId),
    foreignKey({
      name: "step_run_run_fk",
      columns: [t.runId, t.tenantId],
      foreignColumns: [run.id, run.tenantId],
    }),
    // One row per step of a run: the step log upserts on it, so a retried step never adds a row.
    unique("step_run_run_node_key").on(t.runId, t.nodeId),
    index("step_run_run_idx").on(t.runId),
    index("step_run_tenant_idx").on(t.tenantId),
    check("step_run_status_check", oneOf(t.status, STEP_RUN_STATUSES)),
  ],
);

/**
 * One model call of a run's step (migration 0023, ARCHITECTURE §10.10): provider, model, tokens,
 * cost, duration and why it stopped. The request and answer are in object storage under the
 * client's prefix (`body_key`), never in the database. Back office only. Insert only (trigger).
 */
export const modelCall = pgTable(
  "model_call",
  {
    id: id(),
    tenantId: tenantId(),
    runId: uuid("run_id").notNull(),
    stepRunId: uuid("step_run_id").notNull(),
    agentVersionId: uuid("agent_version_id").references(() => agentVersion.id),
    /** `anthropic` | `openai`. */
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    tokensIn: integer("tokens_in").notNull(),
    tokensOut: integer("tokens_out").notNull(),
    costUsd: numeric("cost_usd", { precision: 14, scale: 4 }).notNull(),
    durationMs: integer("duration_ms").notNull(),
    /** The provider's stop reason (`end_turn`, `tool_use`, `max_tokens`…), or `error`. */
    stopReason: text("stop_reason").notNull(),
    /** `tenants/<tenant id>/model-calls/<id>.json` in R2. */
    bodyKey: text("body_key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "model_call_run_fk",
      columns: [t.runId, t.tenantId],
      foreignColumns: [run.id, run.tenantId],
    }),
    foreignKey({
      name: "model_call_step_run_fk",
      columns: [t.stepRunId, t.tenantId],
      foreignColumns: [stepRun.id, stepRun.tenantId],
    }),
    index("model_call_run_idx").on(t.runId, t.createdAt),
    index("model_call_step_run_idx").on(t.stepRunId),
    index("model_call_tenant_idx").on(t.tenantId, t.createdAt),
    check(
      "model_call_amounts_check",
      sql`${t.tokensIn} >= 0 and ${t.tokensOut} >= 0 and ${t.costUsd} >= 0 and ${t.durationMs} >= 0`,
    ),
    // The body is stored under its own client's prefix (CLAUDE.md invariant 1).
    check(
      "model_call_body_key_check",
      sql`${t.bodyKey} like 'tenants/' || ${t.tenantId}::text || '/model-calls/%'`,
    ),
  ],
);

export const SAVED_VIEW_SURFACES = ["ops_runs", "portal_runs"] as const;

/**
 * An operator's named filters for a runs list (migration 0023, ARCHITECTURE §10.10): `filters` is
 * core's `RunFilter`. Operator table (no client owns a row; RLS on `app.operator`); each user reads
 * and writes their own rows, by `user_id` in the query (RLS can't: operator sessions carry no user
 * id). Updated in place, and deleted (not history).
 */
export const savedView = pgTable(
  "saved_view",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUser.id),
    surface: text("surface").$type<(typeof SAVED_VIEW_SURFACES)[number]>().notNull(),
    name: text("name").notNull(),
    filters: json("filters").notNull().default({}),
    createdAt: createdAt(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("saved_view_name_key").on(t.userId, t.surface, t.name),
    check("saved_view_surface_check", oneOf(t.surface, SAVED_VIEW_SURFACES)),
    check("saved_view_name_check", sql`length(trim(${t.name})) between 1 and 80`),
  ],
);

export const toolCall = pgTable(
  "tool_call",
  {
    id: id(),
    tenantId: tenantId(),
    stepRunId: uuid("step_run_id").notNull(),
    tool: text("tool").notNull(),
    input: json("input"),
    output: json("output"),
    status: text("status").$type<(typeof TOOL_CALL_STATUSES)[number]>().notNull(),
    durationMs: integer("duration_ms"),
    externalActionId: uuid("external_action_id"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "tool_call_step_run_fk",
      columns: [t.stepRunId, t.tenantId],
      foreignColumns: [stepRun.id, stepRun.tenantId],
    }),
    foreignKey({
      name: "tool_call_external_action_fk",
      columns: [t.externalActionId, t.tenantId],
      foreignColumns: [externalAction.id, externalAction.tenantId],
    }),
    index("tool_call_step_run_idx").on(t.stepRunId),
    index("tool_call_tenant_idx").on(t.tenantId),
    check("tool_call_status_check", oneOf(t.status, TOOL_CALL_STATUSES)),
  ],
);

// ── Inbox, external actions ──────────────────────────────────────────────────────────────────────

export const inboxItem = pgTable(
  "inbox_item",
  {
    id: id(),
    tenantId: tenantId(),
    kind: text("kind").$type<(typeof INBOX_KINDS)[number]>().notNull(),
    pack: text("pack"),
    agentId: uuid("agent_id"),
    subjectType: text("subject_type"),
    subjectId: uuid("subject_id"),
    runId: uuid("run_id"),
    assigneeUserId: uuid("assignee_user_id").references(() => appUser.id),
    assigneeRole: text("assignee_role").$type<(typeof MEMBERSHIP_ROLES)[number]>(),
    title: text("title").notNull(),
    payload: json("payload").notNull().default({}),
    status: text("status").$type<(typeof INBOX_STATUSES)[number]>().notNull().default("open"),
    resolution: json("resolution"),
    // DECISION: who resolved it gets its own column (ARCHITECTURE §4: every approval records who
    // approved), so it can be queried and joined without reading `resolution`.
    resolvedBy: uuid("resolved_by").references(() => appUser.id),
    dueAt: ts("due_at"),
    createdAt: createdAt(),
    resolvedAt: ts("resolved_at"),
    /**
     * When the item's run took its resolution. A resolved item with a run and no value is a
     * pending delivery: the cron re-sends its event until the run takes it (docs/plan.md §1.5).
     */
    runReceivedAt: ts("run_received_at"),
    /**
     * Approved inside the undo window (migration 0022): the run is told after this moment, not at
     * once. Null: told at once.
     */
    deliverAfter: ts("deliver_after"),
    /** `<run id>:<step id>`: the items one step proposed together, signed as one batch. */
    batchKey: text("batch_key"),
    snoozedUntil: ts("snoozed_until"),
    snoozedBy: uuid("snoozed_by").references(() => appUser.id),
  },
  (t) => [
    unique("inbox_item_id_tenant_key").on(t.id, t.tenantId),
    index("inbox_item_batch_idx").on(t.tenantId, t.batchKey).where(sql`${t.batchKey} is not null`),
    foreignKey({
      name: "inbox_item_agent_fk",
      columns: [t.agentId, t.tenantId],
      foreignColumns: [agent.id, agent.tenantId],
    }),
    foreignKey({
      name: "inbox_item_run_fk",
      columns: [t.runId, t.tenantId],
      foreignColumns: [run.id, run.tenantId],
    }),
    index("inbox_item_open_idx").on(t.tenantId, t.status, t.createdAt),
    index("inbox_item_run_idx").on(t.runId),
    index("inbox_item_undelivered_idx")
      .on(t.tenantId, t.resolvedAt)
      .where(
        sql`${t.status} = 'resolved' and ${t.runId} is not null and ${t.runReceivedAt} is null`,
      ),
    check("inbox_item_kind_check", oneOf(t.kind, INBOX_KINDS)),
    check("inbox_item_status_check", oneOf(t.status, INBOX_STATUSES)),
    check(
      "inbox_item_assignee_role_check",
      sql`${t.assigneeRole} is null or ${oneOf(t.assigneeRole, MEMBERSHIP_ROLES)}`,
    ),
  ],
);

/** Every write to a client's tool: proposed, approved, executed once (idempotency key). */
export const externalAction = pgTable(
  "external_action",
  {
    id: id(),
    tenantId: tenantId(),
    connectionId: uuid("connection_id").notNull(),
    tool: text("tool").notNull(),
    runId: uuid("run_id"),
    stepRunId: uuid("step_run_id"),
    agentVersionId: uuid("agent_version_id").references(() => agentVersion.id),
    input: json("input").notNull().default({}),
    /** `<run id>:<step id>:<index>` (docs/plan.md §1.2 "External actions"). */
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status")
      .$type<(typeof EXTERNAL_ACTION_STATUSES)[number]>()
      .notNull()
      .default("proposed"),
    inboxItemId: uuid("inbox_item_id"),
    approvedBy: uuid("approved_by").references(() => appUser.id),
    approvedAt: ts("approved_at"),
    result: json("result"),
    error: json("error"),
    /** The record's state before the change, where the system allows reading it. */
    before: json("before"),
    createdAt: createdAt(),
    executedAt: ts("executed_at"),
    /**
     * The signer's edit before approving (migration 0022): what is executed when set. `input`
     * stays the agent's version.
     */
    editedInput: json("edited_input"),
    editedBy: uuid("edited_by").references(() => appUser.id),
    editedAt: ts("edited_at"),
  },
  (t) => [
    unique("external_action_idempotency_key").on(t.tenantId, t.idempotencyKey),
    unique("external_action_id_tenant_key").on(t.id, t.tenantId),
    foreignKey({
      name: "external_action_connection_fk",
      columns: [t.connectionId, t.tenantId],
      foreignColumns: [connection.id, connection.tenantId],
    }),
    foreignKey({
      name: "external_action_run_fk",
      columns: [t.runId, t.tenantId],
      foreignColumns: [run.id, run.tenantId],
    }),
    foreignKey({
      name: "external_action_step_run_fk",
      columns: [t.stepRunId, t.tenantId],
      foreignColumns: [stepRun.id, stepRun.tenantId],
    }),
    foreignKey({
      name: "external_action_inbox_item_fk",
      columns: [t.inboxItemId, t.tenantId],
      foreignColumns: [inboxItem.id, inboxItem.tenantId],
    }),
    index("external_action_run_idx").on(t.runId),
    check("external_action_status_check", oneOf(t.status, EXTERNAL_ACTION_STATUSES)),
    check("external_action_edit_check", sql`(${t.editedInput} is null) = (${t.editedAt} is null)`),
  ],
);

// ── Senses ───────────────────────────────────────────────────────────────────────────────────────

/** The senses outbox: `emit()` inserts in the caller's transaction; dispatch stamps `dispatched_at`. */
export const event = pgTable(
  "event",
  {
    id: id(),
    tenantId: tenantId(),
    type: text("type").notNull(),
    subjectType: text("subject_type"),
    subjectId: uuid("subject_id"),
    payload: json("payload").notNull().default({}),
    createdAt: createdAt(),
    dispatchedAt: ts("dispatched_at"),
  },
  (t) => [
    index("event_tenant_idx").on(t.tenantId, t.createdAt),
    // The cron's re-dispatch sweep reads only undispatched rows.
    index("event_undispatched_idx").on(t.createdAt).where(sql`${t.dispatchedAt} is null`),
  ],
);

// ── Threads ──────────────────────────────────────────────────────────────────────────────────────

export const thread = pgTable(
  "thread",
  {
    id: id(),
    tenantId: tenantId(),
    subjectType: text("subject_type"),
    subjectId: uuid("subject_id"),
    title: text("title").notNull(),
    status: text("status").$type<(typeof THREAD_STATUSES)[number]>().notNull().default("open"),
    stepBudget: integer("step_budget").notNull().default(12),
    stepsUsed: integer("steps_used").notNull().default(0),
    createdAt: createdAt(),
    /** Who started it (migration 0021): the person of an `account` conversation; null otherwise. */
    createdBy: uuid("created_by").references(() => appUser.id),
  },
  (t) => [
    unique("thread_id_tenant_key").on(t.id, t.tenantId),
    index("thread_subject_idx").on(t.tenantId, t.subjectType, t.subjectId),
    // One thread with the lead per client (ARCHITECTURE §11.2): subject_id is the tenant id.
    uniqueIndex("thread_lead_key").on(t.tenantId).where(sql`${t.subjectType} = 'lead'`),
    check("thread_status_check", oneOf(t.status, THREAD_STATUSES)),
  ],
);

/**
 * How far a person has read a thread (migration 0021): one row per thread and user, moved forward
 * as they read. Updated in place, never deleted.
 */
export const threadRead = pgTable(
  "thread_read",
  {
    tenantId: tenantId(),
    threadId: uuid("thread_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUser.id),
    lastReadAt: ts("last_read_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.threadId, t.userId] }),
    foreignKey({
      name: "thread_read_thread_fk",
      columns: [t.threadId, t.tenantId],
      foreignColumns: [thread.id, thread.tenantId],
    }),
    index("thread_read_user_idx").on(t.tenantId, t.userId),
  ],
);

export const message = pgTable(
  "message",
  {
    id: id(),
    tenantId: tenantId(),
    threadId: uuid("thread_id").notNull(),
    senderType: text("sender_type").$type<(typeof MESSAGE_SENDER_TYPES)[number]>().notNull(),
    senderId: uuid("sender_id"),
    agentVersionId: uuid("agent_version_id").references(() => agentVersion.id),
    kind: text("kind").$type<(typeof MESSAGE_KINDS)[number]>().notNull().default("text"),
    command: text("command"),
    body: json("body").notNull().default({}),
    /** Record ids the message rests on (CLAUDE.md invariant 10). */
    sources: json<string[]>("sources").notNull().default([]),
    // DECISION: a message is for the operator unless it says otherwise, so model text never
    // reaches the portal by default (CLAUDE.md invariant 11).
    audience: text("audience")
      .$type<(typeof MESSAGE_AUDIENCES)[number]>()
      .notNull()
      .default("operator"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("message_id_tenant_key").on(t.id, t.tenantId),
    foreignKey({
      name: "message_thread_fk",
      columns: [t.threadId, t.tenantId],
      foreignColumns: [thread.id, thread.tenantId],
    }),
    index("message_thread_idx").on(t.threadId, t.createdAt),
    check("message_sender_type_check", oneOf(t.senderType, MESSAGE_SENDER_TYPES)),
    check("message_kind_check", oneOf(t.kind, MESSAGE_KINDS)),
    check("message_audience_check", oneOf(t.audience, MESSAGE_AUDIENCES)),
  ],
);

// ── Memory and usage ─────────────────────────────────────────────────────────────────────────────

/** Per client agent; never shared across clients or with templates. */
export const memoryNote = pgTable(
  "memory_note",
  {
    id: id(),
    tenantId: tenantId(),
    agentId: uuid("agent_id").notNull(),
    scope: text("scope").notNull().default("agent"),
    note: text("note").notNull(),
    sourceMessageId: uuid("source_message_id"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "memory_note_agent_fk",
      columns: [t.agentId, t.tenantId],
      foreignColumns: [agent.id, agent.tenantId],
    }),
    foreignKey({
      name: "memory_note_message_fk",
      columns: [t.sourceMessageId, t.tenantId],
      foreignColumns: [message.id, message.tenantId],
    }),
    index("memory_note_agent_idx").on(t.agentId),
    index("memory_note_tenant_idx").on(t.tenantId),
  ],
);

// DECISION: usage is rolled up per client agent (agent_id not null), so the key is
// (tenant_id, day, agent_id); work outside any agent is not billed in v1.
export const usageDaily = pgTable(
  "usage_daily",
  {
    tenantId: tenantId(),
    day: date("day").notNull(),
    agentId: uuid("agent_id").notNull(),
    runs: integer("runs").notNull().default(0),
    steps: integer("steps").notNull().default(0),
    documents: integer("documents").notNull().default(0),
    externalActions: integer("external_actions").notNull().default(0),
    /** Texts and WhatsApp messages sent (migration 0006), counted once per provider message id. */
    messages: integer("messages").notNull().default(0),
    /**
     * Seconds of phone calls (migration 0008): Twilio's duration of each finished call an agent
     * placed or answered, counted once per call.
     */
    callSeconds: integer("call_seconds").notNull().default(0),
    tokensIn: bigint("tokens_in", { mode: "number" }).notNull().default(0),
    tokensOut: bigint("tokens_out", { mode: "number" }).notNull().default(0),
    costUsd: usd("cost_usd"),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.day, t.agentId] }),
    foreignKey({
      name: "usage_daily_agent_fk",
      columns: [t.agentId, t.tenantId],
      foreignColumns: [agent.id, agent.tenantId],
    }),
  ],
);

/**
 * The client's usage that no agent made (migration 0018, ARCHITECTURE §13): background reading of
 * uploads and forwarded mail (`doc_extraction` rows with no `agent_version_id`), per client and UTC
 * day. Recomputed by the rollup like `usage_daily`, and counted into credits with it: its measure
 * columns have `usage_daily`'s names.
 */
// DECISION: background reading is the client's usage, not an agent's (plan §1.43), so it has its
// own table keyed (tenant_id, day) instead of an invented agent in usage_daily.
export const usagePlatformDaily = pgTable(
  "usage_platform_daily",
  {
    tenantId: tenantId(),
    day: date("day").notNull(),
    documents: integer("documents").notNull().default(0),
    tokensIn: bigint("tokens_in", { mode: "number" }).notNull().default(0),
    tokensOut: bigint("tokens_out", { mode: "number" }).notNull().default(0),
    costUsd: usd("cost_usd"),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.day] })],
);

// ── Shared business records (ARCHITECTURE §5.2) ─────────────────────────────────────────────────
// Connectors map into these; packs and platform tools read them. Added by migration 0004 with the
// documents capability (docs/plan.md §1.6).

export const TRANSACTION_KINDS = ["purchase", "bill", "vendor_credit"] as const;
export const TRANSACTION_STATUSES = [
  "needs_doc",
  "doc_requested",
  "doc_found",
  "extracted",
  "processed",
] as const;
export const LINE_DETAIL_TYPES = ["account", "item"] as const;
export const DOCUMENT_SOURCES = ["connector", "upload", "email", "request"] as const;
export const DOCUMENT_STATUSES = [
  "stored",
  "extracting",
  "extracted",
  "failed",
  "needs_review",
] as const;

/** Money that may be absent (an amount a document did not show). */
const money = (name: string) => numeric(name, { precision: 14, scale: 4 });
const currency = () => text("currency").notNull().default("USD");

export const vendor = pgTable(
  "vendor",
  {
    id: id(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    /** Lowercased, punctuation and company suffixes removed: the key a vendor is found by. */
    normalizedName: text("normalized_name").notNull(),
    aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
    /** Ids in connected tools, e.g. `{ qbo: "56" }`. */
    externalRefs: json("external_refs").notNull().default({}),
    /** Sender domains seen on this vendor's documents, and other signals. */
    ext: json("ext").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    unique("vendor_id_tenant_key").on(t.id, t.tenantId),
    unique("vendor_normalized_name_key").on(t.tenantId, t.normalizedName),
  ],
);

export const transaction = pgTable(
  "transaction",
  {
    id: id(),
    tenantId: tenantId(),
    kind: text("kind").$type<(typeof TRANSACTION_KINDS)[number]>().notNull(),
    // DECISION: a transaction names the connector it came from (`upload`, `qbo`), so events and
    // dedupe don't have to join raw_record; with external_id it is unique per client.
    connector: text("connector").notNull(),
    vendorId: uuid("vendor_id"),
    txnDate: date("txn_date"),
    total: money("total").notNull(),
    currency: currency(),
    purchaserRef: text("purchaser_ref"),
    paymentType: text("payment_type"),
    memo: text("memo"),
    sourceRawRecordId: uuid("source_raw_record_id"),
    externalId: text("external_id").notNull(),
    status: text("status")
      .$type<(typeof TRANSACTION_STATUSES)[number]>()
      .notNull()
      .default("needs_doc"),
    ext: json("ext").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    unique("transaction_id_tenant_key").on(t.id, t.tenantId),
    unique("transaction_external_key").on(t.tenantId, t.connector, t.externalId),
    foreignKey({
      name: "transaction_vendor_fk",
      columns: [t.vendorId, t.tenantId],
      foreignColumns: [vendor.id, vendor.tenantId],
    }),
    foreignKey({
      name: "transaction_raw_record_fk",
      columns: [t.sourceRawRecordId, t.tenantId],
      foreignColumns: [rawRecord.id, rawRecord.tenantId],
    }),
    // The linking window: vendor + date (± 7 days) + total (docs/plan.md §1.6).
    index("transaction_link_idx").on(t.tenantId, t.vendorId, t.txnDate),
    check("transaction_kind_check", oneOf(t.kind, TRANSACTION_KINDS)),
    check("transaction_status_check", oneOf(t.status, TRANSACTION_STATUSES)),
  ],
);

export const transactionLine = pgTable(
  "transaction_line",
  {
    id: id(),
    tenantId: tenantId(),
    transactionId: uuid("transaction_id").notNull(),
    lineNo: integer("line_no").notNull(),
    detailType: text("detail_type").$type<(typeof LINE_DETAIL_TYPES)[number]>().notNull(),
    accountRef: text("account_ref"),
    itemRef: text("item_ref"),
    description: text("description"),
    qty: money("qty"),
    unitPrice: money("unit_price"),
    amount: money("amount").notNull(),
  },
  (t) => [
    foreignKey({
      name: "transaction_line_transaction_fk",
      columns: [t.transactionId, t.tenantId],
      foreignColumns: [transaction.id, transaction.tenantId],
    }),
    unique("transaction_line_no_key").on(t.transactionId, t.lineNo),
    check("transaction_line_detail_type_check", oneOf(t.detailType, LINE_DETAIL_TYPES)),
  ],
);

/** An original file (invoice, receipt), stored once per client and sha256. */
export const document = pgTable(
  "document",
  {
    id: id(),
    tenantId: tenantId(),
    transactionId: uuid("transaction_id"),
    source: text("source").$type<(typeof DOCUMENT_SOURCES)[number]>().notNull(),
    /** The connection it came through (the client's upload connection for uploads and email). */
    connectionId: uuid("connection_id"),
    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type").notNull(),
    filename: text("filename").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    pageCount: integer("page_count"),
    status: text("status").$type<(typeof DOCUMENT_STATUSES)[number]>().notNull().default("stored"),
    /**
     * Where it came from: who uploaded it, or a forwarded email's headers (from, to, subject,
     * date, message id). Never an email body (ARCHITECTURE §6.5).
     */
    meta: json("meta").notNull().default({}),
    receivedAt: ts("received_at").notNull().defaultNow(),
  },
  (t) => [
    unique("document_id_tenant_key").on(t.id, t.tenantId),
    // DECISION: one document per client and sha256: the same file uploaded twice, or uploaded
    // and then forwarded, is one document (its first source).
    unique("document_sha256_key").on(t.tenantId, t.sha256),
    foreignKey({
      name: "document_transaction_fk",
      columns: [t.transactionId, t.tenantId],
      foreignColumns: [transaction.id, transaction.tenantId],
    }),
    foreignKey({
      name: "document_connection_fk",
      columns: [t.connectionId, t.tenantId],
      foreignColumns: [connection.id, connection.tenantId],
    }),
    index("document_transaction_idx").on(t.transactionId),
    index("document_tenant_idx").on(t.tenantId, t.receivedAt),
    check("document_source_check", oneOf(t.source, DOCUMENT_SOURCES)),
    check("document_status_check", oneOf(t.status, DOCUMENT_STATUSES)),
    check("document_sha256_check", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

/** One reading of a document. Immutable (trigger): re-extraction inserts a new row. */
export const docExtraction = pgTable(
  "doc_extraction",
  {
    id: id(),
    tenantId: tenantId(),
    documentId: uuid("document_id").notNull(),
    model: text("model").notNull(),
    agentVersionId: uuid("agent_version_id").references(() => agentVersion.id),
    /** InvoiceExtraction's header: vendor, invoice number and date, PO, per-field confidence. */
    header: json("header").notNull(),
    currency: currency(),
    subtotal: money("subtotal").notNull(),
    freight: usd("freight"),
    /** `[{ label, amount }]`, e.g. a fuel surcharge. */
    surcharges: json<{ label: string; amount: string }[]>("surcharges").notNull().default([]),
    tax: usd("tax"),
    total: money("total").notNull(),
    linesSum: money("lines_sum").notNull(),
    totalsMatch: boolean("totals_match").notNull(),
    /** What validateTotals found, in words, when the totals do not match. */
    problems: json<string[]>("problems").notNull().default([]),
    /** The model's overall confidence, 0–1. */
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    createdAt: createdAt(),
    /**
     * What the reading cost (migration 0018): the model call's tokens and cost, written at insert
     * (the row stays immutable). 0 for readings before 0018. A reading with no `agent_version_id`
     * was done in the background (an upload, forwarded mail) and is the client's usage
     * (`usage_platform_daily`), not an agent's.
     */
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    costUsd: usd("cost_usd"),
  },
  (t) => [
    unique("doc_extraction_id_tenant_key").on(t.id, t.tenantId),
    // The usage rollup's background readings: a client's extractions with no agent, by day.
    index("doc_extraction_background_idx")
      .on(t.tenantId, t.createdAt)
      .where(sql`${t.agentVersionId} is null`),
    foreignKey({
      name: "doc_extraction_document_fk",
      columns: [t.documentId, t.tenantId],
      foreignColumns: [document.id, document.tenantId],
    }),
    index("doc_extraction_document_idx").on(t.documentId, t.createdAt),
  ],
);

/** A line of an extraction. Immutable with it. */
export const docLine = pgTable(
  "doc_line",
  {
    id: id(),
    tenantId: tenantId(),
    extractionId: uuid("extraction_id").notNull(),
    lineNo: integer("line_no").notNull(),
    vendorSku: text("vendor_sku"),
    rawDescription: text("raw_description").notNull(),
    qty: money("qty").notNull(),
    uomRaw: text("uom_raw"),
    unitPrice: money("unit_price").notNull(),
    extPrice: money("ext_price").notNull(),
    discount: money("discount"),
    page: integer("page"),
    bbox: json("bbox"),
  },
  (t) => [
    foreignKey({
      name: "doc_line_extraction_fk",
      columns: [t.extractionId, t.tenantId],
      foreignColumns: [docExtraction.id, docExtraction.tenantId],
    }),
    unique("doc_line_no_key").on(t.extractionId, t.lineNo),
  ],
);

// ── Client settings log and feedback ─────────────────────────────────────────────────────────────

/**
 * Append-only log of the operator's changes to a client's settings that need a reason (today the
 * feedback switch, `tenant.settings.feedback`).
 */
export const tenantChange = pgTable(
  "tenant_change",
  {
    id: id(),
    tenantId: tenantId(),
    actorId: uuid("actor_id").references(() => appUser.id),
    /** E.g. `{ setting: "feedback", from: false, to: true }`. */
    change: json("change").notNull(),
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("tenant_change_tenant_idx").on(t.tenantId, t.createdAt)],
);

export const FEEDBACK_SURFACES = ["ops", "portal"] as const;
export const FEEDBACK_STATUSES = ["open", "resolved"] as const;

/** Where a pin was dropped, in CSS pixels of the viewport, and what was under it. */
export interface FeedbackPin {
  x: number;
  y: number;
}
export interface FeedbackViewport {
  width: number;
  height: number;
}

/**
 * What people tell us about the product, from the Feedback button: back-office feedback is the
 * operator's own (`tenant_id` null, visible only in operator sessions); portal feedback belongs to
 * its client. Read only by operators (`/api/ops/feedback`). The screenshot lives in object storage
 * under the client's key; the row holds the key, never the bytes.
 */
export const feedback = pgTable(
  "feedback",
  {
    id: id(),
    tenantId: optionalTenantId(),
    surface: text("surface").$type<(typeof FEEDBACK_SURFACES)[number]>().notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUser.id),
    comment: text("comment").notNull(),
    path: text("path").notNull(),
    viewport: json<FeedbackViewport>("viewport").notNull(),
    /** Null for "no particular spot". */
    pin: json<FeedbackPin>("pin"),
    /** A short description of the element under the pin (e.g. `button "Approve"`). */
    target: text("target"),
    screenshotKey: text("screenshot_key"),
    screenshotBytes: integer("screenshot_bytes"),
    status: text("status").$type<(typeof FEEDBACK_STATUSES)[number]>().notNull().default("open"),
    resolvedAt: ts("resolved_at"),
    resolvedBy: uuid("resolved_by").references(() => appUser.id),
    resolutionNote: text("resolution_note"),
    createdAt: createdAt(),
  },
  (t) => [
    index("feedback_status_idx").on(t.status, t.createdAt),
    index("feedback_tenant_idx").on(t.tenantId, t.createdAt),
    check("feedback_surface_check", oneOf(t.surface, FEEDBACK_SURFACES)),
    check("feedback_status_check", oneOf(t.status, FEEDBACK_STATUSES)),
    // Portal feedback always names its client; back-office feedback never does.
    check(
      "feedback_surface_tenant_check",
      sql`(${t.surface} = 'portal') = (${t.tenantId} is not null)`,
    ),
  ],
);

// ── The directory (migration 0014, docs/plan.md §1.27) ───────────────────────────────────────────

/** What an organization is to the client; several are allowed (a vendor that is also a customer). */
export const ORGANIZATION_KINDS = ["vendor", "customer", "partner", "own", "other"] as const;
export type OrganizationKind = (typeof ORGANIZATION_KINDS)[number];
/** The languages agents write in (core's LOCALES, docs/plan.md §1.18). */
export const ORGANIZATION_LANGUAGES = ["en", "es", "fr", "pt-BR", "it", "de"] as const;
/** What a person is to the client. */
export const CONTACT_RELATIONSHIPS = [
  "employee",
  "contractor",
  "customer",
  "vendor",
  "partner",
  "other",
] as const;
export type ContactRelationship = (typeof CONTACT_RELATIONSHIPS)[number];

/** A postal address as people write it; every part optional. */
export interface OrganizationAddress {
  line1?: string | undefined;
  line2?: string | undefined;
  city?: string | undefined;
  region?: string | undefined;
  postalCode?: string | undefined;
  country?: string | undefined;
}

/**
 * An organization in a client's directory: a vendor, customer, partner, the client itself or other.
 * People (contacts) point at it with `organization_id`. A vendor organization links to its `vendor`
 * record (one per vendor) so matching and the directory share one entry. Edited in place and never
 * deleted, as contacts; every change goes in `organization_change`.
 */
export const organization = pgTable(
  "organization",
  {
    id: id(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    kinds: text("kinds").array().$type<OrganizationKind[]>().notNull().default(sql`'{}'::text[]`),
    website: text("website"),
    /** Lower case. */
    email: text("email"),
    /** E.164 where it can be read as one; else as given. */
    phone: text("phone"),
    address: json<OrganizationAddress>("address"),
    /**
     * The language to write to its people in when they have none of their own (`en`, `es`, `fr`,
     * `pt-BR`, `it`, `de`); null: the client's.
     */
    language: text("language"),
    notes: text("notes"),
    /** Ids in connected tools, e.g. `{ zoho_crm: "4150868000000224005" }`. */
    externalRefs: json<Record<string, string>>("external_refs").notNull().default({}),
    /** The `vendor` record this organization is, if it is a vendor. One organization per vendor. */
    vendorId: uuid("vendor_id"),
    /** `manual`, `csv`, `agent`, or the connector it came from (`zoho_crm`, `podio`). */
    source: text("source").notNull().default("manual"),
    createdBy: uuid("created_by").references(() => appUser.id),
    createdAt: createdAt(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("organization_id_tenant_key").on(t.id, t.tenantId),
    unique("organization_vendor_key").on(t.tenantId, t.vendorId),
    foreignKey({
      name: "organization_vendor_fk",
      columns: [t.vendorId, t.tenantId],
      foreignColumns: [vendor.id, vendor.tenantId],
    }),
    index("organization_tenant_idx").on(t.tenantId, t.name),
    check(
      "organization_kinds_check",
      sql`${t.kinds} <@ array[${sql.raw(ORGANIZATION_KINDS.map((k) => `'${k}'`).join(", "))}]::text[]`,
    ),
    check("organization_source_check", sql`${t.source} ~ '^[a-z][a-z0-9_]{0,39}$'`),
    check(
      "organization_language_check",
      sql`${t.language} is null or ${oneOf(t.language, ORGANIZATION_LANGUAGES)}`,
    ),
  ],
);

/** Append-only log of an organization's changes, as `contact_change`. */
export const organizationChange = pgTable(
  "organization_change",
  {
    id: id(),
    tenantId: tenantId(),
    organizationId: uuid("organization_id").notNull(),
    /** Null for the system. */
    actorId: uuid("actor_id").references(() => appUser.id),
    change: json("change").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "organization_change_organization_fk",
      columns: [t.organizationId, t.tenantId],
      foreignColumns: [organization.id, organization.tenantId],
    }),
    index("organization_change_organization_idx").on(t.organizationId, t.createdAt),
    index("organization_change_tenant_idx").on(t.tenantId),
  ],
);

// ── Contacts (migration 0006, docs/plan.md §1.22) ─────────────────────────────────────────────────

export const MESSAGING_CHANNELS = ["sms", "whatsapp"] as const;
export type MessagingChannel = (typeof MESSAGING_CHANNELS)[number];

/** One channel's consent: when it was given and how (a web form, a signed paper, a START text). */
export interface ContactChannelConsent {
  grantedAt: string;
  source: string;
}
/**
 * Consent per channel; `voice` is calls from an agent to the contact's phone (docs/plan.md §1.23),
 * `email` is email from an agent (§1.25).
 */
export type ContactConsent = Partial<
  Record<MessagingChannel | "voice" | "email", ContactChannelConsent>
>;

/** `contact.autonomy` (ARCHITECTURE §5.5, §6.4). */
export type ContactAutonomy = Partial<
  Record<"email" | "sms" | "whatsapp" | "voice", "auto" | "approval" | "off">
>;

/**
 * A person a client's agents may text or message: a phone in E.164 (SMS), a WhatsApp number, a
 * language, consent per channel with its source and time, and an opt-out that stops every channel.
 * Sends check this in code before calling the provider; STOP and START texts change it at once.
 */
export const contact = pgTable(
  "contact",
  {
    id: id(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    /** E.164, e.g. `+15551234567`. */
    phone: text("phone"),
    /** The WhatsApp number, E.164 (often the same as `phone`). */
    whatsapp: text("whatsapp"),
    /** Lower case; email-only contacts are allowed (migration 0010). */
    email: text("email"),
    /** e.g. `es`; null: the client's language. */
    language: text("language"),
    /** Channels in the order the contact prefers (`whatsapp`, `voice`, `sms`, `email`). */
    preferredChannels: json<string[]>("preferred_channels").notNull().default([]),
    /** IANA zone; null: the client's timezone. */
    timezone: text("timezone"),
    /** `{start, end}` as `HH:MM`; null: the client's quiet hours. */
    quietHours: json<{ start: string; end: string }>("quiet_hours"),
    /** Labels such as `purchaser`, `owner`, `vendor rep`. */
    roles: json<string[]>("roles").notNull().default([]),
    notes: text("notes"),
    /** The organization this person belongs to, in the same client's directory (migration 0014). */
    organizationId: uuid("organization_id"),
    /** Job title, e.g. `Purchasing manager`. */
    title: text("title"),
    /** What this person is to the client; null: not said. */
    relationship: text("relationship").$type<ContactRelationship>(),
    /** `manual`, `csv`, `agent` or a connector; null: made before the directory (manual). */
    source: text("source"),
    /** Ids in connected tools, e.g. `{ zoho_crm: "4150868000000224005" }` (migration 0014). */
    externalRefs: json<Record<string, string>>("external_refs").notNull().default({}),
    consent: json<ContactConsent>("consent").notNull().default({}),
    /**
     * How freely agents may reach this person, per channel (migration 0025): `auto`, `approval` or
     * `off`. A missing channel takes the step's and client's settings.
     */
    autonomy: json<ContactAutonomy>("autonomy").notNull().default({}),
    optedOutAt: ts("opted_out_at"),
    /** `keyword:STOP`, `operator`, `client`. */
    optOutSource: text("opt_out_source"),
    createdBy: uuid("created_by").references(() => appUser.id),
    createdAt: createdAt(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("contact_id_tenant_key").on(t.id, t.tenantId),
    uniqueIndex("contact_phone_key").on(t.tenantId, t.phone),
    uniqueIndex("contact_whatsapp_key").on(t.tenantId, t.whatsapp),
    uniqueIndex("contact_email_key").on(t.tenantId, t.email),
    index("contact_tenant_idx").on(t.tenantId, t.name),
    foreignKey({
      name: "contact_organization_fk",
      columns: [t.organizationId, t.tenantId],
      foreignColumns: [organization.id, organization.tenantId],
    }),
    index("contact_organization_idx").on(t.tenantId, t.organizationId),
    check(
      "contact_relationship_check",
      sql`${t.relationship} is null or ${oneOf(t.relationship, CONTACT_RELATIONSHIPS)}`,
    ),
    check(
      "contact_source_check",
      sql`${t.source} is null or ${t.source} ~ '^[a-z][a-z0-9_]{0,39}$'`,
    ),
    check(
      "contact_reachable_check",
      sql`${t.phone} is not null or ${t.whatsapp} is not null or ${t.email} is not null`,
    ),
    check("contact_opt_out_check", sql`(${t.optedOutAt} is null) = (${t.optOutSource} is null)`),
  ],
);

/** Append-only log of a contact's changes: consent given or withdrawn, opt-outs, edits. */
export const contactChange = pgTable(
  "contact_change",
  {
    id: id(),
    tenantId: tenantId(),
    contactId: uuid("contact_id").notNull(),
    /** Null for the system (a STOP or START text). */
    actorId: uuid("actor_id").references(() => appUser.id),
    change: json("change").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "contact_change_contact_fk",
      columns: [t.contactId, t.tenantId],
      foreignColumns: [contact.id, contact.tenantId],
    }),
    index("contact_change_contact_idx").on(t.contactId, t.createdAt),
    index("contact_change_tenant_idx").on(t.tenantId),
  ],
);

// ── Reach out (migration 0010, docs/plan.md §1.25) ───────────────────────────────────────────────

export const REACH_OUT_STATUSES = ["awaiting_approval", "open", "ended"] as const;
export const REACH_OUT_OUTCOMES = [
  "replied",
  "no_reply",
  "declined",
  "opted_out",
  "not_allowed",
] as const;

/**
 * One agent reaching one contact from one workflow step: the approved plan (channels, attempts,
 * escalation), each attempt (an external action with its own key), the reply as untrusted data, and
 * how it ended. At most one open per contact and subject. The run waits on it like an inbox item:
 * once it ends, the cron re-sends its event until the run takes it (`run_received_at`).
 */
export const reachOut = pgTable(
  "reach_out",
  {
    id: id(),
    tenantId: tenantId(),
    agentId: uuid("agent_id").notNull(),
    agentVersionId: uuid("agent_version_id").notNull(),
    runId: uuid("run_id").notNull(),
    stepRunId: uuid("step_run_id"),
    /** The step's durable name in the run. */
    nodeId: text("node_id").notNull(),
    contactId: uuid("contact_id").notNull(),
    /** The role it was addressed to, if any. */
    role: text("role"),
    /** What it is about (its sources, else its purpose): one open reach-out per contact and subject. */
    subject: text("subject").notNull(),
    purpose: text("purpose").notNull(),
    urgency: text("urgency").notNull(),
    /** Channels in order, attempts, escalation, language and the message. */
    plan: json("plan").notNull(),
    status: text("status").$type<(typeof REACH_OUT_STATUSES)[number]>().notNull(),
    outcome: text("outcome").$type<(typeof REACH_OUT_OUTCOMES)[number]>(),
    reason: text("reason"),
    /** Each attempt: channel, its external action and when. */
    attempts: json<Record<string, unknown>[]>("attempts").notNull().default([]),
    /** The reply, as untrusted data (never instructions). */
    reply: json("reply"),
    sources: json<string[]>("sources").notNull().default([]),
    inboxItemId: uuid("inbox_item_id"),
    nextAttemptAt: ts("next_attempt_at"),
    dueAt: ts("due_at"),
    endedAt: ts("ended_at"),
    runReceivedAt: ts("run_received_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("reach_out_id_tenant_key").on(t.id, t.tenantId),
    uniqueIndex("reach_out_step_key").on(t.tenantId, t.runId, t.nodeId),
    uniqueIndex("reach_out_open_key")
      .on(t.tenantId, t.contactId, t.subject)
      .where(sql`${t.status} <> 'ended'`),
    index("reach_out_due_idx").on(t.tenantId, t.status, t.nextAttemptAt),
    index("reach_out_contact_idx").on(t.tenantId, t.contactId, t.createdAt),
    foreignKey({
      name: "reach_out_contact_fk",
      columns: [t.contactId, t.tenantId],
      foreignColumns: [contact.id, contact.tenantId],
    }),
    foreignKey({
      name: "reach_out_run_fk",
      columns: [t.runId, t.tenantId],
      foreignColumns: [run.id, run.tenantId],
    }),
    foreignKey({
      name: "reach_out_agent_fk",
      columns: [t.agentId, t.tenantId],
      foreignColumns: [agent.id, agent.tenantId],
    }),
    check("reach_out_status_check", oneOf(t.status, REACH_OUT_STATUSES)),
    check(
      "reach_out_outcome_check",
      sql`${t.outcome} is null or ${oneOf(t.outcome, REACH_OUT_OUTCOMES)}`,
    ),
    check("reach_out_ended_check", sql`(${t.status} = 'ended') = (${t.outcome} is not null)`),
  ],
);

// ── Browser sites (docs/plan.md §1.26, phase 3) ────────────────────────────────────────────────

export const BROWSER_TIERS = ["low", "medium", "high", "blocked"] as const;

/**
 * The operator's catalogue of websites agents may sign in to (ARCHITECTURE §6.10). Operator only:
 * no client owns a site, and only operator sessions read or write it (row-level security on
 * `app.operator`). The tier is live: changing it applies to every connection on the site at once.
 * The login steps and URL rules are versioned in `browser_site_version`.
 */
// DECISION: no `tenant_id` column. A site never belongs to a client, and the RLS policy is the
// templates' `tenant_id IS NULL AND app_is_operator()` reduced to `app_is_operator()`; a column that
// is always null would only make the table look like a client's.
export const browserSite = pgTable(
  "browser_site",
  {
    id: id(),
    /** Stable name in binding keys (`browser:<slug>`) and in client connections. */
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    tier: text("tier").$type<(typeof BROWSER_TIERS)[number]>().notNull(),
    /** Who checked the site's terms allow automated access, and when; why this tier. */
    notes: text("notes").notNull().default(""),
    createdBy: uuid("created_by").references(() => appUser.id),
    createdAt: createdAt(),
    updatedBy: uuid("updated_by").references(() => appUser.id),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check("browser_site_tier_check", oneOf(t.tier, BROWSER_TIERS)),
    check("browser_site_slug_check", sql`${t.slug} ~ '^[a-z0-9][a-z0-9-]{0,62}$'`),
  ],
);

/**
 * One version of a site's profile: login page and origins, selectors, second factor, signed-in
 * check, sign-out, allowed and blocked pages (core's `BrowserSiteProfile`). Immutable and never
 * deleted (trigger); a client's browser connection pins the version it was set up on.
 */
export const browserSiteVersion = pgTable(
  "browser_site_version",
  {
    id: id(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => browserSite.id),
    version: integer("version").notNull(),
    profile: json("profile").notNull(),
    changeNote: text("change_note"),
    authorId: uuid("author_id").references(() => appUser.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("browser_site_version_site_version_key").on(t.siteId, t.version),
    check("browser_site_version_version_check", sql`${t.version} >= 1`),
  ],
);

/**
 * Every table with a `tenant_id`, in the order RLS tests walk them. Migration 0002 enables and
 * forces row-level security on each; migrations.test.ts checks this list against the database.
 */

// ── Knowledge base ───────────────────────────────────────────────────────────────────────────────

/** `voice_sample` (migration 0025): a message in a person's own voice, for writing like them. */
export const KNOWLEDGE_ENTRY_KINDS = ["faq", "policy", "voice_sample"] as const;
export const KNOWLEDGE_ENTRY_STATUSES = ["active", "archived"] as const;
export const KNOWLEDGE_AUTHOR_ROLES = ["operator", "client_admin"] as const;
export const KNOWLEDGE_SOURCE_TYPES = ["entry", "document"] as const;

/** Postgres full-text search vectors; written with `to_tsvector(...)` in SQL, never parsed here. */
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

/**
 * A client's FAQ or policy (docs/plan.md §1.21), written by the operator or the client admin. The
 * row is the entry's current state (its latest version number, archived or not); what it says
 * lives in its versions.
 */
export const knowledgeEntry = pgTable(
  "knowledge_entry",
  {
    id: id(),
    tenantId: tenantId(),
    kind: text("kind").$type<(typeof KNOWLEDGE_ENTRY_KINDS)[number]>().notNull(),
    status: text("status")
      .$type<(typeof KNOWLEDGE_ENTRY_STATUSES)[number]>()
      .notNull()
      .default("active"),
    /** The latest version's number (`knowledge_entry_version.version`). */
    version: integer("version").notNull().default(1),
    createdBy: uuid("created_by").references(() => appUser.id),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("knowledge_entry_id_tenant_key").on(t.id, t.tenantId),
    index("knowledge_entry_tenant_idx").on(t.tenantId, t.status),
    check("knowledge_entry_kind_check", oneOf(t.kind, KNOWLEDGE_ENTRY_KINDS)),
    check("knowledge_entry_status_check", oneOf(t.status, KNOWLEDGE_ENTRY_STATUSES)),
  ],
);

/**
 * Every saved state of an entry, in order: its title and text, archived or not, and who saved it.
 * Immutable (trigger): an edit or an archive inserts the next version, so this is the audit trail.
 */
export const knowledgeEntryVersion = pgTable(
  "knowledge_entry_version",
  {
    id: id(),
    tenantId: tenantId(),
    entryId: uuid("entry_id").notNull(),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    status: text("status").$type<(typeof KNOWLEDGE_ENTRY_STATUSES)[number]>().notNull(),
    authorId: uuid("author_id").references(() => appUser.id),
    authorRole: text("author_role").$type<(typeof KNOWLEDGE_AUTHOR_ROLES)[number]>().notNull(),
    createdAt: createdAt(),
    /** Voice samples: whose voice and from which channel (migration 0025). */
    meta: json<KnowledgeEntryMeta>("meta").notNull().default({}),
  },
  (t) => [
    unique("knowledge_entry_version_id_tenant_key").on(t.id, t.tenantId),
    unique("knowledge_entry_version_key").on(t.entryId, t.version),
    foreignKey({
      name: "knowledge_entry_version_entry_fk",
      columns: [t.entryId, t.tenantId],
      foreignColumns: [knowledgeEntry.id, knowledgeEntry.tenantId],
    }),
    check("knowledge_entry_version_status_check", oneOf(t.status, KNOWLEDGE_ENTRY_STATUSES)),
    check("knowledge_entry_version_role_check", oneOf(t.authorRole, KNOWLEDGE_AUTHOR_ROLES)),
    check("knowledge_entry_version_number_check", sql`${t.version} >= 1`),
  ],
);

/** `knowledge_entry_version.meta` (ARCHITECTURE §5.5). */
export interface KnowledgeEntryMeta {
  personUserId?: string;
  channel?: string;
}

/**
 * The searchable index: passages of an entry's current version, or of a document (its name and
 * latest extraction). Derived from those records and rebuilt when they change, so rows are
 * replaced, not versioned. `config` is the text-search configuration the passage was indexed
 * with (from the client's language).
 */
export const knowledgeChunk = pgTable(
  "knowledge_chunk",
  {
    id: id(),
    tenantId: tenantId(),
    sourceType: text("source_type").$type<(typeof KNOWLEDGE_SOURCE_TYPES)[number]>().notNull(),
    entryId: uuid("entry_id"),
    entryVersionId: uuid("entry_version_id"),
    documentId: uuid("document_id"),
    /** The extraction the passage was read from; null for a document not read yet. */
    extractionId: uuid("extraction_id"),
    chunkNo: integer("chunk_no").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    config: text("config").notNull().default("english"),
    tsv: tsvector("tsv").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "knowledge_chunk_entry_fk",
      columns: [t.entryId, t.tenantId],
      foreignColumns: [knowledgeEntry.id, knowledgeEntry.tenantId],
    }),
    foreignKey({
      name: "knowledge_chunk_entry_version_fk",
      columns: [t.entryVersionId, t.tenantId],
      foreignColumns: [knowledgeEntryVersion.id, knowledgeEntryVersion.tenantId],
    }),
    foreignKey({
      name: "knowledge_chunk_document_fk",
      columns: [t.documentId, t.tenantId],
      foreignColumns: [document.id, document.tenantId],
    }),
    foreignKey({
      name: "knowledge_chunk_extraction_fk",
      columns: [t.extractionId, t.tenantId],
      foreignColumns: [docExtraction.id, docExtraction.tenantId],
    }),
    index("knowledge_chunk_tsv_idx").using("gin", t.tsv),
    index("knowledge_chunk_entry_idx").on(t.entryId),
    index("knowledge_chunk_document_idx").on(t.documentId),
    index("knowledge_chunk_tenant_idx").on(t.tenantId),
    check("knowledge_chunk_source_check", oneOf(t.sourceType, KNOWLEDGE_SOURCE_TYPES)),
    // An entry's passage names its entry and version; a document's passage its document.
    check(
      "knowledge_chunk_source_ids_check",
      sql`(${t.sourceType} = 'entry' and ${t.entryId} is not null and ${t.entryVersionId} is not null and ${t.documentId} is null) or (${t.sourceType} = 'document' and ${t.documentId} is not null and ${t.entryId} is null)`,
    ),
  ],
);

// ── Billing (docs/plan.md §1.17, §1.24) ──────────────────────────────────────────────────────────
// Mezonas bills each client through Stripe: a base fee per active client agent that includes an
// allowance of credits, then usage beyond it. One credit is one cent of what the work cost us,
// priced from `usage_daily` with the unit costs below. A client's Stripe ids live in
// `tenant.settings.billing` (the webhook finds the client by customer id in that global table);
// what was reported, and the Stripe events received, are tenant tables here.

export const BILLING_REPORT_STATUSES = ["pending", "sent", "failed", "none"] as const;

/**
 * Mezonas' own billing settings: one row (`id` = 1), global, written only from `/api/ops/billing`.
 * Since §1.32 Mezonas works out each bill itself: the default agent price and included credits,
 * the price of an extra credit, auto-send and the days until due. The Stripe price ids, meter name
 * and price snapshots are from §1.24's subscriptions and are no longer read (kept, unused).
 */
export const billingSetting = pgTable(
  "billing_setting",
  {
    id: integer("id").primaryKey().default(1),
    /**
     * Credits an agent includes each month when neither the client agent nor its template sets
     * them (§1.32's default; it was §1.24's allowance per active agent). Pooled per client.
     */
    allowanceCreditsPerAgent: integer("allowance_credits_per_agent").notNull(),
    /** Unused since §1.32 (Stripe prices). */
    basePriceId: text("base_price_id"),
    /** Unused since §1.32 (Stripe prices). */
    overagePriceId: text("overage_price_id"),
    /** Unused since §1.32 (Stripe billing meter). */
    meterEventName: text("meter_event_name").notNull(),
    /** Invoices are sent (not charged to a card on file) and due this many days after. */
    daysUntilDue: integer("days_until_due").notNull().default(30),
    /** Unused since §1.32 (Stripe price snapshots). */
    baseFee: money("base_fee"),
    /** Unused since §1.32 (Stripe price snapshots). */
    overagePrice: money("overage_price"),
    currency: currency(),
    /** The monthly price of an agent with no price of its own or from its template. */
    defaultAgentPrice: money("default_agent_price").notNull().default("250.0000"),
    /** The price of one credit beyond a client's pooled allowance. */
    creditPrice: money("credit_price").notNull().default("0.0200"),
    /** Send each month's statements to Stripe as soon as they are built (off: the operator sends). */
    autoSend: boolean("auto_send").notNull().default(false),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    updatedBy: uuid("updated_by").references(() => appUser.id),
  },
  (t) => [
    check("billing_setting_singleton_check", sql`${t.id} = 1`),
    check("billing_setting_allowance_check", sql`${t.allowanceCreditsPerAgent} >= 0`),
    check("billing_setting_days_until_due_check", sql`${t.daysUntilDue} between 1 and 365`),
    check(
      "billing_setting_prices_check",
      sql`${t.defaultAgentPrice} >= 0 and ${t.creditPrice} >= 0`,
    ),
  ],
);

/**
 * What one unit of a usage measure costs us (a measure is a `usage_daily` column, by its SQL
 * name): `unit_cost` per `per_units` units, e.g. `cost_usd` 1.0000 per 1, `call_seconds` 0.1000 per
 * 60. Global, operator-written. A measure with no row is not billed.
 */
export const billingUnitCost = pgTable(
  "billing_unit_cost",
  {
    measure: text("measure").primaryKey(),
    unitCost: numeric("unit_cost", { precision: 14, scale: 4 }).notNull(),
    perUnits: integer("per_units").notNull().default(1),
    currency: currency(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    updatedBy: uuid("updated_by").references(() => appUser.id),
  },
  (t) => [
    check("billing_unit_cost_per_units_check", sql`${t.perUnits} > 0`),
    check("billing_unit_cost_nonnegative_check", sql`${t.unitCost} >= 0`),
  ],
);

/**
 * One day's usage report for a client and billing period: the period's credits through `day`, the
 * allowance, the overage, and the increment sent to Stripe (`quantity`) under `identifier`, so a
 * repeat of the day sends nothing. Immutable except status, error and sent_at; never deleted.
 */
export const billingUsageReport = pgTable(
  "billing_usage_report",
  {
    id: id(),
    tenantId: tenantId(),
    /** The billing period's first day (calendar months, UTC). */
    period: date("period").notNull(),
    day: date("day").notNull(),
    /** Active client agents when reported; the allowance is theirs, pooled. */
    agents: integer("agents").notNull(),
    allowance: integer("allowance").notNull(),
    /** Credits used in the period through `day` (each day rounded up). */
    credits: integer("credits").notNull(),
    overage: integer("overage").notNull(),
    /** Overage credits sent with this report (the increment over earlier reports). */
    quantity: integer("quantity").notNull(),
    /** What the period's work cost us through `day`, as priced (operator only). */
    costUsd: usd("cost_usd"),
    currency: currency(),
    /** The meter event's identifier and idempotency key: `<tenant>:<period>:<day>`. */
    identifier: text("identifier").notNull(),
    status: text("status").$type<(typeof BILLING_REPORT_STATUSES)[number]>().notNull(),
    error: text("error"),
    sentAt: ts("sent_at"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("billing_usage_report_day_key").on(t.tenantId, t.period, t.day),
    index("billing_usage_report_tenant_idx").on(t.tenantId, t.period),
    check("billing_usage_report_status_check", oneOf(t.status, BILLING_REPORT_STATUSES)),
    check(
      "billing_usage_report_counts_check",
      sql`${t.quantity} >= 0 and ${t.overage} >= 0 and ${t.credits} >= 0 and ${t.allowance} >= 0`,
    ),
  ],
);

/** A Stripe webhook event, stored once per event id: invoice paid or failed, subscription changes. */
export const billingEvent = pgTable(
  "billing_event",
  {
    id: id(),
    tenantId: tenantId(),
    stripeEventId: text("stripe_event_id").notNull().unique(),
    type: text("type").notNull(),
    /** The invoice or subscription id. */
    objectId: text("object_id"),
    /** What we read from it (status, amounts as decimal strings, links), not the whole event. */
    summary: json("summary").notNull().default({}),
    stripeCreatedAt: ts("stripe_created_at"),
    createdAt: createdAt(),
  },
  (t) => [index("billing_event_tenant_idx").on(t.tenantId, t.createdAt)],
);

// ── Billing statements (docs/plan.md §1.32) ──────────────────────────────────────────────────────
// Mezonas works out each client's bill; Stripe only holds the customer and the invoice, sends it
// and takes payment. Prices live here: a template's default, a client agent's override, the global
// default. Each hourly pass records which agents were active that day, with the price snapshotted;
// on the 1st the month's statement is built from those days and the credits used.

export const BILLING_PRICE_SOURCES = ["override", "template", "platform", "default"] as const;
export const BILLING_STATEMENT_STATUSES = [
  "draft",
  "sent",
  "paid",
  "payment_failed",
  "void",
  "nothing_due",
] as const;
export const BILLING_LINE_KINDS = ["agent", "usage", "adjustment"] as const;

/**
 * A template's monthly price and included credits: the default for every client agent forked from
 * it. Global like the unit costs: every session reads it, operator sessions write it.
 */
export const billingTemplatePrice = pgTable(
  "billing_template_price",
  {
    templateId: uuid("template_id")
      .primaryKey()
      .references(() => agent.id),
    monthlyPrice: money("monthly_price").notNull(),
    includedCredits: integer("included_credits").notNull(),
    currency: currency(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    updatedBy: uuid("updated_by").references(() => appUser.id),
  },
  (t) => [
    check(
      "billing_template_price_amounts_check",
      sql`${t.monthlyPrice} >= 0 and ${t.includedCredits} >= 0`,
    ),
  ],
);

/**
 * A client agent's own price, over its template's: set by the operator with a note. Changes in
 * place; every change is also written to `agent_change`.
 */
export const billingAgentPrice = pgTable(
  "billing_agent_price",
  {
    id: id(),
    tenantId: tenantId(),
    agentId: uuid("agent_id").notNull(),
    monthlyPrice: money("monthly_price").notNull(),
    includedCredits: integer("included_credits").notNull(),
    currency: currency(),
    note: text("note").notNull(),
    setBy: uuid("set_by").references(() => appUser.id),
    setAt: ts("set_at").notNull().defaultNow(),
  },
  (t) => [
    unique("billing_agent_price_agent_key").on(t.tenantId, t.agentId),
    foreignKey({
      name: "billing_agent_price_agent_fk",
      columns: [t.agentId, t.tenantId],
      foreignColumns: [agent.id, agent.tenantId],
    }),
    check(
      "billing_agent_price_amounts_check",
      sql`${t.monthlyPrice} >= 0 and ${t.includedCredits} >= 0`,
    ),
    check("billing_agent_price_note_check", sql`length(trim(${t.note})) > 0`),
  ],
);

/**
 * One day (UTC) a client agent was active at an hourly pass, with the price and credits it had
 * then (the first seen that day sticks). What statements are built from. Never updated or deleted.
 */
export const billingAgentDay = pgTable(
  "billing_agent_day",
  {
    tenantId: tenantId(),
    day: date("day").notNull(),
    agentId: uuid("agent_id").notNull(),
    /** The name the client knows it by (service name, else agent name), as it was that day. */
    agentName: text("agent_name").notNull(),
    monthlyPrice: money("monthly_price").notNull(),
    includedCredits: integer("included_credits").notNull(),
    currency: currency(),
    priceSource: text("price_source").$type<(typeof BILLING_PRICE_SOURCES)[number]>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.day, t.agentId] }),
    foreignKey({
      name: "billing_agent_day_agent_fk",
      columns: [t.agentId, t.tenantId],
      foreignColumns: [agent.id, agent.tenantId],
    }),
    check("billing_agent_day_source_check", oneOf(t.priceSource, BILLING_PRICE_SOURCES)),
    check(
      "billing_agent_day_amounts_check",
      sql`${t.monthlyPrice} >= 0 and ${t.includedCredits} >= 0`,
    ),
  ],
);

/**
 * A client's statement for one calendar month (UTC): Mezonas' record of the bill. Its lines are in
 * `billing_statement_line`. One per client and month. A draft's total follows its adjustments;
 * once its send has started, only the status, Stripe's ids and links, and their times change.
 */
export const billingStatement = pgTable(
  "billing_statement",
  {
    id: id(),
    tenantId: tenantId(),
    /** The month's first day. */
    period: date("period").notNull(),
    periodEnd: date("period_end").notNull(),
    daysInMonth: integer("days_in_month").notNull(),
    status: text("status").$type<(typeof BILLING_STATEMENT_STATUSES)[number]>().notNull(),
    currency: currency(),
    total: usd("total"),
    creditsUsed: integer("credits_used").notNull(),
    /** The pooled allowance: each agent's credits × its billed days ÷ days in the month. */
    creditsIncluded: integer("credits_included").notNull(),
    extraCredits: integer("extra_credits").notNull(),
    creditPrice: money("credit_price").notNull(),
    stripeInvoiceId: text("stripe_invoice_id"),
    stripeInvoiceNumber: text("stripe_invoice_number"),
    hostedInvoiceUrl: text("hosted_invoice_url"),
    invoicePdfUrl: text("invoice_pdf_url"),
    dueAt: ts("due_at"),
    finalizedAt: ts("finalized_at"),
    sentAt: ts("sent_at"),
    sentBy: uuid("sent_by").references(() => appUser.id),
    paidAt: ts("paid_at"),
    voidedAt: ts("voided_at"),
    voidedBy: uuid("voided_by").references(() => appUser.id),
    /** Why the last send stopped; cleared when a send finishes. */
    sendError: text("send_error"),
    /** The `created` time of the last Stripe event applied, so older events change nothing. */
    stripeEventAt: ts("stripe_event_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("billing_statement_period_key").on(t.tenantId, t.period),
    unique("billing_statement_id_tenant_key").on(t.id, t.tenantId),
    index("billing_statement_invoice_idx").on(t.stripeInvoiceId),
    index("billing_statement_status_idx").on(t.tenantId, t.status),
    check("billing_statement_status_check", oneOf(t.status, BILLING_STATEMENT_STATUSES)),
    check(
      "billing_statement_counts_check",
      sql`${t.creditsUsed} >= 0 and ${t.creditsIncluded} >= 0 and ${t.extraCredits} >= 0 and ${t.creditPrice} >= 0 and ${t.daysInMonth} between 28 and 31`,
    ),
  ],
);

/**
 * One line of a statement: an agent's prorated price, the extra usage, or an operator's
 * adjustment (positive or negative). Amounts are rounded to cents. Lines are inserted while the
 * statement is a draft; afterwards only Stripe's invoice item id is set, once.
 */
export const billingStatementLine = pgTable(
  "billing_statement_line",
  {
    id: id(),
    tenantId: tenantId(),
    statementId: uuid("statement_id").notNull(),
    position: integer("position").notNull(),
    kind: text("kind").$type<(typeof BILLING_LINE_KINDS)[number]>().notNull(),
    agentId: uuid("agent_id"),
    description: text("description").notNull(),
    amount: money("amount").notNull(),
    currency: currency(),
    /** How the amount was worked out (days, prices, credits) as decimal strings and integers. */
    detail: json("detail").notNull().default({}),
    stripeInvoiceItemId: text("stripe_invoice_item_id"),
    createdBy: uuid("created_by").references(() => appUser.id),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "billing_statement_line_statement_fk",
      columns: [t.statementId, t.tenantId],
      foreignColumns: [billingStatement.id, billingStatement.tenantId],
    }),
    foreignKey({
      name: "billing_statement_line_agent_fk",
      columns: [t.agentId, t.tenantId],
      foreignColumns: [agent.id, agent.tenantId],
    }),
    index("billing_statement_line_statement_idx").on(t.statementId, t.position),
    check("billing_statement_line_kind_check", oneOf(t.kind, BILLING_LINE_KINDS)),
    check(
      "billing_statement_line_agent_check",
      sql`(${t.kind} = 'agent') = (${t.agentId} is not null)`,
    ),
  ],
);

// ── Access: client data keys and agent grants (docs/plan.md §1.26) ──────────────────────────────

export const TENANT_KEY_STATUSES = ["active", "retired", "destroyed"] as const;

/**
 * A client's data key, which encrypts that client's connection secrets (credential envelope v2).
 * Stored only wrapped: AES-256-GCM under the deployment's `ENCRYPTION_KEY`, with the client id as
 * additional data, as `{ v, alg, kid, iv, ct }` (`kid` names the master key, so a master key
 * rotation knows which rows to re-wrap). One `active` key per client, created on first use.
 * Destroying a key wipes `wrapped_key`: everything it encrypted is unreadable from then on.
 */
// DECISION: `wrapped_key` is jsonb in the shape of the v1 credential envelope rather than bytea, so
// the master key's id travels with it and the column reads like `credentials_encrypted`.
export const tenantKey = pgTable(
  "tenant_key",
  {
    id: id(),
    tenantId: tenantId(),
    /** Null once destroyed. */
    wrappedKey: json<WrappedTenantKey>("wrapped_key"),
    status: text("status")
      .$type<(typeof TENANT_KEY_STATUSES)[number]>()
      .notNull()
      .default("active"),
    createdAt: createdAt(),
    retiredAt: ts("retired_at"),
  },
  (t) => [
    unique("tenant_key_id_tenant_key").on(t.id, t.tenantId),
    uniqueIndex("tenant_key_active_key").on(t.tenantId).where(sql`${t.status} = 'active'`),
    check("tenant_key_status_check", oneOf(t.status, TENANT_KEY_STATUSES)),
    check(
      "tenant_key_destroyed_check",
      sql`(${t.status} = 'destroyed') = (${t.wrappedKey} is null)`,
    ),
  ],
);

/** A client data key wrapped by a master key (see `tenant_key`). */
export interface WrappedTenantKey {
  v: 1;
  alg: "A256GCM";
  /** The master key's id (derived from the key, as credential envelopes v1 name it). */
  kid: string;
  iv: string;
  ct: string;
}

/**
 * What one client agent may do through one bound connection, narrowing the binding (docs/plan.md
 * §1.26 "Grants"). No row means no narrowing. Validated by core's `GrantLimits`.
 */
export interface AgentGrantLimits {
  verbs?:
    | {
        [verb in "read" | "create" | "update" | "delete"]?: "auto" | "approval" | "off" | undefined;
      }
    | undefined;
  tools?: string[] | undefined;
}

/**
 * A client agent's grant on one connection: the binding is the grant, and a row only narrows it
 * (a ceiling per verb, a subset of the connector's tools). Every change is an `agent_change` row.
 */
export const agentGrant = pgTable(
  "agent_grant",
  {
    tenantId: tenantId(),
    agentId: uuid("agent_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    limits: json<AgentGrantLimits>("limits").notNull().default({}),
    updatedBy: uuid("updated_by").references(() => appUser.id),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    primaryKey({ name: "agent_grant_pkey", columns: [t.agentId, t.connectionId] }),
    index("agent_grant_connection_idx").on(t.tenantId, t.connectionId),
    foreignKey({
      name: "agent_grant_agent_fk",
      columns: [t.agentId, t.tenantId],
      foreignColumns: [agent.id, agent.tenantId],
    }),
    foreignKey({
      name: "agent_grant_connection_fk",
      columns: [t.connectionId, t.tenantId],
      foreignColumns: [connection.id, connection.tenantId],
    }),
  ],
);

// ── Human release (migration 0013, docs/plan.md §1.26 "Human release") ──────────────────────────

/** Mirrors core's RELEASE_STATUSES (this file imports core only for types). */
export const ACCESS_RELEASE_STATUSES = [
  "pending",
  "released",
  "expired",
  "failed",
  "revoked",
  "void",
] as const;
export const ACCESS_RELEASE_CHANNELS = ["sms", "email"] as const;

/**
 * One request for a person to release a vault item (a connection) to one client agent, made by a
 * step of one run: the code went to the person by text or email, and only its HMAC is kept
 * (`code_hash`, under a key derived from ENCRYPTION_KEY). Append-mostly: only the status columns
 * change (status, tries, released_at, valid_until, revoked_by); never deleted. A `run` release has
 * no `valid_until` and covers its run only; an hours release covers the connection and agent until
 * `valid_until`.
 */
export const accessRelease = pgTable(
  "access_release",
  {
    id: id(),
    tenantId: tenantId(),
    connectionId: uuid("connection_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    runId: uuid("run_id").notNull(),
    personId: uuid("person_id")
      .notNull()
      .references(() => appUser.id),
    channel: text("channel").$type<(typeof ACCESS_RELEASE_CHANNELS)[number]>().notNull(),
    /** Hex HMAC-SHA256 of the request id and the code; never the code. */
    codeHash: text("code_hash").notNull(),
    expiresAt: ts("expires_at").notNull(),
    tries: integer("tries").notNull().default(0),
    status: text("status")
      .$type<(typeof ACCESS_RELEASE_STATUSES)[number]>()
      .notNull()
      .default("pending"),
    releasedAt: ts("released_at"),
    validUntil: ts("valid_until"),
    revokedBy: uuid("revoked_by").references(() => appUser.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("access_release_id_tenant_key").on(t.id, t.tenantId),
    foreignKey({
      name: "access_release_connection_fk",
      columns: [t.connectionId, t.tenantId],
      foreignColumns: [connection.id, connection.tenantId],
    }),
    foreignKey({
      name: "access_release_agent_fk",
      columns: [t.agentId, t.tenantId],
      foreignColumns: [agent.id, agent.tenantId],
    }),
    foreignKey({
      name: "access_release_run_fk",
      columns: [t.runId, t.tenantId],
      foreignColumns: [run.id, run.tenantId],
    }),
    index("access_release_lookup_idx").on(t.tenantId, t.connectionId, t.agentId, t.status),
    index("access_release_run_idx").on(t.runId),
    check("access_release_status_check", oneOf(t.status, ACCESS_RELEASE_STATUSES)),
    check("access_release_channel_check", oneOf(t.channel, ACCESS_RELEASE_CHANNELS)),
    check("access_release_tries_check", sql`${t.tries} between 0 and 5`),
    check(
      "access_release_released_check",
      sql`(${t.status} in ('released', 'revoked')) = (${t.releasedAt} is not null)`,
    ),
  ],
);

// ── Audit log (docs/plan.md §1.35) ───────────────────────────────────────────────────────────────

export const AUDIT_OUTCOMES = ["ok", "refused", "error"] as const;
export const AUDIT_ACTOR_KINDS = ["user", "system", "anonymous"] as const;

/**
 * Who did what, when, from where, to which records: one row per request to a session route (reads
 * included), per sign-in, sign-out and refused sign-in, and per operator action outside a request.
 * Append-only for everyone but the table's owner (trigger and grants, migration 0017). `tenant_id`
 * is the client acted in, or null (sign-in, cross-client back-office lists). No foreign keys, so
 * the log outlives a purged client or user (it holds ids, never the records' content).
 */
export const auditEvent = pgTable(
  "audit_event",
  {
    id: id(),
    tenantId: uuid("tenant_id"),
    actorKind: text("actor_kind").$type<(typeof AUDIT_ACTOR_KINDS)[number]>().notNull(),
    actorUserId: uuid("actor_user_id"),
    /** The address signed in with, as it was then. */
    actorEmail: text("actor_email"),
    actorRole: text("actor_role"),
    /** `GET /api/runs/:id` for a route; `session.sign_in`, `client.retire`… otherwise. */
    action: text("action").notNull(),
    outcome: text("outcome").$type<(typeof AUDIT_OUTCOMES)[number]>().notNull(),
    httpStatus: integer("http_status"),
    /** The ids the action named (route params, `?client=`); never bodies or record content. */
    target: json("target").notNull().default({}),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_event_tenant_idx").on(t.tenantId, t.createdAt),
    index("audit_event_actor_idx").on(t.actorUserId, t.createdAt),
    index("audit_event_created_idx").on(t.createdAt),
    check("audit_event_outcome_check", oneOf(t.outcome, AUDIT_OUTCOMES)),
    check("audit_event_actor_kind_check", oneOf(t.actorKind, AUDIT_ACTOR_KINDS)),
  ],
);

// ── Notifications and the Weekly Table (migration 0020, ARCHITECTURE §11.3, §11.4) ─────────────

export const NOTIFICATION_CHANNELS = ["email", "sms"] as const;
export const NOTIFICATION_KINDS = [
  "items_waiting",
  "weekly_table",
  "reconnect",
  "credits",
  "lead_message",
  "signoff",
] as const;
export const NOTIFICATION_STATUSES = ["queued", "sent", "failed", "skipped"] as const;
export const WEEKLY_TABLE_STATUSES = ["draft", "sent"] as const;

/**
 * One email or text telling a person something is waiting: a count and a link, never record
 * content (plan §1.35). Sent once per `dedupe_key` and channel. Only `status`, `reason`,
 * `provider_id` and `sent_at` change (trigger); never deleted.
 */
export const notification = pgTable(
  "notification",
  {
    id: id(),
    tenantId: tenantId(),
    /** The person: a user of the client (or its operator), or a contact. */
    userId: uuid("user_id").references(() => appUser.id),
    contactId: uuid("contact_id"),
    channel: text("channel").$type<(typeof NOTIFICATION_CHANNELS)[number]>().notNull(),
    kind: text("kind").$type<(typeof NOTIFICATION_KINDS)[number]>().notNull(),
    /** e.g. `items_waiting:<user>:<hour>`: the same key on the same channel is sent once. */
    dedupeKey: text("dedupe_key").notNull(),
    /** Where the person goes: a page of the portal or the back office. */
    link: text("link").notNull(),
    /** What the message counts, e.g. `{ items: 3 }`. Numbers only. */
    counts: json<Record<string, number>>("counts").notNull().default({}),
    status: text("status")
      .$type<(typeof NOTIFICATION_STATUSES)[number]>()
      .notNull()
      .default("queued"),
    /** Why it failed or was skipped (quiet hours, opted out, no address). */
    reason: text("reason"),
    /** The provider's message id (Resend, Twilio). */
    providerId: text("provider_id"),
    createdAt: createdAt(),
    sentAt: ts("sent_at"),
  },
  (t) => [
    unique("notification_dedupe_key").on(t.tenantId, t.channel, t.dedupeKey),
    foreignKey({
      name: "notification_contact_fk",
      columns: [t.contactId, t.tenantId],
      foreignColumns: [contact.id, contact.tenantId],
    }),
    index("notification_tenant_idx").on(t.tenantId, t.createdAt),
    index("notification_queued_idx").on(t.createdAt).where(sql`${t.status} = 'queued'`),
    check("notification_channel_check", oneOf(t.channel, NOTIFICATION_CHANNELS)),
    check("notification_kind_check", oneOf(t.kind, NOTIFICATION_KINDS)),
    check("notification_status_check", oneOf(t.status, NOTIFICATION_STATUSES)),
  ],
);

/** One decision the Weekly Table asks the client for, and its reply once given. */
export interface WeeklyTableDecision {
  id: string;
  title: string;
  body: string;
  options: string[];
  /** Record ids the decision rests on (CLAUDE.md invariant 10). */
  sources: string[];
  reply?: { by: string; at: string; messageId: string };
}

/**
 * A client's week, one per client and week (`week_start`, its first day): the figures, the lead's
 * note, the decisions asked for, next week's plan and what was set up. A draft until it is sent;
 * decisions take their replies after that. Updated in place, never deleted.
 */
export const weeklyTable = pgTable(
  "weekly_table",
  {
    id: id(),
    tenantId: tenantId(),
    weekStart: date("week_start").notNull(),
    status: text("status")
      .$type<(typeof WEEKLY_TABLE_STATUSES)[number]>()
      .notNull()
      .default("draft"),
    stats: json("stats").notNull().default({}),
    note: text("note"),
    noteBy: uuid("note_by").references(() => appUser.id),
    decisions: json<WeeklyTableDecision[]>("decisions").notNull().default([]),
    nextWeek: text("next_week"),
    setup: json("setup").notNull().default({}),
    sentAt: ts("sent_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("weekly_table_week_key").on(t.tenantId, t.weekStart),
    unique("weekly_table_id_tenant_key").on(t.id, t.tenantId),
    check("weekly_table_status_check", oneOf(t.status, WEEKLY_TABLE_STATUSES)),
    check("weekly_table_sent_check", sql`(${t.status} = 'sent') = (${t.sentAt} is not null)`),
  ],
);

// ── Accounts receivable (migration 0024, ARCHITECTURE §6.2) ──────────────────────────────────────

export const RECEIVABLE_STATUSES = ["open", "paid", "void", "deleted"] as const;

/**
 * An invoice the client sent its customer, as synced from QuickBooks (`Invoice`): its total, what
 * is still owed (`balance`) and its status. Updated in place by each synced version (the versions
 * themselves stay in `raw_record`, the latest is `source_raw_record_id`); never deleted (a deleted
 * invoice keeps its row with status `deleted`).
 */
export const receivable = pgTable(
  "receivable",
  {
    id: id(),
    tenantId: tenantId(),
    connectionId: uuid("connection_id").notNull(),
    /** `qbo`. */
    connector: text("connector").notNull(),
    externalId: text("external_id").notNull(),
    /** QuickBooks' DocNumber; null when the invoice has none (it is optional there). */
    docNumber: text("doc_number"),
    customerExternalId: text("customer_external_id").notNull(),
    customerName: text("customer_name").notNull(),
    /** The customer's organization in the client's directory, once matched or imported. */
    organizationId: uuid("organization_id"),
    txnDate: date("txn_date").notNull(),
    dueDate: date("due_date"),
    total: money("total").notNull(),
    balance: money("balance").notNull(),
    currency: currency(),
    status: text("status").$type<(typeof RECEIVABLE_STATUSES)[number]>().notNull(),
    /** QuickBooks' PrivateNote (the only field `qbo.invoice.add_note` writes). */
    privateNote: text("private_note"),
    sourceRawRecordId: uuid("source_raw_record_id").notNull(),
    ext: json("ext").notNull().default({}),
    createdAt: createdAt(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("receivable_external_key").on(t.connectionId, t.externalId),
    unique("receivable_id_tenant_key").on(t.id, t.tenantId),
    foreignKey({
      name: "receivable_connection_fk",
      columns: [t.connectionId, t.tenantId],
      foreignColumns: [connection.id, connection.tenantId],
    }),
    foreignKey({
      name: "receivable_organization_fk",
      columns: [t.organizationId, t.tenantId],
      foreignColumns: [organization.id, organization.tenantId],
    }),
    foreignKey({
      name: "receivable_raw_record_fk",
      columns: [t.sourceRawRecordId, t.tenantId],
      foreignColumns: [rawRecord.id, rawRecord.tenantId],
    }),
    // Aging: a client's open invoices by due date.
    index("receivable_open_idx").on(t.tenantId, t.status, t.dueDate),
    index("receivable_customer_idx").on(t.tenantId, t.customerExternalId),
    check("receivable_status_check", oneOf(t.status, RECEIVABLE_STATUSES)),
  ],
);

// ── The connectors catalog (migration 0026, ARCHITECTURE §6.1) ─────────────────────────────────

export const CONNECTOR_STATUSES = ["live", "beta", "in_review", "building"] as const;
export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number];

/**
 * The operator's setting for one registered connector (a connector's manifest `id`): its status in
 * the catalog, the default access a client's connection starts with when it is first made, and a
 * note. Operator table like `browser_site` (no client owns a row; RLS on `app.operator`). Updated in
 * place, never deleted. A connector without a row reads as the platform's defaults.
 */
export const connectorSetting = pgTable(
  "connector_setting",
  {
    /** The manifest's `id` (`qbo`, `gmail`…). */
    connector: text("connector").primaryKey(),
    status: text("status").$type<ConnectorStatus>().notNull(),
    /** A matrix with entities (core's `PermissionMatrix`); null: the manifest's, else the platform's. */
    defaultPermissions: json<PermissionMatrix>("default_permissions"),
    note: text("note").notNull().default(""),
    updatedBy: uuid("updated_by").references(() => appUser.id),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check("connector_setting_status_check", oneOf(t.status, CONNECTOR_STATUSES)),
    check("connector_setting_connector_check", sql`length(${t.connector}) between 1 and 64`),
  ],
);

// ── Automations (migration 0027, ARCHITECTURE §10.7) ────────────────────────────────────────────
// Rows follow skills exactly: shared (tenant_id null, operator only) or written for one client.

/**
 * A reusable, versioned chain of steps, used in a workflow as one `use_automation` step. `slug` is
 * unique among the shared automations and within each client (`shared:<slug>` for a shared one
 * copied into a client).
 */
export const automation = pgTable(
  "automation",
  {
    id: id(),
    tenantId: optionalTenantId(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    liveVersionId: uuid("live_version_id").references((): AnyPgColumn => automationVersion.id),
    status: text("status").$type<(typeof SKILL_STATUSES)[number]>().notNull().default("active"),
    createdAt: createdAt(),
  },
  (t) => [
    // Nulls not distinct: shared automations (tenant_id null) are unique among themselves too.
    unique("automation_tenant_slug_key").on(t.tenantId, t.slug).nullsNotDistinct(),
    unique("automation_id_tenant_key").on(t.id, t.tenantId),
    check("automation_status_check", oneOf(t.status, SKILL_STATUSES)),
  ],
);

/**
 * One version of an automation: `definition` is core's `Automation` (input schema, steps, output,
 * requires). Immutable except `status` (trigger), like `skill_version`.
 */
export const automationVersion = pgTable(
  "automation_version",
  {
    id: id(),
    tenantId: optionalTenantId(),
    automationId: uuid("automation_id").notNull(),
    version: integer("version").notNull(),
    definition: json("definition").notNull(),
    definitionHash: text("definition_hash").notNull(),
    status: text("status").$type<(typeof VERSION_STATUSES)[number]>().notNull().default("draft"),
    changeNote: text("change_note"),
    authorId: uuid("author_id").references(() => appUser.id),
    parentVersionId: uuid("parent_version_id").references((): AnyPgColumn => automationVersion.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("automation_version_automation_version_key").on(t.automationId, t.version),
    // A version belongs to its automation's tenant (enforced whenever tenant_id is set).
    foreignKey({
      name: "automation_version_automation_fk",
      columns: [t.automationId, t.tenantId],
      foreignColumns: [automation.id, automation.tenantId],
    }),
    foreignKey({
      name: "automation_version_automation_id_fk",
      columns: [t.automationId],
      foreignColumns: [automation.id],
    }),
    index("automation_version_tenant_idx").on(t.tenantId),
    check("automation_version_status_check", oneOf(t.status, VERSION_STATUSES)),
    check("automation_version_version_check", sql`${t.version} >= 1`),
  ],
);

// ── The test bench (migration 0028, ARCHITECTURE §9.10) ─────────────────────────────────────────
// Shared cases and their runs have tenant_id null (operator only); a case built from a client's
// records carries that client's id and never runs or shows outside it (CLAUDE.md invariant 1).

export const TEST_TARGET_KINDS = ["skill", "template"] as const;
export type TestTargetKind = (typeof TEST_TARGET_KINDS)[number];
export const TEST_CASE_SOURCES = ["manual", "builder", "run"] as const;
export const TEST_SUITE_RUN_STATUSES = ["running", "done", "failed"] as const;
export const TEST_CASE_RESULT_STATUSES = ["pass", "fail", "error"] as const;

/**
 * One saved example for a skill or a template: the input (a trigger payload for a template), the
 * answers read tools give (`fixtures`), the expected output and how to compare (`matcher`, core's
 * test bench schemas). Edited in place; archived, never deleted.
 */
// DECISION: `target_id` (and a suite run's `version_id`) has no foreign key: it names a skill or a
// template by `target_kind`, and a client's case may target a shared skill or a template, whose
// rows have no client. The routes check the target exists in the session's scope.
export const testCase = pgTable(
  "test_case",
  {
    id: id(),
    tenantId: optionalTenantId(),
    targetKind: text("target_kind").$type<TestTargetKind>().notNull(),
    /** `skill.id` or the template's `agent.id`. */
    targetId: uuid("target_id").notNull(),
    name: text("name").notNull(),
    input: json<unknown>("input").notNull(),
    fixtures: json<unknown>("fixtures").notNull().default([]),
    expected: json<unknown>("expected").notNull(),
    matcher: json("matcher").notNull(),
    /** A required case must pass for the publish gate. */
    required: boolean("required").notNull().default(true),
    source: text("source").$type<(typeof TEST_CASE_SOURCES)[number]>().notNull().default("manual"),
    /** The run, message or Builder turn the case came from. */
    sourceRef: text("source_ref"),
    createdBy: uuid("created_by").references(() => appUser.id),
    createdAt: createdAt(),
    archivedAt: ts("archived_at"),
  },
  (t) => [
    unique("test_case_id_tenant_key").on(t.id, t.tenantId),
    index("test_case_target_idx").on(t.targetKind, t.targetId).where(sql`${t.archivedAt} is null`),
    index("test_case_tenant_idx").on(t.tenantId),
    check("test_case_target_kind_check", oneOf(t.targetKind, TEST_TARGET_KINDS)),
    check("test_case_source_check", oneOf(t.source, TEST_CASE_SOURCES)),
    check("test_case_name_check", sql`length(trim(${t.name})) between 1 and 200`),
  ],
);

/**
 * One run of a target's cases at one version (`skill_version.id` or the template's
 * `agent_version.id`): counts, metrics (`{passRate, precision?, costPerCase}`) and cost, the
 * operator's (never a client's usage). Updated while running; never deleted.
 */
export const testSuiteRun = pgTable(
  "test_suite_run",
  {
    id: id(),
    tenantId: optionalTenantId(),
    targetKind: text("target_kind").$type<TestTargetKind>().notNull(),
    targetId: uuid("target_id").notNull(),
    versionId: uuid("version_id").notNull(),
    status: text("status")
      .$type<(typeof TEST_SUITE_RUN_STATUSES)[number]>()
      .notNull()
      .default("running"),
    total: integer("total").notNull().default(0),
    passed: integer("passed").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    metrics: json("metrics").notNull().default({}),
    costUsd: usd("cost_usd"),
    startedBy: uuid("started_by").references(() => appUser.id),
    createdAt: createdAt(),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    unique("test_suite_run_id_tenant_key").on(t.id, t.tenantId),
    // The publish gate: the latest suite run of a version.
    index("test_suite_run_version_idx").on(t.targetKind, t.versionId, t.createdAt),
    index("test_suite_run_target_idx").on(t.targetKind, t.targetId, t.createdAt),
    index("test_suite_run_tenant_idx").on(t.tenantId),
    check("test_suite_run_target_kind_check", oneOf(t.targetKind, TEST_TARGET_KINDS)),
    check("test_suite_run_status_check", oneOf(t.status, TEST_SUITE_RUN_STATUSES)),
    check(
      "test_suite_run_counts_check",
      sql`${t.total} >= 0 and ${t.passed} >= 0 and ${t.failed} >= 0 and ${t.passed} + ${t.failed} <= ${t.total} and ${t.costUsd} >= 0`,
    ),
    check(
      "test_suite_run_finished_check",
      sql`(${t.status} = 'running') = (${t.finishedAt} is null)`,
    ),
  ],
);

/** One case's result in a suite run: what it got and the difference. Insert only (trigger). */
export const testCaseResult = pgTable(
  "test_case_result",
  {
    id: id(),
    tenantId: optionalTenantId(),
    suiteRunId: uuid("suite_run_id").notNull(),
    testCaseId: uuid("test_case_id").notNull(),
    status: text("status").$type<(typeof TEST_CASE_RESULT_STATUSES)[number]>().notNull(),
    got: json<unknown>("got"),
    diff: json<unknown>("diff"),
    costUsd: usd("cost_usd"),
    /** A template case's test run. */
    runId: uuid("run_id"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("test_case_result_case_key").on(t.suiteRunId, t.testCaseId),
    // Same client as its suite run and case (enforced whenever tenant_id is set), and existing.
    foreignKey({
      name: "test_case_result_suite_run_fk",
      columns: [t.suiteRunId, t.tenantId],
      foreignColumns: [testSuiteRun.id, testSuiteRun.tenantId],
    }),
    foreignKey({
      name: "test_case_result_suite_run_id_fk",
      columns: [t.suiteRunId],
      foreignColumns: [testSuiteRun.id],
    }),
    foreignKey({
      name: "test_case_result_case_fk",
      columns: [t.testCaseId, t.tenantId],
      foreignColumns: [testCase.id, testCase.tenantId],
    }),
    foreignKey({
      name: "test_case_result_case_id_fk",
      columns: [t.testCaseId],
      foreignColumns: [testCase.id],
    }),
    // DECISION: a client's result points at a run of that client only. A shared case's run is a
    // test run of the template's copy in the Sandbox client, so a shared result's run_id is not
    // tied by a foreign key (one to run(id) alone would also block purging the Sandbox).
    foreignKey({
      name: "test_case_result_run_fk",
      columns: [t.runId, t.tenantId],
      foreignColumns: [run.id, run.tenantId],
    }),
    index("test_case_result_tenant_idx").on(t.tenantId),
    index("test_case_result_case_idx").on(t.testCaseId, t.createdAt),
    check("test_case_result_status_check", oneOf(t.status, TEST_CASE_RESULT_STATUSES)),
    check("test_case_result_cost_check", sql`${t.costUsd} >= 0`),
  ],
);

// ── Run oversight (migration 0029, ARCHITECTURE v0.13 §5.6, §10.11) ────────────────────────────

export const OVERSIGHT_CAUSES = ["failed", "checkpoint"] as const;
export const OVERSIGHT_ACTIONS = ["continue", "retry", "retry_with", "ask", "stop"] as const;
export type OversightAction = (typeof OVERSIGHT_ACTIONS)[number];

/**
 * One decision the run's own agent took about a step that failed or reached a checkpoint: what it
 * did (`action`), its diagnosis (`note`, operator only), the corrected input for `retry_with`, a
 * lasting fix it proposes, the records it relied on, and what the review cost. `seq` counts from 1
 * per step node within the run. Back office only (no portal route returns it). Insert only
 * (grants and trigger): the inbox item an `ask` or a proposal opens is created first.
 */
export const oversightDecision = pgTable(
  "oversight_decision",
  {
    id: id(),
    tenantId: tenantId(),
    runId: uuid("run_id").notNull(),
    stepRunId: uuid("step_run_id").notNull(),
    nodeId: text("node_id").notNull(),
    seq: integer("seq").notNull(),
    cause: text("cause").$type<(typeof OVERSIGHT_CAUSES)[number]>().notNull(),
    action: text("action").$type<OversightAction>().notNull(),
    /** `retry_with` only: the step's input before and after the correction. */
    inputBefore: json<unknown>("input_before"),
    inputAfter: json<unknown>("input_after"),
    note: text("note").notNull(),
    /** `{summary, change}`: a lasting fix, proposed to the operator. */
    proposal: json<{ summary: string; change: unknown }>("proposal"),
    inboxItemId: uuid("inbox_item_id"),
    /** Record ids the decision relied on (CLAUDE.md invariant 10). */
    sources: json<string[]>("sources").notNull().default([]),
    model: text("model").notNull(),
    costUsd: usd("cost_usd"),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    agentVersionId: uuid("agent_version_id")
      .notNull()
      .references(() => agentVersion.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("oversight_decision_seq_key").on(t.runId, t.nodeId, t.seq),
    foreignKey({
      name: "oversight_decision_run_fk",
      columns: [t.runId, t.tenantId],
      foreignColumns: [run.id, run.tenantId],
    }),
    foreignKey({
      name: "oversight_decision_step_run_fk",
      columns: [t.stepRunId, t.tenantId],
      foreignColumns: [stepRun.id, stepRun.tenantId],
    }),
    foreignKey({
      name: "oversight_decision_inbox_item_fk",
      columns: [t.inboxItemId, t.tenantId],
      foreignColumns: [inboxItem.id, inboxItem.tenantId],
    }),
    index("oversight_decision_step_run_idx").on(t.stepRunId),
    index("oversight_decision_tenant_idx").on(t.tenantId, t.createdAt),
    check("oversight_decision_cause_check", oneOf(t.cause, OVERSIGHT_CAUSES)),
    check("oversight_decision_action_check", oneOf(t.action, OVERSIGHT_ACTIONS)),
    check("oversight_decision_seq_check", sql`${t.seq} >= 1`),
    check(
      "oversight_decision_input_check",
      sql`(${t.action} = 'retry_with') = (${t.inputAfter} is not null) and (${t.inputBefore} is null or ${t.action} = 'retry_with')`,
    ),
    check("oversight_decision_note_check", sql`length(${t.note}) between 1 and 2000`),
    check("oversight_decision_sources_check", sql`jsonb_typeof(${t.sources}) = 'array'`),
    check(
      "oversight_decision_amounts_check",
      sql`${t.tokensIn} >= 0 and ${t.tokensOut} >= 0 and ${t.costUsd} >= 0`,
    ),
  ],
);

/**
 * Every table with a `tenant_id`, in the order RLS tests walk them. Migration 0002 enables and
 * forces row-level security on each; migrations.test.ts checks this list against the database.
 */

export const TENANT_TABLES = [
  "membership",
  "connection",
  "connection_change",
  "raw_record",
  "external_action",
  "tenant_pack",
  "skill",
  "skill_version",
  "agent",
  "agent_version",
  "agent_change",
  "run",
  "step_run",
  "tool_call",
  "event",
  "thread",
  "message",
  "inbox_item",
  "memory_note",
  "usage_daily",
  "vendor",
  "transaction",
  "transaction_line",
  "document",
  "doc_extraction",
  "doc_line",
  "tenant_change",
  "feedback",
  "contact",
  "contact_change",
  "knowledge_entry",
  "knowledge_entry_version",
  "knowledge_chunk",
  "billing_usage_report",
  "billing_event",
  "reach_out",
  "tenant_key",
  "agent_grant",
  "access_release",
  "organization",
  "organization_change",
  "billing_agent_price",
  "billing_agent_day",
  "billing_statement",
  "billing_statement_line",
  "audit_event",
  "usage_platform_daily",
  "notification",
  "weekly_table",
  "thread_read",
  "model_call",
  "receivable",
  "automation",
  "automation_version",
  "test_case",
  "test_suite_run",
  "test_case_result",
  "oversight_decision",
] as const;
export type TenantTable = (typeof TENANT_TABLES)[number];

/** Tenant tables whose rows may also belong to the operator (tenant_id null; ARCHITECTURE §4). */
export const OPERATOR_TABLES = [
  "skill",
  "skill_version",
  "agent",
  "agent_version",
  "agent_change",
  "feedback",
  "audit_event",
  "automation",
  "automation_version",
  "test_case",
  "test_suite_run",
  "test_case_result",
] as const satisfies readonly TenantTable[];

/** Global tables only operator sessions may read or write (row-level security on `app.operator`). */
export const OPERATOR_ONLY_TABLES = [
  "browser_site",
  "browser_site_version",
  "saved_view",
  "connector_setting",
] as const;
