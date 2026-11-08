/**
 * The nightly build of a site's measurement (migration 0037; ported from Plenary Labs'
 * `apps/api/src/site/rollup.ts`): a finished day's events become its visits and daily totals, and
 * everything past its retention is deleted.
 *
 * A day is rebuilt whole, its rows deleted and inserted again in the client's transaction, so
 * running it twice, or late, gives the same rows. All of it is SQL over the day's `site_event`
 * rows, one round trip per table, always filtered by client and site as well as by RLS
 * (invariant 1).
 *
 * Known edge: a page view open across midnight UTC reports its engaged time under the next day's
 * visit hash, where it has no view to belong to, so that time is not counted.
 */

import { type Db, type Tx, tenant, tenantPack, withTenant } from "@countersign/db";
import { and, eq, type SQL, sql } from "drizzle-orm";
import { PACK_ID } from "../ids";
import {
  BOUNCE_ENGAGED_MS,
  ENGAGED_BAND_UPPER_SECONDS,
  SITE_EVENT_RETENTION_DAYS,
  SITE_VISIT_MAX_PAGES,
  SITE_VISIT_RETENTION_MONTHS,
  site,
} from "../schema";
import { utcDay } from "./events";

const DAY_TABLES = ["site_visit", "site_daily_page", "site_daily_click", "site_daily_total"];

/**
 * `array[count(*) filter (where … < 10000), …]`: one count per engaged-time band, in the order of
 * `ENGAGED_BAND_UPPER_SECONDS`, the last band open-ended. Built from our own constants only.
 */
export function bandCounts(column: string): string {
  const bounds = ENGAGED_BAND_UPPER_SECONDS.map((seconds) => seconds * 1000);
  const parts = bounds.map((upper, index) => {
    const lower = index === 0 ? null : bounds[index - 1];
    const where =
      lower === null ? `${column} < ${upper}` : `${column} >= ${lower} and ${column} < ${upper}`;
    return `count(*) filter (where ${where})::int`;
  });
  parts.push(`count(*) filter (where ${column} >= ${bounds[bounds.length - 1]})::int`);
  return `array[${parts.join(", ")}]`;
}

const raw = (text: string): SQL => sql.raw(text);

