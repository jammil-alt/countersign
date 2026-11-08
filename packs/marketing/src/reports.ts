// The pack's reports (`/api/reports/marketing/:report` for the portal, and per client in the back
// office): built from the daily totals only, never from a visit, so a report says nothing about
// any one visitor. Small samples and today's partial day are marked, not hidden.

import type { Tx } from "@countersign/db";
import { sql } from "drizzle-orm";
import { listSites, type SiteRow } from "./sites";

/** Fewer visits than this behind a figure: shown, and marked as a small sample. */
export const SMALL_SAMPLE = 20;
/** The overview's period: the last 28 finished days, against the 28 before. */
export const PERIOD_DAYS = 28;

export interface PeriodTotals {
  visits: number;
  views: number;
  goals: number;
  bounces: number;
  engagedMs: number;
  /** Goals ÷ visits, to 4 places, as a string; null with no visits. */
  goalRate: string | null;
  bounceRate: string | null;
  smallSample: boolean;
}

export interface Overview {
  sites: SiteRow[];
  period: { from: string; to: string };
  previous: { from: string; to: string };
  totals: PeriodTotals;
  previousTotals: PeriodTotals;
  daily: { day: string; visits: number; goals: number }[];
  pages: { path: string; views: number; entries: number; goals: number }[];
  sources: { source: string; visits: number; goals: number; smallSample: boolean }[];
  /** Requests not counted as visits in the period (filtered by heuristics). */
  filtered: number;
}

const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const rate = (n: number, of: number) => (of > 0 ? (n / of).toFixed(4) : null);

function totalsOf(row: Record<string, unknown> | undefined): PeriodTotals {
  const visits = Number(row?.visits ?? 0);
  const goals = Number(row?.goals ?? 0);
  const bounces = Number(row?.bounces ?? 0);
  return {
    visits,
    views: Number(row?.views ?? 0),
    goals,
    bounces,
    engagedMs: Number(row?.engaged_ms ?? 0),
    goalRate: rate(goals, visits),
    bounceRate: rate(bounces, visits),
    smallSample: visits < SMALL_SAMPLE,
  };
}

/** The overview of every site of one client, for the period ending yesterday (UTC). */
export async function overview(tx: Tx, tenantId: string, today: string): Promise<Overview> {
  const to = addDays(today, -1);
  const from = addDays(to, -(PERIOD_DAYS - 1));
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(PERIOD_DAYS - 1));
  const sum = async (a: string, b: string) =>
    [
      ...(await tx.execute(sql`
        select coalesce(sum(visits), 0)::int as visits, coalesce(sum(views), 0)::int as views,
               coalesce(sum(goals), 0)::int as goals, coalesce(sum(bounces), 0)::int as bounces,
               coalesce(sum(engaged_ms), 0)::bigint as engaged_ms
        from site_daily_total
        where tenant_id = ${tenantId} and dimension = 'all' and day between ${a} and ${b}`)),
    ][0] as Record<string, unknown> | undefined;

  const daily = await tx.execute<{ day: string; visits: number; goals: number }>(sql`
    select day::text as day, sum(visits)::int as visits, sum(goals)::int as goals
    from site_daily_total
    where tenant_id = ${tenantId} and dimension = 'all' and day between ${from} and ${to}
    group by day order by day`);
  const pages = await tx.execute<{
    path: string;
    views: number;
    entries: number;
    goals: number;
  }>(sql`
    select path, sum(views)::int as views, sum(entries)::int as entries, sum(goals)::int as goals
    from site_daily_page
    where tenant_id = ${tenantId} and day between ${from} and ${to}
    group by path order by 2 desc, 1 limit 10`);
  const sources = await tx.execute<{ source: string; visits: number; goals: number }>(sql`
    select key as source, sum(visits)::int as visits, sum(goals)::int as goals
    from site_daily_total
    where tenant_id = ${tenantId} and dimension = 'source' and day between ${from} and ${to}
    group by key order by 2 desc, 1 limit 10`);
  const [filtered] = await tx.execute<{ n: number }>(sql`
    select coalesce(sum(requests), 0)::int as n from site_bot_daily
    where tenant_id = ${tenantId} and day between ${from} and ${to}`);

  return {
    sites: await listSites(tx, tenantId),
    period: { from, to },
    previous: { from: prevFrom, to: prevTo },
    totals: totalsOf(await sum(from, to)),
    previousTotals: totalsOf(await sum(prevFrom, prevTo)),
    daily: [...daily].map((r) => ({ day: r.day, visits: r.visits, goals: r.goals })),
    pages: [...pages].map((r) => ({
      path: r.path,
      views: r.views,
      entries: r.entries,
      goals: r.goals,
    })),
    sources: [...sources].map((r) => ({
      source: r.source,
      visits: r.visits,
      goals: r.goals,
      smallSample: r.visits < SMALL_SAMPLE,
    })),
    filtered: filtered?.n ?? 0,
  };
}

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The overview's days as CSV: one row per day. */
export function overviewCsv(o: Overview): string {
  const rows = [["day", "visits", "goals"], ...o.daily.map((d) => [d.day, d.visits, d.goals])];
  return `${rows.map((r) => r.map(csvCell).join(",")).join("\n")}\n`;
}
