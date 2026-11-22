// The platform tables (ARCHITECTURE §4, §5.1, §5.3). Shared business records (vendor, transaction,
// document…) and pack tables arrive with the tools that use them, in the same migration sequence.
//
// Hand-written SQL in ./migrations adds what Drizzle cannot express: the extensions, the
// `uuid_generate_v7()` default used below, the cs_runtime grants, row-level security on every
// table with a `tenant_id`, and the immutability triggers (docs/plan.md §1.2).
//
// This file imports only drizzle-orm at runtime, so drizzle-kit can load it on its own.

import type {
  AnyAgentBundle,
  AnyAutomationDefinition,
  ConnectionSettings,
  MezonasMay,
  PermissionMatrix,
  processes,
  SkillDefinition,
} from "@countersign/core";
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
  smallint,
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
/** Connectors C3 (docs/plan.md §1.161): core's CONNECTION_CHANGE_REQUEST_STATUSES. */
export const CONNECTION_CHANGE_REQUEST_STATUSES = [
  "open",
  "approved",
  "declined",
  "replaced",
  "expired",
  "withdrawn",
] as const;
/** Connectors C3: core's MEZONAS_MAY_CHOICES (Changes by Mezonas, beside "Ask me each time"). */
export const MEZONAS_MAY_CHOICES = ["needs", "any"] as const;
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
/**
 * The business areas an owner oversees (ARCHITECTURE §10.15, docs/plan.md §1.117). Core keeps the
 * same list (`OWNER_AREAS`); a test holds them equal.
 */
export const OWNER_AREAS = [
  "purchasing",
  "sales",
  "receivables",
  "bookkeeping",
  "marketing",
  "general",
] as const;
export type OwnerArea = (typeof OWNER_AREAS)[number];
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

// ── A person's second factor (docs/plan.md §1.100) ─────────────────────────────────────────────────
// Per person, not per client: row-level security on `app.user_id` (the person signing in, set by
// withUser) or an operator session (resets, Claude connection approvals). Twilio Verify holds every
// code and authenticator secret; these rows only say which methods a person has.

export const SECOND_FACTOR_KINDS = ["totp", "sms", "whatsapp"] as const;

export const userFactor = pgTable(
  "user_factor",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUser.id, { onDelete: "cascade" }),
    kind: text("kind").$type<(typeof SECOND_FACTOR_KINDS)[number]>().notNull(),
    /** E.164, for `sms` and `whatsapp`. */
    phone: text("phone"),
    /** Twilio Verify's TOTP factor (`YF…`), for `totp`. */
    twilioFactorSid: text("twilio_factor_sid"),
    /** Null while being set up: the first code proves it. */
    verifiedAt: ts("verified_at"),
    lastUsedAt: ts("last_used_at"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("user_factor_user_kind_key").on(t.userId, t.kind),
    check("user_factor_kind_check", oneOf(t.kind, SECOND_FACTOR_KINDS)),
    check(
      "user_factor_shape_check",
      sql`(${t.kind} = 'totp' and ${t.twilioFactorSid} is not null and ${t.phone} is null)
        or (${t.kind} in ('sms', 'whatsapp') and ${t.phone} is not null and ${t.twilioFactorSid} is null)`,
    ),
  ],
);

/** One-time recovery codes, as HMACs; a used one keeps its row with `used_at`. */
export const userRecoveryCode = pgTable(
  "user_recovery_code",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUser.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: ts("used_at"),
    createdAt: createdAt(),
  },
  (t) => [index("user_recovery_code_user_idx").on(t.userId)],
);

/**
 * A Claude connection to the Ops MCP server (§1.34), tied to its AuthKit session: refused until an
 * operator who passed the second step in the browser approves it with the link's code.
 */
export const mcpSessionApproval = pgTable(
  "mcp_session_approval",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUser.id, { onDelete: "cascade" }),
    /** AuthKit's session id (`sid` in the access token). */
    workosSessionId: text("workos_session_id").notNull(),
    /** HMAC of the approval link's code. */
    codeHash: text("code_hash").notNull(),
    /**
     * Who is asking (H6): the Claude client as the newest asking request names itself ("Claude",
     * "Claude Code"), in words, never its user agent; null where a request named nothing we read.
     */
    client: text("client"),
    /** Where the newest asking request came from, as Cloudflare places its address: "Ashburn, US". */
    place: text("place"),
    approvedAt: ts("approved_at"),
    /** The link stops working, or the approval ends, at this time. */
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("mcp_session_approval_session_key").on(t.workosSessionId, t.userId),
    unique("mcp_session_approval_code_key").on(t.codeHash),
  ],
);

/** Where a sign-in's approval on the phone app is (docs/plan.md §1.154). */
export const SIGN_IN_APPROVAL_STATUSES = ["pending", "approved", "denied"] as const;

/**
 * A sign-in waiting on the person's phone (§1.154): the browser shows `number`, the phone app
 * picks it and signs the approval with the phone's key behind Face ID or a fingerprint. Only the
 * browser that asked, holding the key whose hash is kept here, passes the step with it, once.
 * Pending past `expires_at` is expired.
 */
export const signInApproval = pgTable(
  "sign_in_approval",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUser.id, { onDelete: "cascade" }),
    /** SHA-256 of the key only the asking browser holds (it polls with it). */
    browserKeyHash: text("browser_key_hash").notNull(),
    /** The two-digit number the browser shows and the phone must pick. */
    number: smallint("number").notNull(),
    status: text("status")
      .$type<(typeof SIGN_IN_APPROVAL_STATUSES)[number]>()
      .notNull()
      .default("pending"),
    /** What the phone shows of the asking browser: "Chrome on macOS". */
    browser: text("browser").notNull(),
    /** Where the request came from, as Cloudflare places its address: "Austin, US". */
    place: text("place"),
    /** The phone that decided (`person_device.id`, in one of the person's clients). */
    deviceId: uuid("device_id"),
    decidedAt: ts("decided_at"),
    /** The asking browser passed the step with it. */
    usedAt: ts("used_at"),
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("sign_in_approval_user_idx").on(t.userId, t.createdAt),
    check("sign_in_approval_status_check", oneOf(t.status, SIGN_IN_APPROVAL_STATUSES)),
    check("sign_in_approval_number_check", sql`${t.number} between 10 and 99`),
    check(
      "sign_in_approval_decided_check",
      sql`(${t.status} = 'pending') = (${t.decidedAt} is null)
        and (${t.status} <> 'approved' or ${t.deviceId} is not null)`,
    ),
    check("sign_in_approval_used_check", sql`${t.usedAt} is null or ${t.status} = 'approved'`),
  ],
);

/** Global tables keyed by person, readable by that person (`app.user_id`) or an operator session. */
export const USER_TABLES = [
  "user_factor",
  "user_recovery_code",
  "mcp_session_approval",
  "sign_in_approval",
] as const;

// ── Reggie, the operator's account agent (docs/plan.md §1.101) ───────────────────────────────────

/** An operator's conversation with Reggie; `client_id` when it was opened from a client's page. */
export const reggieConversation = pgTable(
  "reggie_conversation",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUser.id, { onDelete: "cascade" }),
    clientId: uuid("client_id").references(() => tenant.id),
    title: text("title").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("reggie_conversation_user_idx").on(t.userId, t.updatedAt)],
);

export const REGGIE_ROLES = ["operator", "reggie"] as const;

/**
 * One message: the operator's, or Reggie's answer with the tool calls and results that led to it
 * (`blocks`, the model's history for later turns). Tool results are untrusted data (invariant 9).
 */
export const reggieMessage = pgTable(
  "reggie_message",
  {
    id: id(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => reggieConversation.id, { onDelete: "cascade" }),
    role: text("role").$type<(typeof REGGIE_ROLES)[number]>().notNull(),
    text: text("text").notNull().default(""),
    blocks: jsonb("blocks").$type<unknown[]>().notNull().default([]),
    /** The model, cost, tools used, errors. */
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("reggie_message_conversation_idx").on(t.conversationId, t.createdAt),
    check("reggie_message_role_check", oneOf(t.role, REGGIE_ROLES)),
  ],
);

export const REGGIE_ACTION_STATUSES = ["proposed", "done", "cancelled", "failed"] as const;

/**
 * A change Reggie proposed: shown as a card, made only when the operator confirms it, once. The
 * preview is what the card showed; `result` what the change returned.
 */
