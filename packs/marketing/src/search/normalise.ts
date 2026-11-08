// From the search connectors' raw records to the area's search tables (M45; docs/plan.md §1.75).
// The platform's nightly sync stores what Search Console and Bing said, one raw record per
// connection, day and dimension set (packages/connectors `gsc`, `bing_webmaster`); here a client's
// search sources (a site, a provider, the connection it reads) turn the newest version of each day
// into `search_query_daily` and `search_page_daily`: the provider's URLs as the site's own paths
// (another site's rows are dropped), rows on the same path merged, a day replaced whole. Run in the
// pack's nightly pass and by a person's actions, always inside the client's own transaction.
// Copied in part from Plenary Labs' search import (rows.ts, store.ts), not shared.

import {
  BING_WEBMASTER_CONNECTOR_ID,
  GSC_CONNECTOR_ID,
  GSC_OAUTH_CONNECTOR_ID,
  readSearchDayPayload,
  readSearchSyncState,
  SEARCH_ENTITIES,
  SEARCH_ENTITY,
  type SearchDayPayload,
} from "@countersign/connectors";
import {
  connection,
  type Db,
  rawRecord,
  type Tx,
  tenant,
  tenantPack,
  withTenant,
} from "@countersign/db";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { PACK_ID } from "../ids";
import {
  SEARCH_PROVIDERS,
  type SearchProvider,
  searchPageDaily,
  searchQueryDaily,
  searchSource,
  site,
} from "../schema";

/**
 * The path a query row keeps when the provider reports the query without its page (Bing): not a
 * page anyone can have (`pathOf` never gives it), and left out wherever pages are listed.
 */
// DECISION: the schema keeps a path on every query row (part of its key, starting with `/`), so
// Bing's page-less queries are kept against `/*` rather than the home page.
export const NO_PAGE = "/*";

/**
 * Which connectors serve each provider. M50 (docs/plan.md §1.78): Google by a service account
 * (`gsc`) or by Google sign-in (`gsc_oauth`); both store the same raw records.
 */
export const SEARCH_CONNECTORS: Record<SearchProvider, readonly string[]> = {
  google: [GSC_CONNECTOR_ID, GSC_OAUTH_CONNECTOR_ID],
  bing: [BING_WEBMASTER_CONNECTOR_ID],
};

export const providerOfConnector = (connector: string): SearchProvider | null =>
  SEARCH_PROVIDERS.find((p) => SEARCH_CONNECTORS[p].includes(connector)) ?? null;

/**
 * The path of one of the site's own URLs, or null for another site's (or one we can't read).
 * `www.` and either protocol count as the site's; the query string and fragment are dropped, and
 * a trailing slash except the root's: `https://www.mezonas.com/how-it-works/?ref=x` is
 * `/how-it-works`.
 */
export function pathOf(url: string, domain: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== domain && host !== `www.${domain}`) return null;
  let path = parsed.pathname || "/";
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (path === NO_PAGE) return null;
  return path.startsWith("/") && path.length <= 512 ? path : null;
}

export interface NormalRow {
  query?: string;
  path: string;
  impressions: number;
  clicks: number;
  position: number | null;
}

/**
 * Rows that land on the same query and path merged: counts summed, positions averaged by
 * impressions (as the providers average them), so `http` and `https` of one page become one row.
 */
export function mergeRows(rows: readonly NormalRow[]): NormalRow[] {
  const out = new Map<string, NormalRow & { w: number; n: number }>();
  for (const r of rows) {
    const key = `${r.query ?? ""}\u0000${r.path}`;
    const weight = r.position === null ? 0 : Math.max(1, r.impressions);
    const seen = out.get(key);
    if (!seen) {
      out.set(key, { ...r, w: (r.position ?? 0) * weight, n: weight });
      continue;
    }
    seen.impressions += r.impressions;
    seen.clicks += r.clicks;
    seen.w += (r.position ?? 0) * weight;
    seen.n += weight;
  }
  return [...out.values()].map(({ w, n, ...r }) => ({
    ...r,
    position: n > 0 ? Math.round((w / n) * 100) / 100 : null,
  }));
}

/** A payload's rows as the site's rows: page rows by path, query rows by query and path. */
export function normalRows(payload: SearchDayPayload, kind: "page" | "query", domain: string) {
  const rows: NormalRow[] = [];
  for (const r of payload.rows) {
    const path = r.url ? pathOf(r.url, domain) : kind === "query" ? NO_PAGE : null;
    if (path === null) continue;
    if (kind === "query" && !r.query) continue;
    rows.push({
      ...(kind === "query" ? { query: r.query as string } : {}),
      path,
      impressions: r.impressions,
      clicks: r.clicks,
      position: r.position,
    });
  }
  return mergeRows(rows);
}

