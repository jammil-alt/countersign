// The Journeys report (M44, docs/plan.md §1.74): how visits move through the site, from the visits'
// page lists (13 months). The most common paths, the path that leads to the goal most often, the
// pages visits leave from, the page a visit that reached the goal ended on, and the goal funnel by
// entry page: landed, saw a form, reached the goal.

import type { Tx } from "@countersign/db";
import { sql } from "drizzle-orm";
import {
  num,
  type PeriodQuery,
  rangeOut,
  rate,
  resolveRange,
  SMALL_SAMPLE,
  siteOf,
  small,
  toCsv,
} from "./range";

/** A path longer than this keeps its first pages and its last. */
export const JOURNEY_STEPS = 5;
/** How many paths are named before the rest are counted together. */
export const TOP_PATHS = 12;

export interface JourneyPath {
  pages: string[];
  /** It was longer: the pages between the first ones and the last are left out. */
  longer: boolean;
  visits: number;
  goals: number;
  goalRate: string | null;
  smallSample: boolean;
}

export async function journeysReport(tx: Tx, tenantId: string, today: string, q: PeriodQuery) {
  const r = await resolveRange(tx, tenantId, today, q);
  const siteId = siteOf(r);
  const visits = sql`select * from site_visit where tenant_id = ${tenantId}
    and site_id = ${siteId} and day between ${r.from} and ${r.to}`;
  const paths = await tx.execute<{
    pages: string[];
    longer: boolean;
    visits: number;
    goals: number;
  }>(sql`
    with keyed as (
      select case when cardinality(pages) <= ${JOURNEY_STEPS}::int then pages
                  else pages[1:${JOURNEY_STEPS - 1}::int] || pages[cardinality(pages)] end as key,
             cardinality(pages) > ${JOURNEY_STEPS}::int as longer, reached_goal
      from (${visits}) v)
    select to_json(key) as pages, longer, count(*)::int as visits,
           count(*) filter (where reached_goal)::int as goals
    from keyed group by key, longer
    order by 3 desc, 4 desc, cardinality(key), key::text`);
  const all: JourneyPath[] = [...paths].map((p) => ({
    pages: p.pages,
    longer: Boolean(p.longer),
    visits: num(p.visits),
    goals: num(p.goals),
    goalRate: rate(num(p.goals), num(p.visits)),
    smallSample: small(num(p.visits)),
  }));
  // DECISION: the best path is the one with the highest goal rate among paths of at least 20
  // visits (a small sample isn't a pattern); with none that large, the one with the most goals.
  const withGoals = all.filter((p) => p.goals > 0);
  const large = withGoals.filter((p) => !p.smallSample);
  const best =
    (large.length > 0
      ? [...large].sort((a, b) => Number(b.goalRate) - Number(a.goalRate) || b.visits - a.visits)
      : [...withGoals].sort((a, b) => b.goals - a.goals || b.visits - a.visits))[0] ?? null;

  const leaves = await tx.execute<{ path: string; visits: number; left: number }>(sql`
    with v as (${visits}),
         seen as (select p as path, count(*)::int as visits
                  from v, unnest(v.pages) as p group by p),
         left_from as (select exit_path as path, count(*)::int as n from v
                       where not reached_goal group by 1)
    select l.path, coalesce(s.visits, 0)::int as visits, l.n as left
    from left_from l left join seen s using (path)
    order by 3 desc, 1 limit 20`);
  const lastPage = await tx.execute<{ path: string; visits: number }>(sql`
    select exit_path as path, count(*)::int as visits from (${visits}) v
    where reached_goal group by 1 order by 2 desc, 1 limit 20`);
  const funnel = await tx.execute<{
    entry: string;
    landed: number;
    saw_form: number;
    goals: number;
  }>(sql`
    select entry_path as entry, count(*)::int as landed,
           count(*) filter (where saw_form or reached_goal)::int as saw_form,
           count(*) filter (where reached_goal)::int as goals
    from (${visits}) v group by 1 order by 2 desc, 1 limit 20`);
  const total = all.reduce((a, p) => a + p.visits, 0);
  const rest = all.slice(TOP_PATHS);
  return {
    ...rangeOut(r),
    visits: total,
    smallSample: total < SMALL_SAMPLE,
    paths: all.slice(0, TOP_PATHS),
    other: { paths: rest.length, visits: rest.reduce((a, p) => a + p.visits, 0) },
    best,
    /** Pages visits that didn't reach the goal left from: how many left, of the visits that read it. */
    leaves: [...leaves].map((l) => ({
      path: l.path,
      visits: num(l.visits),
      left: num(l.left),
      leftRate: rate(num(l.left), num(l.visits)),
    })),
    /** The page a visit that reached the goal ended on. */
    lastPage: [...lastPage].map((l) => ({ path: l.path, visits: num(l.visits) })),
    funnel: [...funnel].map((f) => ({
      entry: f.entry,
      landed: num(f.landed),
      sawForm: num(f.saw_form),
      goals: num(f.goals),
      goalRate: rate(num(f.goals), num(f.landed)),
      smallSample: small(num(f.landed)),
    })),
  };
}

export function journeysCsv(report: Awaited<ReturnType<typeof journeysReport>>): string {
  return toCsv([
    ["path", "longer", "visits", "goals"],
    ...report.paths.map((p) => [p.pages.join(" > "), p.longer ? "yes" : "no", p.visits, p.goals]),
  ]);
}
