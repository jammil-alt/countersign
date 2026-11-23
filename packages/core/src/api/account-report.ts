import { z } from "zod";
import { isUuid } from "../ids";
import { AgentReportQuery, PortalReportFilter, ReportHeadline, reportFigure } from "./agent-report";
import { defineRoute } from "./contract";
import { ExportFile } from "./exports";
import { RunFilter } from "./runs-filter";
import { IsoDay } from "./usage";

// R5: a report per account, and every account side by side (docs/reporting-plan.md §3 R5,
// docs/plan.md §1.235). One client's period across its agents, built on R4's figures: a line per
// agent with R4's headline, what waits now and the oldest wait, failed runs nobody has looked at,
// connections that need attention (`refresh_failing` included, C4.2), usage against the allowance,
// and this period against the one before. The back office adds "Needs us" (the owner's answer 3)
// and lists every client it serves on `/ops/accounts`, sortable, those that need us first.
//
// Like R4's, its routes stay out of the web's first-load registry: the screens load when opened.

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const CLIENT = ["client_admin", "client_user"] as const;

/** Something waiting longer than this needs us (the owner's answer 3: "more than a day"). */
export const ACCOUNT_WAIT_OVERDUE_HOURS = 24;
/** An allowance used past this share needs us (the owner's answer 3: "over 80%"). */
export const ACCOUNT_ALLOWANCE_SHARE = 0.8;

/**
 * Why a client needs us, in the order "Needs us" lists them: one per kind of Home's Needs us
 * escalation (S4.6, decision D5): an approval nobody at the client can act on or waiting over a
 * day, a failed run not tried again, a connection an agent uses in error, an item for us, a
 * reading under the client's threshold.
 */
export const NEEDS_US_REASONS = [
  "waiting",
  "failed",
  "connection",
  "item",
  "low_confidence",
] as const;
export const NeedsUsReason = z.enum(NEEDS_US_REASONS);
export type NeedsUsReason = z.infer<typeof NeedsUsReason>;

/** Why a connection needs a person: `error` (sign in again) or `refresh_failing` (C4.2). */
export const ConnectionAttention = z.enum(["error", "refresh_failing"]);
export type ConnectionAttention = z.infer<typeof ConnectionAttention>;

function accountSchemas<F extends z.ZodType>(Filter: F) {
  const Figure = reportFigure(Filter);

  /** One agent's line: R4's headline for the period and the one before, and its runs now. */
  const AgentLine = z.object({
    service: z.object({ id: z.string(), name: z.string() }),
    headline: ReportHeadline,
    previous: ReportHeadline,
    runs: Figure,
    done: Figure,
    failed: Figure,
    /** Its runs waiting now, whenever they started. */
    waiting: Figure,
  });

  /** What waits now: runs, the open items behind them and the oldest of those. */
  const Waiting = z.object({
    runs: Figure,
    items: z.number().int(),
    /** Items open longer than ACCOUNT_WAIT_OVERDUE_HOURS. */
    overdue: z.number().int(),
    oldestSince: z.string().nullable(),
  });

  /**
   * Live runs that failed in the last FAILED_RUN_ESCALATION_DAYS and were not tried again, as
   * Needs us counts them. RunFilter can't say "not tried again", so the figure has no filter.
   */
  const FailedUnseen = z.object({
    count: z.number().int(),
    oldestSince: z.string().nullable(),
    filter: Filter.nullable(),
  });

  const ConnectionLine = z.object({
    id: z.string(),
    connector: z.string(),
    /** The connector's name ("QuickBooks Online"). */
    name: z.string(),
    attention: ConnectionAttention,
    /** When the connection last changed. */
    since: z.string(),
  });

  /** The month's credits against the allowance; null when the client isn't set up for billing. */
  const Usage = z
    .object({
      period: IsoDay,
      used: z.number().int(),
      included: z.number().int(),
      /** used / included, null when nothing is included. */
      share: z.number().nullable(),
    })
    .nullable();

  const Report = z.object({
    client: z.object({ id: z.string(), name: z.string() }),
    from: IsoDay,
    to: IsoDay,
    timezone: z.string(),
    /** The whole client's headline, this period and the one before. */
    headline: ReportHeadline,
    previous: ReportHeadline,
    runs: Figure,
    done: Figure,
    failed: Figure,
    /** One line per agent, the most runs first. */
    agents: z.array(AgentLine),
    waiting: Waiting,
    failedUnseen: FailedUnseen,
    connections: z.array(ConnectionLine),
    usage: Usage,
  });
  return { Report };
}

const portal = accountSchemas(PortalReportFilter);
const ops = accountSchemas(RunFilter);

/** The portal's account report: no cost, tokens, errors or Needs us (invariant 11). */
export const PortalAccountReport = portal.Report;
export type PortalAccountReport = z.infer<typeof PortalAccountReport>;

/** Back office: the same report with why the client needs us, if it does. */
export const OpsAccountReport = ops.Report.extend({ needsUs: z.array(NeedsUsReason) });
export type OpsAccountReport = z.infer<typeof OpsAccountReport>;

/** One row of `/ops/accounts`: the account report without its agent lines. */
export const OpsAccountRow = OpsAccountReport.omit({ agents: true }).extend({
  agents: z.number().int(),
});
export type OpsAccountRow = z.infer<typeof OpsAccountRow>;

export const accountReportRoutes = {
  portalAccountReport: defineRoute({
    method: "GET",
    path: "/api/reports/account",
    auth: "session",
    roles: CLIENT,
    summary:
      "The client's report for a period (default: this month, against last month): a line per agent, what waits now, failed runs, connections that need attention and usage",
    query: AgentReportQuery,
    response: PortalAccountReport,
  }),
  portalAccountReportCsv: defineRoute({
    method: "GET",
    path: "/api/reports/account.csv",
    auth: "session",
    roles: CLIENT,
    summary: "The client's report for a period, as CSV",
    query: AgentReportQuery,
    response: ExportFile,
  }),
  opsClientReport: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/report",
    auth: "session",
    roles: OPS,
    summary:
      "A client's report for a period (default: this month, against last month): the portal's figures and why it needs us",
    params: z.object({ id: Id }),
    query: AgentReportQuery,
    response: OpsAccountReport,
  }),
  opsClientReportCsv: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/report.csv",
    auth: "session",
    roles: OPS,
    summary: "A client's report for a period, as CSV",
    params: z.object({ id: Id }),
    query: AgentReportQuery,
    response: ExportFile,
  }),
  opsAccounts: defineRoute({
    method: "GET",
    path: "/api/ops/accounts",
    auth: "session",
    roles: OPS,
    summary:
      "Every client the operator serves, side by side for a period (each in its own days): runs, what waits, failed runs, connections, usage and why it needs us",
    query: AgentReportQuery,
    response: z.object({ accounts: z.array(OpsAccountRow) }),
  }),
} as const;
