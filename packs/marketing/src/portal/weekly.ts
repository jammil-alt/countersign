// M50 (docs/plan.md §1.78): the weekly report as the client's portal reads it
// (`/api/reports/marketing/weekly-report`, and one report as an item), read only. A projection
// of `marketing_report` and its actions that keeps what the client reads: the week, what changed,
// why it probably did, what we can't know, the three suggested actions and whether each was done.
// It never carries the agent version, the run, who decided an action, the figures the agent was
// given or the record ids behind each line (the back office's `reports` report has those): no
// portal route returns agent internals (invariant 11).
//
// The body is the agent's, written through `marketing.report.record` (the agent set): read here
// with a tolerant schema, so a field the agent left out reads as empty rather than failing the
// page. Its text is the agent's words about the client's own figures, shown as written.

import type { Tx } from "@countersign/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { toCsv } from "../measure/range";
import { marketingReport, marketingReportAction, type REPORT_ACTION_DECISIONS } from "../schema";
import { listSites, type SiteRow } from "../sites";

export const WEEKLY_REPORT = "weekly-report";
/** How many past reports the list shows: half a year of Mondays. */
export const WEEKLY_LIST_LIMIT = 26;

export const WeeklyQuery = z.strictObject({ site: z.uuid().optional() });
export type WeeklyQuery = z.output<typeof WeeklyQuery>;

const Line = z.looseObject({ text: z.string().min(1).max(1000) });
const lines = z
  .array(z.unknown())
  .catch([])
  .transform((xs) =>
    xs.flatMap((x) => {
      const parsed = Line.safeParse(x);
      return parsed.success ? [{ text: parsed.data.text }] : [];
    }),
  );
const text = (max: number) => z.string().max(max).catch("");

/** The parts of a report's body the portal shows (the agent set's shape, Plenary's weekly report). */
// DECISION: tolerant, field by field: an unknown or malformed field reads as empty, and nothing
// in the body but these four reaches the portal (evidence links point at back-office pages).
const WeeklyBody = z.looseObject({
  summary: text(2000).optional(),
  changes: lines.optional(),
  causes: lines.optional(),
  unknown: text(2000).optional(),
});

export interface WeeklyListItem {
  id: string;
  periodFrom: string;
  periodTo: string;
  createdAt: string;
  /** Whether someone at the client or the operator has read it. */
  read: boolean;
}

export interface WeeklyAction {
  idx: number;
  text: string;
  decision: (typeof REPORT_ACTION_DECISIONS)[number];
}

export interface WeeklyView extends WeeklyListItem {
  siteId: string;
  summary: string;
  changes: { text: string }[];
  causes: { text: string }[];
  unknown: string;
  actions: WeeklyAction[];
  /** How many records the report rests on (every number in it came from them). */
  sourceCount: number;
}

export interface WeeklyReports {
  site: SiteRow | null;
  sites: SiteRow[];
  reports: WeeklyListItem[];
  latest: WeeklyView | null;
}

type ReportRow = typeof marketingReport.$inferSelect;

const listItem = (r: ReportRow): WeeklyListItem => ({
  id: r.id,
  periodFrom: r.periodFrom,
  periodTo: r.periodTo,
  createdAt: r.createdAt.toISOString(),
  read: r.readAt !== null,
});

async function view(tx: Tx, tenantId: string, r: ReportRow): Promise<WeeklyView> {
  const body = WeeklyBody.safeParse(r.body);
  const b = body.success ? body.data : {};
  const actions = await tx
    .select({
      idx: marketingReportAction.idx,
      text: marketingReportAction.text,
      decision: marketingReportAction.decision,
    })
    .from(marketingReportAction)
    .where(
      and(eq(marketingReportAction.tenantId, tenantId), eq(marketingReportAction.reportId, r.id)),
    )
    .orderBy(marketingReportAction.idx);
  return {
    ...listItem(r),
    siteId: r.siteId,
    summary: b.summary ?? "",
    changes: b.changes ?? [],
    causes: b.causes ?? [],
    unknown: b.unknown ?? "",
    actions,
    sourceCount: Array.isArray(r.sources) ? r.sources.length : 0,
  };
}

/**
 * A site's weekly reports, newest first, and the newest in full. A site the client hasn't reads as
 * no site (empty), the same answer as a client with no site yet: it says nothing about others.
 */
export async function weeklyReports(
  tx: Tx,
  tenantId: string,
  query: WeeklyQuery = {},
): Promise<WeeklyReports> {
  const sites = await listSites(tx, tenantId);
  const chosen = query.site ? (sites.find((s) => s.id === query.site) ?? null) : (sites[0] ?? null);
  if (!chosen) return { site: null, sites, reports: [], latest: null };
  const rows = await tx
    .select()
    .from(marketingReport)
    .where(
      and(
        eq(marketingReport.tenantId, tenantId),
        eq(marketingReport.siteId, chosen.id),
        eq(marketingReport.kind, "weekly"),
      ),
    )
    .orderBy(desc(marketingReport.periodTo), desc(marketingReport.createdAt))
    .limit(WEEKLY_LIST_LIMIT);
  const newest = rows[0];
  return {
    site: chosen,
    sites,
    reports: rows.map(listItem),
    latest: newest ? await view(tx, tenantId, newest) : null,
  };
}

/** One weekly report in full; null when it isn't this client's (or not a weekly one). */
export async function weeklyReport(
  tx: Tx,
  tenantId: string,
  id: string,
): Promise<WeeklyView | null> {
  const [row] = await tx
    .select()
    .from(marketingReport)
    .where(
      and(
        eq(marketingReport.tenantId, tenantId),
        eq(marketingReport.id, id),
        eq(marketingReport.kind, "weekly"),
      ),
    );
  return row ? view(tx, tenantId, row) : null;
}

/** The list as CSV: one row per report, with its actions' decisions counted. */
export async function weeklyCsv(tx: Tx, tenantId: string, query: WeeklyQuery = {}) {
  const w = await weeklyReports(tx, tenantId, query);
  const ids = w.reports.map((r) => r.id);
  const actions =
    ids.length > 0
      ? await tx
          .select({
            reportId: marketingReportAction.reportId,
            decision: marketingReportAction.decision,
          })
          .from(marketingReportAction)
          .where(
            and(
              eq(marketingReportAction.tenantId, tenantId),
              inArray(marketingReportAction.reportId, ids),
            ),
          )
      : [];
  const count = (id: string, d: string) =>
    actions.filter((a) => a.reportId === id && a.decision === d).length;
  return toCsv([
    ["week_from", "week_to", "written_at", "actions_done", "actions_not_now", "actions_open"],
    ...w.reports.map((r) => [
      r.periodFrom,
      r.periodTo,
      r.createdAt,
      count(r.id, "done"),
      count(r.id, "not_now"),
      count(r.id, "open"),
    ]),
  ]);
}
