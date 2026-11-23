// R5: a report per account, and every account side by side (docs/reporting-plan.md §3 R5,
// docs/plan.md §1.235). The portal's `GET /api/reports/account`, the back office's
// `GET /api/ops/clients/:id/report` (each with its CSV) and `GET /api/ops/accounts`. The portal's
// answer is its own schema, without Needs us, cost or errors (invariant 11), for the one client of
// the session; the back office's are for the clients the operator serves (`ensureClient`, RLS).

import {
  accountReportRoutes,
  billingPeriod,
  type OpsAccountReport,
  type OpsAccountRow,
  type PortalAccountReport,
  readTenantBilling,
  utcDayOf,
} from "@countersign/core";
import { agent, narrowToTenant, type Tx, tenant } from "@countersign/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import { creditsMonth } from "../billing/credits-out";
import {
  type BillingConfig,
  loadBillingConfig,
  loadPricing,
  monthFor,
  type Pricing,
  tenantBilling,
} from "../billing/ledger";
import { CSV_TYPE, type CsvValue, csvFile } from "../exports/csv";
import { type AppEnv, ensureClient, mount, mountFile, notFound, type Services } from "../http";
import { tenantRow } from "../notify/people";
import type { Platform } from "../platform";
import { accountReport, needsUsOf } from "../runs/account-report";
import { reportPeriods } from "../runs/agent-report";
import { REPORT_CSV_COLUMNS } from "./agent-report";
import { needsUs, needsUsContext } from "./command-center";
import { checkRange, isService, todayIn } from "./usage";

type Query = { from?: string | undefined; to?: string | undefined };
type TenantRow = typeof tenant.$inferSelect;
type Usage = PortalAccountReport["usage"];

const usageOf = (period: string, used: number, included: number): NonNullable<Usage> => ({
  period,
  used,
  included,
  share: included > 0 ? used / included : null,
});

/**
 * The back office's usage: the month's credits against the allowance the month will have, as the
 * credits check that pauses agents reads them (`creditsMonth`). Null when not set up for billing.
 */
// DECISION: the back office reads the projected allowance (the month's included credits if the
// agents active now stay active), the figure that pauses a client, so "over 80%" warns before the
// pause. The portal reads its Billing page's month so far: the client sees one set of numbers.
async function opsUsage(
  tx: Tx,
  t: TenantRow,
  billing: { config: BillingConfig; pricing: Pricing },
  now: Date,
): Promise<Usage> {
  if (!readTenantBilling(t.settings)) return null;
  const m = await creditsMonth(tx, { tenantId: t.id, at: now, settings: t.settings, ...billing });
  return usageOf(m.period, m.used, m.included);
}

/** The portal's usage: its Billing page's month so far, for a client admin only. */
async function portalUsage(tx: Tx, tenantId: string, now: Date): Promise<Usage> {
  const t = await tenantBilling(tx, tenantId);
  if (!t?.billing) return null;
  const through = utcDayOf(now);
  const period = billingPeriod(through).start;
  const config = await loadBillingConfig(tx);
  const { built } = await monthFor(tx, { tenantId, period, through, config, billing: t.billing });
  return usageOf(period, built.creditsUsed, built.creditsIncluded);
}

/** The clients' services: `isService` for several clients at once. */
const services = (tx: Tx, tenantIds: readonly string[]) =>
  tx
    .select({ tenantId: agent.tenantId })
    .from(agent)
    .where(
      and(
        inArray(agent.tenantId, [...tenantIds]),
        eq(agent.kind, "client"),
        eq(agent.testCopy, false),
        inArray(agent.runStatus, ["active", "paused", "retired"]),
      ),
    );

async function report(
  tx: Tx,
  platform: Platform,
  input: {
    surface: "portal" | "ops";
    t: TenantRow;
    query: Query;
    usage: Usage;
    lines: boolean;
    now: Date;
  },
) {
  const periods = reportPeriods(input.query, todayIn(input.t.timezone, input.now));
  checkRange(periods.from, periods.to);
  const agents = input.lines
    ? await tx.select().from(agent).where(isService(input.t.id)).orderBy(agent.slug)
    : [];
  return accountReport(tx, platform, {
    surface: input.surface,
    client: { id: input.t.id, name: input.t.name, timezone: input.t.timezone },
    agents,
    ...periods,
    usage: input.usage,
    now: input.now,
  });
}

/** The client's own report, for the session's one client. */
async function portalReport(
  tx: Tx,
  platform: Platform,
  input: { tenantId: string; admin: boolean; query: Query },
): Promise<PortalAccountReport> {
  const t = await tenantRow(tx, input.tenantId);
  if (!t) throw notFound("client");
  const now = new Date();
  // DECISION: usage is billing, which only a client admin sees (`GET /api/billing`).
  const usage = input.admin ? await portalUsage(tx, t.id, now) : null;
  return (await report(tx, platform, {
    surface: "portal",
    t,
    query: input.query,
    usage,
    lines: true,
    now,
  })) as PortalAccountReport;
}

/** The back office's report for one client it serves. */
async function opsReport(
  tx: Tx,
  svc: Services,
  tenantId: string,
  query: Query,
): Promise<OpsAccountReport> {
  const { platform } = svc;
  const t = await tenantRow(tx, tenantId);
  if (!t) throw notFound("client");
  const now = new Date();
  // Pricing reads the platform's templates, which only the operator's scope sees: before narrowing.
  const config = await loadBillingConfig(tx);
  const usage = await opsUsage(tx, t, { config, pricing: await loadPricing(tx, tx, config) }, now);
  // DECISION: the figures are read under the one client's scope, as R4's report is.
  const body = await narrowToTenant(tx, tenantId, (one) =>
    report(one, platform, { surface: "ops", t, query, usage, lines: true, now }),
  );
  // S4.6 (D5): Home's Needs us for this client, read under the operator's scope as Home reads it.
  const escalations = await needsUs(tx, [tenantId], now, needsUsContext(svc));
  return { ...body, needsUs: needsUsOf(escalations, tenantId) } as OpsAccountReport;
}

