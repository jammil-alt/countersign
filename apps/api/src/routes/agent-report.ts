// R4: a report per agent (docs/reporting-plan.md §3 R4, docs/plan.md §1.214). The portal's
// `GET /api/services/:id/report` and the back office's `GET /api/ops/agents/:id/report`, each with
// its CSV. The portal's answer is its own schema, without cost, tokens or errors (invariant 11),
// for one of the client's services a limited person sees; the back office's is for a client agent
// of a client the operator serves.

import {
  agentReportRoutes,
  type OpsAgentReport,
  type PortalAgentReport,
  type ReportAmount,
  type ReportFigure,
} from "@countersign/core";
import { agent, narrowToTenant, type Tx } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { ensureSeesAgent } from "../assigned";
import { CSV_TYPE, type CsvValue, csvFile } from "../exports/csv";
import { type AppEnv, ensureClient, mount, mountFile, notFound } from "../http";
import { readerLocale } from "../kpi/view";
import { tenantRow } from "../notify/people";
import type { Platform } from "../platform";
import { agentReport, opsReportExtras, reportPeriods } from "../runs/agent-report";
import { checkRange, isService, todayIn } from "./usage";

type AgentRow = typeof agent.$inferSelect;
type Query = { from?: string | undefined; to?: string | undefined };

/** The client's report for one of its services. */
async function portalReport(
  tx: Tx,
  platform: Platform,
  input: { tenantId: string; serviceId: string; readerId: string; query: Query },
): Promise<PortalAgentReport> {
  const [[a], t] = await Promise.all([
    tx
      .select()
      .from(agent)
      .where(and(isService(input.tenantId), eq(agent.id, input.serviceId))),
    tenantRow(tx, input.tenantId),
  ]);
  if (!a) throw notFound("service");
  if (!t) throw notFound("client");
  const periods = reportPeriods(input.query, todayIn(t.timezone));
  checkRange(periods.from, periods.to);
  return (await agentReport(tx, platform, {
    surface: "portal",
    agent: a,
    tenantId: input.tenantId,
    timezone: t.timezone,
    ...periods,
    locale: readerLocale(t, input.readerId),
  })) as PortalAgentReport;
}

/** The back office's report for a client agent: the portal's figures, its errors and its cost. */
async function opsReport(
  tx: Tx,
  platform: Platform,
  a: AgentRow,
  query: Query,
): Promise<OpsAgentReport> {
  const tenantId = a.tenantId as string;
  // DECISION: read under the one client's scope, as the portal's own report is.
  return narrowToTenant(tx, tenantId, async (one) => {
    const t = await tenantRow(one, tenantId);
    if (!t) throw notFound("client");
    const periods = reportPeriods(query, todayIn(t.timezone));
    checkRange(periods.from, periods.to);
    const [report, extras] = await Promise.all([
      agentReport(one, platform, {
        surface: "ops",
        agent: a,
        tenantId,
        timezone: t.timezone,
        ...periods,
        // The back office reads in English.
        locale: "en",
      }),
      opsReportExtras(one, platform, {
        agent: a,
        tenantId,
        timezone: t.timezone,
        from: periods.from,
        to: periods.to,
      }),
    ]);
    return { ...report, client: { id: t.id, name: t.name }, ...extras } as OpsAgentReport;
  });
}

/** A client agent of a client the operator serves; a template or another's agent is "not found". */
async function opsAgentRow(
  ctx: { tx: Tx; tenantIds: readonly string[] },
  id: string,
): Promise<AgentRow> {
  const [a] = await ctx.tx.select().from(agent).where(eq(agent.id, id));
  if (a?.kind !== "client" || a.tenantId === null || a.testCopy) throw notFound("agent");
  ensureClient(ctx, a.tenantId);
  return a;
}

// ── CSV ─────────────────────────────────────────────────────────────────────────────────────────

export const REPORT_CSV_COLUMNS = ["section", "item", "figure", "value", "currency"] as const;