/** Rebuilds one finished day of one site. Returns how many visits it found. */
export async function buildDay(
  tx: Tx,
  input: { tenantId: string; siteId: string; day: string },
): Promise<number> {
  const { tenantId, siteId, day } = input;
  for (const table of DAY_TABLES) {
    await tx.execute(
      sql`delete from ${raw(table)} where tenant_id = ${tenantId} and site_id = ${siteId} and day = ${day}`,
    );
  }

  // One row per visit that had at least one page view. Its context (source, place, device) is
  // its first view's; its engaged time every report summed, capped at a day; its goal the first
  // click on one of the site's goals.
  await tx.execute(sql`
    with ev as (
           select * from site_event
           where tenant_id = ${tenantId} and site_id = ${siteId} and day = ${day}),
         goals as (select goals from site where tenant_id = ${tenantId} and id = ${siteId}),
         first_view as (
           select distinct on (visit) * from ev where kind = 'view' order by visit, at, id),
         last_view as (
           select distinct on (visit) visit, path from ev where kind = 'view'
           order by visit, at desc, id desc),
         pages as (
           select visit, (array_agg(path order by at, id))[1:${raw(String(SITE_VISIT_MAX_PAGES))}] as pages
           from ev where kind = 'view' group by visit),
         totals as (
           -- Kept 13 months, so a visit's times are kept to the hour, not the second.
           select visit, date_trunc('hour', min(at), 'UTC') as started_at,
                  date_trunc('hour', max(at), 'UTC') as ended_at,
                  count(*) filter (where kind = 'view')::int as views,
                  count(*) filter (where kind = 'click')::int as clicks,
                  least(coalesce(sum(engaged_ms) filter (where kind = 'engage'), 0), 86400000)::int
                    as engaged_ms,
                  bool_or(kind = 'form_seen') as saw_form,
                  (array_agg(target order by at, id)
                     filter (where kind = 'click'
                       and target = any(coalesce((select goals from goals), '{}'::text[]))))[1]
                    as goal
           from ev group by visit)
    insert into site_visit (tenant_id, site_id, day, visit, started_at, ended_at, entry_path,
                            exit_path, pages, views, clicks, engaged_ms, source_group, source_name,
                            referrer_host, utm_source, utm_medium, utm_campaign, utm_content,
                            country, region, city, time_zone, device, browser, os, language,
                            saw_form, reached_goal, goal, bounced)
    select ${tenantId}, ${siteId}, ${day}, t.visit, t.started_at, t.ended_at, f.path, l.path,
           p.pages, t.views, t.clicks, t.engaged_ms, f.source_group, f.source_name,
           f.referrer_host, f.utm_source, f.utm_medium, f.utm_campaign, f.utm_content, f.country,
           f.region, f.city, f.time_zone, f.device, f.browser, f.os, f.language, t.saw_form,
           t.goal is not null, t.goal,
           t.views = 1 and t.clicks = 0 and t.engaged_ms < ${raw(String(BOUNCE_ENGAGED_MS))}
             and t.goal is null
    from totals t
    join first_view f using (visit)
    join last_view l using (visit)
    join pages p using (visit)`);

  // Per page: its views, with each view's engaged time and furthest quarter; entries, exits and
  // goals from the visits just built.
  await tx.execute(sql`
    with per_view as (
           select view_id,
                  min(path) filter (where kind = 'view') as path,
                  coalesce(sum(engaged_ms) filter (where kind = 'engage'), 0)::bigint as engaged,
                  coalesce(max(scroll) filter (where kind = 'engage'), 0) as scroll,
                  bool_or(kind = 'form_seen') as seen
           from site_event
           where tenant_id = ${tenantId} and site_id = ${siteId} and day = ${day}
           group by view_id
           having bool_or(kind = 'view')),
         by_page as (
           select path, count(*)::int as views,
                  count(*) filter (where seen)::int as form_seen,
                  sum(engaged)::bigint as engaged_ms,
                  ${raw(bandCounts("engaged"))} as engaged_bands,
                  array[count(*) filter (where scroll >= 1)::int,
                        count(*) filter (where scroll >= 2)::int,
                        count(*) filter (where scroll >= 3)::int,
                        count(*) filter (where scroll >= 4)::int] as scroll_reached
           from per_view group by path),
         visits as (
           select entry_path, exit_path, reached_goal from site_visit
           where tenant_id = ${tenantId} and site_id = ${siteId} and day = ${day})
    insert into site_daily_page (tenant_id, site_id, day, path, views, entries, exits, goals,
                                 form_seen, engaged_ms, engaged_bands, scroll_reached)
    select ${tenantId}, ${siteId}, ${day}, b.path, b.views,
           (select count(*)::int from visits where entry_path = b.path),
           (select count(*)::int from visits where exit_path = b.path),
           (select count(*)::int from visits where entry_path = b.path and reached_goal),
           b.form_seen, b.engaged_ms, b.engaged_bands, b.scroll_reached
    from by_page b`);

  await tx.execute(sql`
    insert into site_daily_click (tenant_id, site_id, day, path, target, clicks, position)
    select ${tenantId}, ${siteId}, ${day}, path, target, count(*)::int,
           percentile_disc(0.5) within group (order by position)
    from site_event
    where tenant_id = ${tenantId} and site_id = ${siteId} and day = ${day} and kind = 'click'
    group by path, target`);

  // Visit totals, overall and by one dimension at a time. The `all` row is written even for a day
  // with no visits, so the job can tell a day it built from one it never reached.
  const totals = raw(`count(*)::int, coalesce(sum(views), 0)::int,
                      count(*) filter (where reached_goal)::int,
                      count(*) filter (where bounced)::int,
                      coalesce(sum(engaged_ms), 0)::bigint, ${bandCounts("engaged_ms")}`);
  const head = sql`${tenantId}::uuid, ${siteId}::uuid, ${day}::date`;
  await tx.execute(sql`
    with v as (
           select * from site_visit
           where tenant_id = ${tenantId} and site_id = ${siteId} and day = ${day})
    insert into site_daily_total (tenant_id, site_id, day, dimension, key, visits, views, goals,
                                  bounces, engaged_ms, engaged_bands)
    select ${head}, 'all', '', ${totals} from v
    union all
    select ${head}, 'source', source_group || coalesce('/' || source_name, ''), ${totals}
    from v group by source_group || coalesce('/' || source_name, '')
    union all
    select ${head}, 'country', coalesce(country, 'unknown'), ${totals}
    from v group by coalesce(country, 'unknown')
    union all
    select ${head}, 'device', device, ${totals} from v group by device
    union all
    select ${head}, 'entry', entry_path, ${totals} from v group by entry_path`);

  const [built] = await tx.execute<{ n: number }>(
    sql`select count(*)::int as n from site_visit
        where tenant_id = ${tenantId} and site_id = ${siteId} and day = ${day}`,
  );
  return built?.n ?? 0;
}