const CHUNK = 1000;
const position = (p: number | null) => (p === null ? null : Math.min(p, 9999.99).toFixed(2));

/** One day of one table replaced whole by these rows. */
async function replaceDay(
  tx: Tx,
  target: { tenantId: string; siteId: string; provider: SearchProvider; day: string },
  kind: "page" | "query",
  rows: readonly NormalRow[],
): Promise<void> {
  const { tenantId, siteId, provider, day } = target;
  if (kind === "page") {
    await tx
      .delete(searchPageDaily)
      .where(
        and(
          eq(searchPageDaily.tenantId, tenantId),
          eq(searchPageDaily.siteId, siteId),
          eq(searchPageDaily.provider, provider),
          eq(searchPageDaily.day, day),
        ),
      );
    for (let i = 0; i < rows.length; i += CHUNK) {
      await tx.insert(searchPageDaily).values(
        rows.slice(i, i + CHUNK).map((r) => ({
          tenantId,
          siteId,
          provider,
          day,
          path: r.path,
          impressions: r.impressions,
          clicks: r.clicks,
          position: position(r.position),
        })),
      );
    }
    return;
  }
  await tx
    .delete(searchQueryDaily)
    .where(
      and(
        eq(searchQueryDaily.tenantId, tenantId),
        eq(searchQueryDaily.siteId, siteId),
        eq(searchQueryDaily.provider, provider),
        eq(searchQueryDaily.day, day),
      ),
    );
  for (let i = 0; i < rows.length; i += CHUNK) {
    await tx.insert(searchQueryDaily).values(
      rows.slice(i, i + CHUNK).map((r) => ({
        tenantId,
        siteId,
        provider,
        day,
        query: r.query as string,
        path: r.path,
        impressions: r.impressions,
        clicks: r.clicks,
        position: position(r.position),
      })),
    );
  }
}

/** Removes every search figure of a site from one provider (its source now reads elsewhere). */
export async function clearSearchFigures(
  tx: Tx,
  target: { tenantId: string; siteId: string; provider: SearchProvider },
): Promise<void> {
  for (const table of [searchPageDaily, searchQueryDaily]) {
    await tx
      .delete(table)
      .where(
        and(
          eq(table.tenantId, target.tenantId),
          eq(table.siteId, target.siteId),
          eq(table.provider, target.provider),
        ),
      );
  }
}

/** What a sync stored but the pack hasn't seen yet is read again from this long before. */
// DECISION: records are read from a day before the last import, not from the instant: a sync's
// transaction that committed late would otherwise be missed, and normalising a day twice gives
// the same rows.
const OVERLAP_MS = 24 * 60 * 60 * 1000;

export interface NormaliseResult {
  sourceId: string;
  days: number;
  dataRunsTo: string | null;
  error: string | null;
}

/**
 * Brings one source's new records into the search tables and its state up to date: the day the
 * data runs to and the last failure, from the sync's state on its connection. `full` reads every
 * stored record, not only those since the last import.
 */
