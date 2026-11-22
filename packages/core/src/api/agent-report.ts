import { z } from "zod";
import { isUuid } from "../ids";
import { DECIMAL_RE } from "../money";
import { RunSubjectKind } from "../schemas/tool-about";
import { KpiValue } from "./client-view";
import { defineRoute } from "./contract";
import { ExportFile } from "./exports";
import { RunFilter } from "./runs-filter";
import { IsoDay } from "./usage";

// R4: a report per agent (docs/reporting-plan.md §3 R4, docs/plan.md §1.214). One agent's work in
// a period, the same on both surfaces apart from cost and errors (the owner's answer 2): runs by
// outcome per day, time to finish, time waiting on people, approvals, changes with their amounts
// per currency (answer 4), what it handled, its own KPIs. Every figure carries the RunFilter that
// opens exactly the runs behind it, or none when the filter can't say it exactly.
//
// Its routes stay out of the web's first-load registry (all-routes.ts): the report's screens load
// when opened, and their schemas with them.

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const CLIENT = ["client_admin", "client_user"] as const;

/** The portal's RunFilter: the back office's keys left out, so no answer can carry `costOver`. */
export const PortalReportFilter = RunFilter.omit({
  clients: true,
  templates: true,
  versions: true,
  mode: true,
  costOver: true,
  errorKey: true,
});
export type PortalReportFilter = z.infer<typeof PortalReportFilter>;

/** `?from&to`: days in the client's time zone, both ends included (default: this month so far). */
export const AgentReportQuery = z.object({ from: IsoDay.optional(), to: IsoDay.optional() });

/** A decimal amount beside its currency (invariant 6). */
export const ReportAmount = z.object({ currency: z.string(), total: z.string().regex(DECIMAL_RE) });
export type ReportAmount = z.infer<typeof ReportAmount>;

/** What every report figure's schema is built from: its filter, the surface's RunFilter. */
function reportSchemas<F extends z.ZodType>(Filter: F) {
  /**
   * A number and the filter that opens exactly the runs behind it; null when RunFilter can't say
   * it exactly (who signed is a key, how they signed is not).
   */
  const Figure = z.object({ count: z.number().int().nonnegative(), filter: Filter.nullable() });

  /** Runs by how they ended, or stand now: the portal's five states. */
  const Outcomes = z.object({
    done: Figure,
    waiting: Figure,
    failed: Figure,
    stopped: Figure,
    going: Figure,
  });

  /** Milliseconds: the median and the 90th percentile, null over nothing. */
  const Durations = z.object({
    medianMs: z.number().int().nullable(),
    p90Ms: z.number().int().nullable(),
  });

  /** The figures each period is compared by. */
  const Headline = z.object({
    from: IsoDay,
    to: IsoDay,
    runs: z.number().int(),
    done: z.number().int(),
    failed: z.number().int(),
    finishMedianMs: z.number().int().nullable(),
    waitMedianMs: z.number().int().nullable(),
    approvals: z.number().int(),
    changes: z.number().int(),
  });

  const Report = z.object({
    service: z.object({ id: z.string(), name: z.string() }),
    from: IsoDay,
    to: IsoDay,
    timezone: z.string(),
    /** This period's headline, and the one before it (last month, or as many days before). */
    headline: Headline,
    previous: Headline,
    /** Every run of the period. */
    runs: Figure,
    outcomes: Outcomes,
    /** Each day of the period (the client's days), oldest first. */
    perDay: z.array(Outcomes.extend({ day: IsoDay })),
    /** Runs that succeeded: from start to finish. */
    timeToFinish: Durations.extend({ runs: Figure }),
    /** The client's people: from each item's creation to its answer. */
    waitingOnPeople: Durations.extend({
      answered: z.number().int(),
      open: z.number().int(),
      totalMs: z.number().int(),
    }),
    approvals: z.object({
      signed: z.number().int(),
      edited: z.number().int(),
      turnedDown: z.number().int(),
      byPerson: z.array(
        z.object({
          /** Null when we stepped in: never our person's name on the portal. */
          person: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
          steppedIn: z.boolean(),
          signed: z.number().int(),
          edited: z.number().int(),
          turnedDown: z.number().int(),
          filter: Filter.nullable(),
        }),
      ),
    }),
    /** Changes made in the client's tools (done), by tool, with their amounts per currency. */
    changes: z.object({
      total: Figure,
      amounts: z.array(ReportAmount),
      byConnector: z.array(
        z.object({
          connector: z.string(),
          name: z.string(),
          count: z.number().int(),
          amounts: z.array(ReportAmount),
          /** By record type (`bill`, `invoice`); `other` when the tool names none. */
          entities: z.array(z.object({ entity: z.string(), count: z.number().int() })),
          filter: Filter.nullable(),
        }),
      ),
    }),
    /** What its runs read, decided on or changed, by kind (R1), the most frequent first. */
    handled: z.array(
      z.object({
        kind: RunSubjectKind,
        records: z.number().int(),
        runs: z.number().int(),
        filter: Filter.nullable(),
        top: z.array(
          z.object({
            id: z.string().nullable(),
            label: z.string().nullable(),
            number: z.string().nullable(),
            runs: z.number().int(),
            filter: Filter.nullable(),
          }),
        ),
      }),
    ),
    /** Its own KPIs (`clientView`), each over the period, labels and values only. */
    kpis: z.array(KpiValue),
  });
  return { Report, Figure };
}

