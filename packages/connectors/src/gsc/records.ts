// What the two search connectors (`gsc`, Google Search Console, and `bing_webmaster`, Bing
// Webmaster Tools) store, and what they share (docs/marketing-plan.md §4.4; docs/plan.md §1.75).
// Neither has agent tools: a nightly sync (apps/api/src/search-sync.ts) reads a span of days and
// stores one raw record per connection, day and dimension set, as the provider gave the rows (the
// URL, not our path); the Marketing pack normalises them into its search tables. Pure here: the
// record shape, its version, the sync's state on the connection and its plan. Copied in part from
// Plenary Labs' search import (rows.ts, jobs.ts), not shared.

import { z } from "zod";
import type { ConnectionContext, Connector, RawRecordInput } from "../connector";
import { subtle, toHex, utf8 } from "../runtime";

export const SEARCH_PROVIDERS = ["google", "bing"] as const;
export type SearchProvider = (typeof SEARCH_PROVIDERS)[number];

/** How long Search Console keeps data (16 months), and so how far back a first import reaches. */
export const SEARCH_HISTORY_DAYS = 486;
/** Days before the data's end read again each night, in case the provider filled them in late. */
export const SEARCH_REREAD_DAYS = 3;
/** The most rows kept for one day and dimension set; past it the record says `truncated`. */
export const SEARCH_DAY_ROWS_MAX = 50_000;
/** The longest query kept (Search Console's are far shorter; a bound, not a cut). */
export const SEARCH_QUERY_MAX = 500;
/** The longest URL kept. */
export const SEARCH_URL_MAX = 2048;

/** The record types, one per dimension set (`raw_record.entity_type`). */
export const SEARCH_ENTITY = {
  /** A day's rows by query and page (Search Console). */
  queryPage: "search.query_page_day",
  /** A day's rows by query, without the page (Bing reports queries without their pages). */
  query: "search.query_day",
  /** A day's rows by page, every query counted (both). */
  page: "search.page_day",
} as const;
export type SearchEntity = (typeof SEARCH_ENTITY)[keyof typeof SEARCH_ENTITY];
export const SEARCH_ENTITIES: readonly SearchEntity[] = Object.values(SEARCH_ENTITY);

export const SearchDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a day, yyyy-mm-dd");

/** One row as the provider gave it, cut to what is kept. */
export const SearchRow = z.object({
  query: z.string().min(1).max(SEARCH_QUERY_MAX).optional(),
  url: z.string().min(1).max(SEARCH_URL_MAX).optional(),
  impressions: z.number().int().min(0),
  clicks: z.number().int().min(0),
  /** The provider's average position (1 is the top); null when it gave none. */
  position: z.number().min(1).max(9999).nullable(),
});
export type SearchRow = z.infer<typeof SearchRow>;

/** A raw record's payload: one day and dimension set of one property. */
export const SearchDayPayload = z.object({
  v: z.literal(1),
  provider: z.enum(SEARCH_PROVIDERS),
  /** The provider's property: `sc-domain:mezonas.com`, `https://mezonas.com/`. */
  property: z.string().min(1).max(300),
  day: SearchDay,
  rows: z.array(SearchRow).max(SEARCH_DAY_ROWS_MAX),
  /** More rows than SEARCH_DAY_ROWS_MAX (or than the pages read) were left out. */
  truncated: z.boolean(),
});
export type SearchDayPayload = z.infer<typeof SearchDayPayload>;

/** A short reason in our own words: what the Search screen shows. Never a response body. */
export class SearchImportError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "SearchImportError";
  }
}

/** The UTC day of an instant. */
export const dayOf = (at: Date): string => at.toISOString().slice(0, 10);
export const addDays = (day: string, by: number): string =>
  dayOf(new Date(Date.parse(`${day}T00:00:00Z`) + by * 86_400_000));

/** A count as kept: a non-negative integer, else 0. */
export function countOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** A position as kept: the provider's average (≥ 1), else null. */
export function positionOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 9999
    ? Math.round(value * 100) / 100
    : null;
}

/** A query as kept: trimmed, null when empty or past the bound. */
export function queryOf(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const q = text.trim();
  return q.length > 0 && q.length <= SEARCH_QUERY_MAX ? q : null;
}

/** A URL as kept: an http(s) URL within the bound, else null. */
export function urlOf(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const u = text.trim();
  return u.length > 0 && u.length <= SEARCH_URL_MAX && /^https?:\/\//i.test(u) ? u : null;
}

