import { z } from "zod";
import { isUuid } from "../ids";
import { DECIMAL_RE } from "../money";
import { KpiValue } from "./client-view";
import { defineRoute } from "./contract";

// Usage and reports (docs/plan.md §1.15, ARCHITECTURE §13–§15). The back office sees model cost
// and usage per client, client agent and template, by month (operator only). The portal sees what
// its services did in a period: runs, documents and changes to its tools, never cost, tokens or
// prompts (invariant 11), and a service's own page.

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const CLIENT = ["client_admin", "client_user"] as const;

/** The longest range one usage or report request may span. */
export const USAGE_MAX_DAYS = 731;

/** `YYYY-MM-DD`, a real calendar day. */
export const IsoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "a day as YYYY-MM-DD")
  .refine((v) => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "not a calendar day");

/** `YYYY-MM`. */
const IsoMonth = z.string().regex(/^\d{4}-\d{2}$/);

const Range = z.object({ from: IsoDay.optional(), to: IsoDay.optional() });

/** Model cost in USD as a decimal string (4 places), never a float. */
const UsdAmount = z.string().regex(DECIMAL_RE);

// ── Back office ──────────────────────────────────────────────────────────────────────────────────

/** One cell of usage: what was done and what it cost. */
export const UsageFigures = z.object({
  runs: z.number().int(),
  steps: z.number().int(),
  documents: z.number().int(),
  externalActions: z.number().int(),
  tokensIn: z.number().int(),
  tokensOut: z.number().int(),
  costUsd: UsdAmount,
});
export type UsageFigures = z.infer<typeof UsageFigures>;

/** A row's figures for the whole range and for each month of it (every month, oldest first). */
const UsageSeries = {
  total: UsageFigures,
  byMonth: z.array(z.object({ month: IsoMonth, figures: UsageFigures })),
};

export const UsageClientRow = z.object({ id: z.string(), name: z.string(), ...UsageSeries });
export const UsageAgentRow = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  client: z.object({ id: z.string(), name: z.string() }),
  /** The template it was forked from; null for an agent built for this client alone. */
  template: z.object({ id: z.string(), slug: z.string(), name: z.string() }).nullable(),
  /** A template's Sandbox test copy (its usage is the template's testing). */
  testCopy: z.boolean(),
  ...UsageSeries,
});
export const UsageTemplateRow = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  /** Clients and client agents (forks, test copies included) with usage in the range. */
  clients: z.number().int(),
  agents: z.number().int(),
  ...UsageSeries,
});

/**
 * The longest range the report also splits by day (for the period's chart). Feedback
 * (2026-11-16): the chart is daily for every preset, a year included (at most 366 rows).
 */
// DECISION: 400 days covers "Last 12 months" from any day of a month (its first day is up to 365
// days back) with room; a longer custom range charts by month.
export const USAGE_DAILY_MAX_DAYS = 400;

/**
 * UI cleanup: model cost by model, from the model calls in the range (runs' calls, and the clients'
 * background reading when the report isn't narrowed to an agent or a template).
 */
export const UsageModelRow = z.object({
  /** `anthropic` | `openai` | `xai` | `google` (core's `modelProvider`). */
  provider: z.string(),
  model: z.string(),
  calls: z.number().int(),
  tokensIn: z.number().int(),
  tokensOut: z.number().int(),
  costUsd: UsdAmount,
});
export type UsageModelRow = z.infer<typeof UsageModelRow>;

/**
 * UI cleanup: what the work cost by vendor: each model provider from its model calls, and Twilio
 * and ElevenLabs from the messages and call seconds usage_daily counts, priced at our unit costs
 * (`estimated`); `costUsd` null when no unit cost is set for that measure.
 */
