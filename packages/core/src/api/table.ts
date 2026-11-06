// The Table and the Weekly Table (ARCHITECTURE §11.4, §14 v0.12; docs/plan.md §1.37). The Table is
// the portal's home: each service and what it is doing now, this week's figures, the latest
// step summaries, the top of the Desk and the lead's latest message. The Weekly Table is drafted
// Friday, edited by the lead in the back office and sent Monday; the portal reads sent ones and
// downloads them as a PDF. No response carries a bundle, a prompt or a cost.

import { z } from "zod";
import { isUuid } from "../ids";
import { WeeklyEditBody, WeeklyTableView, WeekStartParam } from "../weekly/schemas";
import { defineRoute } from "./contract";

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const CLIENT = ["client_admin", "client_user"] as const;

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
  /** It waits on someone of the client (an open Desk item of this run). */
  waitingOnYou: z.boolean(),
});

export const TableService = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  /** bench, trial, signoff or live (null before go-live stages). */
  stage: z.string().nullable(),
  now: ServiceNow.nullable(),
  /** Live runs done this week. */
  runsDone: z.number().int(),
  // DECISION: KPIs come from W2-G (docs/plan.md §1.50); until it merges every list is empty.
  kpis: z.array(z.object({ key: z.string(), label: z.string(), value: z.string() })),
});

export const TableView = z.object({
  client: z.object({ id: z.string(), name: z.string(), timezone: z.string() }),
  week: z.object({ weekStart: z.string(), from: z.string(), to: z.string() }),
  services: z.array(TableService),
  figures: z.object({
    runsDone: z.number().int(),
    changes: z.object({ automatic: z.number().int(), signed: z.number().int() }),
  }),
  /** The latest client-visible step summaries across services. */
  recent: z.array(
    z.object({
      runId: z.string(),
      service: z.object({ id: z.string(), name: z.string() }),
      label: z.string(),
      summary: z.string().nullable(),
      sources: z.array(z.string()),
      at: z.string().nullable(),
    }),
  ),
  desk: z.object({
    open: z.number().int(),
    top: z.array(
      z.object({
        id: z.string(),
        kind: z.string(),
        title: z.string(),
        runId: z.string().nullable(),
        dueAt: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
  }),
  /** The lead and their latest message to the client (null when no lead is set). */
  lead: z
    .object({
      id: z.string(),
      name: z.string().nullable(),
      message: z.object({ id: z.string(), text: z.string(), at: z.string() }).nullable(),
    })
    .nullable(),
});
export type TableView = z.infer<typeof TableView>;

export const PortalWeekly = z.object({
  /** The week asked for, or the latest sent; null when none was sent yet. */
  table: WeeklyTableView.nullable(),
  /** Weeks with a sent table, newest first. */
  weeks: z.array(z.string()),
});
export type PortalWeekly = z.infer<typeof PortalWeekly>;

export const OpsWeekly = z.object({
  /** The client's tables, newest first: the draft being written and those sent. */
  tables: z.array(WeeklyTableView),
});
export type OpsWeekly = z.infer<typeof OpsWeekly>;

export const tableRoutes = {
  portalTable: defineRoute({
    method: "GET",
    path: "/api/table",
    auth: "session",
    roles: CLIENT,
    summary: "The Table: your services now, this week's figures, the Desk's top and your lead",
    response: TableView,
  }),
  portalWeekly: defineRoute({
    method: "GET",
    path: "/api/weekly",
    auth: "session",
    roles: CLIENT,
    summary: "A sent weekly summary (the latest, or `week`) and the weeks there are",
    query: z.object({ week: WeekStartParam.optional() }),
    response: PortalWeekly,
  }),
  portalWeeklyPdf: defineRoute({
    method: "GET",
    path: "/api/weekly/:weekStart/pdf",
    auth: "session",
    roles: CLIENT,
    summary: "A sent weekly summary as a PDF, rendered on request; not JSON",
    params: z.object({ weekStart: WeekStartParam }),
    response: z.unknown(),
  }),
  portalWeeklyReply: defineRoute({
    method: "POST",
    path: "/api/weekly/:weekStart/decisions/:decisionId/reply",
    auth: "session",
    roles: CLIENT,
    summary: "Answer a decision in the lead thread (501 not_yet until threads are built)",
    params: z.object({ weekStart: WeekStartParam, decisionId: Id }),
    body: z.strictObject({ text: z.string().trim().min(1).max(4000) }),
    response: z.object({ messageId: z.string() }),
  }),
  opsWeekly: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/weekly",
    auth: "session",
    roles: OPS,
    summary: "A client's weekly summaries: this week's draft and the sent ones",
    params: z.object({ id: Id }),
    response: OpsWeekly,
  }),
  opsWeeklyEdit: defineRoute({
    method: "PUT",
    path: "/api/ops/clients/:id/weekly/:weekStart",
    auth: "session",
    roles: OPS,
    summary: "The lead's note, decisions and next week, until the table is sent (409 sent)",
    params: z.object({ id: Id, weekStart: WeekStartParam }),
    body: WeeklyEditBody,
    response: z.object({ table: WeeklyTableView }),
  }),
} as const;