/** Every client the operator serves (not retired), side by side; those that need us first. */
async function opsAccounts(
  tx: Tx,
  svc: Services,
  tenantIds: readonly string[],
  query: Query,
): Promise<OpsAccountRow[]> {
  if (tenantIds.length === 0) return [];
  const { platform } = svc;
  const now = new Date();
  // S4.6 (D5): Home's Needs us, once for every client served, then per client.
  const escalations = await needsUs(tx, tenantIds, now, needsUsContext(svc));
  const [clients, agents, config] = await Promise.all([
    tx
      .select()
      .from(tenant)
      .where(and(inArray(tenant.id, [...tenantIds]), isNull(tenant.retiredAt))),
    services(tx, tenantIds),
    loadBillingConfig(tx),
  ]);
  const pricing = await loadPricing(tx, tx, config);
  // DECISION: each client's figures are asked at once in the request's transaction, which the
  // driver pipelines (as the command center does); every query names its client.
  const rows = await Promise.all(
    clients.map(async (t) => {
      const usage = await opsUsage(tx, t, { config, pricing }, now);
      const body = await report(tx, platform, {
        surface: "ops",
        t,
        query,
        usage,
        lines: false,
        now,
      });
      return {
        ...body,
        agents: agents.filter((a) => a.tenantId === t.id).length,
        needsUs: needsUsOf(escalations, t.id),
      } as OpsAccountRow;
    }),
  );
  return rows.sort(
    (a, b) =>
      Number(b.needsUs.length > 0) - Number(a.needsUs.length > 0) ||
      a.client.name.localeCompare(b.client.name),
  );
}

// ── CSV ─────────────────────────────────────────────────────────────────────────────────────────

/** One line per figure, in R4's columns: what it is, of what, and its value. */
export function accountCsvRows(
  report: PortalAccountReport | OpsAccountReport,
): (readonly CsvValue[])[] {
  const rows: (readonly CsvValue[])[] = [];
  const line = (section: string, item: string, figure: string, value: CsvValue, currency = "") =>
    rows.push([section, item, figure, value, currency]);
  const name = report.client.name;
  line("period", name, "from", report.from);
  line("period", name, "to", report.to);
  line("period", name, "timezone", report.timezone);
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
  for (const a of report.agents) {
    const h = a.headline;
    line("agent", a.service.name, "runs", h.runs);
    line("agent", a.service.name, "done", h.done);
    line("agent", a.service.name, "failed", h.failed);
    line("agent", a.service.name, "waiting_now", a.waiting.count);
    line("agent", a.service.name, "finish_median_ms", h.finishMedianMs);
    line("agent", a.service.name, "wait_median_ms", h.waitMedianMs);
    line("agent", a.service.name, "approvals", h.approvals);
    line("agent", a.service.name, "changes", h.changes);
    line("agent", a.service.name, "runs_before", a.previous.runs);
  }
  line("waiting now", "", "runs", report.waiting.runs.count);
  line("waiting now", "", "items", report.waiting.items);
  line("waiting now", "", "over_a_day", report.waiting.overdue);
  line("waiting now", "", "oldest_since", report.waiting.oldestSince);
  line("failed not looked at", "", "runs", report.failedUnseen.count);
  line("failed not looked at", "", "oldest_since", report.failedUnseen.oldestSince);
  for (const c of report.connections) line("connections", c.name, c.attention, c.since);
  if (report.usage) {
    line("usage", report.usage.period, "credits_used", report.usage.used);
    line("usage", report.usage.period, "credits_included", report.usage.included);
  }
  if ("needsUs" in report) {
    for (const r of report.needsUs) line("needs us", "", r, "yes");
  }
  return rows;
}

function csvOf(report: PortalAccountReport | OpsAccountReport) {
  const slug =
    report.client.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "account";
  return {
    filename: `${slug}-account-report-${report.from}-to-${report.to}.csv`,
    contentType: CSV_TYPE,
    bytes: csvFile(REPORT_CSV_COLUMNS, accountCsvRows(report)),
  } as const;
}

// ── Routes ──────────────────────────────────────────────────────────────────────────────────────

export function accountReportRouteHandlers(app: Hono<AppEnv>): void {
  mount(app, accountReportRoutes.portalAccountReport, async (ctx) =>
    portalReport(ctx.tx, ctx.services.platform, {
      tenantId: ctx.tenantIds[0] as string,
      admin: ctx.role === "client_admin",
      query: ctx.query,
    }),
  );

  mountFile(app, accountReportRoutes.portalAccountReportCsv, async (ctx) =>
    csvOf(
      await portalReport(ctx.tx, ctx.services.platform, {
        tenantId: ctx.tenantIds[0] as string,
        admin: ctx.role === "client_admin",
        query: ctx.query,
      }),
    ),
  );

  mount(app, accountReportRoutes.opsClientReport, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return opsReport(ctx.tx, ctx.services, ctx.params.id, ctx.query);
  });

  mountFile(app, accountReportRoutes.opsClientReportCsv, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return csvOf(await opsReport(ctx.tx, ctx.services, ctx.params.id, ctx.query));
  });

  mount(app, accountReportRoutes.opsAccounts, async (ctx) => ({
    accounts: await opsAccounts(ctx.tx, ctx.services, ctx.tenantIds, ctx.query),
  }));
}
