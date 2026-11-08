// "gsc": Google Search Console, read only (docs/marketing-plan.md §4.2, §4.4; docs/plan.md §1.75).
// The client's own Search Console property, read with a Google Cloud service account the client
// added to the property as a Restricted user: the client admin (for Mezonas, the owner) enters the
// account's JSON key and the property in the portal, write-only in the client's vault. A signed
// assertion buys a one-hour token for `webmasters.readonly`, and the Search Analytics API answers
// with the property's impressions, clicks and positions by day, query and page, final figures only
// (`dataState: final`), so a stored day isn't revised later. No agent tools: the nightly sync
// stores one raw record per day and dimension set and the Marketing pack normalises them. Nothing
// here logs or keeps a token, a key or a response body. What is unchecked: ./NOTES.md.
// Request code copied from Plenary Labs' search import (apps/api/src/search/google.ts), not shared.

import { z } from "zod";
import { type ConnectionContext, type Connector, defineConnector } from "../connector";
import { importSigningKey, signJwt } from "../gchat/jwt";
import { GOOGLE_TOKEN_URL } from "../gmail/index";
import { type FetchLike, formEncode, globalFetch, timeoutSignal } from "../http";
import {
  addDays,
  byDay,
  countOf,
  credentialText,
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
} from "./records";

export {
  planSearchSync,
  readSearchDayPayload,
  readSearchSyncState,
  SEARCH_DAY_ROWS_MAX,
  SEARCH_ENTITIES,
  SEARCH_ENTITY,
  SEARCH_HISTORY_DAYS,
  SEARCH_PROVIDERS,
  SEARCH_REREAD_DAYS,
  type SearchConnector,
  SearchDayPayload,
  type SearchEntity,
  SearchImportError,
  type SearchProvider,
  type SearchRead,
  SearchRow,
  type SearchSpan,
  type SearchSync,
  SearchSyncState,
  searchConnectorOf,
  searchDayRecord,
} from "./records";

export const GSC_CONNECTOR_ID = "gsc";
export const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
export const GSC_API = "https://searchconsole.googleapis.com/webmasters/v3/sites";
/** The API's most rows per request. */
export const GSC_ROW_LIMIT = 25_000;
/** Days per request: a month keeps each answer well under the row limit for a small site. */
export const GSC_SPAN_DAYS = 31;
/** Pages read per span and dimension set; past them the span's days say `truncated`. */
export const GSC_MAX_PAGES = 4;
/** The longest answer read (a page of 25,000 rows is a few MB). */
const MAX_ANSWER_CHARS = 32 * 1024 * 1024;

/** The fields the client admin fills in (write-only key; the property may be shown back). */
export const GSC_CREDENTIAL_FIELDS = [
  {
    name: "property",
    label: "Search Console property",
    secret: false,
    hint: "sc-domain:example.com for a Domain property, or https://example.com/ for a URL-prefix one.",
  },
  {
    name: "serviceAccountKey",
    label: "Service account key (JSON)",
    secret: true,
    hint: "The JSON key of a Google Cloud service account with the Search Console API on, added to the property as a Restricted user.",
  },
] as const;

/** `sc-domain:example.com` or an http(s) URL prefix ending in `/`. */
export function isGscProperty(value: string): boolean {
  const v = value.trim();
  if (v.length > 300) return false;
  if (v.startsWith("sc-domain:")) {
    return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(
      v.slice("sc-domain:".length),
    );
  }
  return /^https?:\/\/[a-z0-9.-]+(:\d+)?\/([^\s]*\/)?$/i.test(v);
}

const ServiceAccountKey = z.looseObject({
  client_email: z.string().min(3).max(320).includes("@"),
  private_key: z.string().min(100).max(16_000),
  private_key_id: z.string().max(200).optional(),
});

/** The key JSON's parts used here, or a refusal naming what is wrong (never the key). */
export function gscServiceAccount(json: string): {
  clientEmail: string;
  privateKey: string;
  keyId: string | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new SearchImportError("the service account key is not JSON");
  }
  const key = ServiceAccountKey.safeParse(parsed);
  if (!key.success) {
    throw new SearchImportError("the service account key has no client_email or private_key");
  }
  return {
    clientEmail: key.data.client_email,
    privateKey: key.data.private_key,
    keyId: key.data.private_key_id ?? null,
  };
}

