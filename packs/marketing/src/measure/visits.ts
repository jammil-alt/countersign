// The Visits report and one visit's timeline (M44, docs/plan.md §1.74): the visits behind a number,
// filtered by source, entry page, a page read, country and goal, fifty to a page; and one visit as
// the steps it took. A visit is shown by its day, never its time of day, and a day's visits are
// listed in the order of their hash, which is random: nothing here can be set beside anything else
// a visitor did at a known time. A visit's steps come from the raw events, kept 90 days; after
// that its summary is all there is.

import type { Tx } from "@countersign/db";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { QueryDay } from "../pack";
import { SOURCE_GROUPS } from "./events";
import { num, periodQuery, rangeOut, resolveRange, siteOf, small, toCsv } from "./range";

/** How many visits one page of the list shows. */
export const VISITS_PAGE = 50;

const PathParam = z.string().regex(/^\/[^\s]{0,511}$/, "a page's path, starting with /");
export const VisitsQuery = periodQuery({
  /** One day only, inside the range. */
  day: QueryDay.optional(),
  /** A source group, or `group/name` (a daily total's source key). */
  source: z
    .string()
    .max(250)
    .refine((s) => (SOURCE_GROUPS as readonly string[]).includes(s.split("/")[0] ?? ""), {
      message: "a source group, or group/name",
    })
    .optional(),
  entry: PathParam.optional(),
  /** A page the visit read. */
  path: PathParam.optional(),
  country: z
    .string()
    .regex(/^([A-Z]{2}|unknown)$/)
    .optional(),
  goal: z.enum(["yes", "no"]).optional(),
  /** The page of the list, from 1. */
  page: z
    .string()
    .regex(/^[1-9]\d{0,3}$/, "a page number")
    .optional(),
});
export type VisitsQuery = z.output<typeof VisitsQuery>;

export interface VisitRow {
  day: string;
  visit: string;
  entryPath: string;
  exitPath: string;
  pages: string[];
  views: number;
  engagedMs: number;
  source: string;
  sourceGroup: string;
  sourceName: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  device: string;
  reachedGoal: boolean;
  goal: string | null;
  bounced: boolean;
}

type VisitSql = {
  day: string;
  visit: string;
  entry_path: string;
  exit_path: string;
  pages: string[];
  views: number;
  engaged_ms: number;
  source_group: string;
  source_name: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  device: string;
  reached_goal: boolean;
  goal: string | null;
  bounced: boolean;
};

const COLUMNS = sql.raw(`day::text as day, visit, entry_path, exit_path, to_json(pages) as pages,
  views, engaged_ms, source_group, source_name, country, region, city, device, reached_goal, goal,
  bounced`);

const visitRow = (v: VisitSql): VisitRow => ({
  day: v.day,
  visit: v.visit,
  entryPath: v.entry_path,
  exitPath: v.exit_path,
  pages: v.pages,
  views: num(v.views),
  engagedMs: num(v.engaged_ms),
  source: v.source_group + (v.source_name ? `/${v.source_name}` : ""),
  sourceGroup: v.source_group,
  sourceName: v.source_name,
  country: v.country,
  region: v.region,
  city: v.city,
  device: v.device,
  reachedGoal: Boolean(v.reached_goal),
  goal: v.goal,
  bounced: Boolean(v.bounced),
});

export async function visitsReport(tx: Tx, tenantId: string, today: string, q: VisitsQuery) {
  const r = await resolveRange(tx, tenantId, today, q);
  const where: SQL[] = [
    sql`tenant_id = ${tenantId}`,
    sql`site_id = ${siteOf(r)}`,
    q.day ? sql`day = ${q.day}` : sql`day between ${r.from} and ${r.to}`,
  ];
  if (q.source) {
    const slash = q.source.indexOf("/");
    if (slash < 0) where.push(sql`source_group = ${q.source}`);
    else {
      where.push(sql`source_group = ${q.source.slice(0, slash)}`);
      where.push(sql`source_name = ${q.source.slice(slash + 1)}`);
    }
  }
  if (q.entry) where.push(sql`entry_path = ${q.entry}`);
  if (q.path) where.push(sql`${q.path} = any(pages)`);
  if (q.country) {
    where.push(q.country === "unknown" ? sql`country is null` : sql`country = ${q.country}`);
  }
  if (q.goal) where.push(sql`reached_goal = ${q.goal === "yes"}`);
  const clause = sql.join(where, sql` and `);
  const page = Number(q.page ?? "1");
  const rows = await tx.execute<VisitSql>(sql`
    select ${COLUMNS} from site_visit where ${clause}
    order by day desc, visit limit ${VISITS_PAGE} offset ${(page - 1) * VISITS_PAGE}`);
  const [total] = await tx.execute<{ n: number; goals: number }>(sql`
    select count(*)::int as n, count(*) filter (where reached_goal)::int as goals
    from site_visit where ${clause}`);
  const n = num(total?.n);
  return {
    ...rangeOut(r),
    day: q.day ?? null,
    total: n,
    goals: num(total?.goals),
    smallSample: small(n),
    page,
    pageSize: VISITS_PAGE,
    pages: Math.max(1, Math.ceil(n / VISITS_PAGE)),
    visits: [...rows].map(visitRow),
  };
}