export const UsageVendorRow = z.object({
  id: z.string(),
  name: z.string(),
  costUsd: UsdAmount.nullable(),
  estimated: z.boolean(),
  calls: z.number().int().optional(),
  tokensIn: z.number().int().optional(),
  tokensOut: z.number().int().optional(),
  messages: z.number().int().optional(),
  callSeconds: z.number().int().optional(),
});
export type UsageVendorRow = z.infer<typeof UsageVendorRow>;

export const UsageReport = z.object({
  from: IsoDay,
  to: IsoDay,
  months: z.array(IsoMonth),
  ...UsageSeries,
  clients: z.array(UsageClientRow),
  agents: z.array(UsageAgentRow),
  templates: z.array(UsageTemplateRow),
  /** Every day of the range, oldest first, when it spans at most USAGE_DAILY_MAX_DAYS days. */
  byDay: z.array(z.object({ day: IsoDay, figures: UsageFigures })).optional(),
  byModel: z.array(UsageModelRow).optional(),
  byVendor: z.array(UsageVendorRow).optional(),
  /**
   * v0.12 W1-H (ARCHITECTURE §13): reading no agent asked for (uploads, forwarded mail), the
   * clients' own usage from usage_platform_daily. It is in the total and each client's row, never
   * in an agent's or a template's; absent when the report is narrowed to an agent or a template.
   */
  background: z.object(UsageSeries).optional(),
});
export type UsageReport = z.infer<typeof UsageReport>;

// ── Back office: tokens by client, agent, model and action ───────────────────────────────────────
// Owner, 2026-11-06, kept 2026-11-16 (docs/plan.md §1.115): every token an agent uses, Sloan's
// included, tallied per client and kept by model, by agent and by action, for the back office.

/**
 * What a model call was for (`model_call.action`, migration 0055): an agent's own turn in a step
 * (Sloan's conversation included), the run's oversight review, a reach-out's message, a tool's own
 * call (a document read, a web search, a translation in a step), a portal question answered for
 * the client's account agent (Sloan), a turn of a conversation step, an AI check of a step (the
 * second check), and the agent choosing a path or ending a repeat.
 */
// DECISION: main's model calls since 2026-11-06 that the original list didn't know each get their
// own action rather than `agent_turn`, so the tally shows what they cost: a conversation step's
// turns (`conversation`, §1.66), the AI's second check (`check`, §1.86) and the agent's choice of a
// path or a repeat's end (`choice`, §1.99). A translation or web search in a step is a tool's own
// call (`tool_call`), as a document read is.
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
export type ModelCallAction = (typeof MODEL_CALL_ACTIONS)[number];

/**
 * The actions a token report counts: every model call's, and the client's own model use no agent
 * asked for, which has no `model_call` row: `background_read` (uploads and forwarded mail, from
 * `doc_extraction`) and `background_translation` (the background job and a person's own text,
 * from `message_translation`).
 */
export const TOKEN_ACTIONS = [
  ...MODEL_CALL_ACTIONS,
  "background_read",
  "background_translation",
] as const;
export type TokenAction = (typeof TOKEN_ACTIONS)[number];

/** The back office's word for each action. */
export const TOKEN_ACTION_LABELS: Record<TokenAction, string> = {
  agent_turn: "Agent work",
  oversight: "Oversight review",
  reach_out: "Reach-out message",
  tool_call: "Tool's own call",
  question: "Portal question",
  conversation: "Conversation turn",
  check: "Second check",
  choice: "Path choice",
  background_read: "Background reading",
  background_translation: "Background translation",
};

/** Model calls and their tokens (input counts cache reads and writes) and cost. */
export const TokenFigures = z.object({
  calls: z.number().int(),
  tokensIn: z.number().int(),
  tokensOut: z.number().int(),
  costUsd: UsdAmount,
});
export type TokenFigures = z.infer<typeof TokenFigures>;

const TokenClient = z.object({ id: z.string(), name: z.string() });
/** A client agent; `account` marks the client's account agent (Sloan). */
const TokenAgent = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  account: z.boolean(),
});

