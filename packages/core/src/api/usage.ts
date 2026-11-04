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

export const UsageReport = z.object({
  from: IsoDay,
  to: IsoDay,
  months: z.array(IsoMonth),
  ...UsageSeries,
  clients: z.array(UsageClientRow),
  agents: z.array(UsageAgentRow),
  templates: z.array(UsageTemplateRow),
});
export type UsageReport = z.infer<typeof UsageReport>;

// ── Portal ───────────────────────────────────────────────────────────────────────────────────────

/** Runs in a period by how they ended (waiting = on a person; going = queued or running). */
export const ActivityRuns = z.object({
  total: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  cancelled: z.number().int(),
  waiting: z.number().int(),
  going: z.number().int(),
});

export const ActivityService = z.object({
  id: z.string(),
  name: z.string(),
  runs: ActivityRuns,
  /** Documents this service read in the period. */
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
    /** Read (extracted) in the period. */
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