export function visitsCsv(report: Awaited<ReturnType<typeof visitsReport>>): string {
  return toCsv([
    ["day", "entry", "pages", "engaged_ms", "source", "country", "device", "goal"],
    ...report.visits.map((v) => [
      v.day,
      v.entryPath,
      v.views,
      v.engagedMs,
      v.source,
      v.country,
      v.device,
      v.goal,
    ]),
  ]);
}

export const VisitQuery = z.strictObject({
  site: z.uuid().optional(),
  day: QueryDay,
  visit: z.string().regex(/^[0-9a-f]{32}$/, "a visit, 32 hex"),
});
export type VisitQuery = z.output<typeof VisitQuery>;

export interface VisitStep {
  kind: "view" | "click" | "form_seen";
  path: string;
  /** A view's engaged time and the furthest quarter it reached. */
  engagedMs: number | null;
  scroll: number | null;
  /** A click's tracked element and where it sits (% of the page's height). */
  target: string | null;
  position: number | null;
  /** The click was on one of the site's goals. */
  goal: boolean;
  form: string | null;
}

/** One visit and its steps, or `visit: null` when the site has no such visit that day. */
export async function visitReport(tx: Tx, tenantId: string, today: string, q: VisitQuery) {
  const r = await resolveRange(tx, tenantId, today, { site: q.site, from: q.day, to: q.day });
  const siteId = siteOf(r);
  const [row] = await tx.execute<
    VisitSql & {
      browser: string | null;
      os: string | null;
      language: string | null;
      referrer_host: string | null;
      utm_campaign: string | null;
      utm_content: string | null;
      clicks: number;
      saw_form: boolean;
    }
  >(sql`
    select ${COLUMNS}, browser, os, language, referrer_host, utm_campaign, utm_content, clicks,
           saw_form
    from site_visit
    where tenant_id = ${tenantId} and site_id = ${siteId} and day = ${q.day}
      and visit = ${q.visit}`);
  const base = { site: r.site, sites: r.sites, day: q.day };
  if (!row) return { ...base, visit: null, steps: null };
  // A view's engagement reports fold into the view; clicks and forms are steps of their own. The
  // order is the events' order; no time is given.
  const events = await tx.execute<{
    kind: VisitStep["kind"];
    path: string;
    engaged_ms: number | null;
    scroll: number | null;
    target: string | null;
    position: number | null;
    form: string | null;
  }>(sql`
    with e as (select * from site_event
               where tenant_id = ${tenantId} and site_id = ${siteId} and day = ${q.day}
                 and visit = ${q.visit}),
         engaged as (select view_id, sum(engaged_ms)::int as engaged_ms, max(scroll)::int as scroll
                     from e where kind = 'engage' group by view_id)
    select e.kind, e.path,
           case when e.kind = 'view' then coalesce(g.engaged_ms, 0) end as engaged_ms,
           case when e.kind = 'view' then coalesce(g.scroll, 0) end as scroll,
           e.target, e.position, e.form
    from e left join engaged g on g.view_id = e.view_id and e.kind = 'view'
    where e.kind <> 'engage'
    order by e.at, e.id`);
  const goals = new Set(r.site?.goals ?? []);
  const steps: VisitStep[] = [...events].map((e) => ({
    kind: e.kind,
    path: e.path,
    engagedMs: e.engaged_ms === null ? null : num(e.engaged_ms),
    scroll: e.scroll === null ? null : num(e.scroll),
    target: e.target,
    position: e.position === null ? null : num(e.position),
    goal: e.kind === "click" && e.target !== null && goals.has(e.target),
    form: e.form,
  }));
  return {
    ...base,
    visit: {
      ...visitRow(row),
      browser: row.browser,
      os: row.os,
      language: row.language,
      referrerHost: row.referrer_host,
      utmCampaign: row.utm_campaign,
      utmContent: row.utm_content,
      clicks: num(row.clicks),
      sawForm: Boolean(row.saw_form),
    },
    /** Null once the visit's events are past their 90 days. */
    steps: steps.length > 0 ? steps : null,
  };
}

export function visitCsv(report: Awaited<ReturnType<typeof visitReport>>): string {
  return toCsv([
    ["step", "kind", "path", "engaged_ms", "scroll_quarter", "target", "form"],
    ...(report.steps ?? []).map((s, i) => [
      i + 1,
      s.kind,
      s.path,
      s.engagedMs,
      s.scroll,
      s.target,
      s.form,
    ]),
  ]);
}