export async function normaliseSource(
  tx: Tx,
  input: { tenantId: string; sourceId: string; now: Date; full?: boolean },
): Promise<NormaliseResult> {
  const { tenantId, sourceId, now } = input;
  const [source] = await tx
    .select({
      id: searchSource.id,
      siteId: searchSource.siteId,
      provider: searchSource.provider,
      connectionId: searchSource.connectionId,
      dataRunsTo: searchSource.dataRunsTo,
      lastImportedAt: searchSource.lastImportedAt,
      domain: site.domain,
    })
    .from(searchSource)
    .innerJoin(
      site,
      and(eq(site.id, searchSource.siteId), eq(site.tenantId, searchSource.tenantId)),
    )
    .where(and(eq(searchSource.tenantId, tenantId), eq(searchSource.id, sourceId)));
  if (!source) return { sourceId, days: 0, dataRunsTo: null, error: "no such search source" };
  const done = async (days: number, dataRunsTo: string | null, error: string | null) => {
    await tx
      .update(searchSource)
      .set({ dataRunsTo, lastError: error, ...(days > 0 ? { lastImportedAt: now } : {}) })
      .where(and(eq(searchSource.tenantId, tenantId), eq(searchSource.id, sourceId)));
    return { sourceId, days, dataRunsTo, error };
  };
  if (!source.connectionId) return done(0, source.dataRunsTo, null);
  const [conn] = await tx
    .select({
      status: connection.status,
      connector: connection.connector,
      cursor: connection.syncCursor,
    })
    .from(connection)
    .where(and(eq(connection.tenantId, tenantId), eq(connection.id, source.connectionId)));
  if (!conn || providerOfConnector(conn.connector) !== source.provider) {
    return done(0, source.dataRunsTo, "the connection this source read is gone");
  }
  const state = readSearchSyncState(conn.cursor);
  const since =
    !input.full && source.lastImportedAt
      ? new Date(source.lastImportedAt.getTime() - OVERLAP_MS)
      : null;
  const records = await tx
    .select({
      entityType: rawRecord.entityType,
      externalId: rawRecord.externalId,
      payload: rawRecord.payload,
    })
    .from(rawRecord)
    .where(
      and(
        eq(rawRecord.tenantId, tenantId),
        eq(rawRecord.connectionId, source.connectionId),
        inArray(rawRecord.entityType, [...SEARCH_ENTITIES]),
        ...(since ? [gt(rawRecord.syncedAt, since)] : []),
      ),
    )
    .orderBy(desc(rawRecord.syncedAt), desc(rawRecord.id));
  // The newest version of each day and dimension set.
  const seen = new Set<string>();
  let days = 0;
  for (const r of records) {
    const key = `${r.entityType}\u0000${r.externalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const payload = readSearchDayPayload(r.payload);
    if (!payload || payload.provider !== source.provider || payload.day !== r.externalId) continue;
    const kind = r.entityType === SEARCH_ENTITY.page ? "page" : "query";
    await replaceDay(
      tx,
      { tenantId, siteId: source.siteId, provider: source.provider, day: payload.day },
      kind,
      normalRows(payload, kind, source.domain),
    );
    days += 1;
  }
  const error =
    conn.status !== "connected"
      ? `the ${source.provider === "google" ? "Search Console" : "Bing"} connection is ${conn.status}`
      : (state?.lastError ?? null);
  return done(days, state?.dataRunsTo ?? source.dataRunsTo, error);
}

/** Every source of one client, normalised. */
export async function normaliseClient(
  tx: Tx,
  tenantId: string,
  now: Date,
  filter: { siteId?: string; provider?: SearchProvider; full?: boolean } = {},
): Promise<NormaliseResult[]> {
  const sources = await tx
    .select({ id: searchSource.id })
    .from(searchSource)
    .where(
      and(
        eq(searchSource.tenantId, tenantId),
        ...(filter.siteId ? [eq(searchSource.siteId, filter.siteId)] : []),
        ...(filter.provider ? [eq(searchSource.provider, filter.provider)] : []),
      ),
    )
    .orderBy(searchSource.createdAt);
  const out: NormaliseResult[] = [];
  for (const s of sources) {
    out.push(
      await normaliseSource(tx, {
        tenantId,
        sourceId: s.id,
        now,
        ...(filter.full ? { full: true } : {}),
      }),
    );
  }
  return out;
}

/**
 * The search area's part of the pack's nightly pass (03:41 UTC, half an hour after the platform's
 * search sync): every client with the pack on, each in its own transaction.
 */
export async function searchNightly(
  db: Db,
  now: Date,
  onError: (tenantId: string, error: unknown) => void = () => {},
): Promise<{ clients: number; sources: number; days: number }> {
  const clients = await db.select({ id: tenant.id }).from(tenant);
  const result = { clients: 0, sources: 0, days: 0 };
  for (const client of clients) {
    try {
      await withTenant(db, client.id, async (tx) => {
        const [on] = await tx
          .select({ pack: tenantPack.pack })
          .from(tenantPack)
          .where(and(eq(tenantPack.tenantId, client.id), eq(tenantPack.pack, PACK_ID)));
        if (!on) return;
        result.clients += 1;
        for (const r of await normaliseClient(tx, client.id, now)) {
          result.sources += 1;
          result.days += r.days;
        }
      });
    } catch (error) {
      onError(client.id, error);
    }
  }
  return result;
}

/** How many query rows are kept for a site (for tests and the sources report). */
export async function searchRowCounts(tx: Tx, tenantId: string, siteId: string) {
  const [row] = await tx.execute<{ queries: number; pages: number }>(sql`
    select (select count(*)::int from search_query_daily where tenant_id = ${tenantId} and site_id = ${siteId}) as queries,
           (select count(*)::int from search_page_daily where tenant_id = ${tenantId} and site_id = ${siteId}) as pages`);
  return { queries: Number(row?.queries ?? 0), pages: Number(row?.pages ?? 0) };
}