/**
 * The finished days of a site to build: the last three (rebuilt every night, which costs little
 * and absorbs a late report), and any older day still holding events that was never built.
 */
export async function daysToBuild(
  tx: Tx,
  input: { tenantId: string; siteId: string; today: string },
  limit = 30,
): Promise<string[]> {
  const { tenantId, siteId, today } = input;
  const rows = await tx.execute<{ day: string }>(sql`
    select distinct e.day::text as day
    from site_event e
    where e.tenant_id = ${tenantId} and e.site_id = ${siteId}
      and e.day < ${today}::date
      and (e.day >= ${today}::date - 3
           or not exists (select 1 from site_daily_total t
                          where t.tenant_id = e.tenant_id and t.site_id = e.site_id
                            and t.day = e.day and t.dimension = 'all'))
    order by 1
    limit ${limit}`);
  return [...rows].map((r) => r.day);
}

/**
 * Deletes one client's measurement past its retention: events after 90 days, visits after 13
 * months, and every salt whose day is over (no visit hash can be made again after that).
 */
export async function sweep(
  tx: Tx,
  tenantId: string,
  today: string,
): Promise<{ events: number; visits: number; salts: number }> {
  const n = async (q: SQL) => {
    const rows = await tx.execute<{ n: number }>(
      sql`with gone as (${q} returning 1) select count(*)::int as n from gone`,
    );
    return [...rows][0]?.n ?? 0;
  };
  return {
    events: await n(sql`delete from site_event where tenant_id = ${tenantId}
      and day < ${today}::date - ${SITE_EVENT_RETENTION_DAYS}::int`),
    visits: await n(sql`delete from site_visit where tenant_id = ${tenantId}
      and day < (${today}::date - make_interval(months => ${SITE_VISIT_RETENTION_MONTHS}::int))::date`),
    salts: await n(
      sql`delete from site_salt where tenant_id = ${tenantId} and day < ${today}::date`,
    ),
  };
}

export interface NightlyResult {
  clients: number;
  built: { tenantId: string; siteId: string; day: string; visits: number }[];
  swept: { events: number; visits: number; salts: number };
}

/**
 * The nightly pass over every client with the pack on: build each site's finished days, then
 * sweep. One transaction per client, so one client's failure never holds up another's (the
 * caller reports it). The build runs before the sweep, so the oldest day's events are read
 * before they can be deleted.
 */
export async function nightly(
  db: Db,
  now: Date,
  onError: (tenantId: string, error: unknown) => void = () => {},
): Promise<NightlyResult> {
  const today = utcDay(now);
  const clients = await db.select({ id: tenant.id }).from(tenant);
  const result: NightlyResult = {
    clients: 0,
    built: [],
    swept: { events: 0, visits: 0, salts: 0 },
  };
  for (const client of clients) {
    try {
      await withTenant(db, client.id, async (tx) => {
        const [on] = await tx
          .select({ pack: tenantPack.pack })
          .from(tenantPack)
          .where(and(eq(tenantPack.tenantId, client.id), eq(tenantPack.pack, PACK_ID)));
        if (!on) return;
        result.clients += 1;
        const sites = await tx
          .select({ id: site.id })
          .from(site)
          .where(eq(site.tenantId, client.id));
        for (const s of sites) {
          for (const day of await daysToBuild(tx, { tenantId: client.id, siteId: s.id, today })) {
            const visits = await buildDay(tx, { tenantId: client.id, siteId: s.id, day });
            result.built.push({ tenantId: client.id, siteId: s.id, day, visits });
          }
        }
        const swept = await sweep(tx, client.id, today);
        result.swept.events += swept.events;
        result.swept.visits += swept.visits;
        result.swept.salts += swept.salts;
      });
    } catch (error) {
      onError(client.id, error);
    }
  }
  return result;
}