export const TokenRow = z.object({
  client: TokenClient,
  /** Null for the client's own background use, which no agent made. */
  agent: TokenAgent.nullable(),
  /** `anthropic` | `openai` | `xai` | `google` (core's `modelProvider`). */
  provider: z.string(),
  model: z.string(),
  action: z.enum(TOKEN_ACTIONS),
  ...TokenFigures.shape,
});
export type TokenRow = z.infer<typeof TokenRow>;

export const TokenReport = z.object({
  from: IsoDay,
  to: IsoDay,
  total: TokenFigures,
  /** Per client, agent, model and action: the finest grain. Highest cost first. */
  rows: z.array(TokenRow),
  /** The account-level tally: per client. */
  byClient: z.array(TokenClient.extend(TokenFigures.shape)),
  byAgent: z.array(
    z.object({ client: TokenClient, agent: TokenAgent.nullable(), ...TokenFigures.shape }),
  ),
  byModel: z.array(z.object({ provider: z.string(), model: z.string(), ...TokenFigures.shape })),
  byAction: z.array(z.object({ action: z.enum(TOKEN_ACTIONS), ...TokenFigures.shape })),
});
export type TokenReport = z.infer<typeof TokenReport>;

// ── Small charts (both sides) ────────────────────────────────────────────────────────────────────

/** How many days the small run charts (sparklines) cover, on both sides. */
export const KPI_DAYS = 14;

/** One day's runs for a small chart: how many started, and how many of them failed. */
export const DayRuns = z.object({
  runs: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type DayRuns = z.infer<typeof DayRuns>;

// ── Portal ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Runs started in a period by how they stand (QA round 1, one definition for the Table, an agent's
 * page and Reports): waiting = waiting on someone of the client, even while the run's stored status
 * is running; going = queued or running and not waiting on the client.
 */
export const ActivityRuns = z.object({
  total: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  cancelled: z.number().int(),
  waiting: z.number().int(),
  going: z.number().int(),
});

/** What an agent has going now: runs working, and runs waiting on the client. */
export const AgentRunsNow = z.object({
  running: z.number().int(),
  waitingOnYou: z.number().int(),
});
export type AgentRunsNow = z.infer<typeof AgentRunsNow>;

/** What a service is doing now: its latest live run. */
export const ServiceNow = z.object({
  runId: z.string(),
  status: z.string(),
  /** The current top-level step: "3 of 6 · Match items". Null once the run is done. */
  step: z
    .object({ index: z.number().int(), total: z.number().int(), label: z.string() })
    .nullable(),
  /** When the run started, or when it began waiting. */
  since: z.string().nullable(),
  /** It waits on someone of the client (an open Desk item of this run for anyone of the client). */
  waitingOnYou: z.boolean(),
});
export type ServiceNow = z.infer<typeof ServiceNow>;

export const ActivityService = z.object({
  id: z.string(),
  name: z.string(),
  runs: ActivityRuns,
  /**
   * Documents this service read in the period: those it extracted, and those its live runs started
   * in the period worked on (the document that started the run).
   */
  documentsRead: z.number().int(),
  /** Changes it made to your tools in the period. */
  actions: z.number().int(),
});

export const ActivityReport = z.object({
  from: IsoDay,
  to: IsoDay,
  /** The client's time zone the period's days are in. */
  timezone: z.string(),
  runs: ActivityRuns,
  documents: z.object({
    /** Uploaded or forwarded in the period. */
    received: z.number().int(),
    /** Read in the period: extracted, or worked on by a live run (the services' documents too). */
    read: z.number().int(),
  }),
  actions: z.object({
    total: z.number().int(),
    /** Per tool connected: QuickBooks Online, Gmail, … */
    byConnector: z.array(z.object({ connector: z.string(), name: z.string(), count: z.number() })),
  }),
  services: z.array(ActivityService),
  /** Packs enabled for this client; their reports show under /reports (none are built yet). */
  packs: z.array(z.string()),
});
export type ActivityReport = z.infer<typeof ActivityReport>;

const PortalRun = z.object({
  id: z.string(),
  service: z.object({ id: z.string(), name: z.string() }),
  status: z.enum(["queued", "running", "waiting", "succeeded", "failed", "cancelled"]),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  // QA round 1: as on `/api/runs` (PortalRunSummary): waiting on the client now, time waited.
  waitingOnYou: z.boolean().optional(),
  waitedMs: z.number().int().nonnegative().optional(),
});

export const ServiceDetail = z.object({
  service: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    status: z.string(),
  }),
  /** This month so far, in the client's time zone. */
  thisMonth: ActivityService.omit({ id: true, name: true }).extend({ from: IsoDay, to: IsoDay }),
  recentRuns: z.array(PortalRun),
  packs: z.array(z.string()),
  // UI cleanup: what the portal's agent page mounts its own view by (apps/web/src/agents/views.ts).
  // The slug of the template it was forked from (a name, never the template's bundle: invariant
  // 11), null for an agent built for this client alone; optional so older answers still parse.
  template: z.string().nullable().optional(),
  /** It starts from documents (a `document.*` event trigger): its page offers upload. */
  readsDocuments: z.boolean().optional(),
  // audit-plan 6.6: what the agent page read from the Table, so it need not ask for it. Optional
  // so older answers still parse.
  /** bench, trial, signoff or live (null before go-live stages). */
  stage: z.string().nullable().optional(),
  /** Its latest live run, as the Table shows it; null before its first. */
  now: ServiceNow.nullable().optional(),
  /** What it has going now: runs working, and runs waiting on you. */
  runsNow: AgentRunsNow.optional(),
  /** Its KPIs, each over its own period, labels and values only (never the definition). */
  kpis: z.array(KpiValue).optional(),
});
export type ServiceDetail = z.infer<typeof ServiceDetail>;

