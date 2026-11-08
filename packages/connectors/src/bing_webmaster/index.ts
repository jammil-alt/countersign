// "bing_webmaster": Bing Webmaster Tools, read only (docs/marketing-plan.md §4.2, §4.4; docs/plan.md
// §1.75). The client's own Bing site, read with the API key a Bing user generates in Webmaster
// Tools: the client admin (for Mezonas, the owner) enters it and the site's URL in the portal,
// write-only in the client's vault. Two reports cover the history Bing keeps: queries
// (`GetQueryStats`, without their pages) and pages (`GetPageStats`), with dates in Microsoft's
// JSON form (`/Date(ms±hhmm)/`). No agent tools: the nightly sync stores one raw record per day and
// dimension set and the Marketing pack normalises them. The key is never logged or kept anywhere
// but the vault. What is unchecked: ./NOTES.md.
// Request code copied from Plenary Labs' search import (apps/api/src/search/bing.ts), not shared.

import { type ConnectionContext, type Connector, defineConnector } from "../connector";
import {
  addDays,
  byDay,
  countOf,
  credentialText,
  dayOf,
  positionOf,
  queryOf,
  SEARCH_ENTITY,
  type SearchConnector,
  SearchImportError,
  type SearchRead,
  type SearchRow,
  type SearchSpan,
  searchDayRecord,
  urlOf,
} from "../gsc/records";
import { type FetchLike, globalFetch, timeoutSignal } from "../http";

export const BING_WEBMASTER_CONNECTOR_ID = "bing_webmaster";
export const BING_API = "https://ssl.bing.com/webmaster/api.svc/json";
/**
 * Days at the end Bing may not have finished: a day is imported once it is this many days old.
 */
// DECISION: Bing says nothing like Google's `dataState: final`, so the last two days (yesterday and
// the day before) are left out and read on a later night; UNCHECKED how late Bing's figures settle.
export const BING_UNFINISHED_DAYS = 2;
const MAX_ANSWER_CHARS = 32 * 1024 * 1024;

export const BING_CREDENTIAL_FIELDS = [
  {
    name: "siteUrl",
    label: "Site URL in Bing Webmaster Tools",
    secret: false,
    hint: "The site as Bing lists it, e.g. https://example.com/",
  },
  {
    name: "apiKey",
    label: "Bing Webmaster API key",
    secret: true,
    hint: "Webmaster Tools, Settings, API access: generate a key for a user with access to the site.",
  },
] as const;

export function isBingSiteUrl(value: string): boolean {
  const v = value.trim();
  return v.length <= 300 && /^https?:\/\/[a-z0-9.-]+(:\d+)?(\/[^\s]*)?$/i.test(v);
}

/** `/Date(1399100400000-0700)/` as the calendar day it names, or null. */
export function bingDay(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^\/Date\((-?\d{1,15})([+-]\d{4})?\)\/$/.exec(value);
  if (!match) return null;
  const ms = Number(match[1]);
  const offset = match[2];
  const shift = offset
    ? (offset.startsWith("-") ? -1 : 1) *
      (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(3, 5))) *
      60_000
    : 0;
  const at = new Date(ms + shift);
  return Number.isNaN(at.getTime()) ? null : dayOf(at);
}

type BingRow = {
  Query?: unknown;
  Date?: unknown;
  Impressions?: unknown;
  Clicks?: unknown;
  AvgImpressionPosition?: unknown;
};

async function report(
  method: "GetQueryStats" | "GetPageStats",
  input: { siteUrl: string; apiKey: string },
  fetch: FetchLike,
): Promise<BingRow[]> {
  // The key goes in the query string, as Bing's JSON API takes it: this URL is never logged.
  const url = `${BING_API}/${method}?siteUrl=${encodeURIComponent(input.siteUrl)}&apikey=${encodeURIComponent(input.apiKey)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "manual",
    signal: timeoutSignal(60_000),
  });
  if (res.status === 401 || res.status === 403) {
    throw new SearchImportError(`Bing refused the API key (${res.status})`);
  }
  if (res.status === 429) {
    throw new SearchImportError("Bing is limiting requests; we try again tonight");
  }
  if (!res.ok) throw new SearchImportError(`Bing answered ${res.status} to ${method}`);
  const text = await res.text();
  if (text.length > MAX_ANSWER_CHARS) throw new SearchImportError("Bing's answer was too large");
  let body: { d?: unknown } | null = null;
  try {
    body = JSON.parse(text) as { d?: unknown } | null;
  } catch {
    body = null;
  }
  // Bing answers a site the key's user can't see with an error object, not rows (UNCHECKED shape).
  if (!Array.isArray(body?.d)) {
    throw new SearchImportError(
      `Bing's ${method} answer had no rows: is the site URL as Bing lists it?`,
    );
  }
  return body.d as BingRow[];
}

