// The Audience report (M44, docs/plan.md §1.74): where visitors are (country, then a country's
// regions, then a region's cities), when they read (day of the week by hour, in the client's own
// time zone), and on what (device, browser, operating system, language), from the visits. A visit's
// start is kept to the hour, so the hours are as fine as anything here goes.

import type { Tx } from "@countersign/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { num, periodQuery, rangeOut, rate, resolveRange, siteOf, small, toCsv } from "./range";

export const AudienceQuery = periodQuery({
  /** A country's regions (ISO 3166 alpha-2, as the visits keep it, or `unknown`). */
  country: z
    .string()
    .regex(/^([A-Z]{2}|unknown)$/, "a two-letter country code")
    .optional(),
  /** A region's cities (with `country`). */
  region: z.string().trim().min(1).max(120).optional(),
});
export type AudienceQuery = z.output<typeof AudienceQuery>;

export interface PlaceRow {
  key: string | null;
  visits: number;
  goals: number;
  goalRate: string | null;
  bounceRate: string | null;
  /** The visits' median engaged time, to the second. */
  medianEngagedMs: number | null;
  smallSample: boolean;
}

const BREAKDOWNS = ["device", "browser", "os", "language"] as const;

export async function audienceReport(tx: Tx, tenantId: string, today: string, q: AudienceQuery) {
  const r = await resolveRange(tx, tenantId, today, q);
  const siteId = siteOf(r);
  const where = sql`tenant_id = ${tenantId} and site_id = ${siteId}
    and day between ${r.from} and ${r.to}`;
  const unknown = (v: string) => (v === "unknown" ? null : v);
  // The level shown: countries, a country's regions, or a region's cities.
  const level = q.country ? (q.region ? "city" : "region") : "country";
  const column = sql.raw(level);
  const narrow = q.country
    ? sql`and country is not distinct from ${unknown(q.country)}
          ${q.region ? sql`and region is not distinct from ${unknown(q.region)}` : sql``}`
    : sql``;
  const places = await tx.execute<{
    key: string | null;
    visits: number;
    goals: number;
    bounces: number;
    median: number | null;
  }>(sql`
    select ${column} as key, count(*)::int as visits,
           count(*) filter (where reached_goal)::int as goals,
           count(*) filter (where bounced)::int as bounces,
           percentile_cont(0.5) within group (order by engaged_ms) as median
    from site_visit where ${where} ${narrow}
    group by 1 order by 2 desc, 1 nulls last limit 200`);

  // DECISION: day by hour in the client's own time zone (tenant.timezone), as its schedules are;
  // one Postgres doesn't know reads as UTC rather than failing.
  const [zone] = await tx.execute<{ name: string }>(sql`
    select coalesce(z.name, 'UTC') as name
    from tenant t left join pg_timezone_names z on z.name = t.timezone
    where t.id = ${tenantId}`);
  const timeZone = zone?.name ?? "UTC";
  const hours = await tx.execute<{ dow: number; hour: number; visits: number }>(sql`
    with zoned as (
      select started_at at time zone ${timeZone} as local from site_visit where ${where})
    select (extract(isodow from local)::int - 1) as dow, extract(hour from local)::int as hour,
           count(*)::int as visits
    from zoned group by 1, 2`);
  const heatmap = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const h of hours) {
    const row = heatmap[num(h.dow)];
    if (row) row[num(h.hour)] = num(h.visits);
  }

  const breakdowns: Record<(typeof BREAKDOWNS)[number], PlaceRow[]> = {
    device: [],
    browser: [],
    os: [],
    language: [],
  };
  for (const b of BREAKDOWNS) {
    const rows = await tx.execute<{
      key: string | null;
      visits: number;
      goals: number;
      bounces: number;
      median: number | null;
    }>(sql`
      select ${sql.raw(b)} as key, count(*)::int as visits,
             count(*) filter (where reached_goal)::int as goals,
             count(*) filter (where bounced)::int as bounces,
             percentile_cont(0.5) within group (order by engaged_ms) as median
      from site_visit where ${where}
      group by 1 order by 2 desc, 1 nulls last limit 30`);
    breakdowns[b] = [...rows].map(placeRow);
  }

  return {
    ...rangeOut(r),
    level,
    country: q.country ?? null,
    region: q.region ?? null,
    places: [...places].map(placeRow),
    timeZone,
    /** Visits by day of the week (Monday first) and hour, in `timeZone`. */
    heatmap,
    ...breakdowns,
  };
}

function placeRow(p: {
  key: string | null;
  visits: number;
  goals: number;
  bounces: number;
  median: number | null;
}): PlaceRow {
  const visits = num(p.visits);
  return {
    key: p.key,
    visits,
    goals: num(p.goals),
    goalRate: rate(num(p.goals), visits),
    bounceRate: rate(num(p.bounces), visits),
    medianEngagedMs: p.median === null ? null : Math.round(Number(p.median)),
    smallSample: small(visits),
  };
}

export function audienceCsv(report: Awaited<ReturnType<typeof audienceReport>>): string {
  return toCsv([
    [report.level, "visits", "goals", "median_engaged_ms"],
    ...report.places.map((p) => [p.key ?? "unknown", p.visits, p.goals, p.medianEngagedMs]),
  ]);
}