const portal = reportSchemas(PortalReportFilter);
const ops = reportSchemas(RunFilter);

/** The portal's agent report: no cost, tokens or errors (invariant 11). */
export const PortalAgentReport = portal.Report;
export type PortalAgentReport = z.infer<typeof PortalAgentReport>;

/** Back office: the same report with the client, the five most frequent errors and the cost. */
export const OpsAgentReport = ops.Report.extend({
  client: z.object({ id: z.string(), name: z.string() }),
  errors: z.array(z.object({ key: z.string(), count: z.number().int(), filter: RunFilter })),
  spend: z.object({
    runs: z.number().int(),
    costUsd: z.string().regex(DECIMAL_RE),
    costPerRunUsd: z.string().regex(DECIMAL_RE).nullable(),
    tokensIn: z.number().int(),
    tokensOut: z.number().int(),
    tokensPerRun: z.number().int().nullable(),
    filter: RunFilter,
  }),
});
export type OpsAgentReport = z.infer<typeof OpsAgentReport>;

/** A figure as either surface carries it. */
export type ReportFigure = { count: number; filter: RunFilter | null };

/** The errors the back office's report lists. */
export const AGENT_REPORT_ERRORS = 5;
/** The records listed under each kind of what it handled. */
export const AGENT_REPORT_TOP = 5;

export const agentReportRoutes = {
  portalServiceReport: defineRoute({
    method: "GET",
    path: "/api/services/:id/report",
    auth: "session",
    roles: CLIENT,
    summary:
      "One service's report for a period (default: this month, against last month): runs, time, approvals, changes and amounts, what it handled, its KPIs",
    params: z.object({ id: Id }),
    query: AgentReportQuery,
    response: PortalAgentReport,
  }),
  portalServiceReportCsv: defineRoute({
    method: "GET",
    path: "/api/services/:id/report.csv",
    auth: "session",
    roles: CLIENT,
    summary: "One service's report for a period, as CSV",
    params: z.object({ id: Id }),
    query: AgentReportQuery,
    response: ExportFile,
  }),
  opsAgentReport: defineRoute({
    method: "GET",
    path: "/api/ops/agents/:id/report",
    auth: "session",
    roles: OPS,
    summary:
      "A client agent's report for a period (default: this month, against last month): the portal's figures, its errors and its cost",
    params: z.object({ id: Id }),
    query: AgentReportQuery,
    response: OpsAgentReport,
  }),
  opsAgentReportCsv: defineRoute({
    method: "GET",
    path: "/api/ops/agents/:id/report.csv",
    auth: "session",
    roles: OPS,
    summary: "A client agent's report for a period, as CSV, errors and cost included",
    params: z.object({ id: Id }),
    query: AgentReportQuery,
    response: ExportFile,
  }),
} as const;