/** Order-independent JSON for a version hash. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Rows in a fixed order, so the same answer always hashes the same. */
function sortedRows(rows: readonly SearchRow[]): SearchRow[] {
  const key = (r: SearchRow) => `${r.query ?? ""}\u0000${r.url ?? ""}`;
  return [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/**
 * One day and dimension set as a raw record. Its version is a hash of what it says, so a day read
 * again with the same figures stores nothing new (raw_record is unique per version), and a day the
 * provider has revised stores a new version beside the old one (raw records are never changed).
 */
// DECISION: the version is the content's hash (SHA-256, 32 hex), not the time it was read: a
// nightly re-read of the last few days then adds no rows unless the figures moved. Final data
// doesn't move, so a day going back to figures it had before (stored, then superseded) is not a
// case we keep apart; the newest stored version is the day.
export async function searchDayRecord(input: {
  entity: SearchEntity;
  provider: SearchProvider;
  property: string;
  day: string;
  rows: readonly SearchRow[];
  truncated: boolean;
}): Promise<RawRecordInput> {
  const rows = sortedRows(input.rows).slice(0, SEARCH_DAY_ROWS_MAX);
  const payload = SearchDayPayload.parse({
    v: 1,
    provider: input.provider,
    property: input.property,
    day: input.day,
    rows,
    truncated: input.truncated || input.rows.length > SEARCH_DAY_ROWS_MAX,
  });
  const digest = await subtle().digest(
    "SHA-256",
    utf8(canonical({ entity: input.entity, ...payload })),
  );
  return {
    entityType: input.entity,
    externalId: input.day,
    externalVersion: toHex(new Uint8Array(digest)).slice(0, 32),
    payload: payload as unknown as RawRecordInput["payload"],
  };
}

/** A stored payload read back, or null when it isn't one. */
export function readSearchDayPayload(payload: unknown): SearchDayPayload | null {
  const parsed = SearchDayPayload.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

// ── The sync's state, on the connection (`connection.sync_cursor.search`) ──────────────────────

export const SearchSyncState = z.object({
  v: z.literal(1),
  /** The last day the provider's final figures cover, as stored. */
  dataRunsTo: SearchDay.nullable(),
  /** When a sync last ran, and last ran without failing. */
  lastRunAt: z.iso.datetime({ offset: true }).nullable(),
  lastOkAt: z.iso.datetime({ offset: true }).nullable(),
  /** The last failure in our own words (SearchImportError's reason); null when the last run was fine. */
  lastError: z.string().max(500).nullable(),
});
export type SearchSyncState = z.infer<typeof SearchSyncState>;

/** The state kept on a connection's sync cursor, or null before its first sync. */
export function readSearchSyncState(cursor: unknown): SearchSyncState | null {
  const parsed = SearchSyncState.safeParse((cursor as { search?: unknown } | null)?.search);
  return parsed.success ? parsed.data : null;
}

/** The days a sync reads. */
export interface SearchSpan {
  from: string;
  to: string;
  /** Today (UTC), for a provider that must leave unfinished days out. */
  today: string;
  /** No data stored yet: the whole history the provider keeps. */
  first: boolean;
}

/**
 * The span a sync reads: everything the provider keeps (SEARCH_HISTORY_DAYS) the first time, else
 * from a few days before the data's end; always up to yesterday. A provider leaves out days it
 * hasn't finished (Search Console's final data stops two or three days back).
 */
export function planSearchSync(state: SearchSyncState | null, now: Date): SearchSpan {
  const today = dayOf(now);
  const to = addDays(today, -1);
  const runsTo = state?.dataRunsTo ?? null;
  const from = runsTo ? addDays(runsTo, -SEARCH_REREAD_DAYS) : addDays(today, -SEARCH_HISTORY_DAYS);
  return { from: from < to ? from : to, to, today, first: runsTo === null };
}

/** What a sync read: the records to store and the last day the provider had final figures for. */
export interface SearchRead {
  records: RawRecordInput[];
  /** The last day with figures in the span; null when the provider gave none. */
  lastDay: string | null;
}

/** A search connector's sync, which the platform runs nightly. */
export interface SearchSync {
  provider: SearchProvider;
  /** Reads the span's days. Throws SearchImportError with a reason in our words. */
  read(ctx: ConnectionContext, span: SearchSpan): Promise<SearchRead>;
}

export type SearchConnector = Connector & { search: SearchSync };

/** The connector as a search connector, or null when it has no search sync. */
export function searchConnectorOf(c: Connector | undefined | null): SearchConnector | null {
  const s = (c as Partial<SearchConnector> | undefined | null)?.search;
  return c && s && typeof s.read === "function" ? (c as SearchConnector) : null;
}

/** Credentials as text fields (API-key connectors store what the client admin entered). */
export async function credentialText(ctx: ConnectionContext): Promise<Record<string, string>> {
  const creds = await ctx.credentials.get();
  if (!creds) throw new SearchImportError("no key has been entered for this connection");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(creds)) if (typeof v === "string") out[k] = v;
  return out;
}

/** Rows grouped by day, each day's in the order they came. */
export function byDay<T extends { day: string }>(rows: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const list = out.get(r.day);
    if (list) list.push(r);
    else out.set(r.day, [r]);
  }
  return out;
}