export const usageRoutes = {
  opsUsage: defineRoute({
    method: "GET",
    path: "/api/ops/usage",
    auth: "session",
    roles: OPS,
    summary:
      "Usage and model cost per client, client agent and template, by month (default: the last six months)",
    query: Range.extend({
      client: Id.optional(),
      agent: Id.optional(),
      template: Id.optional(),
    }),
    response: UsageReport,
  }),
  opsUsageTokens: defineRoute({
    method: "GET",
    path: "/api/ops/usage/tokens",
    auth: "session",
    roles: OPS,
    summary:
      "Model calls, tokens and cost per client, agent (Sloan included), model and action (default: this month)",
    query: Range.extend({
      client: Id.optional(),
      agent: Id.optional(),
      template: Id.optional(),
      model: z.string().min(1).max(200).optional(),
      action: z.enum(TOKEN_ACTIONS).optional(),
    }),
    response: TokenReport,
  }),
  portalActivityReport: defineRoute({
    method: "GET",
    path: "/api/reports/activity",
    auth: "session",
    roles: CLIENT,
    summary:
      "What your services did in a period (default: this month): runs, documents, changes to your tools",
    query: Range.extend({ service: Id.optional() }),
    response: ActivityReport,
  }),
  portalService: defineRoute({
    method: "GET",
    path: "/api/services/:id",
    auth: "session",
    roles: CLIENT,
    summary: "One service: what it does, this month's activity, recent runs",
    params: z.object({ id: Id }),
    response: ServiceDetail,
  }),
  // docs/plan.md §1.163 (owner, 2026-11-20): the back office opens what a client sees for one of
  // its agents. The portal's own answer, the same schema object, so it never carries more than the
  // portal's page does (no bundle, instructions, prompts or cost: invariant 11).
  opsClientAgentView: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/agents/:agentId/client-view",
    auth: "session",
    roles: OPS,
    summary:
      "One client agent as that client's portal shows it, read only: the same answer as GET /api/services/:id for the client",
    params: z.object({ id: Id, agentId: Id }),
    response: ServiceDetail,
  }),
} as const;
