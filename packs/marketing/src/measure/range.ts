// What every read report shares (M44, docs/plan.md §1.74): which site and which days a query
// means, the period before it, how far the nightly build has got, and the small helpers that turn
// sums into rates, medians and CSV. Reports read the site tables only, always filtered by client
// and site as well as by RLS (invariant 1).
//
// A period is 7, 28 or 90 finished days ending yesterday (UTC); `from` and `to` override it. Today
// is never built until the night after, so a range that reaches today says so (`includesToday`),
// and `dataThrough` is the last day the nightly build finished, so a screen can mark days that are
// still to come rather than show them as quiet.

import type { Tx } from "@countersign/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { siteRangeQuery } from "../pack";
import { ENGAGED_BAND_UPPER_SECONDS, ENGAGED_BANDS } from "../schema";
import { listSites, type SiteRow } from "../sites";

/** Fewer visits (or views) than this behind a figure: shown, and marked as a small sample. */
export const SMALL_SAMPLE = 20;
export const PERIODS = ["7", "28", "90"] as const;
export const DEFAULT_PERIOD_DAYS = 28;
/** The longest range a query may ask for: a visit is kept 13 months. */
export const MAX_RANGE_DAYS = 400;

/** The site-and-days query, plus `period` (7, 28 or 90) and a report's own parameters. */
export function periodQuery<T extends z.ZodRawShape>(extra: T = {} as T) {
  return siteRangeQuery({ period: z.enum(PERIODS).optional(), ...extra });
}
export const PeriodQuery = periodQuery();
export type PeriodQuery = z.output<typeof PeriodQuery>;

export interface ReportRange {
  /** The site the report is about; null when the client has none, or asked for one it hasn't. */
  site: SiteRow | null;
  sites: SiteRow[];
  /** The period asked for (7, 28, 90); null when `from` and `to` set the days. */
  period: number | null;
  from: string;
  to: string;
  days: number;
  previous: { from: string; to: string };
  today: string;
  /** The range reaches today, which is not built until tonight: its figures are partial. */
  includesToday: boolean;
  /** The last day of the range the nightly build has finished; null before the first. */
  dataThrough: string | null;
}

export const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

// DECISION: a site the query names that isn't this client's reads as no site (empty figures),
// not an error: the same answer as a client with no site yet, and it says nothing about others'.
/** Matches no site: what a report's queries filter by when there is no site to report on. */
export const NO_SITE = "00000000-0000-0000-0000-000000000000";

export async function resolveRange(
  tx: Tx,
  tenantId: string,
  today: string,
  q: {
    site?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    period?: string | undefined;
  },
): Promise<ReportRange> {
  const sites = await listSites(tx, tenantId);
  const site = q.site ? (sites.find((s) => s.id === q.site) ?? null) : (sites[0] ?? null);
  const explicit = Boolean(q.from || q.to);
  const period = explicit ? null : Number(q.period ?? DEFAULT_PERIOD_DAYS);
  const span = period ?? Number(q.period ?? DEFAULT_PERIOD_DAYS);
  const yesterday = addDays(today, -1);
  let to = yesterday;
  if (q.to) to = q.to;
  else if (q.from) {
    // From a day on: the period's length, or up to yesterday, whichever comes first.
    const end = addDays(q.from, span - 1);
    to = end < yesterday ? end : yesterday < q.from ? q.from : yesterday;
  }
  let from = q.from ?? addDays(to, -(span - 1));
  if (daysBetween(from, to) > MAX_RANGE_DAYS) from = addDays(to, -(MAX_RANGE_DAYS - 1));
  const days = daysBetween(from, to);
  const prevTo = addDays(from, -1);
  const [built] = await tx.execute<{ day: string | null }>(sql`
    select max(day)::text as day from site_daily_total
    where tenant_id = ${tenantId} and site_id = ${site?.id ?? NO_SITE} and dimension = 'all'
      and day <= ${to}::date`);
  return {
    site,
    sites,
    period,
    from,
    to,
    days,
    previous: { from: addDays(prevTo, -(days - 1)), to: prevTo },
    today,
    includesToday: to >= today,
    dataThrough: built?.day ?? null,
  };
}

/** The site id a range's queries filter by. */
export const siteOf = (r: ReportRange) => r.site?.id ?? NO_SITE;

export const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
/** n ÷ of to 4 places, as a string; null when there is nothing to divide by. */
export const rate = (n: number, of: number) => (of > 0 ? (n / of).toFixed(4) : null);
export const small = (n: number) => n < SMALL_SAMPLE;

/** The engaged-time band the median falls in: `fromSeconds` to `toSeconds` (null: and over). */
export interface MedianBand {
  band: number;
  fromSeconds: number;
  toSeconds: number | null;
}

/**
 * The median's band from a distribution of engaged-time bands (`ENGAGED_BAND_UPPER_SECONDS`):
 * the daily tables keep bands, not each view's time, so the median is read as a band, never
 * invented to the second. Null with nothing counted.
 */
export function medianBand(bands: readonly number[]): MedianBand | null {
  const counts = Array.from({ length: ENGAGED_BANDS }, (_, i) => num(bands[i]));
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  let seen = 0;
  for (let band = 0; band < counts.length; band++) {
    seen += counts[band] ?? 0;
    if (seen * 2 >= total) {
      return {
        band,
        fromSeconds: band === 0 ? 0 : (ENGAGED_BAND_UPPER_SECONDS[band - 1] ?? 0),
        toSeconds: ENGAGED_BAND_UPPER_SECONDS[band] ?? null,
      };
    }
  }
  return null;
}

/** `array[sum(col[1])::int, …]` as JSON, for summing a fixed-length array column. */
export function sumArray(column: string, length: number) {
  return sql.raw(
    `to_json(array[${Array.from({ length }, (_, i) => `coalesce(sum(${column}[${i + 1}]), 0)::int`).join(", ")}])`,
  );
}

/** The furthest quarter (1–4) at least half the views reached; 0 when under half saw a quarter. */
export function halfReadTo(views: number, reached: readonly number[]): number {
  let half = 0;
  for (let quarter = 1; quarter <= 4; quarter++) {
    if (views > 0 && num(reached[quarter - 1]) * 2 >= views) half = quarter;
  }
  return half;
}

/** `group/name` (a daily total's source key) → its parts. */
export function sourceParts(key: string): { group: string; name: string | null } {
  const slash = key.indexOf("/");
  return slash < 0
    ? { group: key, name: null }
    : { group: key.slice(0, slash), name: key.slice(slash + 1) };
}

const csvCell = (v: string | number | boolean | null | undefined) => {
  let s = v === null || v === undefined ? "" : String(v);
  // Text a spreadsheet would read as a formula (a page path never is; a campaign name may be).
  if (typeof v === "string" && /^[=+@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Rows as CSV, the header first. */
export function toCsv(
  rows: readonly (readonly (string | number | boolean | null | undefined)[])[],
) {
  return `${rows.map((r) => r.map(csvCell).join(",")).join("\n")}\n`;
}

/** What every read report starts with: the site, the days and how far they are built. */
export function rangeOut(r: ReportRange) {
  return {
    site: r.site,
    sites: r.sites,
    range: {
      period: r.period,
      from: r.from,
      to: r.to,
      days: r.days,
      previous: r.previous,
      includesToday: r.includesToday,
      dataThrough: r.dataThrough,
    },
  };
}