export const reggieAction = pgTable(
  "reggie_action",
  {
    id: id(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => reggieConversation.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUser.id, { onDelete: "cascade" }),
    clientId: uuid("client_id").references(() => tenant.id),
    tool: text("tool").notNull(),
    args: jsonb("args").$type<Record<string, unknown>>().notNull(),
    preview: jsonb("preview").$type<Record<string, unknown>>().notNull(),
    status: text("status")
      .$type<(typeof REGGIE_ACTION_STATUSES)[number]>()
      .notNull()
      .default("proposed"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: text("error"),
    createdAt: createdAt(),
    decidedAt: ts("decided_at"),
  },
  (t) => [
    index("reggie_action_conversation_idx").on(t.conversationId, t.createdAt),
    check("reggie_action_status_check", oneOf(t.status, REGGIE_ACTION_STATUSES)),
  ],
);

/** Reggie's tables (§1.101): only an operator session reads them; a client never does. */
export const REGGIE_TABLES = ["reggie_conversation", "reggie_message", "reggie_action"] as const;

// ── Builds: from intake to go-live (docs/plan.md §1.108, migration 0053) ─────────────────────────

export const BUILD_KINDS = ["agent", "skill"] as const;
export const BUILD_PHASES = ["intake", "fitgap", "draft", "poc", "client_test", "qa"] as const;
export const BUILD_STATUSES = ["open", "live", "stopped"] as const;
/** §1.124: how a build makes its agent; a fork of a template skips the build phases. */
export const BUILD_PATHS = ["new", "template"] as const;
/**
 * Where a build opens (docs/plan.md §1.172): `phases`, on its build page, through intake, fit-gap,
 * draft and the tests; `describe`, started on the lab's Describe it, in the one-screen builder.
 */
export const BUILD_FLOWS = ["phases", "describe"] as const;
/** §1.124: what a build or a deal came from. */
export const WORK_ORIGIN_KINDS = ["deal", "ask", "enhancement", "issue"] as const;
/** §1.124: whose move an item of back office work waits on. */
export const WORK_WAITING_ON = ["operator", "reggie", "client"] as const;

/**
 * One build of a new agent or skill, for a client (`client_id`: a client agent or that client's
 * skill) or for everyone (a template or a shared skill). `brief`, `fitgap`, `test_plan` and `qa`
 * are the phases' records (core's schemas); each confirmed one is also kept in `build_event`.
 * `agent_id` / `skill_id` name the draft once made; `test_client_id` / `test_agent_id` the client
 * and the copy it is tested with. Updated in place; never deleted.
 */
// DECISION: operator only, like Reggie's tables: a build is the operator's project, and a client
// sees only what it already sees (the agent once it runs, its Desk items).
export const build = pgTable(
  "build",
  {
    id: id(),
    clientId: uuid("client_id").references(() => tenant.id),
    kind: text("kind").$type<(typeof BUILD_KINDS)[number]>().notNull(),
    title: text("title").notNull(),
    phase: text("phase").$type<(typeof BUILD_PHASES)[number]>().notNull().default("intake"),
    status: text("status").$type<(typeof BUILD_STATUSES)[number]>().notNull().default("open"),
    brief: json("brief").notNull().default({}),
    fitgap: json("fitgap").notNull().default({}),
    testPlan: json("test_plan").notNull().default({}),
    qa: json("qa").notNull().default({}),
    agentId: uuid("agent_id").references(() => agent.id),
    skillId: uuid("skill_id").references(() => skill.id),
    sessionId: uuid("session_id").references(() => builderSession.id),
    testClientId: uuid("test_client_id").references(() => tenant.id),
    testAgentId: uuid("test_agent_id").references(() => agent.id),
    createdBy: uuid("created_by").references(() => appUser.id),
    createdAt: createdAt(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    phaseAt: ts("phase_at").notNull().defaultNow(),
    // docs/plan.md §1.124 (migration 0060): the build as back office work.
    // DECISION: builds get a promised date (owner, 2026-11-17); moving it is the operator's.
    promisedOn: date("promised_on"),
    /** `new`: built through the phases; `template`: forked from `template_id` for the client. */
    path: text("path").$type<(typeof BUILD_PATHS)[number]>().notNull().default("new"),
    /** Migration 0073: which screens the build opens on. Builds before it are `phases`. */
    flow: text("flow").$type<(typeof BUILD_FLOWS)[number]>().notNull().default("phases"),
    templateId: uuid("template_id").references((): AnyPgColumn => agent.id),
    /** What the build came from: a deal, a client's ask, an enhancement or an issue. */
    originKind: text("origin_kind").$type<(typeof WORK_ORIGIN_KINDS)[number]>(),
    originId: uuid("origin_id"),
    /** The requirements request sent to the client (core `RequirementsRequest`). */
    requirements: json("requirements"),
    waitingOn: text("waiting_on")
      .$type<(typeof WORK_WAITING_ON)[number]>()
      .notNull()
      .default("operator"),
    statusLine: text("status_line").notNull().default(""),
    stuck: boolean("stuck").notNull().default(false),
    manualRank: integer("manual_rank"),
  },
  (t) => [
    index("build_phase_idx").on(t.status, t.phase, t.updatedAt),
    index("build_origin_idx").on(t.originKind, t.originId),
    check("build_path_check", oneOf(t.path, BUILD_PATHS)),
    check("build_flow_check", oneOf(t.flow, BUILD_FLOWS)),
    check(
      "build_origin_kind_check",
      sql`${t.originKind} is null or ${oneOf(t.originKind, WORK_ORIGIN_KINDS)}`,
    ),
    check("build_origin_check", sql`(${t.originKind} is null) = (${t.originId} is null)`),
    check("build_waiting_on_check", oneOf(t.waitingOn, WORK_WAITING_ON)),
    check("build_status_line_check", sql`char_length(${t.statusLine}) <= 120`),
    index("build_agent_idx").on(t.agentId),
    index("build_test_agent_idx").on(t.testAgentId),
    check("build_kind_check", oneOf(t.kind, BUILD_KINDS)),
    check("build_phase_check", oneOf(t.phase, BUILD_PHASES)),
    check("build_status_check", oneOf(t.status, BUILD_STATUSES)),
    check("build_title_check", sql`length(${t.title}) between 1 and 200`),
    check(
      "build_target_check",
      sql`(${t.kind} = 'agent' and ${t.skillId} is null) or (${t.kind} = 'skill' and ${t.agentId} is null and ${t.testAgentId} is null)`,
    ),
  ],
);

export const BUILD_ITEM_KINDS = [
  "question",
  "gap",
  "precondition",
  "test",
  "feedback",
  "qa",
  "note",
] as const;
export const BUILD_ITEM_OWNERS = ["operator", "builder", "client", "engineering"] as const;
export const BUILD_ITEM_STATES = ["open", "in_progress", "waiting", "done", "deferred"] as const;

/**
 * What is left on a build, from any phase: who has it and its state. `key` names an item made
 * from something (a fit-gap row, a failed case, a rejected write) so it is made once; `ref` links
 * it (`testCaseId`, `runId`, `actionId`, `buildId` of a skill build). Updated in place.
 */
export const buildItem = pgTable(
  "build_item",
  {
    id: id(),
    buildId: uuid("build_id")
      .notNull()
      .references(() => build.id),
    phase: text("phase").$type<(typeof BUILD_PHASES)[number]>().notNull(),
    kind: text("kind").$type<(typeof BUILD_ITEM_KINDS)[number]>().notNull(),
    title: text("title").notNull(),
    detail: text("detail").notNull().default(""),
    owner: text("owner").$type<(typeof BUILD_ITEM_OWNERS)[number]>().notNull().default("operator"),
    state: text("state").$type<(typeof BUILD_ITEM_STATES)[number]>().notNull().default("open"),
    stepId: text("step_id"),
    ref: json("ref").notNull().default({}),
    key: text("key"),
    createdBy: uuid("created_by").references(() => appUser.id),
    createdAt: createdAt(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    resolvedAt: ts("resolved_at"),
  },
  (t) => [
    index("build_item_build_idx").on(t.buildId, t.createdAt),
    uniqueIndex("build_item_key").on(t.buildId, t.key).where(sql`${t.key} is not null`),
    check("build_item_phase_check", oneOf(t.phase, BUILD_PHASES)),
    check("build_item_kind_check", oneOf(t.kind, BUILD_ITEM_KINDS)),
    check("build_item_owner_check", oneOf(t.owner, BUILD_ITEM_OWNERS)),
    check("build_item_state_check", oneOf(t.state, BUILD_ITEM_STATES)),
    check("build_item_title_check", sql`length(${t.title}) between 1 and 300`),
  ],
);

export const BUILD_MESSAGE_ROLES = ["operator", "builder"] as const;

/**
 * The build's conversation: the operator's words, or the Builder's answer (`meta`: the chips it
 * offered, what it changed, its model and cost). Tagged with the phase it was in. Insert only.
 */
export const buildMessage = pgTable(
  "build_message",
  {
    id: id(),
    buildId: uuid("build_id")
      .notNull()
      .references(() => build.id),
    phase: text("phase").$type<(typeof BUILD_PHASES)[number]>().notNull(),
    role: text("role").$type<(typeof BUILD_MESSAGE_ROLES)[number]>().notNull(),
    text: text("text").notNull().default(""),
    meta: json("meta").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("build_message_build_idx").on(t.buildId, t.createdAt),
    check("build_message_phase_check", oneOf(t.phase, BUILD_PHASES)),
    check("build_message_role_check", oneOf(t.role, BUILD_MESSAGE_ROLES)),
  ],
);

export const BUILD_EVENT_KINDS = ["phase", "record", "qa", "decision"] as const;

/**
 * A build's history: a phase move (`from_phase`, `to_phase`, `reason`), a confirmed record (the
 * brief, fit-gap or test plan as confirmed, in `payload`), QA signed, go or no-go. Insert only.
 */
export const buildEvent = pgTable(
  "build_event",
  {
    id: id(),
    buildId: uuid("build_id")
      .notNull()
      .references(() => build.id),
    kind: text("kind").$type<(typeof BUILD_EVENT_KINDS)[number]>().notNull(),
    fromPhase: text("from_phase").$type<(typeof BUILD_PHASES)[number]>(),
    toPhase: text("to_phase").$type<(typeof BUILD_PHASES)[number]>(),
    payload: json("payload").notNull().default({}),
    reason: text("reason"),
    userId: uuid("user_id").references(() => appUser.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("build_event_build_idx").on(t.buildId, t.createdAt),
    check("build_event_kind_check", oneOf(t.kind, BUILD_EVENT_KINDS)),
  ],
);

/** The build tables (§1.108): only an operator session reads them; a client never does. */
export const BUILD_TABLES = ["build", "build_item", "build_message", "build_event"] as const;

// ── The Dev queue: Builder code requests (docs/plan.md §1.125, owner 2026-11-17) ───────────────
// What the Builder can't make from catalog parts (a new tool, an extension of a built-in) goes to
// engineering as a numbered request (DQ-001), triaged before it is built and shipped back to the
// builds waiting on it. Operator only and global, like the build tables: a client never sees one.

export const CODE_REQUEST_KINDS = [
  "extend_existing",
  "new_tool",
  "new_skill_code",
  "config_only",
] as const;
export const CODE_REQUEST_STATUSES = [
  "triage",
  "accepted",
  "in_progress",
  "shipped",
  "closed",
] as const;
export const CODE_REQUEST_DECISIONS = [
  "exists",
  "config",
  "extend",
  "new_general",
  "one_off",
] as const;
export const CODE_REQUEST_CLOSE_REASONS = [
  "exists",
  "config",
  "merged",
  "not_worth_it",
  "not_possible",
  "superseded",
] as const;
export const CODE_REQUEST_CREATORS = ["builder", "operator", "session"] as const;
export const CODE_REQUEST_EVENT_KINDS = [
  "status",
  "note",
  "reuse_check",
  "merge",
  "claim",
  "pr",
  "notified",
  "shipped",
] as const;

/**
 * One request for code: what it must do (`spec`, core's `CodeRequestSpec`), the questions it
 * leaves (`open_questions`), the reuse check that found what already exists (`reuse_check`), and
 * the decision on the ladder (exists, config, extend, new_general, one_off) with its reason.
 * `number` is shown as DQ-001. Updated in place (its history is `code_request_event`); never
 * deleted.
 */
// DECISION: the number is an identity column, global, so DQ numbers never repeat or collide; a
// refused insert still takes one, so they may skip.
export const codeRequest = pgTable(
  "code_request",
  {
    id: id(),
    number: integer("number").notNull().generatedByDefaultAsIdentity(),
    title: text("title").notNull(),
    kind: text("kind").$type<(typeof CODE_REQUEST_KINDS)[number]>().notNull(),
    status: text("status")
      .$type<(typeof CODE_REQUEST_STATUSES)[number]>()
      .notNull()
      .default("triage"),
    spec: json("spec").notNull().default({}),
    openQuestions: json<unknown[]>("open_questions").notNull().default([]),
    reuseCheck: json("reuse_check"),
    decision: text("decision").$type<(typeof CODE_REQUEST_DECISIONS)[number]>(),
    decisionReason: text("decision_reason"),
    /** Other work that would use it; empty means a one-off. */
    otherUses: text("other_uses").array().notNull().default(sql`'{}'::text[]`),
    oneOffApprovedBy: uuid("one_off_approved_by").references(() => appUser.id),
    oneOffApprovedAt: ts("one_off_approved_at"),
    mergedIntoId: uuid("merged_into_id").references((): AnyPgColumn => codeRequest.id),
    closeReason: text("close_reason").$type<(typeof CODE_REQUEST_CLOSE_REASONS)[number]>(),
    /** Who has it, in words ("Mezonas engineering", a person). */
    owner: text("owner"),
    claimedBy: uuid("claimed_by").references(() => appUser.id),
    claimedAt: ts("claimed_at"),
    prUrl: text("pr_url"),
    /** The catalog part the code adds (a tool id, a skill ref), set with the PR. */
    expectedPartId: text("expected_part_id"),
    shippedPartId: text("shipped_part_id"),
    shippedStagingAt: ts("shipped_staging_at"),
    shippedProductionAt: ts("shipped_production_at"),
    createdBy: text("created_by").$type<(typeof CODE_REQUEST_CREATORS)[number]>().notNull(),
    createdByUser: uuid("created_by_user").references(() => appUser.id),
    /** The latest event's time: a claim lapses 2 hours after it. */
    lastEventAt: ts("last_event_at").notNull().defaultNow(),
    closedAt: ts("closed_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("code_request_number_key").on(t.number),
    index("code_request_status_idx").on(t.status, t.createdAt),
    check("code_request_title_check", sql`char_length(${t.title}) between 1 and 200`),
    check("code_request_kind_check", oneOf(t.kind, CODE_REQUEST_KINDS)),
    check("code_request_status_check", oneOf(t.status, CODE_REQUEST_STATUSES)),
    check(
      "code_request_decision_check",
      sql`${t.decision} is null or ${oneOf(t.decision, CODE_REQUEST_DECISIONS)}`,
    ),
    check(
      "code_request_close_reason_check",
      sql`${t.closeReason} is null or ${oneOf(t.closeReason, CODE_REQUEST_CLOSE_REASONS)}`,
    ),
    check("code_request_created_by_check", oneOf(t.createdBy, CODE_REQUEST_CREATORS)),
    // Closed always says why; merged always says into what.
    check(
      "code_request_closed_check",
      sql`(${t.status} = 'closed') = (${t.closeReason} is not null)`,
    ),
    check(
      "code_request_merged_check",
      sql`(${t.closeReason} = 'merged') = (${t.mergedIntoId} is not null)`,
    ),
    check(
      "code_request_not_self_check",
      sql`${t.mergedIntoId} is null or ${t.mergedIntoId} <> ${t.id}`,
    ),
  ],
);

/**
 * Where a request is needed: a build, and in it a workflow's step and the build's open item of
 * kind `gap` (`issue_id`, a `build_item`). One request links to many builds and steps.
 */
export const codeRequestLink = pgTable(
  "code_request_link",
  {
    id: id(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => codeRequest.id),
    buildId: uuid("build_id")
      .notNull()
      .references(() => build.id),
    workflowId: text("workflow_id"),
    stepId: text("step_id"),
    issueId: uuid("issue_id").references(() => buildItem.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("code_request_link_request_idx").on(t.requestId),
    index("code_request_link_build_idx").on(t.buildId),
    // One link per build and step (a build's link with no step counts once too).
    uniqueIndex("code_request_link_key").on(
      t.requestId,
      t.buildId,
      sql`coalesce(${t.workflowId}, '')`,
      sql`coalesce(${t.stepId}, '')`,
    ),
  ],
);

/** A request's history: every change writes one. Insert only, like `audit_event`. */
export const codeRequestEvent = pgTable(
  "code_request_event",
  {
    id: id(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => codeRequest.id),
    at: ts("at").notNull().defaultNow(),
    /** `operator`, `builder`, `session` or `system`. */
    actor: text("actor").notNull(),
    userId: uuid("user_id").references(() => appUser.id),
    kind: text("kind").$type<(typeof CODE_REQUEST_EVENT_KINDS)[number]>().notNull(),
    body: json("body").notNull().default({}),
  },
  (t) => [
    index("code_request_event_request_idx").on(t.requestId, t.at),
    check("code_request_event_kind_check", oneOf(t.kind, CODE_REQUEST_EVENT_KINDS)),
    check(
      "code_request_event_actor_check",
      sql`${t.actor} in ('operator', 'builder', 'session', 'system')`,
    ),
  ],
);

/** The Dev queue's tables (§1.125): operator sessions only; links only with their build. */
export const CODE_REQUEST_TABLES = [
  "code_request",
  "code_request_link",
  "code_request_event",
] as const;

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
    // R4 (migration 0043, docs/plan.md §1.86): this person's own working week and away dates in
    // this client (core's `processes.PersonHours`, validated where written). Null: the client's
    // hours, never away.
    hours: json<processes.PersonHours>("hours"),
    /**
     * The client agents a client user may see and work on (migration 0059, docs/plan.md §1.122).
     * Null: every agent, as before. Only a `client_user` is ever limited; an admin and an operator
     * keep null. Ids are client agents of this client, checked where written.
     */
    agentIds: uuid("agent_ids").array(),
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
    /**
     * Connectors C3 (docs/connectors-plan.md §7.2): Changes by Mezonas, the client admin's standing
     * say over our changes to this connection (core's `MezonasMay`). Null: Ask me each time.
     */
    mezonasMay: json<MezonasMay>("mezonas_may"),
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
    check(
      "connection_mezonas_may_check",
      sql`${t.mezonasMay} is null or (jsonb_typeof(${t.mezonasMay}) = 'object'
        and ${t.mezonasMay}->>'choice' in ('needs', 'any')
        and ${t.mezonasMay} ? 'until' and ${t.mezonasMay} ? 'setBy' and ${t.mezonasMay} ? 'setAt')`,
    ),
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
    /**
     * What changed. Connectors C3: a change made under Changes by Mezonas carries the
     * authorization it used in here (`authorization`, core's `MezonasMay`).
     */
    change: json("change").notNull(),
    /** Connectors C3: the change request this change applied, when a client admin approved one. */
    requestId: uuid("request_id"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "connection_change_connection_fk",
      columns: [t.connectionId, t.tenantId],
      foreignColumns: [connection.id, connection.tenantId],
    }),
    foreignKey({
      name: "connection_change_request_fk",
      columns: [t.requestId, t.tenantId],
      foreignColumns: [connectionChangeRequest.id, connectionChangeRequest.tenantId],
    }),
    index("connection_change_connection_idx").on(t.connectionId, t.createdAt),
    index("connection_change_tenant_idx").on(t.tenantId),
  ],
);

/**
 * Connectors C3 (docs/connectors-plan.md §7.1): our ask to change a client's connection in a way
 * that gives agents more. Nothing changes until a client admin approves; approving applies exactly
 * `proposed` as one `connection_change` naming this request, and is refused once the connection's
 * settings are no longer `against` (Out of date). One open request per connection: a new one
 * replaces it. Only its status and answer change (trigger); never deleted.
 */
export const connectionChangeRequest = pgTable(
  "connection_change_request",
  {
    id: id(),
    tenantId: tenantId(),
    connectionId: uuid("connection_id").notNull(),
    status: text("status")
      .$type<(typeof CONNECTION_CHANGE_REQUEST_STATUSES)[number]>()
      .notNull()
      .default("open"),
    /** The connection's settings when we asked (core's `ConnectionSettings`). */
    against: json<ConnectionSettings>("against").notNull(),
    /** What approving sets (core's `ConnectionSettings`). */
    proposed: json<ConnectionSettings>("proposed").notNull(),
    /** Why, in our words; shown to the client. */
    reason: text("reason").notNull(),
    /** The operator who asked. */
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => appUser.id),
    /** The agent it is for, when it comes from an agent's needs. */
    forAgentId: uuid("for_agent_id"),
    expiresAt: ts("expires_at").notNull(),
    /** When it stopped being open, and who ended it (null when it expired or was replaced). */
    closedAt: ts("closed_at"),
    closedBy: uuid("closed_by").references(() => appUser.id),
    /** The client admin's note back, on approving or declining. */
    answerNote: text("answer_note"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("connection_change_request_id_tenant_key").on(t.id, t.tenantId),
    foreignKey({
      name: "connection_change_request_connection_fk",
      columns: [t.connectionId, t.tenantId],
      foreignColumns: [connection.id, connection.tenantId],
    }),
    foreignKey({
      name: "connection_change_request_agent_fk",
      columns: [t.forAgentId, t.tenantId],
      foreignColumns: [agent.id, agent.tenantId],
    }),
    uniqueIndex("connection_change_request_open_key")
      .on(t.connectionId)
      .where(sql`${t.status} = 'open'`),
    index("connection_change_request_tenant_idx").on(t.tenantId, t.status, t.createdAt),
    check(
      "connection_change_request_status_check",
      oneOf(t.status, CONNECTION_CHANGE_REQUEST_STATUSES),
    ),
    check("connection_change_request_reason_check", sql`length(${t.reason}) between 1 and 1000`),
    check(
      "connection_change_request_note_check",
      sql`${t.answerNote} is null or length(${t.answerNote}) <= 1000`,
    ),
    check("connection_change_request_expiry_check", sql`${t.expiresAt} > ${t.createdAt}`),
    check(
      "connection_change_request_closed_check",
      sql`(${t.status} = 'open') = (${t.closedAt} is null)
        and (${t.status} not in ('approved', 'declined', 'withdrawn') or ${t.closedBy} is not null)
        and (${t.answerNote} is null or ${t.status} in ('approved', 'declined'))`,
    ),
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
    /**
     * v0.19 (ARCHITECTURE §10.15): the business area whose owner oversees this client agent's
     * process. Operational, never in a version; null reads as the template's area, else `general`.
     */
    area: text("area").$type<OwnerArea>(),
    /**
     * A safety hold (docs/plan.md §1.124, migration 0060): while set, the agent's writes and sends
     * wait for a person. Operational, never in a version; set only on client agents (enforced in
     * code). Null when not held.
     */
    hold: json<AgentHold>("hold"),
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
    check("agent_area_check", sql`${t.area} is null or ${oneOf(t.area, OWNER_AREAS)}`),
  ],
);

// ── Area owners (v0.19, ARCHITECTURE §10.15) ────────────────────────────────────────────────────

/**
 * One named owner per business area per client: the AI that watches every process in its area.
 * Its own table, not an `agent` kind, so no listing, bill or export of a client's agents counts
 * it. `name` is the client's to change (renaming makes no version).
 */
// DECISION (O1): a table of its own rather than `agent.kind = 'owner'`: 59 queries over `agent`
// don't filter by kind (billing, weekly stats, exports, search), and an owner is none of those.
export const areaOwner = pgTable(
  "area_owner",
  {
    id: id(),
    tenantId: tenantId(),
    area: text("area").$type<OwnerArea>().notNull(),
    /** Shown everywhere it acts; the client admin may rename it (2 to 12 letters, not Sloan). */
    name: text("name").notNull(),
    avatar: text("avatar"),
    liveVersionId: uuid("live_version_id").references((): AnyPgColumn => areaOwnerVersion.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("area_owner_id_tenant_key").on(t.id, t.tenantId),
    unique("area_owner_tenant_area_key").on(t.tenantId, t.area),
    check("area_owner_area_check", oneOf(t.area, OWNER_AREAS)),
  ],
);

/**
 * An owner's settings, versioned and never updated or deleted (invariant 3): its model, its notes
 * (Markdown the operator writes) and its oversight defaults, as core's `OwnerDefinition`.
 */
export const areaOwnerVersion = pgTable(
  "area_owner_version",
  {
    id: id(),
    tenantId: tenantId(),
    ownerId: uuid("owner_id").notNull(),
    version: integer("version").notNull(),
    definition: json("definition").notNull(),
    authorType: text("author_type").$type<"operator" | "system">().notNull(),
    authorId: uuid("author_id"),
    changeNote: text("change_note"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("area_owner_version_id_tenant_key").on(t.id, t.tenantId),
    unique("area_owner_version_owner_version_key").on(t.ownerId, t.version),
    check("area_owner_version_author_check", sql`${t.authorType} in ('operator', 'system')`),
    foreignKey({
      name: "area_owner_version_owner_fk",
      columns: [t.ownerId, t.tenantId],
      foreignColumns: [areaOwner.id, areaOwner.tenantId],
    }),
  ],
);

/** `agent.stage_state` (ARCHITECTURE §5.5); validated by core where it is written. */
export interface AgentStageState {
  trial?: { startedAt: string; minDays: number; minRuns: number; setBy: string | null };
  signoff?: { inboxItemId: string; askedAt: string };
  skipped?: { stage: AgentStage; reason: string; by: string | null; at: string }[];
  rejections?: { reason: string; by: string | null; at: string; inboxItemId: string | null }[];
  /** docs/builder-plan.md §6: the setup checklist's progress, by item id (core's SetupProgress). */
  setup?: Record<
    string,
    {
      done: boolean;
      by: string | null;
      byName?: string | null;
      side?: "client" | "operator" | null;
      at: string;
      value?: string;
      files?: string[];
      versionId?: string;
    }
  >;
}

/** `agent.pause` (ARCHITECTURE §5.5): one side's pause; `all` pauses every agent of the client. */
/**
 * A client agent's safety hold (docs/plan.md §1.124): the issue it is held for, who placed it and
 * why. Core's `AgentHold` schema validates it; this is its stored shape.
 */
export interface AgentHold {
  issueId: string;
  by: "reggie" | "operator";
  userId: string | null;
  at: string;
  reason: string;
}

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
    // R8/wave 3b: a stored v3 bundle or one that holds v4 processes; readers check
    // `schemaVersion` (or read through core's `readConverted` / `toProcessBundle`).
    bundle: json<AnyAgentBundle>("bundle").notNull(),
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

/** Who made a change an SOP revision records (docs/sop-plan.md §6). */
export const SOP_REVISION_SIDES = ["client", "operator", "system"] as const;
/** Where the change that made an SOP revision was made (docs/sop-plan.md §6). */
export const SOP_REVISION_SOURCES = [
  "first",
  "version",
  "agent",
  "connection",
  "grant",
  "approver_rules",
  "business_hours",
  "owner",
  "adjust",
  "stage",
  "check",
  // Only how Mezonas writes SOPs changed (core's SOP_FORMAT), not how the agent works.
  "format",
] as const;

/**
 * The agent's SOP, one row per revision (docs/sop-plan.md §6, migration 0074): the SOP as it was
 * (`view`, core's `SopView`), what changed from the revision before (`changes`, core's
 * `SopChange[]`), who made the change and where. Recorded at the change, in its transaction, only
 * when the SOP's content (`fingerprint`) differs from the last revision's. Never updated or
 * deleted (invariant 3's rule, applied here): a later change is a later row.
 */
export const sopRevision = pgTable(
  "sop_revision",
  {
    id: id(),
    tenantId: tenantId(),
    agentId: uuid("agent_id").notNull(),
    /** The agent version's number: 7 in "7.2". */
    major: integer("major").notNull(),
    /** Setup changes since that version went live: 2 in "7.2"; 0 when the version itself. */
    minor: integer("minor").notNull(),
    agentVersionId: uuid("agent_version_id")
      .notNull()
      .references(() => agentVersion.id),
    /** sha256 of the SOP's canonical content (core's `sopFingerprint`). */
    fingerprint: text("fingerprint").notNull(),
    view: jsonb("view").notNull(),
    changes: jsonb("changes").$type<unknown[]>().notNull().default([]),
    changedByUserId: uuid("changed_by_user_id").references(() => appUser.id),
    changedBySide: text("changed_by_side").$type<(typeof SOP_REVISION_SIDES)[number]>().notNull(),
    source: text("source").$type<(typeof SOP_REVISION_SOURCES)[number]>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "sop_revision_agent_fk",
      columns: [t.agentId, t.tenantId],
      foreignColumns: [agent.id, agent.tenantId],
    }),
    unique("sop_revision_number_key").on(t.agentId, t.major, t.minor),
    index("sop_revision_agent_idx").on(t.tenantId, t.agentId, t.createdAt),
    check("sop_revision_major_check", sql`${t.major} >= 0`),
    check("sop_revision_minor_check", sql`${t.minor} >= 0`),
    check("sop_revision_side_check", sql`${t.changedBySide} in ('client', 'operator', 'system')`),
    check(
      "sop_revision_source_check",
      sql`${t.source} in ('first', 'version', 'agent', 'connection', 'grant', 'approver_rules', 'business_hours', 'owner', 'adjust', 'stage', 'check', 'format')`,
    ),
    check("sop_revision_fingerprint_check", sql`length(${t.fingerprint}) = 64`),
  ],
);

/** What an agent's security check looked at (docs/agent-assurance-plan.md §4). */
export const CONTROL_CHECK_KINDS = ["setup", "runs", "attack"] as const;
/**
 * A check's result (§4, owner 2026-11-21): never "failed". "Not yet checked" is the absence of a
 * row, so a check that never ran never reads as one that found nothing.
 */
export const CONTROL_CHECK_RESULTS = ["verified", "in_review", "not_applicable"] as const;
/** What started the check. */
export const CONTROL_CHECK_TRIGGERS = ["nightly", "setup_change", "person", "attack_run"] as const;

/**
 * One result of one security check of one client agent (docs/agent-assurance-plan.md §6,
 * migration 0075): which check (core's `assurance` check id), the register controls it proves,
 * what it looked at, its result and its evidence (counts and record ids, never contents, secrets,
 * prompts or message bodies). A check in review links the issue it opened. History: never updated
 * or deleted, like `audit_event`; the next check is the next row.
 */
export const controlCheck = pgTable(
  "control_check",
  {
    id: id(),
    tenantId: tenantId(),
    agentId: uuid("agent_id").notNull(),
    /** The agent version the check read; null for a check of the client's setup alone. */
    agentVersionId: uuid("agent_version_id").references(() => agentVersion.id),
    checkId: text("check_id").notNull(),
    kind: text("kind").$type<(typeof CONTROL_CHECK_KINDS)[number]>().notNull(),
    /** The register's control ids it proves (core `compliance/controls.ts`): AGT-1, ISO-1, … */
    controls: text("controls").array().notNull().default(sql`'{}'::text[]`),
    result: text("result").$type<(typeof CONTROL_CHECK_RESULTS)[number]>().notNull(),
    /** What it found, in a line, for the client's view and the back office. */
    found: text("found").notNull().default(""),
    /** Counts and record ids it read; never their contents. */
    evidence: jsonb("evidence").notNull().default({}),
    periodStart: ts("period_start"),
    periodEnd: ts("period_end"),
    trigger: text("trigger").$type<(typeof CONTROL_CHECK_TRIGGERS)[number]>().notNull(),
    /** The issue a check in review opened for us. */
    issueId: uuid("issue_id"),
    checkedAt: ts("checked_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "control_check_agent_fk",
      columns: [t.agentId, t.tenantId],
      foreignColumns: [agent.id, agent.tenantId],
    }),
    index("control_check_agent_idx").on(t.tenantId, t.agentId, t.checkId, t.checkedAt),
    check("control_check_kind_check", sql`${t.kind} in ('setup', 'runs', 'attack')`),
    check(
      "control_check_result_check",
      sql`${t.result} in ('verified', 'in_review', 'not_applicable')`,
    ),
    check(
      "control_check_trigger_check",
      sql`${t.trigger} in ('nightly', 'setup_change', 'person', 'attack_run')`,
    ),
    check("control_check_check_id_check", sql`length(${t.checkId}) between 1 and 80`),
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
    /** v0.19: the area owner's version that watched this run, pinned at its start (§10.15). */
    ownerVersionId: uuid("owner_version_id"),
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
    foreignKey({
      name: "run_owner_version_fk",
      columns: [t.ownerVersionId, t.tenantId],
      foreignColumns: [areaOwnerVersion.id, areaOwnerVersion.tenantId],
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
 * What a model call was for (migration 0055, docs/plan.md §1.115), so tokens can be counted by
 * action: an agent's own turn in a step, the run's oversight review, a reach-out's message, a
 * tool's own call (a document read, a web search, a translation in a step), a question asked of the
 * client's account agent (Sloan) in the portal, a turn of a conversation step, an AI check of a
 * step, and the agent choosing a path or ending a repeat. Mirrors core's `MODEL_CALL_ACTIONS` (db
 * can't import core's runtime).
 */
export const MODEL_CALL_ACTIONS = [
  "agent_turn",
  "oversight",
  "reach_out",
  "tool_call",
  "question",
  "conversation",
  "check",
  "choice",
] as const;

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
    /** `anthropic` | `openai` | `xai` | `google` (core's `modelProvider`). */
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    /**
     * What the call was for (migration 0055): core's `MODEL_CALL_ACTIONS`. Rows from before it
     * read `agent_turn`, which most were.
     */
    action: text("action").notNull().default("agent_turn"),
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
    check("model_call_action_check", oneOf(t.action, MODEL_CALL_ACTIONS)),
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

/** What a run was about (docs/reporting-plan.md §3 R1): the kind of thing it read or changed. */
export const RUN_SUBJECT_KINDS = [
  "document",
  "vendor",
  "customer",
  "organization",
  "person",
  "transaction",
  "item",
  "message",
  "record",
] as const;
/** What the run did with it. */
export const RUN_SUBJECT_ROLES = ["read", "decided", "changed"] as const;

/**
 * One thing a run read, decided on or changed (docs/reporting-plan.md §3 R1, migration 0077), kept
 * as the run happens so runs can be found by what they were about: our record's id, the client's
 * tool and its id for the thing, the name a person reads and the document's own number, and its
 * amount when it carries money. `label` and `number` are data, never instructions (invariant 9).
 * The portal reads only `client_visible` rows. History: never updated or deleted (trigger).
 */
export const runSubject = pgTable(
  "run_subject",
  {
    id: id(),
    tenantId: tenantId(),
    runId: uuid("run_id").notNull(),
    // DECISION: null for what started the run (the trigger's document or message): it is the
    // run's, kept on `run.trigger`, not any step's (docs/plan.md §1.188).
    stepRunId: uuid("step_run_id"),
    kind: text("kind").$type<(typeof RUN_SUBJECT_KINDS)[number]>().notNull(),
    role: text("role").$type<(typeof RUN_SUBJECT_ROLES)[number]>().notNull(),
    /** Our record's id, when there is one. */
    recordId: uuid("record_id"),
    /** The client's tool (a connector id) and its id for the thing (a QuickBooks bill). */
    connector: text("connector"),
    externalId: text("external_id"),
    /** The name a person reads: a vendor's name, a file's name. */
    label: text("label"),
    /** The document's own number: an invoice or PO number. */
    number: text("number"),
    /** When it carries money: numeric(14,4) with its currency (invariant 6). */
    amount: numeric("amount", { precision: 14, scale: 4 }),
    currency: text("currency"),
    /** Whether the step is one the client's timeline shows. */
    clientVisible: boolean("client_visible").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "run_subject_run_fk",
      columns: [t.runId, t.tenantId],
      foreignColumns: [run.id, run.tenantId],
    }),
    foreignKey({
      name: "run_subject_step_run_fk",
      columns: [t.stepRunId, t.tenantId],
      foreignColumns: [stepRun.id, stepRun.tenantId],
    }),
    index("run_subject_record_idx").on(t.tenantId, t.kind, t.recordId),
    index("run_subject_run_idx").on(t.tenantId, t.runId),
    index("run_subject_label_trgm_idx").using("gin", t.label.op("gin_trgm_ops")),
    index("run_subject_number_trgm_idx").using("gin", t.number.op("gin_trgm_ops")),
    check("run_subject_kind_check", oneOf(t.kind, RUN_SUBJECT_KINDS)),
    check("run_subject_role_check", oneOf(t.role, RUN_SUBJECT_ROLES)),
    // DECISION: a row is whole (docs/plan.md §1.188): money carries its currency (invariant 6),
    // and a tool's id means nothing without the tool.
    check("run_subject_amount_check", sql`(${t.amount} is null) = (${t.currency} is null)`),
    check("run_subject_external_check", sql`${t.externalId} is null or ${t.connector} is not null`),
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
    /**
     * The record's state the write left (migration 0044, R5 undo): what an undo compares with the
     * record now, so it never reverses someone else's later change. Null for writes before 0044.
     */
    after: json("after"),
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
    // Dispatches that failed for this event (its own work threw; a run whose instance would not
    // start is the engine's failure and not counted), the last one's error, and when it was set
    // aside after too many: a set-aside event leaves the queue until an operator retries it
    // (docs/operations.md §5).
    dispatchAttempts: integer("dispatch_attempts").notNull().default(0),
    dispatchError: text("dispatch_error"),
    setAsideAt: ts("set_aside_at"),
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

/**
 * Per client agent or area owner; never shared across clients or with templates. v0.19: an owner's
 * notes carry `owner_id` instead of `agent_id`; a person's conversation summaries carry
 * `scope = 'person'` and `person_id` (ARCHITECTURE §10.15).
 */
export const memoryNote = pgTable(
  "memory_note",
  {
    id: id(),
    tenantId: tenantId(),
    agentId: uuid("agent_id"),
    ownerId: uuid("owner_id"),
    scope: text("scope").notNull().default("agent"),
    /** `scope = 'person'` only: whose conversations the note summarises. */
    personId: uuid("person_id").references(() => appUser.id),
    note: text("note").notNull(),
    sourceMessageId: uuid("source_message_id"),
    createdAt: createdAt(),
  },
  (t) => [
    check("memory_note_subject_check", sql`num_nonnulls(${t.agentId}, ${t.ownerId}) = 1`),
    check("memory_note_person_check", sql`(${t.scope} = 'person') = (${t.personId} is not null)`),
    foreignKey({
      name: "memory_note_owner_fk",
      columns: [t.ownerId, t.tenantId],
      foreignColumns: [areaOwner.id, areaOwner.tenantId],
    }),
    index("memory_note_owner_idx").on(t.ownerId).where(sql`${t.ownerId} is not null`),
    index("memory_note_person_idx")
      .on(t.tenantId, t.personId, t.createdAt)
      .where(sql`${t.personId} is not null`),
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
    // P-7 (migration 0034): model translations no agent made (the background job, a person's own
    // text); their tokens and cost are in the columns above with the readings'.
    translations: integer("translations").notNull().default(0),
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
// v0.14 capture: `message`, a file sent in a WhatsApp message (migration 0031, docs/plan.md §1.55).
// P-5: `generated`, a document a tool made for the client (a purchase order PDF; migration 0033,
// docs/plan.md §1.67). It never comes in from outside, so nothing reads it as an invoice.
export const DOCUMENT_SOURCES = [
  "connector",
  "upload",
  "email",
  "request",
  "message",
  "generated",
] as const;
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

// ── The chart of accounts (B-2, docs/plan.md §1.79; migration 0039) ──────────────────────────────

/** QuickBooks' five classifications, lowercased. */
export const LEDGER_CLASSIFICATIONS = [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
] as const;
export type LedgerClassification = (typeof LEDGER_CLASSIFICATIONS)[number];
/**
 * What an account is, in the same words whatever the accounting tool (each connector's mapper sets
 * it from the tool's own type, which `account_type` keeps as written): what agents and packs read.
 */
// DECISION (docs/plan.md §1.79): a closed list, so a pack asks "is this a card account" the same way
// for QuickBooks and any later tool; a type a mapper doesn't know is `other`.
export const LEDGER_KINDS = [
  "bank",
  "card",
  "receivable",
  "payable",
  "other_current_asset",
  "fixed_asset",
  "other_asset",
  "other_current_liability",
  "long_term_liability",
  "equity",
  "income",
  "other_income",
  "cost_of_goods",
  "expense",
  "other_expense",
  "other",
] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];
/** The ledger's dimensions besides accounts: classes and locations (QuickBooks' Department). */
export const LEDGER_DIMENSION_KINDS = ["class", "location"] as const;
export type LedgerDimensionKind = (typeof LEDGER_DIMENSION_KINDS)[number];
export const LEDGER_NOTE_SOURCES = ["client", "operator", "agent"] as const;
export type LedgerNoteSource = (typeof LEDGER_NOTE_SOURCES)[number];
/** A note on an account is one or two sentences. */
export const LEDGER_NOTE_MAX = 500;

/**
 * An account of a client's ledger in its accounting tool: synced in place by that connection's
 * sync, never deleted (an account gone or made inactive there is `active = false`).
 */
// DECISION: a platform table, not a pack's (docs/plan.md §1.79): accounts are the client's tool's
// records, read by the Bill clerk, the buyer and the Bookkeeping area alike.
// DECISION (owner, 2026-11-08): the ledger belongs to the accounting connection, one to one with
// the general ledger there: an account is unique by connection and the tool's id, so a second
// company (several entities) would bring its own chart beside the first, ids never colliding.
export const ledgerAccount = pgTable(
  "ledger_account",
  {
    id: id(),
    tenantId: tenantId(),
    connectionId: uuid("connection_id").notNull(),
    connector: text("connector").notNull(),
    /** QuickBooks' Account.Id. */
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    /** QuickBooks' FullyQualifiedName ("Parent:Child"). */
    fullName: text("full_name").notNull(),
    /** QuickBooks' AcctNum. */
    number: text("number"),
    classification: text("classification").$type<LedgerClassification>(),
    /** What the account is, in the platform's words (`bank`, `card`, `expense`, …). */
    kind: text("kind").$type<LedgerKind>().notNull(),
    /** The tool's own type, as written there (QuickBooks' AccountType, e.g. `Credit Card`). */
    accountType: text("account_type").notNull(),
    accountSubType: text("account_sub_type"),
    parentExternalId: text("parent_external_id"),
    /** The description kept in the accounting tool. */
    description: text("description"),
    currency: currency(),
    active: boolean("active").notNull().default(true),
    /** The raw record of the version last read. */
    rawRecordId: uuid("raw_record_id"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("ledger_account_id_tenant_key").on(t.id, t.tenantId),
    unique("ledger_account_external_key").on(t.connectionId, t.externalId),
    index("ledger_account_tenant_idx").on(t.tenantId, t.kind),
    foreignKey({
      name: "ledger_account_connection_fk",
      columns: [t.connectionId, t.tenantId],
      foreignColumns: [connection.id, connection.tenantId],
    }),
    foreignKey({
      name: "ledger_account_raw_record_fk",
      columns: [t.rawRecordId, t.tenantId],
      foreignColumns: [rawRecord.id, rawRecord.tenantId],
    }),
    check(
      "ledger_account_classification_check",
      sql`${t.classification} is null or ${oneOf(t.classification, LEDGER_CLASSIFICATIONS)}`,
    ),
    check("ledger_account_kind_check", oneOf(t.kind, LEDGER_KINDS)),
  ],
);

/**
 * The ledger's other dimensions in the accounting tool: classes and locations (QuickBooks'
 * Department), per connection like the accounts, synced in place and never deleted.
 */
export const ledgerDimension = pgTable(
  "ledger_dimension",
  {
    id: id(),
    tenantId: tenantId(),
    connectionId: uuid("connection_id").notNull(),
    connector: text("connector").notNull(),
    kind: text("kind").$type<LedgerDimensionKind>().notNull(),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    fullName: text("full_name").notNull(),
    parentExternalId: text("parent_external_id"),
    active: boolean("active").notNull().default(true),
    rawRecordId: uuid("raw_record_id"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("ledger_dimension_id_tenant_key").on(t.id, t.tenantId),
    unique("ledger_dimension_external_key").on(t.connectionId, t.kind, t.externalId),
    index("ledger_dimension_tenant_idx").on(t.tenantId, t.kind),
    foreignKey({
      name: "ledger_dimension_connection_fk",
      columns: [t.connectionId, t.tenantId],
      foreignColumns: [connection.id, connection.tenantId],
    }),
    foreignKey({
      name: "ledger_dimension_raw_record_fk",
      columns: [t.rawRecordId, t.tenantId],
      foreignColumns: [rawRecord.id, rawRecord.tenantId],
    }),
    check("ledger_dimension_kind_check", oneOf(t.kind, LEDGER_DIMENSION_KINDS)),
  ],
);

/**
 * What an account is used for, in words (B-2): the client's answers, the operator's, and the
 * agent's, learned from what was booked there. Insert only: a change is a newer note.
 */
export const ledgerAccountNote = pgTable(
  "ledger_account_note",
  {
    id: id(),
    tenantId: tenantId(),
    ledgerAccountId: uuid("ledger_account_id").notNull(),
    note: text("note").notNull(),
    source: text("source").$type<LedgerNoteSource>().notNull(),
    /** The records it rests on (bookings, transactions), invariant 10. */
    sources: json<string[]>("sources").notNull().default([]),
    agentVersionId: uuid("agent_version_id").references(() => agentVersion.id),
    userId: uuid("user_id").references(() => appUser.id),
    /** The question this note answers. */
    inboxItemId: uuid("inbox_item_id"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "ledger_account_note_account_fk",
      columns: [t.ledgerAccountId, t.tenantId],
      foreignColumns: [ledgerAccount.id, ledgerAccount.tenantId],
    }),
    foreignKey({
      name: "ledger_account_note_inbox_item_fk",
      columns: [t.inboxItemId, t.tenantId],
      foreignColumns: [inboxItem.id, inboxItem.tenantId],
    }),
    index("ledger_account_note_account_idx").on(t.tenantId, t.ledgerAccountId, t.createdAt),
    check("ledger_account_note_source_check", oneOf(t.source, LEDGER_NOTE_SOURCES)),
    check("ledger_account_note_length_check", sql`char_length(${t.note}) between 1 and 500`),
    // An agent's note rests on records and names its version; a person's names the person.
    check(
      "ledger_account_note_author_check",
      sql`(${t.source} = 'agent' and ${t.agentVersionId} is not null and jsonb_array_length(${t.sources}) > 0) or (${t.source} <> 'agent' and ${t.userId} is not null)`,
    ),
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
    /** What validateTotals found, in words: totals that do not match, and lines whose own arithmetic doesn't add up (noted only). */
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
    // P-1 (migration 0033): for the Materials pack's composite foreign keys, as raw_record's.
    unique("doc_line_id_tenant_key").on(t.id, t.tenantId),
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
/** How it was sent: the Feedback button, or "Report an issue" on a page that failed to load. */
export const FEEDBACK_SOURCES = ["button", "error_page"] as const;

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
    source: text("source").$type<(typeof FEEDBACK_SOURCES)[number]>().notNull().default("button"),
    /**
     * For an error page's report: what failed, for us (route, URL, status, code, the request, when,
     * the client and user, the release, the Sentry event). Never shown to the person sending it.
     */
    context: json<Record<string, unknown>>("context"),
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
    check("feedback_source_check", oneOf(t.source, FEEDBACK_SOURCES)),
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
    // P-7 (migration 0034, docs/plan.md §1.69): this person's switch over the client's translation.
    /** `{incoming?, outgoing?}`: `true` or `false` wins over the client's setting; absent follows it. */
    translation: json<ContactTranslation>("translation").notNull().default({}),
    // R4 (migration 0043, docs/plan.md §1.86): the contact's own working week and away dates
    // (core's `processes.PersonHours`, validated where written), for deadlines in business time
    // and approvals that skip someone away. Null: the client's hours, never away.
    hours: json<processes.PersonHours>("hours"),
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

// ── Forms: "Request info" (docs/plan.md §1.121; migration 0058) ─────────────────────────────────

// Kept in step with core's `FORM_REQUEST_STATUSES` (this file imports only drizzle at runtime).
export const FORM_REQUEST_STATUSES = [
  "sending",
  "open",
  "submitted",
  "expired",
  "cancelled",
  "not_sent",
] as const;

/**
 * One contact's copy of one form, asked by one workflow step: the form as it was sent (the agent's
 * or the operator's), the operator's ask, the saved draft, the answers sent and the documents
 * uploaded. The link carries only this row's id, signed; the answers are what the person wrote,
 * data and never instructions (invariant 9). `sending` while its link's reach-out waits for its
 * approval or quiet hours, `open` once sent. The run waits on it like a reach-out: once answered
 * or expired, the cron re-sends its event until the run takes it (`run_received_at`).
 */
export const formRequest = pgTable(
  "form_request",
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
    /** The reach-out that carries the link. */
    reachOutId: uuid("reach_out_id"),
    /** Why we ask: the step's own words. */
    purpose: text("purpose").notNull(),
    /** The form as sent (core's `FormDefinition`). Never changed once sent. */
    definition: json("definition").notNull(),
    /** The step's ask (core's `FormAsk`): which answers are the required ones. */
    ask: json("ask").notNull(),
    status: text("status").$type<(typeof FORM_REQUEST_STATUSES)[number]>().notNull(),
    /** The language the page and the message read in. */
    language: text("language").notNull().default("en"),
    dueAt: ts("due_at").notNull(),
    /** Answers saved so far, to finish later. */
    draft: json("draft").notNull().default({}),
    /** The answers sent: what the person wrote, untrusted data. */
    answers: json("answers"),
    /** Every document uploaded through the page, kept even when removed from the answers. */
    documents: json<string[]>("documents").notNull().default([]),
    sources: json<string[]>("sources").notNull().default([]),
    /** What happened on the page (opened, saved, file added, sent), with time and browser. */
    log: json<Record<string, unknown>[]>("log").notNull().default([]),
    openedAt: ts("opened_at"),
    submittedAt: ts("submitted_at"),
    runReceivedAt: ts("run_received_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("form_request_id_tenant_key").on(t.id, t.tenantId),
    uniqueIndex("form_request_step_key").on(t.tenantId, t.runId, t.nodeId),
    index("form_request_status_idx").on(t.tenantId, t.status, t.dueAt),
    index("form_request_contact_idx").on(t.tenantId, t.contactId, t.createdAt),
    foreignKey({
      name: "form_request_contact_fk",
      columns: [t.contactId, t.tenantId],
      foreignColumns: [contact.id, contact.tenantId],
    }),
    foreignKey({
      name: "form_request_run_fk",
      columns: [t.runId, t.tenantId],
      foreignColumns: [run.id, run.tenantId],
    }),
    foreignKey({
      name: "form_request_agent_fk",
      columns: [t.agentId, t.tenantId],
      foreignColumns: [agent.id, agent.tenantId],
    }),
    foreignKey({
      name: "form_request_reach_out_fk",
      columns: [t.reachOutId, t.tenantId],
      foreignColumns: [reachOut.id, reachOut.tenantId],
    }),
    check("form_request_status_check", oneOf(t.status, FORM_REQUEST_STATUSES)),
    check(
      "form_request_submitted_check",
      sql`(${t.status} = 'submitted') = (${t.answers} is not null and ${t.submittedAt} is not null)`,
    ),
    check("form_request_purpose_check", sql`char_length(${t.purpose}) between 1 and 500`),
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

// ── P-7: message translation (migration 0034; docs/plan.md §1.69, ARCHITECTURE §5.7) ─────────────

/** A contact's switch over the client's translation (docs/plan.md §1.69). */
export interface ContactTranslation {
  incoming?: boolean;
  outgoing?: boolean;
}

export const TRANSLATION_DIRECTIONS = ["in", "out"] as const;
export const TRANSLATION_STATUSES = [
  "translated",
  "skipped",
  "capped",
  "refused",
  "failed",
] as const;
export const TRANSLATION_DETECTED_BY = ["rule", "model", "none"] as const;
/** The six languages (core's LOCALES) and `unknown` for anything else. */
export const TRANSLATION_LANGUAGES = ["en", "es", "fr", "pt-BR", "it", "de", "unknown"] as const;

/**
 * One translation attempt of one original (docs/plan.md §1.69): a raw record (a text, a WhatsApp
 * message, an email reply), a thread message, or a reach-out's message a person wrote. Every
 * outcome is a row, insert only (a trigger, like doc_extraction): the original is never touched and
 * a retry is a new row. The text is the sender's words in another language: data, never
 * instructions (invariant 9). Made by an agent: its version, run and step; by a person: who asked.
 */
export const messageTranslation = pgTable(
  "message_translation",
  {
    id: id(),
    tenantId: tenantId(),
    rawRecordId: uuid("raw_record_id"),
    messageId: uuid("message_id"),
    reachOutId: uuid("reach_out_id"),
    /** Which text of the original: `text`, or a dotted path into a raw record's payload. */
    field: text("field").notNull().default("text"),
    direction: text("direction").$type<(typeof TRANSLATION_DIRECTIONS)[number]>().notNull(),
    sourceLanguage: text("source_language")
      .$type<(typeof TRANSLATION_LANGUAGES)[number]>()
      .notNull(),
    targetLanguage: text("target_language")
      .$type<(typeof TRANSLATION_LANGUAGES)[number]>()
      .notNull(),
    detectedBy: text("detected_by").$type<(typeof TRANSLATION_DETECTED_BY)[number]>().notNull(),
    status: text("status").$type<(typeof TRANSLATION_STATUSES)[number]>().notNull(),
    /** Why it was skipped, capped, refused or failed, as a code (`same_language`, `contact_off`…). */
    reason: text("reason"),
    /** The translation; only when `translated`. */
    text: text("text"),
    originalChars: integer("original_chars").notNull().default(0),
    /** Only the first part of a long original was translated. */
    truncated: boolean("truncated").notNull().default(false),
    model: text("model"),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    costUsd: usd("cost_usd"),
    agentVersionId: uuid("agent_version_id"),
    runId: uuid("run_id"),
    stepRunId: uuid("step_run_id"),
    requestedBy: uuid("requested_by").references(() => appUser.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("message_translation_id_tenant_key").on(t.id, t.tenantId),
    foreignKey({
      name: "message_translation_raw_record_fk",
      columns: [t.rawRecordId, t.tenantId],
      foreignColumns: [rawRecord.id, rawRecord.tenantId],
    }),
    foreignKey({
      name: "message_translation_message_fk",
      columns: [t.messageId, t.tenantId],
      foreignColumns: [message.id, message.tenantId],
    }),
    foreignKey({
      name: "message_translation_reach_out_fk",
      columns: [t.reachOutId, t.tenantId],
      foreignColumns: [reachOut.id, reachOut.tenantId],
    }),
    foreignKey({
      name: "message_translation_agent_version_fk",
      columns: [t.agentVersionId, t.tenantId],
      foreignColumns: [agentVersion.id, agentVersion.tenantId],
    }),
    foreignKey({
      name: "message_translation_run_fk",
      columns: [t.runId, t.tenantId],
      foreignColumns: [run.id, run.tenantId],
    }),
    foreignKey({
      name: "message_translation_step_run_fk",
      columns: [t.stepRunId, t.tenantId],
      foreignColumns: [stepRun.id, stepRun.tenantId],
    }),
    // One translation per original, field and language; every other outcome may repeat.
    uniqueIndex("message_translation_raw_record_key")
      .on(t.tenantId, t.rawRecordId, t.field, t.targetLanguage)
      .where(sql`${t.status} = 'translated' and ${t.rawRecordId} is not null`),
    uniqueIndex("message_translation_message_key")
      .on(t.tenantId, t.messageId, t.field, t.targetLanguage)
      .where(sql`${t.status} = 'translated' and ${t.messageId} is not null`),
    index("message_translation_raw_record_idx").on(t.tenantId, t.rawRecordId),
    index("message_translation_message_idx").on(t.tenantId, t.messageId),
    index("message_translation_reach_out_idx").on(t.tenantId, t.reachOutId),
    // The daily limit and the rollup: a client's rows by day.
    index("message_translation_tenant_idx").on(t.tenantId, t.createdAt),
    check(
      "message_translation_source_check",
      sql`num_nonnulls(${t.rawRecordId}, ${t.messageId}, ${t.reachOutId}) = 1`,
    ),
    check("message_translation_direction_check", oneOf(t.direction, TRANSLATION_DIRECTIONS)),
    check("message_translation_status_check", oneOf(t.status, TRANSLATION_STATUSES)),
    check("message_translation_detected_by_check", oneOf(t.detectedBy, TRANSLATION_DETECTED_BY)),
    check(
      "message_translation_source_language_check",
      oneOf(t.sourceLanguage, TRANSLATION_LANGUAGES),
    ),
    check(
      "message_translation_target_language_check",
      sql`${t.targetLanguage} in ('en', 'es', 'fr', 'pt-BR', 'it', 'de')`,
    ),
    check(
      "message_translation_text_check",
      sql`(${t.status} = 'translated') = (${t.text} is not null)`,
    ),
    check("message_translation_field_check", sql`length(${t.field}) between 1 and 200`),
    check(
      "message_translation_amounts_check",
      sql`${t.tokensIn} >= 0 and ${t.tokensOut} >= 0 and ${t.costUsd} >= 0 and ${t.originalChars} >= 0`,
    ),
    check(
      "message_translation_step_check",
      sql`${t.stepRunId} is null or (${t.runId} is not null and ${t.agentVersionId} is not null)`,
    ),
  ],
);

/**
 * Every table with a `tenant_id`, in the order RLS tests walk them. Migration 0002 enables and
 * forces row-level security on each; migrations.test.ts checks this list against the database.
 */

// ── Knowledge base ───────────────────────────────────────────────────────────────────────────────

/** `voice_sample` (migration 0025): a message in a person's own voice, for writing like them. */
// §1.149 (0066): `about`, confirmed facts about the client's business, filed when the scope is
// signed (docs/cases-plan.md §4.7), apart from FAQs and policies.
export const KNOWLEDGE_ENTRY_KINDS = ["faq", "policy", "voice_sample", "about"] as const;
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
  // B6 (docs/builder-plan.md §8): governance, on a `policy` entry's version. No migration: the
  // column is JSON. Core's `GovernanceTier` and `GovernanceTag` hold the values.
  /** `charter`: the client's charter (one per client); `policy`: read by agents by its tags. */
  tier?: "charter" | "policy";
  /** The standard topics and business areas it covers. */
  tags?: string[];
  /** The client admin who confirmed this version (an app user id), and when (ISO). */
  confirmedBy?: string;
  confirmedAt?: string;
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
    /** The monthly price of a phone number that is one agent's own (§1.160). */
    phoneLinePrice: money("phone_line_price").notNull().default("10.0000"),
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
    check("billing_setting_phone_line_price_check", sql`${t.phoneLinePrice} >= 0`),
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
// Agent phone lines (docs/plan.md §1.160): a number of the client's that is one agent's own.
export const BILLING_LINE_KINDS = ["agent", "phone_line", "usage", "adjustment"] as const;

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
 * One day a number of the client's was one agent's own (§1.160), with the line's price that day.
 * Recorded by the same hourly pass as `billing_agent_day`, for numbers whose agent was active;
 * the first price seen in a day sticks. Insert only.
 */
export const billingPhoneLineDay = pgTable(
  "billing_phone_line_day",
  {
    tenantId: tenantId(),
    day: date("day").notNull(),
    /** E.164. */
    phoneNumber: text("phone_number").notNull(),
    agentId: uuid("agent_id").notNull(),
    /** The name the client knows the agent by, as it was that day. */
    agentName: text("agent_name").notNull(),
    monthlyPrice: money("monthly_price").notNull(),
    currency: currency(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.day, t.phoneNumber] }),
    foreignKey({
      name: "billing_phone_line_day_agent_fk",
      columns: [t.agentId, t.tenantId],
      foreignColumns: [agent.id, agent.tenantId],
    }),
    check("billing_phone_line_day_price_check", sql`${t.monthlyPrice} >= 0`),
    check("billing_phone_line_day_number_check", sql`${t.phoneNumber} ~ '^\\+[1-9][0-9]{6,14}$'`),
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
      sql`(${t.kind} in ('agent', 'phone_line')) = (${t.agentId} is not null)`,
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

// §1.116: `push`, to a person's registered phones (migration 0056).
export const NOTIFICATION_CHANNELS = ["email", "sms", "push"] as const;
export const DEVICE_PLATFORMS = ["ios", "android"] as const;
export const NOTIFICATION_KINDS = [
  "items_waiting",
  "weekly_table",
  "reconnect",
  "credits",
  "lead_message",
  "signoff",
  // §1.124 (0060): the operator answered a client's request; sent by Build (§1.124.1).
  "issue_update",
] as const;
/**
 * §1.149 (0066): the onboarding emails, sent through this outbox as their own kinds (stream EMAIL;
 * docs/cases-plan.md §4.4). Rendered at send from the intake and its person, never from `counts`.
 * The check allows them before core's notification kinds name them, so the previous Worker keeps
 * working and the next wave's (reminder, scope ready, what happens next) need no migration.
 */
export const ONBOARDING_NOTIFICATION_KINDS = [
  "intake_invite",
  "intake_colleague",
  "intake_more_questions",
  "intake_reminder",
  "intake_scope_ready",
  "intake_next",
] as const;
/** The kinds a row may have: core's, and the onboarding emails' (0066). */
export const NOTIFICATION_KINDS_ALLOWED = [
  ...NOTIFICATION_KINDS,
  ...ONBOARDING_NOTIFICATION_KINDS,
] as const;
/**
 * Work plan C4.10 (0079): an urgent notice's Seen card, told at once whatever the person's quiet
 * hours (process model's Notify, docs/plan.md §1.86). The check allows it before core's
 * notification kinds named it, so the previous Worker kept working; core names it now.
 */
export const URGENT_NOTIFICATION_KINDS = ["urgent"] as const;
/** The kinds the check allows: those above and urgent notices' (0079). */
export const NOTIFICATION_KIND_CHECK = [
  ...NOTIFICATION_KINDS_ALLOWED,
  ...URGENT_NOTIFICATION_KINDS,
] as const;
export const NOTIFICATION_STATUSES = ["queued", "sent", "failed", "skipped"] as const;
export const WEEKLY_TABLE_STATUSES = ["draft", "sent"] as const;

/**
 * §1.116 (migration 0056): a person's phone with the Mezonas app: where its notifications go (an
 * Expo push token) and the public half of the key it signs Desk items with. Removing a phone sets
 * `revoked_at` and clears both; the row stays, since signatures in the audit log name it.
 */
export const personDevice = pgTable(
  "person_device",
  {
    id: id(),
    tenantId: tenantId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUser.id),
    name: text("name").notNull(),
    platform: text("platform").$type<(typeof DEVICE_PLATFORMS)[number]>().notNull(),
    /** Expo's push token (`ExponentPushToken[…]`); null when the person allowed no notifications. */
    pushToken: text("push_token"),
    /** An EC P-256 JWK (public only); null when the phone has no signing key. */
    publicKey: json<{ kty: "EC"; crv: "P-256"; x: string; y: string }>("public_key"),
    createdAt: createdAt(),
    lastSeenAt: ts("last_seen_at"),
    revokedAt: ts("revoked_at"),
  },
  (t) => [
    unique("person_device_id_tenant_key").on(t.id, t.tenantId),
    index("person_device_user_idx").on(t.tenantId, t.userId),
    check("person_device_platform_check", oneOf(t.platform, DEVICE_PLATFORMS)),
    check(
      "person_device_revoked_check",
      sql`${t.revokedAt} is null or (${t.pushToken} is null and ${t.publicKey} is null)`,
    ),
  ],
);

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
    // §1.149: the onboarding emails' kinds too (core ONBOARDING_NOTIFICATION_KINDS); a type only.
    // C4.10: and `urgent`, now core's kind too (0079).
    kind: text("kind").$type<(typeof NOTIFICATION_KIND_CHECK)[number]>().notNull(),
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
    check("notification_kind_check", oneOf(t.kind, NOTIFICATION_KIND_CHECK)),
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
    /**
     * Connectors C3 (docs/connectors-plan.md §6): a connector built for some clients only. Null: every
     * client; else it is shown, offered and bindable only for these. Clearing it promotes it.
     */
    // DECISION: no foreign key (Postgres has none for array elements). A purged client's id stays
    // and matches no client, since ids are never reused.
    clients: uuid("clients").array(),
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
    check(
      "connector_setting_clients_check",
      sql`${t.clients} is null or cardinality(${t.clients}) between 1 and 200`,
    ),
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
    definition: json<AnyAutomationDefinition>("definition").notNull(),
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
 * v0.17 (ARCHITECTURE §10.14 "Automations, repeat and the agent's choice"): what the owner decides
 * besides a review, kept in the same table: an `if` it chooses (`choose`: a path, or `unsure`) and
 * a repeat it says is done or not (`until`: `done`, `again`, or `unsure` when no answer held).
 */
export const CHOICE_CAUSES = ["choose", "until"] as const;
export const CHOICE_ACTIONS = ["choose", "unsure", "done", "again"] as const;
export type ChoiceAction = (typeof CHOICE_ACTIONS)[number];
const DECISION_CAUSES = [...OVERSIGHT_CAUSES, ...CHOICE_CAUSES] as const;
const DECISION_ACTIONS = [...OVERSIGHT_ACTIONS, ...CHOICE_ACTIONS] as const;

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
    cause: text("cause").$type<(typeof DECISION_CAUSES)[number]>().notNull(),
    action: text("action").$type<OversightAction | ChoiceAction>().notNull(),
    /** v0.17: `choose` only: the path id the agent picked. */
    choice: text("choice"),
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
    check("oversight_decision_cause_check", oneOf(t.cause, DECISION_CAUSES)),
    check("oversight_decision_action_check", oneOf(t.action, DECISION_ACTIONS)),
    check(
      "oversight_decision_choice_check",
      sql`(${t.action} = 'choose') = (${t.choice} is not null)`,
    ),
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

// ── The Builder as a conversation (migration 0030, ARCHITECTURE §9.6; plan §1.51) ───────────────
// Rows follow the templates' policy: a session on a template or a shared skill has tenant_id null
// (operator sessions only); a session on a client's agent or skill carries that client's id and is
// seen only in its scope (CLAUDE.md invariant 1). Only operator routes read them.

export const BUILDER_SESSION_KINDS = ["agent", "skill"] as const;
export type BuilderSessionKind = (typeof BUILDER_SESSION_KINDS)[number];
export const BUILDER_SESSION_STATUSES = ["open", "saved", "closed"] as const;
export type BuilderSessionStatus = (typeof BUILDER_SESSION_STATUSES)[number];
export const BUILDER_TURN_ROLES = ["operator", "builder"] as const;
export type BuilderTurnRole = (typeof BUILDER_TURN_ROLES)[number];

/** One labelled change a turn made (`builder_turn.changes`); validated by core where it is written. */
export interface BuilderChangeEntry {
  /** What undo names: core's selectable change id (`step:<id>`, `bundle#/definition/…`) or a field. */
  id: string;
  label: string;
  before?: unknown;
  after?: unknown;
  /** An undo turn's entry: the turn and entry it reverted. */
  undoes?: { turnId: string; changeId: string };
}

/**
 * A Builder conversation about one agent (new or existing, template or client agent) or one skill.
 * `bundle` is the working draft: an `AgentBundle` for `agent`, `{definition, cases}` for `skill`.
 * `agent_id` / `skill_id` are set once the draft is saved (or from the start for an existing one);
 * `base_version_id` is the version the conversation started from (each save is a turn that names
 * the version it wrote).
 * Updated in place; never deleted.
 */
// DECISION: `base_version_id` has no foreign key: it names an `agent_version` or a `skill_version`
// by `kind` (as test_case's target does). The routes check it belongs to the session's target.
export const builderSession = pgTable(
  "builder_session",
  {
    id: id(),
    tenantId: optionalTenantId(),
    kind: text("kind").$type<BuilderSessionKind>().notNull(),
    agentId: uuid("agent_id"),
    skillId: uuid("skill_id"),
    baseVersionId: uuid("base_version_id"),
    bundle: json<unknown>("bundle").notNull(),
    status: text("status").$type<BuilderSessionStatus>().notNull().default("open"),
    createdBy: uuid("created_by").references(() => appUser.id),
    createdAt: createdAt(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("builder_session_id_tenant_key").on(t.id, t.tenantId),
    // Same client as its agent or skill (enforced whenever tenant_id is set), and existing.
    foreignKey({
      name: "builder_session_agent_fk",
      columns: [t.agentId, t.tenantId],
      foreignColumns: [agent.id, agent.tenantId],
    }),
    foreignKey({
      name: "builder_session_agent_id_fk",
      columns: [t.agentId],
      foreignColumns: [agent.id],
    }),
    foreignKey({
      name: "builder_session_skill_fk",
      columns: [t.skillId, t.tenantId],
      foreignColumns: [skill.id, skill.tenantId],
    }),
    foreignKey({
      name: "builder_session_skill_id_fk",
      columns: [t.skillId],
      foreignColumns: [skill.id],
    }),
    index("builder_session_agent_idx").on(t.agentId),
    index("builder_session_skill_idx").on(t.skillId),
    index("builder_session_tenant_idx").on(t.tenantId, t.createdAt),
    check("builder_session_kind_check", oneOf(t.kind, BUILDER_SESSION_KINDS)),
    check("builder_session_status_check", oneOf(t.status, BUILDER_SESSION_STATUSES)),
    check(
      "builder_session_target_check",
      sql`(${t.kind} = 'agent' and ${t.skillId} is null) or (${t.kind} = 'skill' and ${t.agentId} is null)`,
    ),
  ],
);

/**
 * One message of a Builder conversation: the operator's (`text`, the `/command` it was, an undo or
 * a save) or the Builder's answer (`text`, the labelled `changes` it made). `bundle` is the working
 * draft after the turn when the turn changed it (undo merges against it); `meta` holds the
 * Builder's questions, gaps, the guards' notes, publish errors, the parsed command and the model.
 * Immutable except `undone_at` (trigger), set once every change of the turn is undone.
 */
// DECISION: `bundle` and `meta` are two columns beyond ARCHITECTURE §5.5's list: undo needs the
// bundle after the entry's turn (plan §1.51), and a reopened conversation shows the questions,
// gaps and notes the answer had.
// DECISION: `saved_version_id` has no foreign key: an `agent_version` or a `skill_version` by the
// session's kind. It is set when the save turn is inserted, never later.
export const builderTurn = pgTable(
  "builder_turn",
  {
    id: id(),
    tenantId: optionalTenantId(),
    sessionId: uuid("session_id").notNull(),
    seq: integer("seq").notNull(),
    role: text("role").$type<BuilderTurnRole>().notNull(),
    text: text("text").notNull(),
    command: text("command"),
    changes: json<BuilderChangeEntry[]>("changes").notNull().default([]),
    bundle: json<unknown>("bundle"),
    meta: json("meta").notNull().default({}),
    undoneAt: ts("undone_at"),
    savedVersionId: uuid("saved_version_id"),
    costUsd: usd("cost_usd"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("builder_turn_session_seq_key").on(t.sessionId, t.seq),
    // Same client as its session (enforced whenever tenant_id is set), and existing.
    foreignKey({
      name: "builder_turn_session_fk",
      columns: [t.sessionId, t.tenantId],
      foreignColumns: [builderSession.id, builderSession.tenantId],
    }),
    foreignKey({
      name: "builder_turn_session_id_fk",
      columns: [t.sessionId],
      foreignColumns: [builderSession.id],
    }),
    index("builder_turn_tenant_idx").on(t.tenantId),
    check("builder_turn_role_check", oneOf(t.role, BUILDER_TURN_ROLES)),
    check("builder_turn_seq_check", sql`${t.seq} >= 1`),
    check("builder_turn_changes_check", sql`jsonb_typeof(${t.changes}) = 'array'`),
    check("builder_turn_cost_check", sql`${t.costUsd} >= 0`),
  ],
);

// ── v0.14 capture: WhatsApp passive capture (migration 0031; ARCHITECTURE §6.12, docs/plan.md §1.55) ──

export const CONVERSATION_CHANNELS = ["whatsapp", "sms"] as const;
export type ConversationChannel = (typeof CONVERSATION_CHANNELS)[number];
export const CONVERSATION_KINDS = ["direct", "group"] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];
export const CAPTURE_ATTACHMENTS = ["off", "documents", "all"] as const;
export type CaptureAttachments = (typeof CAPTURE_ATTACHMENTS)[number];
export const CONVERSATION_CHANGE_SIDES = ["client", "operator", "system"] as const;
export type ConversationChangeSide = (typeof CONVERSATION_CHANGE_SIDES)[number];
/** 20 MB: a conversation's default per-file limit. */
export const CAPTURE_DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
/** 32 MB: never above the documents capability's limit (`MAX_DOCUMENT_BYTES`). */
export const CAPTURE_MAX_BYTES_CAP = 32 * 1024 * 1024;

/** What a conversation keeps (`conversation.capture`); validated by core where it is written. */
export interface ConversationCapture {
  /** Keep the message text (false: the envelope only). */
  archive: boolean;
  attachments: CaptureAttachments;
  /** Per file, 1 … `CAPTURE_MAX_BYTES_CAP`. */
  maxBytes: number;
  /** A client agent of this client started with the new documents. */
  agentId?: string;
}

/**
 * One WhatsApp chat on one connection: `direct` (one contact; Twilio) or `group` (the provider's
 * group id; Meta, later). Made on the first inbound message with the client's default capture.
 * Only `capture`, `title` and `updated_at` change (trigger); never deleted.
 */
// DECISION: `channel` allows `sms` though only WhatsApp makes conversations in v0.14, so SMS can
// join without a migration. `capture.agentId` has no foreign key (it lives in jsonb); the routes
// check it is this client's agent.
export const conversation = pgTable(
  "conversation",
  {
    id: id(),
    tenantId: tenantId(),
    connectionId: uuid("connection_id").notNull(),
    channel: text("channel").$type<ConversationChannel>().notNull(),
    kind: text("kind").$type<ConversationKind>().notNull(),
    contactId: uuid("contact_id"),
    externalId: text("external_id"),
    title: text("title").notNull(),
    capture: json<ConversationCapture>("capture")
      .notNull()
      .default({ archive: true, attachments: "off", maxBytes: CAPTURE_DEFAULT_MAX_BYTES }),
    createdAt: createdAt(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("conversation_id_tenant_key").on(t.id, t.tenantId),
    foreignKey({
      name: "conversation_connection_fk",
      columns: [t.connectionId, t.tenantId],
      foreignColumns: [connection.id, connection.tenantId],
    }),
    foreignKey({
      name: "conversation_contact_fk",
      columns: [t.contactId, t.tenantId],
      foreignColumns: [contact.id, contact.tenantId],
    }),
    uniqueIndex("conversation_direct_key")
      .on(t.connectionId, t.channel, t.contactId)
      .where(sql`${t.kind} = 'direct'`),
    uniqueIndex("conversation_group_key")
      .on(t.connectionId, t.channel, t.externalId)
      .where(sql`${t.kind} = 'group'`),
    index("conversation_contact_idx").on(t.contactId),
    index("conversation_tenant_idx").on(t.tenantId, t.updatedAt),
    check("conversation_channel_check", oneOf(t.channel, CONVERSATION_CHANNELS)),
    check("conversation_kind_check", oneOf(t.kind, CONVERSATION_KINDS)),
    check(
      "conversation_shape_check",
      sql`(${t.kind} = 'direct' and ${t.contactId} is not null and ${t.externalId} is null) or (${t.kind} = 'group' and ${t.externalId} is not null)`,
    ),
    check("conversation_title_check", sql`length(${t.title}) between 1 and 200`),
    check(
      "conversation_external_id_check",
      sql`${t.externalId} is null or length(${t.externalId}) between 1 and 200`,
    ),
    check(
      "conversation_capture_check",
      sql`jsonb_typeof(${t.capture}) = 'object' and coalesce(jsonb_typeof(${t.capture}->'archive') = 'boolean', false) and coalesce(${t.capture}->>'attachments' in ('off', 'documents', 'all'), false) and case when jsonb_typeof(${t.capture}->'maxBytes') = 'number' then (${t.capture}->>'maxBytes')::numeric between 1 and 33554432 else false end`,
    ),
  ],
);

/**
 * Every change to a conversation's capture: who (null: the system), from which side, the setting
 * before and after, and the reason when one was given. Append-only (trigger), like contact_change.
 */
export const conversationChange = pgTable(
  "conversation_change",
  {
    id: id(),
    tenantId: tenantId(),
    conversationId: uuid("conversation_id").notNull(),
    actorId: uuid("actor_id").references(() => appUser.id),
    side: text("side").$type<ConversationChangeSide>().notNull(),
    /** `{setting: 'capture', before, after, reason?}`. */
    change: json("change").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "conversation_change_conversation_fk",
      columns: [t.conversationId, t.tenantId],
      foreignColumns: [conversation.id, conversation.tenantId],
    }),
    index("conversation_change_conversation_idx").on(t.conversationId, t.createdAt),
    index("conversation_change_tenant_idx").on(t.tenantId),
    check("conversation_change_side_check", oneOf(t.side, CONVERSATION_CHANGE_SIDES)),
    check("conversation_change_change_check", sql`jsonb_typeof(${t.change}) = 'object'`),
  ],
);

// ── Alerts (P-1, migration 0033; ARCHITECTURE §5.2) ───────────────────────────────────────────────────────────────────────────────────────

export const ALERT_SEVERITIES = ["info", "warning", "critical"] as const;
export const ALERT_STATUSES = ["open", "accepted", "dismissed"] as const;

/**
 * Something an agent noticed that a person should see (ARCHITECTURE §5.2), with the records it
 * rests on (`evidence`, never empty: CLAUDE.md invariant 10) and the agent version that raised it.
 * A pack's alerts name the pack; its rules decide `kind`. Kept, never deleted: a person accepts or
 * dismisses one (status), and nothing else changes it.
 */
export const alert = pgTable(
  "alert",
  {
    id: id(),
    tenantId: tenantId(),
    pack: text("pack"),
    kind: text("kind").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    severity: text("severity").$type<(typeof ALERT_SEVERITIES)[number]>().notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    /** Record ids the alert rests on. */
    evidence: json<string[]>("evidence").notNull(),
    /** What the rule measured (prices, percentages, the vendor), for reports. */
    facts: json("facts").notNull().default({}),
    dollarImpact: money("dollar_impact"),
    currency: text("currency").notNull().default("USD"),
    // DECISION: deduplication (ARCHITECTURE §12.4: one open alert per kind, item and vendor) is a
    // key the raiser builds, unique among a client's open alerts, so two runs can't both raise it.
    dedupeKey: text("dedupe_key"),
    status: text("status").$type<(typeof ALERT_STATUSES)[number]>().notNull().default("open"),
    raisedByRunId: uuid("raised_by_run_id"),
    agentVersionId: uuid("agent_version_id").references(() => agentVersion.id),
    createdAt: createdAt(),
    resolvedAt: ts("resolved_at"),
    resolvedBy: uuid("resolved_by").references(() => appUser.id),
  },
  (t) => [
    unique("alert_id_tenant_key").on(t.id, t.tenantId),
    foreignKey({
      name: "alert_run_fk",
      columns: [t.raisedByRunId, t.tenantId],
      foreignColumns: [run.id, run.tenantId],
    }),
    uniqueIndex("alert_open_dedupe_key")
      .on(t.tenantId, t.dedupeKey)
      .where(sql`${t.status} = 'open' and ${t.dedupeKey} is not null`),
    index("alert_tenant_idx").on(t.tenantId, t.status, t.createdAt),
    index("alert_subject_idx").on(t.tenantId, t.subjectType, t.subjectId),
    check("alert_severity_check", oneOf(t.severity, ALERT_SEVERITIES)),
    check("alert_status_check", oneOf(t.status, ALERT_STATUSES)),
    check(
      "alert_evidence_check",
      sql`jsonb_typeof(${t.evidence}) = 'array' and jsonb_array_length(${t.evidence}) > 0`,
    ),
  ],
);

/**
 * Intuit's webhook notifications for a QuickBooks connection, one row per entity change it names
 * (docs/plan.md §1.81): what changed, as Intuit said, kept as a log. The change itself is read by
 * the next sync (CDC); a row whose entity we sync started one. Intuit resends, so the same change
 * is stored once.
 */
export const qboWebhookEvent = pgTable(
  "qbo_webhook_event",
  {
    id: id(),
    tenantId: tenantId(),
    connectionId: uuid("connection_id").notNull(),
    realmId: text("realm_id").notNull(),
    /** Intuit's entity name (`Bill`, `Vendor`, …). */
    entity: text("entity").notNull(),
    entityId: text("entity_id").notNull(),
    /** `Create`, `Update`, `Delete`, `Merge`, `Void`, `Emailed`, as Intuit sends it. */
    operation: text("operation").notNull(),
    /** When the record changed at Intuit; null when the notification didn't say. */
    lastUpdated: ts("last_updated"),
    /** An entity our sync reads: its notification started one. */
    acted: boolean("acted").notNull(),
    receivedAt: ts("received_at").notNull().defaultNow(),
  },
  (t) => [
    unique("qbo_webhook_event_id_tenant_key").on(t.id, t.tenantId),
    // Intuit can resend a notification: one row per change.
    unique("qbo_webhook_event_change_key")
      .on(t.connectionId, t.entity, t.entityId, t.operation, t.lastUpdated)
      .nullsNotDistinct(),
    index("qbo_webhook_event_received_idx").on(t.tenantId, t.receivedAt),
    foreignKey({
      name: "qbo_webhook_event_connection_fk",
      columns: [t.connectionId, t.tenantId],
      foreignColumns: [connection.id, connection.tenantId],
    }),
  ],
);

// ── Wave 4: recorded browser scripts (migration 0045; docs/plan.md §1.86 "Scripts (wave 4)") ──────

/** Who recorded a script version: the operator (back office) or the client admin (portal). */
export const SCRIPT_SIDES = ["operator", "client"] as const;

/**
 * A client's scripted site tool on one of its browser logins (ARCHITECTURE v0.16 §10.14 "Browser
 * connectors"): its name and slug on the site, the recording being made (core's `ScriptRecording`,
 * the working copy edited in place while someone records), and the version the operator
 * published. Only a published version runs; a client admin's recording stays a draft until the
 * operator publishes it (invariant 11). Per client, never shared (invariant 1).
 */
export const browserScript = pgTable(
  "browser_script",
  {
    id: id(),
    tenantId: tenantId(),
    /** The client's browser login the script runs through (connector `browser`). */
    connectionId: uuid("connection_id").notNull(),
    /** The login's site slug (`connection.config.site`), kept so tools find the script by it. */
    site: text("site").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    recording: json("recording").notNull(),
    /** The version that runs as a tool; null: none yet (drafts never run). */
    publishedVersion: integer("published_version"),
    publishedBy: uuid("published_by").references(() => appUser.id),
    publishedAt: ts("published_at"),
    /** The script-draft offer (an operator inbox item) it was started from, if any. */
    offerItemId: uuid("offer_item_id"),
    createdBy: uuid("created_by").references(() => appUser.id),
    createdSide: text("created_side").$type<(typeof SCRIPT_SIDES)[number]>().notNull(),
    createdAt: createdAt(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("browser_script_id_tenant_key").on(t.id, t.tenantId),
    unique("browser_script_slug_key").on(t.tenantId, t.site, t.slug),
    check("browser_script_slug_check", sql`${t.slug} ~ '^[a-z0-9][a-z0-9-]{0,62}$'`),
    check("browser_script_created_side_check", oneOf(t.createdSide, SCRIPT_SIDES)),
    check(
      "browser_script_published_version_check",
      sql`${t.publishedVersion} is null or ${t.publishedVersion} >= 1`,
    ),
    foreignKey({
      name: "browser_script_connection_fk",
      columns: [t.connectionId, t.tenantId],
      foreignColumns: [connection.id, connection.tenantId],
    }),
  ],
);

/**
 * One saved version of a script: its definition (core's `BrowserScriptDefinition`) and the
 * evidence screenshots of its recording by step id (storage keys on the connection's log).
 * Immutable and never deleted (trigger, invariant 3); publishing points the script at one.
 */
export const browserScriptVersion = pgTable(
  "browser_script_version",
  {
    id: id(),
    tenantId: tenantId(),
    scriptId: uuid("script_id").notNull(),
    version: integer("version").notNull(),
    definition: json("definition").notNull(),
    evidence: json("evidence").notNull().default({}),
    recordedBy: uuid("recorded_by").references(() => appUser.id),
    recordedSide: text("recorded_side").$type<(typeof SCRIPT_SIDES)[number]>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("browser_script_version_id_tenant_key").on(t.id, t.tenantId),
    unique("browser_script_version_script_version_key").on(t.scriptId, t.version),
    check("browser_script_version_version_check", sql`${t.version} >= 1`),
    check("browser_script_version_recorded_side_check", oneOf(t.recordedSide, SCRIPT_SIDES)),
    foreignKey({
      name: "browser_script_version_script_fk",
      columns: [t.scriptId, t.tenantId],
      foreignColumns: [browserScript.id, browserScript.tenantId],
    }),
  ],
);

// ── Wave 6: the run audit (migration 0046; docs/plan.md §1.86 "Run audit (wave 6)") ──────────────
// Back office only (invariant 11): no portal route reads these tables.

/** What the owner's check on one attempt at a step came to. */
export const OWNER_CHECK_RESULTS = ["clean", "flagged", "reviewed", "not_watched"] as const;
/**
 * How the attempt itself ended, before any review: done, failed (or threw), escalated (a budget
 * was reached), turned down by a person, or nobody answered in time.
 */
export const OWNER_CHECK_ATTEMPTS = [
  "succeeded",
  "failed",
  "escalated",
  "rejected",
  "unanswered",
] as const;
/**
 * Why a review that was due wasn't made (on a flagged check, or a clean one whose routine review
 * was due): the per-step or per-run limit was reached, the review failed or gave no decision, its
 * input could not be shown; why the owner never looked (a person's answer, or nobody answering,
 * ended the run during the attempt); or why a check is `not_watched`: the agent's owner is off,
 * or this step's review is off.
 */
export const OWNER_CHECK_REASONS = [
  "limit",
  "review_failed",
  "no_decision",
  "input_unresolved",
  "ended_by_person",
  "owner_off",
  "step_off",
] as const;
/** Why a step that succeeded was due a review whatever its result. */
export const OWNER_REVIEW_DUES = ["checkpoint", "all", "always"] as const;

/**
 * The owner's check on one attempt at a step of a v4 process (read, skill, write): clean (its
 * cheap watch saw nothing off), flagged (with the signals, or a failure, and why no review
 * followed), reviewed (the `oversight_decision` it led to) or not watched (the owner is off).
 * Written in a durable step of its own after the attempt, once per run, node and attempt. No
 * model call: the cheap watch is rules only. Insert only (grants and trigger).
 */
export const ownerCheck = pgTable(
  "owner_check",
  {
    id: id(),
    tenantId: tenantId(),
    runId: uuid("run_id").notNull(),
    /** The step's durable name (`step_run.node_id`). */
    nodeId: text("node_id").notNull(),
    /** 1.. per node: the attempt the owner looked at (an oversight retry is the next). */
    attempt: integer("attempt").notNull(),
    result: text("result").$type<(typeof OWNER_CHECK_RESULTS)[number]>().notNull(),
    attemptOutcome: text("attempt_outcome")
      .$type<(typeof OWNER_CHECK_ATTEMPTS)[number]>()
      .notNull(),
    /** core's `AnomalySignal[]`: what the cheap watch saw (empty when clean or not watched). */
    signals: json<unknown[]>("signals").notNull().default([]),
    reason: text("reason").$type<(typeof OWNER_CHECK_REASONS)[number]>(),
    /** `reviewed`: why (the oversight cause) and the verdict's action. */
    cause: text("cause").$type<(typeof OVERSIGHT_CAUSES)[number]>(),
    verdict: text("verdict"),
    /** A step that succeeded and was due a review whatever its result: a checkpoint, all, always. */
    reviewDue: text("review_due").$type<(typeof OWNER_REVIEW_DUES)[number]>(),
    /**
     * `reviewed`: the decision recorded for this run, node and attempt, when there is one.
     * DECISION (wave 6 review): on `oversight_decision(id)` alone, not `(id, tenant_id)`: that
     * table (0029) has no unique `(id, tenant_id)` to reference, and adding one would alter a
     * table the previous Worker writes. The store reads the decision inside the run's own client
     * (`withTenant`, filtered by `tenant_id`), so a check never names another client's decision.
     */
    decisionId: uuid("decision_id").references(() => oversightDecision.id),
    agentVersionId: uuid("agent_version_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("owner_check_attempt_key").on(t.runId, t.nodeId, t.attempt),
    foreignKey({
      name: "owner_check_run_fk",
      columns: [t.runId, t.tenantId],
      foreignColumns: [run.id, run.tenantId],
    }),
    foreignKey({
      name: "owner_check_agent_version_fk",
      columns: [t.agentVersionId, t.tenantId],
      foreignColumns: [agentVersion.id, agentVersion.tenantId],
    }),
    index("owner_check_tenant_idx").on(t.tenantId, t.createdAt),
    check("owner_check_result_check", oneOf(t.result, OWNER_CHECK_RESULTS)),
    check("owner_check_attempt_outcome_check", oneOf(t.attemptOutcome, OWNER_CHECK_ATTEMPTS)),
    check(
      "owner_check_reason_check",
      sql`${t.reason} is null or ${oneOf(t.reason, OWNER_CHECK_REASONS)}`,
    ),
    check(
      "owner_check_cause_check",
      sql`${t.cause} is null or ${oneOf(t.cause, OVERSIGHT_CAUSES)}`,
    ),
    check(
      "owner_check_review_due_check",
      sql`${t.reviewDue} is null or ${oneOf(t.reviewDue, OWNER_REVIEW_DUES)}`,
    ),
    check("owner_check_attempt_check", sql`${t.attempt} >= 1`),
    check("owner_check_signals_check", sql`jsonb_typeof(${t.signals}) = 'array'`),
    check(
      "owner_check_reviewed_check",
      sql`(${t.result} = 'reviewed') = (${t.verdict} is not null and ${t.cause} is not null)`,
    ),
    check("owner_check_verdict_check", sql`${t.verdict} is null or length(${t.verdict}) <= 40`),
  ],
);

/** Why a run is in the audit queue: it wrote to a client's tool, it was sampled, or by hand. */
export const RUN_AUDIT_REASONS = ["wrote", "sampled", "by_hand"] as const;
/** A reviewer's mark on a run. */
export const RUN_AUDIT_VERDICTS = ["looks_right", "problem"] as const;

/**
 * A run queued for a person's audit: chosen when the run finished, by the client's sampling rule
 * (or the agent's override), deterministically (a hash of the run id), or added by hand when a
 * reviewer marks a run that wasn't. One row per run. `rule` is the rule as applied. Insert only.
 */
export const runAudit = pgTable(
  "run_audit",
  {
    id: id(),
    tenantId: tenantId(),
    runId: uuid("run_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    reason: text("reason").$type<(typeof RUN_AUDIT_REASONS)[number]>().notNull(),
    /** core's `AppliedAuditRule`: writes, percent, where it came from and the run's bucket. */
    rule: json("rule").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    unique("run_audit_run_key").on(t.runId),
    foreignKey({
      name: "run_audit_run_fk",
      columns: [t.runId, t.tenantId],
      foreignColumns: [run.id, run.tenantId],
    }),
    foreignKey({
      name: "run_audit_agent_fk",
      columns: [t.agentId, t.tenantId],
      foreignColumns: [agent.id, agent.tenantId],
    }),
    index("run_audit_tenant_idx").on(t.tenantId, t.createdAt),
    index("run_audit_agent_idx").on(t.tenantId, t.agentId, t.createdAt),
    check("run_audit_reason_check", oneOf(t.reason, RUN_AUDIT_REASONS)),
  ],
);

/**
 * A reviewer's mark on a run: it looks right, or a problem (with a note, and the operator inbox
 * item it opened). Insert only: a later mark supersedes an earlier one for display, every mark
 * is kept.
 */
export const runAuditMark = pgTable(
  "run_audit_mark",
  {
    id: id(),
    tenantId: tenantId(),
    runId: uuid("run_id").notNull(),
    verdict: text("verdict").$type<(typeof RUN_AUDIT_VERDICTS)[number]>().notNull(),
    note: text("note"),
    markedBy: uuid("marked_by")
      .notNull()
      .references(() => appUser.id),
    inboxItemId: uuid("inbox_item_id"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "run_audit_mark_run_fk",
      columns: [t.runId, t.tenantId],
      foreignColumns: [run.id, run.tenantId],
    }),
    foreignKey({
      name: "run_audit_mark_inbox_item_fk",
      columns: [t.inboxItemId, t.tenantId],
      foreignColumns: [inboxItem.id, inboxItem.tenantId],
    }),
    index("run_audit_mark_run_idx").on(t.runId, t.createdAt),
    index("run_audit_mark_tenant_idx").on(t.tenantId, t.createdAt),
    check("run_audit_mark_verdict_check", oneOf(t.verdict, RUN_AUDIT_VERDICTS)),
    check(
      "run_audit_mark_note_check",
      sql`(${t.note} is null or length(${t.note}) between 1 and 2000) and (${t.verdict} <> 'problem' or ${t.note} is not null)`,
    ),
  ],
);

// ── Back office work (docs/plan.md §1.124) ───────────────────────────────────────────────────────
// Sales, Build, Your call and Autopilot (docs/cases-plan.md): a client's issues and asks (tenant
// tables, migration 0060), and the operator's enhancements, to-dos, deals and plays (operator-only
// tables, migrations 0060–0063). Builds gain their promised date and origin above.

export const ISSUE_URGENCIES = ["critical", "high", "normal", "low"] as const;
export const ISSUE_STAGES = ["reported", "cause", "fix", "verify", "closed"] as const;
export const ISSUE_CAUSE_KINDS = ["setup", "data", "agent", "platform", "not_a_bug"] as const;
export const ISSUE_SOURCES = [
  "portal",
  "sloan",
  "email",
  "feedback",
  "error_report",
  "ops",
  "reggie",
  "legacy_request",
  "trial_rejection",
  // 0075: a security check of an agent that didn't verify (docs/agent-assurance-plan.md §6).
  "assurance",
] as const;

/**
 * A client's problem with its agents or the platform, numbered per client from 1 (assigned in the
 * insert's transaction under an advisory lock on the client). Its conversation is a thread
 * (`subject_type='issue'`). `reggie_read` is Reggie's read of it (core `ReggieRead`) and never
 * reaches a portal response. Updated in place; never deleted.
 */
// DECISION: numbers are per client, with no cross-client count (§1.124).
export const issue = pgTable(
  "issue",
  {
    id: id(),
    tenantId: tenantId(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    urgency: text("urgency").$type<(typeof ISSUE_URGENCIES)[number]>().notNull().default("normal"),
    stage: text("stage").$type<(typeof ISSUE_STAGES)[number]>().notNull().default("reported"),
    causeKind: text("cause_kind").$type<(typeof ISSUE_CAUSE_KINDS)[number]>(),
    agentId: uuid("agent_id"),
    source: text("source").$type<(typeof ISSUE_SOURCES)[number]>().notNull(),
    raisedBy: uuid("raised_by").references(() => appUser.id),
    raisedByEmail: text("raised_by_email"),
    threadId: uuid("thread_id").notNull(),
    waitingOn: text("waiting_on")
      .$type<(typeof WORK_WAITING_ON)[number]>()
      .notNull()
      .default("operator"),
    /** One plain line on where it stands. */
    statusLine: text("status_line").notNull().default(""),
    stuck: boolean("stuck").notNull().default(false),
    /** The targets, from the urgency and the client's business hours (core `issueTargets`). */
    replyBy: ts("reply_by"),
    fixBy: ts("fix_by"),
    firstReplyAt: ts("first_reply_at"),
    /** The operator's move in the work order; null keeps Reggie's order. */
    manualRank: integer("manual_rank"),
    reggieRead: json("reggie_read"),
    /** Reggie's read is due (a new issue or a client's message); null when read. */
    needsReadAt: ts("needs_read_at"),
    /** The `+tag` of the address its emails go out from and come back to. */
    replyTag: text("reply_tag"),
    /** A change request from the Desk it was adopted from (§1.11 requests, folded in). */
    legacyItemId: uuid("legacy_item_id"),
    feedbackId: uuid("feedback_id").references(() => feedback.id),
    originRunId: uuid("origin_run_id"),
    /** The ask it was converted to ("it isn't a fault"). */
    askId: uuid("ask_id"),
    stageAt: ts("stage_at").notNull().defaultNow(),
    closedAt: ts("closed_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("issue_id_tenant_key").on(t.id, t.tenantId),
    unique("issue_number_key").on(t.tenantId, t.number),
    unique("issue_reply_tag_key").on(t.replyTag),
    uniqueIndex("issue_legacy_item_key")
      .on(t.legacyItemId)
      .where(sql`${t.legacyItemId} is not null`),
    uniqueIndex("issue_feedback_key").on(t.feedbackId).where(sql`${t.feedbackId} is not null`),
    foreignKey({
      name: "issue_agent_fk",
      columns: [t.agentId, t.tenantId],
      foreignColumns: [agent.id, agent.tenantId],
    }),
    foreignKey({
      name: "issue_thread_fk",
      columns: [t.threadId, t.tenantId],
      foreignColumns: [thread.id, thread.tenantId],
    }),
    foreignKey({
      name: "issue_legacy_item_fk",
      columns: [t.legacyItemId, t.tenantId],
      foreignColumns: [inboxItem.id, inboxItem.tenantId],
    }),
    foreignKey({
      name: "issue_ask_fk",
      columns: [t.askId, t.tenantId],
      foreignColumns: [clientAsk.id, clientAsk.tenantId],
    }),
    index("issue_stage_idx").on(t.tenantId, t.stage, t.urgency),
    index("issue_agent_idx").on(t.tenantId, t.agentId),
    index("issue_needs_read_idx").on(t.needsReadAt).where(sql`${t.needsReadAt} is not null`),
    check("issue_number_check", sql`${t.number} >= 1`),
    check("issue_title_check", sql`char_length(${t.title}) between 1 and 200`),
    check("issue_description_check", sql`char_length(${t.description}) <= 4000`),
    check("issue_urgency_check", oneOf(t.urgency, ISSUE_URGENCIES)),
    check("issue_stage_check", oneOf(t.stage, ISSUE_STAGES)),
    check(
      "issue_cause_kind_check",
      sql`${t.causeKind} is null or ${oneOf(t.causeKind, ISSUE_CAUSE_KINDS)}`,
    ),
    check("issue_source_check", oneOf(t.source, ISSUE_SOURCES)),
    check("issue_waiting_on_check", oneOf(t.waitingOn, WORK_WAITING_ON)),
    check("issue_status_line_check", sql`char_length(${t.statusLine}) <= 120`),
  ],
);

export const ISSUE_EVENT_KINDS = [
  "created",
  "stage",
  "urgency",
  "cause",
  "hold",
  "release",
  "rollback",
  "reply",
  "note",
  "link",
  "reggie_read",
  "assign",
  "close",
  "reopen",
  "converted",
  "moved",
] as const;
export const ISSUE_EVENT_ACTORS = ["operator", "reggie", "client", "system"] as const;

/** An issue's history: what changed, from what to what, by whom and why. Insert only. */
export const issueEvent = pgTable(
  "issue_event",
  {
    id: id(),
    tenantId: tenantId(),
    issueId: uuid("issue_id").notNull(),
    kind: text("kind").$type<(typeof ISSUE_EVENT_KINDS)[number]>().notNull(),
    fromValue: text("from_value"),
    toValue: text("to_value"),
    payload: json("payload").notNull().default({}),
    reason: text("reason"),
    actor: text("actor").$type<(typeof ISSUE_EVENT_ACTORS)[number]>().notNull(),
    userId: uuid("user_id").references(() => appUser.id),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "issue_event_issue_fk",
      columns: [t.issueId, t.tenantId],
      foreignColumns: [issue.id, issue.tenantId],
    }),
    index("issue_event_issue_idx").on(t.tenantId, t.issueId, t.createdAt),
    check("issue_event_kind_check", oneOf(t.kind, ISSUE_EVENT_KINDS)),
    check("issue_event_actor_check", oneOf(t.actor, ISSUE_EVENT_ACTORS)),
  ],
);

// An ask never comes from a security check (0075 added "assurance" to issues only).
export const CLIENT_ASK_SOURCES = [
  ...ISSUE_SOURCES.filter(
    (s): s is Exclude<(typeof ISSUE_SOURCES)[number], "assurance"> => s !== "assurance",
  ),
  "question",
] as const;
export const CLIENT_ASK_STATUSES = ["open", "grouped", "told", "closed"] as const;

/**
 * A client's idea or change ("an idea or a change"), in its own words. Grouped with other clients'
 * asks under an enhancement; told when it ships. Its conversation is a thread
 * (`subject_type='client_ask'`). Updated in place; never deleted.
 */
export const clientAsk = pgTable(
  "client_ask",
  {
    id: id(),
    tenantId: tenantId(),
    title: text("title").notNull(),
    text: text("text").notNull(),
    source: text("source").$type<(typeof CLIENT_ASK_SOURCES)[number]>().notNull(),
    raisedBy: uuid("raised_by").references(() => appUser.id),
    raisedByEmail: text("raised_by_email"),
    agentId: uuid("agent_id"),
    threadId: uuid("thread_id").notNull(),
    /**
     * The issue it was converted from. DECISION: a single-column key, unlike the issue's own
     * `ask_id`: two required links between the tables would be a cycle the client purge cannot
     * order (purge.ts); the code sets it inside the client's own transaction.
     */
    issueId: uuid("issue_id").references((): AnyPgColumn => issue.id),
    enhancementId: uuid("enhancement_id").references(() => enhancement.id),
    status: text("status").$type<(typeof CLIENT_ASK_STATUSES)[number]>().notNull().default("open"),
    replyTag: text("reply_tag"),
    toldAt: ts("told_at"),
    closedAt: ts("closed_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("client_ask_id_tenant_key").on(t.id, t.tenantId),
    unique("client_ask_reply_tag_key").on(t.replyTag),
    foreignKey({
      name: "client_ask_agent_fk",
      columns: [t.agentId, t.tenantId],
      foreignColumns: [agent.id, agent.tenantId],
    }),
    foreignKey({
      name: "client_ask_thread_fk",
      columns: [t.threadId, t.tenantId],
      foreignColumns: [thread.id, thread.tenantId],
    }),
    index("client_ask_status_idx").on(t.tenantId, t.status),
    index("client_ask_enhancement_idx").on(t.enhancementId),
    check("client_ask_title_check", sql`char_length(${t.title}) between 1 and 200`),
    check("client_ask_text_check", sql`char_length(${t.text}) between 1 and 4000`),
    check("client_ask_source_check", oneOf(t.source, CLIENT_ASK_SOURCES)),
    check("client_ask_status_check", oneOf(t.status, CLIENT_ASK_STATUSES)),
  ],
);

export const ENHANCEMENT_STAGES = ["captured", "grouped", "decided", "built", "shipped"] as const;
export const ENHANCEMENT_DECISIONS = ["do", "later", "no", "sell"] as const;
export const ENHANCEMENT_SCOPES = ["template", "client", "new_agent"] as const;

/**
 * An improvement the operator may make, grouping clients' asks: decided (do, later, no, sell),
 * built and shipped. Operator only and global.
 */
// DECISION: an enhancement holds no client's words; those stay on each client_ask (invariant 11).
export const enhancement = pgTable(
  "enhancement",
  {
    id: id(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    stage: text("stage").$type<(typeof ENHANCEMENT_STAGES)[number]>().notNull().default("captured"),
    decision: text("decision").$type<(typeof ENHANCEMENT_DECISIONS)[number]>(),
    decisionNote: text("decision_note"),
    scope: text("scope").$type<(typeof ENHANCEMENT_SCOPES)[number]>(),
    size: text("size"),
    templateId: uuid("template_id").references(() => agent.id),
    decideBy: date("decide_by"),
    waitingOn: text("waiting_on")
      .$type<(typeof WORK_WAITING_ON)[number]>()
      .notNull()
      .default("operator"),
    statusLine: text("status_line").notNull().default(""),
    stuck: boolean("stuck").notNull().default(false),
    manualRank: integer("manual_rank"),
    createdBy: uuid("created_by").references(() => appUser.id),
    stageAt: ts("stage_at").notNull().defaultNow(),
    decidedAt: ts("decided_at"),
    shippedAt: ts("shipped_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("enhancement_stage_idx").on(t.stage, t.updatedAt),
    check("enhancement_title_check", sql`char_length(${t.title}) between 1 and 200`),
    check("enhancement_description_check", sql`char_length(${t.description}) <= 4000`),
    check("enhancement_stage_check", oneOf(t.stage, ENHANCEMENT_STAGES)),
    check(
      "enhancement_decision_check",
      sql`${t.decision} is null or ${oneOf(t.decision, ENHANCEMENT_DECISIONS)}`,
    ),
    check(
      "enhancement_scope_check",
      sql`${t.scope} is null or ${oneOf(t.scope, ENHANCEMENT_SCOPES)}`,
    ),
    check("enhancement_waiting_on_check", oneOf(t.waitingOn, WORK_WAITING_ON)),
    check("enhancement_status_line_check", sql`char_length(${t.statusLine}) <= 120`),
  ],
);

export const TODO_OWNERS = ["operator", "reggie", "client"] as const;
export const TODO_ABOUT_KINDS = [
  "issue",
  "client_ask",
  "enhancement",
  "build",
  "deal",
  "question",
  "run",
  "client",
  // docs/plan.md §1.125 (migration 0065): a Dev queue request's notice (accepted, shipped).
  "code_request",
] as const;
export const TODO_STATES = ["open", "done", "snoozed", "dropped"] as const;
export const TODO_SOURCES = ["operator", "reggie", "play", "question", "email", "system"] as const;

/**
 * One thing to do in the back office (Your call, migration 0061): the operator's, Reggie's or the
 * client's, about a client or none, with Reggie's read, plan and draft when it made it, and the
 * one action that does it (`primary_action`). Made once per `dedupe_key`. Updated in place; never
 * deleted (dropped instead).
 */
// DECISION: a to-do is owned by the operator, Reggie or the client, with an optional named
// operator (`owner_user_id`) (owner, 2026-11-17).
export const todo = pgTable(
  "todo",
  {
    id: id(),
    clientId: uuid("client_id").references(() => tenant.id),
    owner: text("owner").$type<(typeof TODO_OWNERS)[number]>().notNull(),
    ownerUserId: uuid("owner_user_id").references(() => appUser.id),
    title: text("title").notNull(),
    detail: text("detail").notNull().default(""),
    why: text("why"),
    dueAt: ts("due_at"),
    aboutKind: text("about_kind").$type<(typeof TODO_ABOUT_KINDS)[number]>(),
    aboutId: uuid("about_id"),
    state: text("state").$type<(typeof TODO_STATES)[number]>().notNull().default("open"),
    snoozedUntil: ts("snoozed_until"),
    source: text("source").$type<(typeof TODO_SOURCES)[number]>().notNull().default("operator"),
    /** The Autopilot play that made it. */
    playKey: text("play_key"),
    /** Reggie's read and how sure it is. */
    read: text("read"),
    sure: text("sure"),
    plan: json<unknown[]>("plan"),
    /** `{to, channel: 'portal'|'email'|'portal_email', subject?, text}`. */
    draft: json("draft"),
    options: json<unknown[]>("options"),
    /** `{label, kind: 'send_reply'|'approve_plan'|'decide'|'open'|'confirm_card'|'send_requirements', ref}`. */
    primaryAction: json("primary_action"),
    /** The client's Desk item or lead request it mirrors. */
    deskItemId: uuid("desk_item_id"),
    dedupeKey: text("dedupe_key"),
    doneAt: ts("done_at"),
    doneBy: uuid("done_by").references(() => appUser.id),
    createdBy: uuid("created_by").references(() => appUser.id),
    createdAt: createdAt(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("todo_dedupe_key").on(t.dedupeKey).where(sql`${t.dedupeKey} is not null`),
    index("todo_state_idx").on(t.state, t.owner, t.dueAt),
    index("todo_client_idx").on(t.clientId, t.state),
    index("todo_about_idx").on(t.aboutKind, t.aboutId),
    check("todo_owner_check", oneOf(t.owner, TODO_OWNERS)),
    check("todo_title_check", sql`char_length(${t.title}) between 1 and 300`),
    check("todo_detail_check", sql`char_length(${t.detail}) <= 4000`),
    check("todo_why_check", sql`${t.why} is null or char_length(${t.why}) <= 300`),
    check(
      "todo_about_kind_check",
      sql`${t.aboutKind} is null or ${oneOf(t.aboutKind, TODO_ABOUT_KINDS)}`,
    ),
    check("todo_about_check", sql`(${t.aboutKind} is null) = (${t.aboutId} is null)`),
    check("todo_state_check", oneOf(t.state, TODO_STATES)),
    check("todo_source_check", oneOf(t.source, TODO_SOURCES)),
  ],
);

export const DEAL_KINDS = ["new", "expansion"] as const;
export const DEAL_NEW_STAGES = [
  "lead",
  "qualified",
  "diagnostic",
  "proposal",
  "setup",
  "live",
] as const;
export const DEAL_EXPANSION_STAGES = ["spotted", "pitch", "offered", "agreed", "billed"] as const;
export const DEAL_OUTCOMES = ["open", "won", "lost", "not_now", "no"] as const;
export const DEAL_SOURCES = ["site_form", "email", "referral", "ops", "reggie"] as const;

/**
 * A deal (Sales, migration 0062): a new account (a company, later a client) or more for a client
 * (expansion), with its stage, value a month, what was agreed and the signed copy. Money is
 * numeric(14,4) with its currency (invariant 6). Updated in place; never deleted.
 */
// DECISION: deals are operator-only tables, not a pack (owner, 2026-11-17); contracts stay by hand
// (the signed copy is uploaded, `agreed_mrr` recorded).
export const deal = pgTable(
  "deal",
  {
    id: id(),
    kind: text("kind").$type<(typeof DEAL_KINDS)[number]>().notNull(),
    clientId: uuid("client_id").references(() => tenant.id),
    company: text("company"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    stage: text("stage")
      .$type<(typeof DEAL_NEW_STAGES)[number] | (typeof DEAL_EXPANSION_STAGES)[number]>()
      .notNull(),
    agentCount: integer("agent_count").notNull().default(0),
    /** `[{name, templateId | null}]`. */
    agentsSold: json<{ name: string; templateId: string | null }[]>("agents_sold")
      .notNull()
      .default([]),
    mrr: usd("mrr"),
    currency: text("currency").notNull().default("USD"),
    outcome: text("outcome").$type<(typeof DEAL_OUTCOMES)[number]>().notNull().default("open"),
    outcomeReason: text("outcome_reason"),
    checkBackOn: date("check_back_on"),
    waitingOn: text("waiting_on")
      .$type<(typeof WORK_WAITING_ON)[number]>()
      .notNull()
      .default("operator"),
    statusLine: text("status_line").notNull().default(""),
    stuck: boolean("stuck").notNull().default(false),
    nextStep: text("next_step").notNull().default(""),
    nextDueOn: date("next_due_on"),
    source: text("source").$type<(typeof DEAL_SOURCES)[number]>().notNull().default("ops"),
    sourceDetail: text("source_detail"),
    /** Why it is worth pursuing: `[{text, sources[]}]` (invariant 10). */
    evidence: json<{ text: string; sources: string[] }[]>("evidence").notNull().default([]),
    originKind: text("origin_kind").$type<(typeof WORK_ORIGIN_KINDS)[number]>(),
    originId: uuid("origin_id"),
    agreedMrr: numeric("agreed_mrr", { precision: 14, scale: 4 }),
    agreedFrom: date("agreed_from"),
    signedCopyKey: text("signed_copy_key"),
    signedCopyName: text("signed_copy_name"),
    replyTag: text("reply_tag"),
    dedupeKey: text("dedupe_key"),
    /**
     * §1.149 (0066): the company's client file, before and after set-up. A lost deal keeps it and a
     * later deal reuses it. Cleared if the file goes (a purged client's).
     */
    clientFileId: uuid("client_file_id").references((): AnyPgColumn => clientFile.id, {
      onDelete: "set null",
    }),
    createdBy: uuid("created_by").references(() => appUser.id),
    stageAt: ts("stage_at").notNull().defaultNow(),
    wonAt: ts("won_at"),
    closedAt: ts("closed_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("deal_reply_tag_key").on(t.replyTag),
    uniqueIndex("deal_dedupe_key").on(t.dedupeKey).where(sql`${t.dedupeKey} is not null`),
    index("deal_outcome_idx").on(t.outcome, t.kind, t.stage),
    index("deal_client_idx").on(t.clientId),
    index("deal_client_file_idx").on(t.clientFileId),
    check("deal_kind_check", oneOf(t.kind, DEAL_KINDS)),
    check(
      "deal_stage_check",
      sql`(${t.kind} = 'new' and ${oneOf(t.stage, DEAL_NEW_STAGES)}) or (${t.kind} = 'expansion' and ${oneOf(t.stage, DEAL_EXPANSION_STAGES)})`,
    ),
    check(
      "deal_company_check",
      sql`${t.company} is null or char_length(${t.company}) between 1 and 200`,
    ),
    check("deal_title_check", sql`char_length(${t.title}) between 1 and 200`),
    check("deal_description_check", sql`char_length(${t.description}) <= 2000`),
    check("deal_agent_count_check", sql`${t.agentCount} >= 0`),
    check("deal_outcome_check", oneOf(t.outcome, DEAL_OUTCOMES)),
    check("deal_waiting_on_check", oneOf(t.waitingOn, WORK_WAITING_ON)),
    check("deal_status_line_check", sql`char_length(${t.statusLine}) <= 120`),
    check("deal_source_check", oneOf(t.source, DEAL_SOURCES)),
    check(
      "deal_origin_kind_check",
      sql`${t.originKind} is null or ${oneOf(t.originKind, WORK_ORIGIN_KINDS)}`,
    ),
    check("deal_origin_check", sql`(${t.originKind} is null) = (${t.originId} is null)`),
    check(
      "deal_expansion_client_check",
      sql`${t.kind} <> 'expansion' or ${t.clientId} is not null`,
    ),
    check("deal_who_check", sql`${t.clientId} is not null or ${t.company} is not null`),
  ],
);

/**
 * A person on a deal: who we talk to. Updated in place; the Worker never deletes one. Its deal's
 * deletion (only a client's purge, as cs_owner) takes its people and activity with it.
 */
export const dealPerson = pgTable(
  "deal_person",
  {
    id: id(),
    dealId: uuid("deal_id")
      .notNull()
      .references(() => deal.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    role: text("role"),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("deal_person_deal_idx").on(t.dealId),
    check("deal_person_name_check", sql`char_length(${t.name}) between 1 and 200`),
  ],
);

export const DEAL_ACTIVITY_KINDS = [
  "email_in",
  "email_out",
  "note",
  "call",
  "meeting",
  "stage",
  "system",
  "form",
  "terms",
] as const;
export const DEAL_ACTIVITY_ACTORS = ["operator", "reggie", "contact", "system"] as const;

/** A deal's history: emails, notes, calls, stage moves, terms. Email text is data. Insert only. */
export const dealActivity = pgTable(
  "deal_activity",
  {
    id: id(),
    dealId: uuid("deal_id")
      .notNull()
      .references(() => deal.id, { onDelete: "cascade" }),
    kind: text("kind").$type<(typeof DEAL_ACTIVITY_KINDS)[number]>().notNull(),
    actor: text("actor").$type<(typeof DEAL_ACTIVITY_ACTORS)[number]>().notNull(),
    userId: uuid("user_id").references(() => appUser.id),
    subject: text("subject"),
    body: text("body").notNull().default(""),
    meta: json("meta").notNull().default({}),
    sources: json<string[]>("sources").notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [
    index("deal_activity_deal_idx").on(t.dealId, t.createdAt),
    check("deal_activity_kind_check", oneOf(t.kind, DEAL_ACTIVITY_KINDS)),
    check("deal_activity_actor_check", oneOf(t.actor, DEAL_ACTIVITY_ACTORS)),
    check("deal_activity_body_check", sql`char_length(${t.body}) <= 20000`),
  ],
);

export const PLAY_FLOWS = ["new", "grow", "issues", "builds", "enh", "questions"] as const;
export const PLAY_LEVELS = ["off", "draft", "send"] as const;
export const PLAY_OUTCOMES = ["drafted", "sent", "done", "skipped", "refused"] as const;

/**
 * How far Reggie goes with one play at one stage of a flow (Autopilot, migration 0063): off, draft
 * for a person, or send and tell. Operator only and global; one row per play.
 */
// DECISION: no row means `draft`, a code default (core `DEFAULT_PLAY_LEVEL`), so a new play never
// sends on its own until the operator says so.
export const playSetting = pgTable(
  "play_setting",
  {
    id: id(),
    flow: text("flow").$type<(typeof PLAY_FLOWS)[number]>().notNull(),
    stage: text("stage").notNull(),
    play: text("play").notNull(),
    level: text("level").$type<(typeof PLAY_LEVELS)[number]>().notNull(),
    updatedBy: uuid("updated_by").references(() => appUser.id),
    createdAt: createdAt(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("play_setting_key").on(t.flow, t.stage, t.play),
    check("play_setting_flow_check", oneOf(t.flow, PLAY_FLOWS)),
    check("play_setting_level_check", oneOf(t.level, PLAY_LEVELS)),
  ],
);

/**
 * What a play did, once (Autopilot's track record and Done today): drafted, sent, done, skipped
 * or refused, about what, at which level. Only the flag columns change: a person flags a row for
 * its play's record. Never deleted.
 */
export const playLog = pgTable(
  "play_log",
  {
    id: id(),
    clientId: uuid("client_id").references(() => tenant.id),
    flow: text("flow").$type<(typeof PLAY_FLOWS)[number]>().notNull(),
    stage: text("stage").notNull(),
    play: text("play").notNull(),
    level: text("level").$type<(typeof PLAY_LEVELS)[number]>().notNull(),
    outcome: text("outcome").$type<(typeof PLAY_OUTCOMES)[number]>().notNull(),
    /** A person changed the draft before it went. */
    edited: boolean("edited").notNull().default(false),
    aboutKind: text("about_kind").$type<(typeof TODO_ABOUT_KINDS)[number]>(),
    aboutId: uuid("about_id"),
    summary: text("summary").notNull().default(""),
    /** Ours only: nothing went to a client or a lead. */
    internal: boolean("internal").notNull().default(false),
    flaggedAt: ts("flagged_at"),
    flaggedBy: uuid("flagged_by").references(() => appUser.id),
    flagNote: text("flag_note"),
    createdAt: createdAt(),
  },
  (t) => [
    index("play_log_created_idx").on(t.createdAt),
    index("play_log_play_idx").on(t.flow, t.play, t.createdAt),
    check("play_log_flow_check", oneOf(t.flow, PLAY_FLOWS)),
    check("play_log_level_check", oneOf(t.level, PLAY_LEVELS)),
    check("play_log_outcome_check", oneOf(t.outcome, PLAY_OUTCOMES)),
    check(
      "play_log_about_kind_check",
      sql`${t.aboutKind} is null or ${oneOf(t.aboutKind, TODO_ABOUT_KINDS)}`,
    ),
    check("play_log_about_check", sql`(${t.aboutKind} is null) = (${t.aboutId} is null)`),
    check("play_log_summary_check", sql`char_length(${t.summary}) <= 300`),
  ],
);

// ── Onboarding v1 (docs/plan.md §1.149; docs/cases-plan.md §4–§5; migration 0066) ──────────────────

export const CLIENT_FILE_STATUSES = ["prospect", "client", "lost"] as const;
export const FACT_SECTIONS = [
  "business",
  "people",
  "systems",
  "volumes",
  "processes",
  "pains",
  "limits",
  "notes",
] as const;
export const FACT_SOURCE_KINDS = [
  "call",
  "note",
  "email",
  "document",
  "website",
  "intake",
  "tool",
  "run",
  "other",
] as const;
export const FACT_SURENESS = ["heard", "seen", "confirmed"] as const;
export const FACT_AUDIENCES = ["theirs", "ours"] as const;
export const FACT_ACTORS = ["operator", "reggie", "client", "system"] as const;
export const START_MODES = ["point", "talk"] as const;

/**
 * A client file (cases-plan §4.1): the company, from the first conversation, before and after it is
 * a client. Operator only, as a deal is: a file about a client is read only by the operators
 * serving it; a prospect's by every operator. Changes in place (name, website, status); never
 * deleted by the Worker (a lost prospect's is deleted by the owner's retention job, later).
 */
// DECISION: core keeps the same value lists (`packages/core/src/onboarding`); a db test holds them
// equal, as OWNER_AREAS does.
export const clientFile = pgTable(
  "client_file",
  {
    id: id(),
    name: text("name").notNull(),
    website: text("website"),
    /** The client it became. One file per client. */
    clientId: uuid("client_id")
      .unique("client_file_client_key")
      .references(() => tenant.id),
    status: text("status")
      .$type<(typeof CLIENT_FILE_STATUSES)[number]>()
      .notNull()
      .default("prospect"),
    createdBy: uuid("created_by").references(() => appUser.id),
    createdAt: createdAt(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("client_file_status_idx").on(t.status, t.updatedAt),
    check("client_file_name_check", sql`char_length(${t.name}) between 1 and 200`),
    check(
      "client_file_website_check",
      sql`${t.website} is null or char_length(${t.website}) between 1 and 300`,
    ),
    check("client_file_status_check", oneOf(t.status, CLIENT_FILE_STATUSES)),
  ],
);

/**
 * One fact in a client file, with where it came from (`sources`: record ids, invariant 10), how
 * sure we are and who may see it (`theirs` or `ours`). Insert only: a correction is a new fact
 * that replaces the earlier one (`replaces_id`), and a fact is replaced at most once.
 */
export const clientFact = pgTable(
  "client_fact",
  {
    id: id(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => clientFile.id, { onDelete: "cascade" }),
    section: text("section").$type<(typeof FACT_SECTIONS)[number]>().notNull(),
    text: text("text").notNull(),
    sourceKind: text("source_kind").$type<(typeof FACT_SOURCE_KINDS)[number]>().notNull(),
    sources: json<string[]>("sources").notNull().default([]),
    sureness: text("sureness").$type<(typeof FACT_SURENESS)[number]>().notNull().default("heard"),
    audience: text("audience").$type<(typeof FACT_AUDIENCES)[number]>().notNull().default("ours"),
    replacesId: uuid("replaces_id").references((): AnyPgColumn => clientFact.id),
    actor: text("actor").$type<(typeof FACT_ACTORS)[number]>().notNull(),
    createdBy: uuid("created_by").references(() => appUser.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("client_fact_file_idx").on(t.fileId, t.createdAt),
    uniqueIndex("client_fact_replaces_key")
      .on(t.replacesId)
      .where(sql`${t.replacesId} is not null`),
    check("client_fact_section_check", oneOf(t.section, FACT_SECTIONS)),
    check("client_fact_text_check", sql`char_length(${t.text}) between 1 and 2000`),
    check("client_fact_source_kind_check", oneOf(t.sourceKind, FACT_SOURCE_KINDS)),
    check("client_fact_sources_check", sql`jsonb_typeof(${t.sources}) = 'array'`),
    check("client_fact_sureness_check", oneOf(t.sureness, FACT_SURENESS)),
    check("client_fact_audience_check", oneOf(t.audience, FACT_AUDIENCES)),
    check("client_fact_actor_check", oneOf(t.actor, FACT_ACTORS)),
    check("client_fact_replaces_check", sql`${t.replacesId} is null or ${t.replacesId} <> ${t.id}`),
  ],
);

/**
 * A saved start for Sign up now and Invite (cases-plan §4.3): its name, what it covers (core
 * `Covers`), the lead's note and how the client starts. Operator only and global. Changes in
 * place; archived, never deleted. Seeded ones carry a `seed_key` so seeding runs once each.
 */
// DECISION: `seed_key` (e.g. `general`, `area:purchasing`, `template:<slug>`, `account`) beside
// `seeded`, so the seeding (stream SALES, in code, not the migration) is idempotent.
export const salesStart = pgTable(
  "sales_start",
  {
    id: id(),
    name: text("name").notNull(),
    /** Core `Covers`: `{general, areas[], templateIds[]}`, validated where written. */
    covers: json<{ general: boolean; areas: string[]; templateIds: string[] }>("covers").notNull(),
    note: text("note").notNull().default(""),
    startMode: text("start_mode").$type<(typeof START_MODES)[number]>().notNull().default("point"),
    seeded: boolean("seeded").notNull().default(false),
    seedKey: text("seed_key"),
    archivedAt: ts("archived_at"),
    createdBy: uuid("created_by").references(() => appUser.id),
    createdAt: createdAt(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("sales_start_seed_key").on(t.seedKey).where(sql`${t.seedKey} is not null`),
    check("sales_start_name_check", sql`char_length(${t.name}) between 1 and 80`),
    check("sales_start_covers_check", sql`jsonb_typeof(${t.covers}) = 'object'`),
    check("sales_start_note_check", sql`char_length(${t.note}) <= 2000`),
    check("sales_start_mode_check", oneOf(t.startMode, START_MODES)),
    check("sales_start_seed_check", sql`${t.seeded} = (${t.seedKey} is not null)`),
  ],
);

export const INTAKE_STATUSES = [
  "sent",
  "open",
  "scope_ready",
  "signed",
  "done",
  "cancelled",
] as const;
export const ANSWER_STATES = ["answered", "confirmed", "corrected", "not_sure", "later"] as const;
export const ANSWER_SOURCES = ["form", "chat", "voice", "call", "tool", "lead"] as const;
export const INTAKE_EVENT_KINDS = [
  "sent",
  "scheduled",
  "delivered",
  "bounced",
  "opened",
  "signed_in",
  "wrong_account",
  "answered",
  "asked",
  "colleague_invited",
  "different_process",
  "section_started",
  "section_not_now",
  "cards_added",
  "reminded",
  "scope_ready",
  "signed",
  "done",
  "cancelled",
] as const;

/**
 * A client's intake (cases-plan §4.2, §4.5): what it covers, the guide (core `Guide`, with each
 * field's state and only `theirs` facts, copied in when sent), how it starts, the lead's note.
 * The client's own record: forced RLS on the client. `deal_id` and `file_id` name operator rows
 * without a foreign key, so nothing of the client's points into an operator-only table's policy.
 * Changes in place (status, guide when cards are added); never deleted.
 */
export const intake = pgTable(
  "intake",
  {
    id: id(),
    tenantId: tenantId(),
    dealId: uuid("deal_id"),
    fileId: uuid("file_id"),
    covers: json<{ general: boolean; areas: string[]; templateIds: string[] }>("covers").notNull(),
    guide: json("guide").notNull(),
    startMode: text("start_mode").$type<(typeof START_MODES)[number]>().notNull().default("point"),
    /** The lead it's from (name, photo and voice in the emails and on the page). */
    leadUserId: uuid("lead_user_id").references(() => appUser.id),
    leadNote: text("lead_note").notNull().default(""),
    status: text("status").$type<(typeof INTAKE_STATUSES)[number]>().notNull().default("sent"),
    /** Sent at a time (Invite's "Send at"); null: sent when made. */
    sendAt: ts("send_at"),
    createdBy: uuid("created_by").references(() => appUser.id),
    createdAt: createdAt(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("intake_id_tenant_key").on(t.id, t.tenantId),
    index("intake_tenant_idx").on(t.tenantId, t.status, t.createdAt),
    index("intake_send_at_idx").on(t.sendAt).where(sql`${t.sendAt} is not null`),
    check("intake_covers_check", sql`jsonb_typeof(${t.covers}) = 'object'`),
    check("intake_guide_check", sql`jsonb_typeof(${t.guide}) = 'object'`),
    check("intake_start_mode_check", oneOf(t.startMode, START_MODES)),
    check("intake_lead_note_check", sql`char_length(${t.leadNote}) <= 2000`),
    check("intake_status_check", oneOf(t.status, INTAKE_STATUSES)),
  ],
);

/**
 * A person asked in an intake: the admin, others with the whole intake or some sections (null:
 * all), and colleagues asked later. Changes in place (their user once made, their sections).
 */
export const intakePerson = pgTable(
  "intake_person",
  {
    id: id(),
    tenantId: tenantId(),
    intakeId: uuid("intake_id").notNull(),
    userId: uuid("user_id").references(() => appUser.id),
    /** Stored lowercased. */
    email: text("email").notNull(),
    name: text("name").notNull(),
    /** Guide section keys; null for every section. */
    sections: text("sections").array(),
    isAdmin: boolean("is_admin").notNull().default(false),
    /** Their language for the emails and the welcome page (core `Locale`); else the client's. */
    language: text("language"),
    invitedBy: uuid("invited_by").references(() => appUser.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("intake_person_id_tenant_key").on(t.id, t.tenantId),
    unique("intake_person_email_key").on(t.intakeId, t.email),
    foreignKey({
      name: "intake_person_intake_fk",
      columns: [t.intakeId, t.tenantId],
      foreignColumns: [intake.id, intake.tenantId],
    }),
    check("intake_person_email_check", sql`char_length(${t.email}) between 3 and 320`),
    check("intake_person_name_check", sql`char_length(${t.name}) between 1 and 200`),
    check(
      "intake_person_language_check",
      sql`${t.language} is null or char_length(${t.language}) between 2 and 10`,
    ),
  ],
);

/**
 * An answer (insert only): a field's value with its state and source. The latest answer to a field
 * is the one that counts; nothing is changed in place. No value for `not_sure` and `later`.
 */
export const intakeAnswer = pgTable(
  "intake_answer",
  {
    id: id(),
    tenantId: tenantId(),
    intakeId: uuid("intake_id").notNull(),
    fieldKey: text("field_key").notNull(),
    value: jsonb("value"),
    state: text("state").$type<(typeof ANSWER_STATES)[number]>().notNull(),
    source: text("source").$type<(typeof ANSWER_SOURCES)[number]>().notNull(),
    userId: uuid("user_id").references(() => appUser.id),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "intake_answer_intake_fk",
      columns: [t.intakeId, t.tenantId],
      foreignColumns: [intake.id, intake.tenantId],
    }),
    index("intake_answer_field_idx").on(t.tenantId, t.intakeId, t.fieldKey, t.createdAt),
    check("intake_answer_field_check", sql`char_length(${t.fieldKey}) between 1 and 100`),
    check("intake_answer_state_check", oneOf(t.state, ANSWER_STATES)),
    check("intake_answer_source_check", oneOf(t.source, ANSWER_SOURCES)),
    check(
      "intake_answer_value_check",
      sql`${t.state} in ('not_sure', 'later') or ${t.value} is not null`,
    ),
  ],
);

/**
 * The scope, per version (cases-plan §4.7; used from the next wave): what each agent will do,
 * read and change, signed by the client admin. Insert only, but for its signature: the Worker may
 * set `signed_by` and `signed_at` (a column grant), never the body. A change is a new version.
 */
export const intakeScope = pgTable(
  "intake_scope",
  {
    id: id(),
    tenantId: tenantId(),
    intakeId: uuid("intake_id").notNull(),
    version: integer("version").notNull(),
    body: json("body").notNull(),
    signedBy: uuid("signed_by").references(() => appUser.id),
    signedAt: ts("signed_at"),
    createdBy: uuid("created_by").references(() => appUser.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("intake_scope_version_key").on(t.intakeId, t.version),
    foreignKey({
      name: "intake_scope_intake_fk",
      columns: [t.intakeId, t.tenantId],
      foreignColumns: [intake.id, intake.tenantId],
    }),
    check("intake_scope_version_check", sql`${t.version} >= 1`),
    check("intake_scope_body_check", sql`jsonb_typeof(${t.body}) = 'object'`),
    check("intake_scope_signed_check", sql`(${t.signedBy} is null) = (${t.signedAt} is null)`),
  ],
);

/** The intake's log (insert only): sent, delivered, opened, signed in, answered, asked… */
export const intakeEvent = pgTable(
  "intake_event",
  {
    id: id(),
    tenantId: tenantId(),
    intakeId: uuid("intake_id").notNull(),
    kind: text("kind").$type<(typeof INTAKE_EVENT_KINDS)[number]>().notNull(),
    personId: uuid("person_id"),
    meta: json("meta").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "intake_event_intake_fk",
      columns: [t.intakeId, t.tenantId],
      foreignColumns: [intake.id, intake.tenantId],
    }),
    foreignKey({
      name: "intake_event_person_fk",
      columns: [t.personId, t.tenantId],
      foreignColumns: [intakePerson.id, intakePerson.tenantId],
    }),
    index("intake_event_intake_idx").on(t.tenantId, t.intakeId, t.createdAt),
    check("intake_event_kind_check", oneOf(t.kind, INTAKE_EVENT_KINDS)),
  ],
);

/**
 * Onboarding's operator-only tables tied to a client (§1.149): an operator session reads only the
 * files about clients it serves or about none (prospects), and a fact only with its file. A
 * client's session never sees a row. `sales_start` is global and in OPERATOR_ONLY_TABLES.
 */
export const CLIENT_FILE_TABLES = ["client_file", "client_fact"] as const;

/** Onboarding's tenant tables (§1.149), in TENANT_TABLES too. */
export const INTAKE_TABLES = [
  "intake",
  "intake_person",
  "intake_answer",
  "intake_scope",
  "intake_event",
] as const;

/**
 * The back office work's operator-only tables (§1.124): an operator session reads only rows about
 * the clients it serves or no client; a client's session never sees a row. Not in
 * OPERATOR_ONLY_TABLES, whose policies are `app_is_operator()` alone.
 */
export const BACKOFFICE_WORK_OPERATOR_TABLES = [
  "enhancement",
  "todo",
  "deal",
  "deal_person",
  "deal_activity",
  "play_setting",
  "play_log",
] as const;

/**
 * Every table with a `tenant_id`, in the order RLS tests walk them. Migration 0002 enables and
 * forces row-level security on each; migrations.test.ts checks this list against the database.
 */

export const TENANT_TABLES = [
  "membership",
  "connection",
  "connection_change",
  // Connectors C3 (0070): our requests to change a client's connection.
  "connection_change_request",
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
  "builder_session",
  "builder_turn",
  // v0.14 capture (0031)
  "conversation",
  "conversation_change",
  // P-1 (0033): the shared alert table. The Materials pack's own tables are not listed here: the
  // platform never imports a pack; they carry the comment `pack:materials` (migrations.test.ts).
  "alert",
  // P-7 (0034)
  "message_translation",
  // B-1 (0039): the chart of accounts and what each account is for (docs/plan.md §1.79).
  "ledger_account",
  "ledger_account_note",
  "ledger_dimension",
  // 0041: Intuit's webhook notifications, one row per entity change (docs/plan.md §1.81).
  "qbo_webhook_event",
  // 0045: recorded browser scripts (docs/plan.md §1.86 "Scripts (wave 4)").
  "browser_script",
  "browser_script_version",
  // 0046: the run audit (docs/plan.md §1.86 "Run audit (wave 6)").
  "owner_check",
  "run_audit",
  "run_audit_mark",
  // §1.116
  "person_device",
  // 0057: area owners and their versions (ARCHITECTURE v0.19 §10.15).
  "area_owner",
  "area_owner_version",
  // 0058: forms, "Request info" (docs/plan.md §1.121).
  "form_request",
  // 0060: a client's issues, their history and its asks (docs/plan.md §1.124).
  "issue",
  "issue_event",
  "client_ask",
  // 0066: a client's intake, its people, answers, scope and log (docs/plan.md §1.149).
  "intake",
  "intake_person",
  "intake_answer",
  "intake_scope",
  "intake_event",
  // 0069: the days a number was one agent's own phone line (docs/plan.md §1.160).
  "billing_phone_line_day",
  // 0074: each agent's SOP, one row per revision (docs/sop-plan.md §6).
  "sop_revision",
  // 0075: each agent's security checks, one row per result (docs/agent-assurance-plan.md §6).
  "control_check",
  // 0077: what each run was about, one row per thing it read or changed (docs/reporting-plan.md R1).
  "run_subject",
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
  "builder_session",
  "builder_turn",
] as const satisfies readonly TenantTable[];

/** Global tables only operator sessions may read or write (row-level security on `app.operator`). */
export const OPERATOR_ONLY_TABLES = [
  "browser_site",
  "browser_site_version",
  "saved_view",
  "connector_setting",
  // 0066: saved starts for Sign up now and Invite (docs/plan.md §1.149).
  "sales_start",
] as const;
