// The Pages report and one page in depth (M44, docs/plan.md §1.74), from the daily tables per page
// and per tracked element, and the visits' page lists (to say where readers came from and went
// next). Never from the raw events: the figures come out the same for a period whose events are
// past their 90 days.

import type { Tx } from "@countersign/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ENGAGED_BANDS } from "../schema";
import {
  halfReadTo,
  type MedianBand,
  medianBand,
  num,
  type PeriodQuery,
  periodQuery,
  rangeOut,
  rate,
  resolveRange,
  siteOf,
  small,
  sumArray,
  toCsv,
} from "./range";

export interface PageRow {
  path: string;
  views: number;
  entries: number;
  exits: number;
  /** Exits ÷ views. */
  exitRate: string | null;
  /** Visits that entered here and reached a goal. */
  goals: number;
  formSeen: number;
  medianEngaged: MedianBand | null;
  /** The furthest quarter (1–4) half the views reached; 0 when under half saw the first. */
  halfReadTo: number;
  smallSample: boolean;
}

type PageSums = {
  path: string;
  views: number;
  entries: number;
  exits: number;
  goals: number;
  form_seen: number;
  bands: number[];
  reach: number[];
};

const toRow = (p: PageSums): PageRow => {
  const views = num(p.views);
  const exits = num(p.exits);
  return {
    path: p.path,
    views,
    entries: num(p.entries),
    exits,
    exitRate: rate(exits, views),
    goals: num(p.goals),
    formSeen: num(p.form_seen),
    medianEngaged: medianBand(p.bands ?? []),
    halfReadTo: halfReadTo(views, (p.reach ?? []).map(num)),
    smallSample: small(views),
  };
};

async function pageSums(
  tx: Tx,
  tenantId: string,
  siteId: string,
  from: string,
  to: string,
  path?: string,
): Promise<PageSums[]> {
  const rows = await tx.execute<PageSums>(sql`
    select path, sum(views)::int as views, sum(entries)::int as entries,
           sum(exits)::int as exits, sum(goals)::int as goals, sum(form_seen)::int as form_seen,
           ${sumArray("engaged_bands", ENGAGED_BANDS)} as bands,
           ${sumArray("scroll_reached", 4)} as reach
    from site_daily_page
    where tenant_id = ${tenantId} and site_id = ${siteId} and day between ${from} and ${to}
      ${path === undefined ? sql`` : sql`and path = ${path}`}
    group by path order by 2 desc, 1`);
  return [...rows];
}

export async function pagesReport(tx: Tx, tenantId: string, today: string, q: PeriodQuery) {
  const r = await resolveRange(tx, tenantId, today, q);
  const rows = (await pageSums(tx, tenantId, siteOf(r), r.from, r.to)).map(toRow);
  return { ...rangeOut(r), pages: rows };
}

export function pagesCsv(report: Awaited<ReturnType<typeof pagesReport>>): string {
  return toCsv([
    [
      "path",
      "views",
      "entries",
      "exits",
      "exit_rate",
      "goals",
      "median_engaged_from_s",
      "median_engaged_to_s",
      "half_read_to_quarter",
    ],
    ...report.pages.map((p) => [
      p.path,
      p.views,
      p.entries,
      p.exits,
      p.exitRate,
      p.goals,
      p.medianEngaged?.fromSeconds,
      p.medianEngaged?.toSeconds,
      p.halfReadTo,
    ]),
  ]);
}

const PagePath = z
  .string()
  .regex(/^\/[^\s]{0,511}$/, "a page's path, starting with /")
  .max(512);
export const PageQuery = periodQuery({ path: PagePath });
export type PageQuery = z.output<typeof PageQuery>;

/** Where a page's readers came from, or went next: a source, a page, the goal, or away. */
export interface Flow {
  kind: "source" | "page" | "goal" | "left";
  key: string | null;
  visits: number;
}

export async function pageReport(tx: Tx, tenantId: string, today: string, q: PageQuery) {
  const r = await resolveRange(tx, tenantId, today, q);
  const siteId = siteOf(r);
  const [sums] = await pageSums(tx, tenantId, siteId, r.from, r.to, q.path);
  const clicks = await tx.execute<{ target: string; clicks: number; position: number }>(sql`
    select target, sum(clicks)::int as clicks,
           round(sum(position * clicks)::numeric / sum(clicks))::int as position
    from site_daily_click
    where tenant_id = ${tenantId} and site_id = ${siteId} and path = ${q.path}
      and day between ${r.from} and ${r.to}
    group by target order by 3, 1`);
  // Each time a visit read the page: the step before it (its source when it entered here) and
  // the step after (the next page, or the goal or leaving when it was the visit's last).
  const steps = sql`
    with v as (
           select pages, source_group, source_name, reached_goal from site_visit
           where tenant_id = ${tenantId} and site_id = ${siteId}
             and day between ${r.from} and ${r.to} and ${q.path} = any(pages)),
         steps as (
           select s.i::int as i, v.pages, v.source_group, v.source_name, v.reached_goal,
                  cardinality(v.pages) as n
           from v, unnest(v.pages) with ordinality as s(path, i)
           where s.path = ${q.path})`;
  const cameFrom = await tx.execute<{ kind: Flow["kind"]; key: string | null; visits: number }>(
    sql`${steps}
    select case when i = 1 then 'source' else 'page' end as kind,
           case when i = 1 then source_group || coalesce('/' || source_name, '')
                else pages[i - 1] end as key,
           count(*)::int as visits
    from steps group by 1, 2 order by 3 desc, 2 limit 20`,
  );
  const wentNext = await tx.execute<{ kind: Flow["kind"]; key: string | null; visits: number }>(
    sql`${steps}
    select case when i < n then 'page' when reached_goal then 'goal' else 'left' end as kind,
           case when i < n then pages[i + 1] end as key,
           count(*)::int as visits
    from steps group by 1, 2 order by 3 desc, 2 nulls first limit 20`,
  );
  const flow = (rows: Iterable<{ kind: Flow["kind"]; key: string | null; visits: number }>) =>
    [...rows].map((f) => ({ kind: f.kind, key: f.key, visits: num(f.visits) }));
  const views = num(sums?.views);
  const reach = (sums?.reach ?? [0, 0, 0, 0]).map(num);
  return {
    ...rangeOut(r),
    path: q.path,
    page: sums ? toRow(sums) : null,
    /** Views that reached each quarter of the page, and as a share of its views. */
    reach: reach.map((n, i) => ({ quarter: i + 1, views: n, share: rate(n, views) })),
    /** Views per engaged-time band (`ENGAGED_BAND_UPPER_SECONDS`, the last open-ended). */
    engaged: (sums?.bands ?? Array(ENGAGED_BANDS).fill(0)).map(num),
    clicks: [...clicks].map((c) => ({
      target: c.target,
      clicks: num(c.clicks),
      position: num(c.position),
    })),
    cameFrom: flow(cameFrom),
    wentNext: flow(wentNext),
  };
}

export function pageCsv(report: Awaited<ReturnType<typeof pageReport>>): string {
  return toCsv([
    ["section", "key", "count"],
    ...report.reach.map((q) => ["reached_quarter", q.quarter, q.views]),
    ...report.engaged.map((n, i) => ["engaged_band", i, n]),
    ...report.clicks.map((c) => ["click", c.target, c.clicks]),
    ...report.cameFrom.map((f) => [`came_from_${f.kind}`, f.key, f.visits]),
    ...report.wentNext.map((f) => [`went_next_${f.kind}`, f.key, f.visits]),
  ]);
}
