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
export const MESSAGE_SENDER_TYPES = ["agent", "user", "system"] as const;
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
    /** Null = the client's setting. */
    approver: text("approver").$type<(typeof AGENT_APPROVERS)[number]>(),
    runStatus: text("run_status").$type<(typeof AGENT_RUN_STATUSES)[number]>(),
    /**
     * A template's test copy in the Sandbox client: what a template test run runs (docs/plan.md
     * §1.5). Never activated, never routed; one per template and client.
     */
    testCopy: boolean("test_copy").notNull().default(false),
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
  ],
);

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
  },
  (t) => [
    unique("run_id_tenant_key").on(t.id, t.tenantId),
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
  },
  (t) => [
    unique("inbox_item_id_tenant_key").on(t.id, t.tenantId),
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
  },
  (t) => [
    unique("thread_id_tenant_key").on(t.id, t.tenantId),
    index("thread_subject_idx").on(t.tenantId, t.subjectType, t.subjectId),
    check("thread_status_check", oneOf(t.status, THREAD_STATUSES)),
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
] as const;
export type TenantTable = (typeof TENANT_TABLES)[number];

/** Tenant tables whose rows may also belong to the operator (tenant_id null; ARCHITECTURE §4). */
export const OPERATOR_TABLES = [
  "skill",
  "skill_version",
  "agent",
  "agent_version",
  "agent_change",
] as const satisfies readonly TenantTable[];
