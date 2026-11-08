// The Sources report (M44, docs/plan.md §1.74): where visits came from, grouped (direct, search,
// social, referral, campaign) with each group's names, against the period before; one campaign
// by its links (`utm_content`) and landing pages; one referring site in depth. Totals from the
// daily totals by source; a campaign's and a referrer's detail from the visits (13 months), and a
// referrer's addresses from the raw events, which are kept 90 days (the report says so).

import type { Tx } from "@countersign/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ENGAGED_BANDS, SITE_EVENT_RETENTION_DAYS } from "../schema";
import { SOURCE_GROUPS } from "./events";
import {
  addDays,
  type MedianBand,
  medianBand,
  num,
  periodQuery,
  rangeOut,
  rate,
  resolveRange,
  siteOf,
  small,
  sourceParts,
  toCsv,
} from "./range";

const Name = z.string().trim().min(1).max(200);
export const SourcesQuery = periodQuery({
  /** One source group's names only. */
  group: z.enum(SOURCE_GROUPS).optional(),
  /** One campaign in depth (`utm_campaign`, the source's name). */
  campaign: Name.optional(),
  /** One referring site in depth (its host, without `www.`). */
  referrer: Name.optional(),
});
export type SourcesQuery = z.output<typeof SourcesQuery>;

export interface SourceRow {
  key: string;
  group: string;
  name: string | null;
  visits: number;
  previousVisits: number;
  goals: number;
  goalRate: string | null;
  bounces: number;
  bounceRate: string | null;
  medianEngaged: MedianBand | null;
  smallSample: boolean;
}

export async function sourcesReport(tx: Tx, tenantId: string, today: string, q: SourcesQuery) {
  const r = await resolveRange(tx, tenantId, today, q);
  const siteId = siteOf(r);
  const rows = await tx.execute<{
    key: string;
    visits: number;
    previous_visits: number;
    goals: number;
    bounces: number;
    bands: number[];
  }>(sql`
    select key, coalesce(sum(visits) filter (where day >= ${r.from}::date), 0)::int as visits,
           coalesce(sum(visits) filter (where day <= ${r.previous.to}::date), 0)::int
             as previous_visits,
           coalesce(sum(goals) filter (where day >= ${r.from}::date), 0)::int as goals,
           coalesce(sum(bounces) filter (where day >= ${r.from}::date), 0)::int as bounces,
           to_json(array[${sql.join(
             Array.from(
               { length: ENGAGED_BANDS },
               (_, i) =>
                 sql`coalesce(sum(engaged_bands[${sql.raw(String(i + 1))}]) filter (where day >= ${r.from}::date), 0)::int`,
             ),
             sql`, `,
           )}]) as bands
    from site_daily_total
    where tenant_id = ${tenantId} and site_id = ${siteId} and dimension = 'source'
      and day between ${r.previous.from} and ${r.to}
    group by key order by 2 desc, 3 desc, 1`);
  const named = [...rows]
    .map((s) => {
      const { group, name } = sourceParts(s.key);
      const visits = num(s.visits);
      const goals = num(s.goals);
      const bounces = num(s.bounces);
      const row: SourceRow = {
        key: s.key,
        group,
        name,
        visits,
        previousVisits: num(s.previous_visits),
        goals,
        goalRate: rate(goals, visits),
        bounces,
        bounceRate: rate(bounces, visits),
        medianEngaged: medianBand(s.bands ?? []),
        smallSample: small(visits),
      };
      return { row, bands: (s.bands ?? []).map(num) };
    })
    .filter(
      ({ row }) =>
        (row.visits > 0 || row.previousVisits > 0) && (!q.group || row.group === q.group),
    );
  const sources = named.map((n) => n.row);

  // The groups, each the sum of its names; a group's median band needs its names' bands summed.
  const byGroup = new Map<string, { row: SourceRow; bands: number[] }>();
  for (const { row: s, bands } of named) {
    const g = byGroup.get(s.group) ?? {
      row: { ...s, key: s.group, name: null, visits: 0, previousVisits: 0, goals: 0, bounces: 0 },
      bands: Array(ENGAGED_BANDS).fill(0),
    };
    g.row.visits += s.visits;
    g.row.previousVisits += s.previousVisits;
    g.row.goals += s.goals;
    g.row.bounces += s.bounces;
    g.bands = g.bands.map((n, b) => n + (bands[b] ?? 0));
    byGroup.set(s.group, g);
  }
  const groups = [...byGroup.values()]
    .map(({ row, bands }) => ({
      ...row,
      goalRate: rate(row.goals, row.visits),
      bounceRate: rate(row.bounces, row.visits),
      medianEngaged: medianBand(bands),
      smallSample: small(row.visits),
      names: sources.filter((s) => s.group === row.group),
    }))
    .sort((a, b) => b.visits - a.visits || a.group.localeCompare(b.group));

  return {
    ...rangeOut(r),
    groups,
    campaign: q.campaign ? await campaignOf(tx, tenantId, siteId, r, q.campaign) : null,
    referrer: q.referrer ? await referrerOf(tx, tenantId, siteId, r, today, q.referrer) : null,
  };
}

type Range = Awaited<ReturnType<typeof resolveRange>>;

