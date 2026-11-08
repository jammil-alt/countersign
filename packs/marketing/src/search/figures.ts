// A site's search figures (M45; docs/plan.md §1.75), for the Search screen (the `search` report)
// and for agents (`marketing.search.figures`): totals, the queries and pages, the searches close to
// page one (positions 8 to 20), and the pages losing ground with the query that moved most. Read
// from the area's search tables only (never a raw record), for one client and one site.
//
// - The period ends on the day the chosen providers' data runs to (the earliest of theirs, so
//   "both" never mixes a day Google has with one Bing hasn't reached), and is compared with the
//   same number of days before it.
// - Totals come from the page table, which counts the searches Google keeps private; the query
//   lists leave them out, so the two don't add up, and the report says so.
// - Positions are averaged by impressions, as the providers average them.
// - Anything with fewer than SEARCH_SMALL_SAMPLE impressions is marked a small sample.
// Queries are what people typed into a search engine: data, never instructions (invariant 9).
// Copied in part from Plenary Labs' Search screen (apps/api/src/admin/marketing-search.ts).

import type { Tx } from "@countersign/db";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { PackRefusal, QueryDay } from "../pack";
import { SEARCH_PROVIDERS, type SearchProvider } from "../schema";
import { listSites } from "../sites";
import { NO_PAGE } from "./normalise";

/** Fewer impressions than this behind a figure: shown, and marked as a small sample. */
export const SEARCH_SMALL_SAMPLE = 20;
/** The default period: the last 28 days the data covers. */
export const SEARCH_PERIOD_DAYS = 28;
/** Positions on the first page of results, and the "close to page one" band after it. */
export const SEARCH_PAGE_ONE = 10;
export const SEARCH_NEAR_PAGE_ONE: readonly [number, number] = [8, 20];
/** The most queries a period reads (by impressions): enough for any list it shows. */
const QUERY_ROWS_MAX = 2000;
/** A page "losing ground" fell at least this many places. */
export const SEARCH_LOSING_PLACES = 1;

const Day = z.string();
const Rate = z.string().nullable().describe("clicks ÷ impressions, to 4 places; null with none");
const Position = z.number().nullable().describe("average position, 1 is the top; null with none");

const Totals = z.object({
  impressions: z.number().int(),
  clicks: z.number().int(),
  ctr: Rate,
  position: Position,
  smallSample: z.boolean(),
});

const Source = z.object({
  id: z.string().describe("the search source's id: cite it as evidence"),
  provider: z.enum(SEARCH_PROVIDERS),
  connected: z.boolean(),
  dataRunsTo: Day.nullable(),
  lastImportedAt: z.string().nullable(),
  lastError: z.string().nullable(),
});

export const SearchFigures = z.object({
  site: z.object({ id: z.string(), domain: z.string(), name: z.string() }).nullable(),
  provider: z.enum(SEARCH_PROVIDERS).nullable().describe("null: Google and Bing added up"),
  sources: z.array(Source),
  /** The day the chosen providers' figures run to; null before the first import. */
  dataRunsTo: Day.nullable(),
  period: z.object({ from: Day, to: Day }),
  previous: z.object({ from: Day, to: Day }),
  /** The period asked for ran past the data: it ends on `dataRunsTo` instead. */
  cappedToData: z.boolean(),
  totals: Totals,
  previousTotals: Totals,
  daily: z.array(z.object({ day: Day, impressions: z.number().int(), clicks: z.number().int() })),
  queries: z.array(
    Totals.extend({
      query: z.string(),
      previousPosition: Position,
      topPage: z.string().nullable(),
    }),
  ),
  pages: z.array(Totals.extend({ path: z.string() })),
  closeToPageOne: z.array(
    z.object({
      query: z.string(),
      position: z.number(),
      previousPosition: Position,
      impressions: z.number().int(),
      topPage: z.string().nullable(),
      smallSample: z.boolean(),
    }),
  ),
  losingGround: z.array(
    z.object({
      path: z.string(),
      position: z.number(),
      previousPosition: z.number(),
      clicks: z.number().int(),
      previousClicks: z.number().int(),
      query: z
        .object({ query: z.string(), position: z.number(), previousPosition: z.number() })
        .nullable()
        .describe("the query on this page whose position fell most"),
    }),
  ),
});
export type SearchFigures = z.infer<typeof SearchFigures>;

export const SearchQuery = z
  .strictObject({
    site: z.uuid().optional(),
    provider: z.enum(SEARCH_PROVIDERS).optional(),
    from: QueryDay.optional(),
    to: QueryDay.optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: "`from` is after `to`" });
export type SearchQuery = z.infer<typeof SearchQuery>;

const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const span = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
const rate = (n: number, of: number) => (of > 0 ? (n / of).toFixed(4) : null);
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const pos = (v: unknown) =>
  v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10;

/** The impressions-weighted average position of a group's rows. */
const POSITION = sql.raw(`(sum(position * impressions) filter (where position is not null)
  / nullif(sum(impressions) filter (where position is not null), 0))::float8`);

