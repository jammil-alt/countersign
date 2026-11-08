// The pack's overview report (`/api/reports/marketing/overview` for the portal from M50, and per
// client in the back office): built from the daily totals only, never from a visit, so it says
// nothing about any one visitor. One site at a time (the query's, else the client's first); the
// last 28 finished days by default, against as many days before. Small samples and days the
// nightly build hasn't reached are marked, not hidden. The other read reports are in ./measure.

import type { Tx } from "@countersign/db";
import { sql } from "drizzle-orm";
import {
  DEFAULT_PERIOD_DAYS,
  type MedianBand,
  medianBand,
  num,
  type PeriodQuery,
  rangeOut,
  rate,
  resolveRange,
  SMALL_SAMPLE,
  siteOf,
  small,
  sumArray,
  toCsv,
} from "./measure/range";
import { ENGAGED_BANDS } from "./schema";
import type { SiteRow } from "./sites";

export { SMALL_SAMPLE };
/** The overview's default period: the last 28 finished days, against the 28 before. */
export const PERIOD_DAYS = DEFAULT_PERIOD_DAYS;

export interface PeriodTotals {
  visits: number;
  views: number;
  goals: number;
  bounces: number;
  engagedMs: number;
  /** Goals ÷ visits, to 4 places, as a string; null with no visits. */
  goalRate: string | null;
  bounceRate: string | null;
  /** The band a visit's median engaged time falls in. */
  medianEngaged: MedianBand | null;
  smallSample: boolean;
}

export interface Overview extends ReturnType<typeof rangeOut> {
  sites: SiteRow[];
  period: { from: string; to: string };
  previous: { from: string; to: string };
  totals: PeriodTotals;
  previousTotals: PeriodTotals;
  /** Every day of the range; `built` false for a day the nightly build hasn't reached (today). */
  daily: { day: string; visits: number; goals: number; built: boolean }[];
  pages: { path: string; views: number; entries: number; goals: number; smallSample: boolean }[];
  sources: {
    source: string;
    group: string;
    name: string | null;
    visits: number;
    goals: number;
    smallSample: boolean;
  }[];
  /** Requests not counted as visits in the period (filtered by heuristics). */
  filtered: number;
}

function totalsOf(row: Record<string, unknown> | undefined): PeriodTotals {
  const visits = num(row?.visits);
  const goals = num(row?.goals);
  const bounces = num(row?.bounces);
  return {
    visits,
    views: num(row?.views),
    goals,
    bounces,
    engagedMs: num(row?.engaged_ms),
    goalRate: rate(goals, visits),
    bounceRate: rate(bounces, visits),
    medianEngaged: medianBand((row?.bands as number[] | undefined) ?? []),
    smallSample: small(visits),
  };
}

/** The overview of one of a client's sites for a period (by default the 28 days to yesterday). */
export async function overview(
  tx: Tx,
  tenantId: string,
  today: string,
  query: PeriodQuery = {},
): Promise<Overview> {
  const r = await resolveRange(tx, tenantId, today, query);
  const siteId = siteOf(r);
  const { from, to } = r;
  const sum = async (a: string, b: string) =>
    [
      ...(await tx.execute(sql`
        select coalesce(sum(visits), 0)::int as visits, coalesce(sum(views), 0)::int as views,
               coalesce(sum(goals), 0)::int as goals, coalesce(sum(bounces), 0)::int as bounces,
               coalesce(sum(engaged_ms), 0)::bigint as engaged_ms,
               ${sumArray("engaged_bands", ENGAGED_BANDS)} as bands
        from site_daily_total
        where tenant_id = ${tenantId} and site_id = ${siteId} and dimension = 'all'
          and day between ${a} and ${b}`)),
    ][0] as Record<string, unknown> | undefined;

  const daily = await tx.execute<{ day: string; visits: number; goals: number; built: boolean }>(
    sql`
    select d::date::text as day, coalesce(t.visits, 0)::int as visits,
           coalesce(t.goals, 0)::int as goals, t.day is not null as built
    from generate_series(${from}::date, ${to}::date, interval '1 day') as d
    left join site_daily_total t
      on t.tenant_id = ${tenantId} and t.site_id = ${siteId} and t.dimension = 'all'
     and t.day = d::date
    order by 1`,
  );
  const pages = await tx.execute<{
    path: string;
    views: number;
    entries: number;
    goals: number;
  }>(sql`
    select path, sum(views)::int as views, sum(entries)::int as entries, sum(goals)::int as goals
    from site_daily_page
    where tenant_id = ${tenantId} and site_id = ${siteId} and day between ${from} and ${to}
    group by path order by 2 desc, 1 limit 10`);
  const sources = await tx.execute<{ source: string; visits: number; goals: number }>(sql`
    select key as source, sum(visits)::int as visits, sum(goals)::int as goals
    from site_daily_total
    where tenant_id = ${tenantId} and site_id = ${siteId} and dimension = 'source'
      and day between ${from} and ${to}
    group by key order by 2 desc, 1 limit 10`);
  const [filtered] = await tx.execute<{ n: number }>(sql`
    select coalesce(sum(requests), 0)::int as n from site_bot_daily
    where tenant_id = ${tenantId} and site_id = ${siteId} and day between ${from} and ${to}`);

  return {
    ...rangeOut(r),
    period: { from, to },
    previous: r.previous,
    totals: totalsOf(await sum(from, to)),
    previousTotals: totalsOf(await sum(r.previous.from, r.previous.to)),
    daily: [...daily].map((d) => ({
      day: d.day,
      visits: num(d.visits),
      goals: num(d.goals),
      built: Boolean(d.built),
    })),
    pages: [...pages].map((p) => ({
      path: p.path,
      views: num(p.views),
      entries: num(p.entries),
      goals: num(p.goals),
      smallSample: small(num(p.views)),
    })),
    sources: [...sources].map((s) => {
      const slash = s.source.indexOf("/");
      return {
        source: s.source,
        group: slash < 0 ? s.source : s.source.slice(0, slash),
        name: slash < 0 ? null : s.source.slice(slash + 1),
        visits: num(s.visits),
        goals: num(s.goals),
        smallSample: small(num(s.visits)),
      };
    }),
    filtered: num(filtered?.n),
  };
}

/** The overview's days as CSV: one row per day. */
export function overviewCsv(o: Overview): string {
  return toCsv([
    ["day", "visits", "goals", "built"],
    ...o.daily.map((d) => [d.day, d.visits, d.goals, d.built ? "yes" : "no"]),
  ]);
}
