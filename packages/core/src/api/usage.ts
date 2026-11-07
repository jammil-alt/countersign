import { z } from "zod";
import { isUuid } from "../ids";
import { DECIMAL_RE } from "../money";
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

/** The longest range the report also splits by day (for the period's chart). */
export const USAGE_DAILY_MAX_DAYS = 92;

/**
 * UI cleanup: model cost by model, from the model calls in the range (runs' calls, and the clients'
 * background reading when the report isn't narrowed to an agent or a template).
 */
export const UsageModelRow = z.object({
  /** `anthropic` | `openai`. */
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
} as const;