async function readJson(res: { text(): Promise<string> }): Promise<unknown> {
  const text = await res.text();
  if (text.length > MAX_ANSWER_CHARS)
    throw new SearchImportError("Search Console's answer was too large");
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// DECISION: the token request always goes to Google's own token endpoint, never to a `token_uri`
// named in the key: the key is text a person pasted, and nothing of ours is sent where it says.
export async function gscToken(
  key: ReturnType<typeof gscServiceAccount>,
  now: Date,
  fetch: FetchLike,
): Promise<string> {
  let signing: Awaited<ReturnType<typeof importSigningKey>>;
  try {
    signing = await importSigningKey(key.privateKey);
  } catch {
    throw new SearchImportError("the service account's private key could not be read");
  }
  const iat = Math.floor(now.getTime() / 1000);
  const assertion = await signJwt(signing, key.keyId ? { kid: key.keyId } : {}, {
    iss: key.clientEmail,
    scope: GSC_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat,
    exp: iat + 3600,
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: formEncode({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    redirect: "manual",
    signal: timeoutSignal(15_000),
  });
  const body = (await readJson(res)) as { access_token?: unknown } | null;
  if (!res.ok)
    throw new SearchImportError(`Google refused the service account key (${res.status})`);
  if (typeof body?.access_token !== "string" || body.access_token.length === 0) {
    throw new SearchImportError("Google's token answer had no access token");
  }
  return body.access_token;
}

type ApiRow = { keys?: unknown; clicks?: unknown; impressions?: unknown; position?: unknown };

/** Every row of one span and dimension set, a page at a time (at most GSC_MAX_PAGES). */
async function spanRows(
  input: { property: string; token: string; from: string; to: string; dimensions: string[] },
  fetch: FetchLike,
): Promise<{ rows: ApiRow[]; truncated: boolean }> {
  const rows: ApiRow[] = [];
  for (let page = 0; page < GSC_MAX_PAGES; page++) {
    const res = await fetch(
      `${GSC_API}/${encodeURIComponent(input.property)}/searchAnalytics/query`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          startDate: input.from,
          endDate: input.to,
          dimensions: input.dimensions,
          type: "web",
          dataState: "final",
          rowLimit: GSC_ROW_LIMIT,
          startRow: page * GSC_ROW_LIMIT,
        }),
        redirect: "manual",
        signal: timeoutSignal(60_000),
      },
    );
    if (res.status === 401 || res.status === 403) {
      throw new SearchImportError(
        `Search Console refused (${res.status}): is the service account a user on the property?`,
      );
    }
    if (res.status === 404) {
      throw new SearchImportError("Search Console has no such property for this account");
    }
    if (res.status === 429) {
      throw new SearchImportError("Search Console is limiting requests; we try again tonight");
    }
    if (!res.ok) throw new SearchImportError(`Search Console answered ${res.status}`);
    const body = (await readJson(res)) as { rows?: unknown } | null;
    const got = Array.isArray(body?.rows) ? (body.rows as ApiRow[]) : [];
    rows.push(...got);
    if (got.length < GSC_ROW_LIMIT) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

type DayRow = SearchRow & { day: string };

function pageRowsOf(rows: readonly ApiRow[]): DayRow[] {
  const out: DayRow[] = [];
  for (const r of rows) {
    const [day, url] = Array.isArray(r.keys) ? r.keys : [];
    const u = urlOf(url);
    if (!isDay(day) || !u) continue;
    out.push({
      day,
      url: u,
      impressions: countOf(r.impressions),
      clicks: countOf(r.clicks),
      position: positionOf(r.position),
    });
  }
  return out;
}

function queryRowsOf(rows: readonly ApiRow[]): DayRow[] {
  const out: DayRow[] = [];
  for (const r of rows) {
    const [day, text, url] = Array.isArray(r.keys) ? r.keys : [];
    const q = queryOf(text);
    const u = urlOf(url);
    if (!isDay(day) || !q || !u) continue;
    out.push({
      day,
      query: q,
      url: u,
      impressions: countOf(r.impressions),
      clicks: countOf(r.clicks),
      position: positionOf(r.position),
    });
  }
  return out;
}

const strip = ({ day: _day, ...row }: DayRow): SearchRow => row;

/**
 * The span's days from Search Console, a month at a time: for each month, every day up to the last
 * one Google gave final figures for (a day it reports nothing for is stored empty, so a day once
 * stored and since emptied is emptied here too); the days after are left for a later night.
 */
export async function readGsc(
  ctx: ConnectionContext,
  span: SearchSpan,
  fetch: FetchLike,
): Promise<SearchRead> {
  const creds = await credentialText(ctx);
  const property = (creds.property ?? "").trim();
  if (!isGscProperty(property)) {
    throw new SearchImportError(
      "the property isn't one Search Console names: sc-domain:example.com or https://example.com/",
    );
  }
  const key = gscServiceAccount(creds.serviceAccountKey ?? "");
  const token = await gscToken(key, ctx.now(), fetch);
  return readGscProperty(property, token, span, fetch);
}

/**
 * The span's days of one property with an access token, however it was got (a service account's
 * assertion, or M50's Google sign-in, ./oauth.ts).
 */
export async function readGscProperty(
  property: string,
  token: string,
  span: SearchSpan,
  fetch: FetchLike,
): Promise<SearchRead> {
  const read: SearchRead = { records: [], lastDay: null };
  for (let from = span.from; from <= span.to; ) {
    const end = addDays(from, GSC_SPAN_DAYS - 1);
    const to = end < span.to ? end : span.to;
    const base = { property, token, from, to };
    const pages = await spanRows({ ...base, dimensions: ["date", "page"] }, fetch);
    const queries = await spanRows({ ...base, dimensions: ["date", "query", "page"] }, fetch);
    const pageDays = byDay(pageRowsOf(pages.rows));
    const queryDays = byDay(queryRowsOf(queries.rows));
    const last = [...pageDays.keys(), ...queryDays.keys()].sort().at(-1);
    if (last) {
      for (let day = from; day <= last; day = addDays(day, 1)) {
        const common = { provider: "google" as const, property, day };
        read.records.push(
          await searchDayRecord({
            ...common,
            entity: SEARCH_ENTITY.page,
            rows: (pageDays.get(day) ?? []).map(strip),
            truncated: pages.truncated,
          }),
          await searchDayRecord({
            ...common,
            entity: SEARCH_ENTITY.queryPage,
            rows: (queryDays.get(day) ?? []).map(strip),
            truncated: queries.truncated,
          }),
        );
      }
      if (!read.lastDay || last > read.lastDay) read.lastDay = last;
    }
    from = addDays(to, 1);
  }
  return read;
}

export interface GscConnectorOptions {
  fetch?: () => FetchLike;
}

export type GscConnector = SearchConnector;

// DECISION: an API-key connector (the service account key and the property in the client's vault,
// entered by the client admin) with no deployment config: nothing to set before it can be offered,
// and it reads only once a key is in the vault. Google OAuth for clients waits for Google's
// verification of the scope (docs/marketing-plan.md D5, M50). M50: it is `gsc_oauth` (./oauth.ts),
// a connector of its own beside this one, so each keeps one way to sign in.
export function createGscConnector(options: GscConnectorOptions = {}): GscConnector {
  const fetch = options.fetch ?? globalFetch;
  const connector: Connector = defineConnector({
    id: GSC_CONNECTOR_ID,
    name: "Google Search Console",
    description:
      "Your site's Google search figures, read only: the searches it showed up for, its pages, clicks and positions, imported each night with 16 months of history.",
    icon: "search",
    auth: "api_key",
    credentialFields: GSC_CREDENTIAL_FIELDS.map((f) => ({ ...f })),
    entities: [SEARCH_ENTITY.queryPage, SEARCH_ENTITY.page],
    tools: [],
  });
  return {
    ...connector,
    search: { provider: "google", read: (ctx, span) => readGsc(ctx, span, fetch()) },
  };
}