type DayRow = SearchRow & { day: string };
const strip = ({ day: _day, ...row }: DayRow): SearchRow => row;

/** The span's days from Bing: everything Bing keeps the first time, else from the span's start. */
export async function readBing(
  ctx: ConnectionContext,
  span: SearchSpan,
  fetch: FetchLike,
): Promise<SearchRead> {
  const creds = await credentialText(ctx);
  const siteUrl = (creds.siteUrl ?? "").trim();
  if (!isBingSiteUrl(siteUrl)) {
    throw new SearchImportError("the site URL isn't one Bing names, e.g. https://example.com/");
  }
  const apiKey = (creds.apiKey ?? "").trim();
  if (!apiKey) throw new SearchImportError("no Bing API key has been entered");
  const input = { siteUrl, apiKey };
  const last = addDays(span.today, -BING_UNFINISHED_DAYS);
  const within = (day: string) => day >= span.from && day <= last && day <= span.to;

  const queries: DayRow[] = [];
  for (const r of await report("GetQueryStats", input, fetch)) {
    const day = bingDay(r.Date);
    const q = queryOf(r.Query);
    if (!day || !q || !within(day)) continue;
    queries.push({
      day,
      query: q,
      impressions: countOf(r.Impressions),
      clicks: countOf(r.Clicks),
      position: positionOf(r.AvgImpressionPosition),
    });
  }
  const pages: DayRow[] = [];
  for (const r of await report("GetPageStats", input, fetch)) {
    const day = bingDay(r.Date);
    // GetPageStats puts the page's URL where GetQueryStats puts the query.
    const u = urlOf(r.Query);
    if (!day || !u || !within(day)) continue;
    pages.push({
      day,
      url: u,
      impressions: countOf(r.Impressions),
      clicks: countOf(r.Clicks),
      position: positionOf(r.AvgImpressionPosition),
    });
  }
  const pageDays = byDay(pages);
  const queryDays = byDay(queries);
  const days = [...pageDays.keys(), ...queryDays.keys()].sort();
  const first = days[0];
  const end = days.at(-1);
  const read: SearchRead = { records: [], lastDay: end ?? null };
  if (!first || !end) return read;
  // Every day from the span's start (or Bing's first day, the first time) to Bing's last: a day
  // Bing names nothing for is stored empty.
  const start = span.first ? first : span.from;
  for (let day = start; day <= end; day = addDays(day, 1)) {
    const common = { provider: "bing" as const, property: siteUrl, day, truncated: false };
    read.records.push(
      await searchDayRecord({
        ...common,
        entity: SEARCH_ENTITY.page,
        rows: (pageDays.get(day) ?? []).map(strip),
      }),
      await searchDayRecord({
        ...common,
        entity: SEARCH_ENTITY.query,
        rows: (queryDays.get(day) ?? []).map(strip),
      }),
    );
  }
  return read;
}

export interface BingWebmasterConnectorOptions {
  fetch?: () => FetchLike;
}

export type BingWebmasterConnector = SearchConnector;

// DECISION: as `gsc`, an API-key connector with no deployment config: offered everywhere, reading
// only once a key is in the client's vault.
export function createBingWebmasterConnector(
  options: BingWebmasterConnectorOptions = {},
): BingWebmasterConnector {
  const fetch = options.fetch ?? globalFetch;
  const connector: Connector = defineConnector({
    id: BING_WEBMASTER_CONNECTOR_ID,
    name: "Bing Webmaster Tools",
    description:
      "Your site's Bing search figures, read only: the searches it showed up for, its pages, clicks and positions, imported each night.",
    icon: "search",
    auth: "api_key",
    credentialFields: BING_CREDENTIAL_FIELDS.map((f) => ({ ...f })),
    entities: [SEARCH_ENTITY.query, SEARCH_ENTITY.page],
    tools: [],
  });
  return {
    ...connector,
    search: { provider: "bing", read: (ctx, span) => readBing(ctx, span, fetch()) },
  };
}