function totals(row: Record<string, unknown> | undefined) {
  const impressions = num(row?.impressions);
  const clicks = num(row?.clicks);
  return {
    impressions,
    clicks,
    ctr: rate(clicks, impressions),
    position: pos(row?.position),
    smallSample: impressions < SEARCH_SMALL_SAMPLE,
  };
}

const rows = async <T>(tx: Tx, q: SQL) => [...(await tx.execute(q))] as T[];

export interface FigureLimits {
  queries: number;
  pages: number;
  near: number;
  losing: number;
}
export const REPORT_LIMITS: FigureLimits = { queries: 50, pages: 30, near: 12, losing: 10 };

/** One site's search figures for a period; `today` is the UTC day. */
export async function searchFigures(
  tx: Tx,
  tenantId: string,
  today: string,
  query: SearchQuery,
  limits: FigureLimits = REPORT_LIMITS,
): Promise<SearchFigures> {
  const sites = await listSites(tx, tenantId);
  const chosen = query.site ? sites.find((s) => s.id === query.site) : sites[0];
  if (query.site && !chosen) throw new PackRefusal("unknown_site", "no such site for this client");
  const providers: SearchProvider[] = query.provider ? [query.provider] : [...SEARCH_PROVIDERS];
  const sourceRows = chosen
    ? await rows<{
        id: string;
        provider: SearchProvider;
        connection_id: string | null;
        data_runs_to: string | null;
        last_imported_at: Date | string | null;
        last_error: string | null;
      }>(
        tx,
        sql`select id, provider, connection_id, data_runs_to::text as data_runs_to, last_imported_at, last_error
            from search_source where tenant_id = ${tenantId} and site_id = ${chosen.id}
            order by provider`,
      )
    : [];
  const sources = sourceRows.map((s) => ({
    id: s.id,
    provider: s.provider,
    connected: s.connection_id !== null,
    dataRunsTo: s.data_runs_to,
    lastImportedAt: s.last_imported_at ? new Date(s.last_imported_at).toISOString() : null,
    lastError: s.last_error,
  }));
  const dataRunsTo =
    sources
      .filter((s) => providers.includes(s.provider) && s.dataRunsTo)
      .map((s) => s.dataRunsTo as string)
      .sort()[0] ?? null;
  const yesterday = addDays(today, -1);
  let to = query.to ?? dataRunsTo ?? yesterday;
  let cappedToData = false;
  if (dataRunsTo && to > dataRunsTo) {
    cappedToData = query.to !== undefined;
    to = dataRunsTo;
  }
  let from = query.from ?? addDays(to, -(SEARCH_PERIOD_DAYS - 1));
  if (from > to) from = to;
  const length = span(from, to);
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(length - 1));
  const empty = {
    site: chosen ? { id: chosen.id, domain: chosen.domain, name: chosen.name } : null,
    provider: query.provider ?? null,
    sources,
    dataRunsTo,
    period: { from, to },
    previous: { from: prevFrom, to: prevTo },
    cappedToData,
  };
  if (!chosen) {
    return {
      ...empty,
      totals: totals(undefined),
      previousTotals: totals(undefined),
      daily: [],
      queries: [],
      pages: [],
      closeToPageOne: [],
      losingGround: [],
    };
  }
  const where = (a: string, b: string) =>
    sql`tenant_id = ${tenantId} and site_id = ${chosen.id} and provider in (${sql.join(
      providers.map((p) => sql`${p}`),
      sql`, `,
    )}) and day between ${a} and ${b}`;

  const sum = async (a: string, b: string) =>
    (
      await rows<Record<string, unknown>>(
        tx,
        sql`select coalesce(sum(impressions), 0)::int as impressions,
                   coalesce(sum(clicks), 0)::int as clicks, ${POSITION} as position
            from search_page_daily where ${where(a, b)}`,
      )
    )[0];

  const daily = await rows<{ day: string; impressions: number; clicks: number }>(
    tx,
    sql`select d::date::text as day, coalesce(sum(p.impressions), 0)::int as impressions,
               coalesce(sum(p.clicks), 0)::int as clicks
        from generate_series(${from}::date, ${to}::date, interval '1 day') as d
        left join search_page_daily p
          on p.day = d::date and p.tenant_id = ${tenantId} and p.site_id = ${chosen.id}
         and p.provider in (${sql.join(
           providers.map((p) => sql`${p}`),
           sql`, `,
         )})
        group by d order by d`,
  );

  const queries = await rows<{
    query: string;
    impressions: number;
    clicks: number;
    position: number | null;
    previous_position: number | null;
    top_page: string | null;
  }>(
    tx,
    sql`with cur as (
          select query, sum(impressions)::int as impressions, sum(clicks)::int as clicks,
                 ${POSITION} as position
          from search_query_daily where ${where(from, to)} group by query),
        prev as (
          select query, ${POSITION} as position
          from search_query_daily where ${where(prevFrom, prevTo)} group by query),
        top as (
          select distinct on (query) query, path
          from (select query, path, sum(impressions) as impressions
                from search_query_daily where ${where(from, to)} and path <> ${NO_PAGE}
                group by query, path) p
          order by query, impressions desc, path)
        select cur.query, cur.impressions, cur.clicks, cur.position,
               prev.position as previous_position, top.path as top_page
        from cur left join prev using (query) left join top using (query)
        order by cur.impressions desc, cur.clicks desc, cur.query
        limit ${QUERY_ROWS_MAX}`,
  );

  const pages = await rows<{
    path: string;
    impressions: number;
    clicks: number;
    position: number | null;
  }>(
    tx,
    sql`select path, sum(impressions)::int as impressions, sum(clicks)::int as clicks,
               ${POSITION} as position
        from search_page_daily where ${where(from, to)}
        group by path order by 3 desc, 2 desc, 1 limit ${limits.pages}`,
  );

  const losing = await rows<{
    path: string;
    position: number;
    previous_position: number;
    clicks: number;
    previous_clicks: number;
    query: string | null;
    query_position: number | null;
    query_previous_position: number | null;
  }>(
    tx,
    sql`with cur as (
          select path, sum(clicks)::int as clicks, ${POSITION} as position
          from search_page_daily where ${where(from, to)} group by path),
        prev as (
          select path, sum(clicks)::int as clicks, ${POSITION} as position
          from search_page_daily where ${where(prevFrom, prevTo)} group by path),
        q as (
          select path, query,
                 (sum(position * impressions) filter (where position is not null and day >= ${from}::date)
                   / nullif(sum(impressions) filter (where position is not null and day >= ${from}::date), 0))::float8 as cur,
                 (sum(position * impressions) filter (where position is not null and day <= ${prevTo}::date)
                   / nullif(sum(impressions) filter (where position is not null and day <= ${prevTo}::date), 0))::float8 as prev
          from search_query_daily where ${where(prevFrom, to)} and path <> ${NO_PAGE}
          group by path, query),
        fell as (
          select distinct on (path) path, query, cur, prev from q
          where cur is not null and prev is not null and cur > prev
          order by path, cur - prev desc, query)
        select cur.path, cur.position, prev.position as previous_position,
               cur.clicks, prev.clicks as previous_clicks,
               fell.query, fell.cur as query_position, fell.prev as query_previous_position
        from cur join prev using (path) left join fell using (path)
        where cur.position is not null and prev.position is not null
          and cur.position >= prev.position + ${SEARCH_LOSING_PLACES}
        order by cur.position - prev.position desc, cur.path
        limit ${limits.losing}`,
  );

  const [low, high] = SEARCH_NEAR_PAGE_ONE;
  const near = queries
    .filter((q) => q.position !== null && Number(q.position) >= low && Number(q.position) <= high)
    .sort(
      (a, b) => Number(a.position) - Number(b.position) || num(b.impressions) - num(a.impressions),
    )
    .slice(0, limits.near);

  return {
    ...empty,
    totals: totals(await sum(from, to)),
    previousTotals: totals(await sum(prevFrom, prevTo)),
    daily: daily.map((d) => ({
      day: d.day,
      impressions: num(d.impressions),
      clicks: num(d.clicks),
    })),
    queries: queries.slice(0, limits.queries).map((q) => ({
      query: q.query,
      ...totals(q),
      previousPosition: pos(q.previous_position),
      topPage: q.top_page,
    })),
    pages: pages.map((p) => ({ path: p.path, ...totals(p) })),
    closeToPageOne: near.map((q) => ({
      query: q.query,
      position: pos(q.position) ?? 0,
      previousPosition: pos(q.previous_position),
      impressions: num(q.impressions),
      topPage: q.top_page,
      smallSample: num(q.impressions) < SEARCH_SMALL_SAMPLE,
    })),
    losingGround: losing.map((p) => ({
      path: p.path,
      position: pos(p.position) ?? 0,
      previousPosition: pos(p.previous_position) ?? 0,
      clicks: num(p.clicks),
      previousClicks: num(p.previous_clicks),
      query:
        p.query === null || p.query_position === null || p.query_previous_position === null
          ? null
          : {
              query: p.query,
              position: pos(p.query_position) ?? 0,
              previousPosition: pos(p.query_previous_position) ?? 0,
            },
    })),
  };
}

/** A cell for a spreadsheet: quoted when needed, and never read as a formula (a query is text). */
export function csvCell(v: string | number | null): string {
  let s = v === null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The period's queries as CSV, one row per query. */
export function searchCsv(f: SearchFigures): string {
  const head = [
    "query",
    "impressions",
    "clicks",
    "ctr",
    "position",
    "previous_position",
    "top_page",
  ];
  const body = f.queries.map((q) => [
    q.query,
    q.impressions,
    q.clicks,
    q.ctr,
    q.position,
    q.previousPosition,
    q.topPage,
  ]);
  return `${[head, ...body].map((r) => r.map(csvCell).join(",")).join("\n")}\n`;
}