/** One campaign: its days, and its links by `utm_content` and landing page. */
async function campaignOf(tx: Tx, tenantId: string, siteId: string, r: Range, name: string) {
  const where = sql`tenant_id = ${tenantId} and site_id = ${siteId}
    and source_group = 'campaign' and source_name = ${name}`;
  const [tags] = await tx.execute<{ utm_source: string | null; utm_medium: string | null }>(sql`
    select mode() within group (order by utm_source) as utm_source,
           mode() within group (order by utm_medium) as utm_medium
    from site_visit where ${where} and day between ${r.from} and ${r.to}`);
  const days = await tx.execute<{ day: string; visits: number; goals: number }>(sql`
    select day::text as day, count(*)::int as visits,
           count(*) filter (where reached_goal)::int as goals
    from site_visit where ${where} and day between ${r.from} and ${r.to}
    group by day order by day`);
  const links = await tx.execute<{
    content: string | null;
    path: string;
    visits: number;
    goals: number;
    bounces: number;
  }>(sql`
    select utm_content as content, entry_path as path, count(*)::int as visits,
           count(*) filter (where reached_goal)::int as goals,
           count(*) filter (where bounced)::int as bounces
    from site_visit where ${where} and day between ${r.from} and ${r.to}
    group by utm_content, entry_path order by 3 desc, 1 nulls last, 2`);
  const linkRows = [...links].map((l) => ({
    content: l.content,
    path: l.path,
    visits: num(l.visits),
    goals: num(l.goals),
    goalRate: rate(num(l.goals), num(l.visits)),
    bounceRate: rate(num(l.bounces), num(l.visits)),
    smallSample: small(num(l.visits)),
  }));
  const visits = linkRows.reduce((a, l) => a + l.visits, 0);
  const goals = linkRows.reduce((a, l) => a + l.goals, 0);
  return {
    name,
    utmSource: tags?.utm_source ?? null,
    utmMedium: tags?.utm_medium ?? null,
    visits,
    goals,
    goalRate: rate(goals, visits),
    smallSample: small(visits),
    days: [...days].map((d) => ({ day: d.day, visits: num(d.visits), goals: num(d.goals) })),
    links: linkRows,
  };
}

/** One referring site, read against the whole site. */
async function referrerOf(
  tx: Tx,
  tenantId: string,
  siteId: string,
  r: Range,
  today: string,
  host: string,
) {
  const bare = host.toLowerCase().replace(/^www\./, "");
  const where = sql`tenant_id = ${tenantId} and site_id = ${siteId} and referrer_host = ${bare}
    and day between ${r.from} and ${r.to}`;
  const [totals] = await tx.execute<{
    group: string | null;
    visits: number;
    goals: number;
    bounces: number;
  }>(sql`
    select mode() within group (order by source_group) as "group", count(*)::int as visits,
           count(*) filter (where reached_goal)::int as goals,
           count(*) filter (where bounced)::int as bounces
    from site_visit where ${where}`);
  const landed = await tx.execute<{ path: string; visits: number; goals: number }>(sql`
    select entry_path as path, count(*)::int as visits,
           count(*) filter (where reached_goal)::int as goals
    from site_visit where ${where} group by 1 order by 2 desc, 1 limit 20`);
  // Where on the referring site: the entering view's referrer path, from the raw events only.
  const eventsFrom = addDays(today, -SITE_EVENT_RETENTION_DAYS);
  const addresses = await tx.execute<{ path: string | null; visits: number }>(sql`
    with entries as (
      select distinct on (day, visit) referrer_path from site_event
      where tenant_id = ${tenantId} and site_id = ${siteId} and kind = 'view'
        and referrer_host = ${bare}
        and day between ${r.from > eventsFrom ? r.from : eventsFrom} and ${r.to}
      order by day, visit, at, id)
    select referrer_path as path, count(*)::int as visits from entries
    group by 1 order by 2 desc, 1 nulls last limit 20`);
  const [site] = await tx.execute<{ visits: number; goals: number; bounces: number }>(sql`
    select coalesce(sum(visits), 0)::int as visits, coalesce(sum(goals), 0)::int as goals,
           coalesce(sum(bounces), 0)::int as bounces
    from site_daily_total
    where tenant_id = ${tenantId} and site_id = ${siteId} and dimension = 'all'
      and day between ${r.from} and ${r.to}`);
  const visits = num(totals?.visits);
  return {
    host: bare,
    group: totals?.group ?? null,
    visits,
    goals: num(totals?.goals),
    goalRate: rate(num(totals?.goals), visits),
    bounceRate: rate(num(totals?.bounces), visits),
    smallSample: small(visits),
    site: {
      visits: num(site?.visits),
      goalRate: rate(num(site?.goals), num(site?.visits)),
      bounceRate: rate(num(site?.bounces), num(site?.visits)),
    },
    landedOn: [...landed].map((l) => ({
      path: l.path,
      visits: num(l.visits),
      goals: num(l.goals),
    })),
    /** The referring site's own pages, kept 90 days (raw events). */
    addresses: [...addresses].map((a) => ({ path: a.path, visits: num(a.visits) })),
    addressesFrom: r.from > eventsFrom ? r.from : eventsFrom,
  };
}

export function sourcesCsv(report: Awaited<ReturnType<typeof sourcesReport>>): string {
  return toCsv([
    ["group", "name", "visits", "previous_visits", "goals", "bounces"],
    ...report.groups.flatMap((g) =>
      g.names.map((s) => [s.group, s.name, s.visits, s.previousVisits, s.goals, s.bounces]),
    ),
  ]);
}