/** One line per figure: what it is, of what, and its value (money beside its currency). */
export function reportCsvRows(report: PortalAgentReport | OpsAgentReport): (readonly CsvValue[])[] {
  const rows: (readonly CsvValue[])[] = [];
  const line = (section: string, item: string, figure: string, value: CsvValue, currency = "") =>
    rows.push([section, item, figure, value, currency]);
  const count = (section: string, item: string, figure: string, f: ReportFigure) =>
    line(section, item, figure, f.count);
  const money = (section: string, item: string, amounts: readonly ReportAmount[]) => {
    for (const a of amounts) line(section, item, "amount", a.total, a.currency);
  };

  line("period", report.service.name, "from", report.from);
  line("period", report.service.name, "to", report.to);
  line("period", report.service.name, "timezone", report.timezone);
  for (const h of [report.headline, report.previous]) {
    const item = `${h.from} to ${h.to}`;
    line("headline", item, "runs", h.runs);
    line("headline", item, "done", h.done);
    line("headline", item, "failed", h.failed);
    line("headline", item, "finish_median_ms", h.finishMedianMs);
    line("headline", item, "wait_median_ms", h.waitMedianMs);
    line("headline", item, "approvals", h.approvals);
    line("headline", item, "changes", h.changes);
  }
  count("runs", "", "all", report.runs);
  for (const [k, f] of Object.entries(report.outcomes)) count("runs", "", k, f);
  for (const d of report.perDay) {
    for (const k of ["done", "waiting", "failed", "stopped", "going"] as const) {
      count("runs per day", d.day, k, d[k]);
    }
  }
  count("time to finish", "", "runs", report.timeToFinish.runs);
  line("time to finish", "", "median_ms", report.timeToFinish.medianMs);
  line("time to finish", "", "p90_ms", report.timeToFinish.p90Ms);
  const w = report.waitingOnPeople;
  line("waiting on people", "", "answered", w.answered);
  line("waiting on people", "", "open", w.open);
  line("waiting on people", "", "median_ms", w.medianMs);
  line("waiting on people", "", "p90_ms", w.p90Ms);
  line("waiting on people", "", "total_ms", w.totalMs);
  line("approvals", "", "signed", report.approvals.signed);
  line("approvals", "", "edited", report.approvals.edited);
  line("approvals", "", "turned_down", report.approvals.turnedDown);
  for (const p of report.approvals.byPerson) {
    const who = p.person?.name ?? (p.steppedIn ? "Mezonas" : "");
    line("approvals", who, "signed", p.signed);
    line("approvals", who, "edited", p.edited);
    line("approvals", who, "turned_down", p.turnedDown);
  }
  count("changes", "", "count", report.changes.total);
  money("changes", "", report.changes.amounts);
  for (const c of report.changes.byConnector) {
    line("changes", c.name, "count", c.count);
    money("changes", c.name, c.amounts);
    for (const e of c.entities) line("changes", `${c.name}: ${e.entity}`, "count", e.count);
  }
  for (const h of report.handled) {
    line("handled", h.kind, "records", h.records);
    line("handled", h.kind, "runs", h.runs);
    for (const t of h.top) {
      const name = [t.label, t.number].filter(Boolean).join(" ") || (t.id ?? "");
      line("handled", `${h.kind}: ${name}`, "runs", t.runs);
    }
  }
  for (const k of report.kpis) line("kpi", k.label, k.format, k.value, k.currency ?? "");
  if ("errors" in report) {
    for (const e of report.errors) line("errors", e.key, "count", e.count);
    const s = report.spend;
    line("cost", "", "runs", s.runs);
    line("cost", "", "cost_usd", s.costUsd, "USD");
    line("cost", "", "cost_per_run_usd", s.costPerRunUsd, "USD");
    line("cost", "", "tokens_in", s.tokensIn);
    line("cost", "", "tokens_out", s.tokensOut);
    line("cost", "", "tokens_per_run", s.tokensPerRun);
  }
  return rows;
}

/** `bill-clerk-report-2026-11-01-to-2026-11-22.csv`. */
function csvName(report: { service: { name: string }; from: string; to: string }): string {
  const slug =
    report.service.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "agent";
  return `${slug}-report-${report.from}-to-${report.to}.csv`;
}

function csvOf(report: PortalAgentReport | OpsAgentReport) {
  return {
    filename: csvName(report),
    contentType: CSV_TYPE,
    bytes: csvFile(REPORT_CSV_COLUMNS, reportCsvRows(report)),
  } as const;
}

// ── Routes ──────────────────────────────────────────────────────────────────────────────────────

export function agentReportRouteHandlers(app: Hono<AppEnv>): void {
  mount(app, agentReportRoutes.portalServiceReport, async (ctx) => {
    // §1.122: an agent off a limited client user's list is "not found", as another client's.
    ensureSeesAgent(ctx.agents, ctx.params.id);
    return portalReport(ctx.tx, ctx.services.platform, {
      tenantId: ctx.tenantIds[0] as string,
      serviceId: ctx.params.id,
      readerId: ctx.session.user.id,
      query: ctx.query,
    });
  });

  mountFile(app, agentReportRoutes.portalServiceReportCsv, async (ctx) => {
    ensureSeesAgent(ctx.agents, ctx.params.id);
    const report = await portalReport(ctx.tx, ctx.services.platform, {
      tenantId: ctx.tenantIds[0] as string,
      serviceId: ctx.params.id,
      readerId: ctx.session.user.id,
      query: ctx.query,
    });
    return csvOf(report);
  });

  mount(app, agentReportRoutes.opsAgentReport, async (ctx) =>
    opsReport(ctx.tx, ctx.services.platform, await opsAgentRow(ctx, ctx.params.id), ctx.query),
  );

  mountFile(app, agentReportRoutes.opsAgentReportCsv, async (ctx) => {
    const a = await opsAgentRow(ctx, ctx.params.id);
    return csvOf(await opsReport(ctx.tx, ctx.services.platform, a, ctx.query));
  });
}
