// A site's search sources (M45; docs/plan.md §1.75): which of the client's Search Console and Bing
// connections each site's figures come from. Set by a person in the back office (the
// `set-search-source` action), never by an agent; one per client, site and provider. The
// connection holds the key and the property (entered by the client admin in the portal); the source
// says which site that property's figures belong to, and keeps the import's state in our words.

import { connection, type Db, type Tx, withTenant } from "@countersign/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { PackRefusal } from "../pack";
import { SEARCH_PROVIDERS, type SearchProvider, searchSource, site } from "../schema";
import { listSites, type SiteRow } from "../sites";
import {
  clearSearchFigures,
  type NormaliseResult,
  normaliseClient,
  normaliseSource,
  providerOfConnector,
  SEARCH_CONNECTOR,
} from "./normalise";

export interface SearchSourceRow {
  id: string;
  siteId: string;
  provider: SearchProvider;
  connectionId: string | null;
  dataRunsTo: string | null;
  lastImportedAt: string | null;
  lastError: string | null;
}

export interface SearchConnectionOption {
  id: string;
  provider: SearchProvider;
  status: string;
  /** The property or site URL the client admin entered (not a secret); null when unknown. */
  property: string | null;
}

export interface SearchSources {
  sites: SiteRow[];
  sources: SearchSourceRow[];
  /** The client's Search Console and Bing connections, to pick from. */
  connections: SearchConnectionOption[];
}

const toRow = (r: typeof searchSource.$inferSelect): SearchSourceRow => ({
  id: r.id,
  siteId: r.siteId,
  provider: r.provider,
  connectionId: r.connectionId,
  dataRunsTo: r.dataRunsTo,
  lastImportedAt: r.lastImportedAt ? r.lastImportedAt.toISOString() : null,
  lastError: r.lastError,
});

/**
 * The non-secret field a search connection's form keeps for showing back (the portal's vault read
 * model, `config.vault.fields`), read loosely: the property for Search Console, the site URL for
 * Bing. Never a secret: those fields are only ever `{ set: true }` there.
 */
function propertyOf(config: unknown, provider: SearchProvider): string | null {
  const field = provider === "google" ? "property" : "siteUrl";
  const value = (config as { vault?: { fields?: Record<string, { value?: unknown }> } } | null)
    ?.vault?.fields?.[field]?.value;
  return typeof value === "string" && value.length <= 300 ? value : null;
}

export const SearchSourcesQuery = z.strictObject({ site: z.uuid().optional() });

/** The client's sites, their search sources and the connections they may read. */
export async function searchSources(
  tx: Tx,
  tenantId: string,
  query: z.infer<typeof SearchSourcesQuery> = {},
): Promise<SearchSources> {
  const sites = await listSites(tx, tenantId);
  if (query.site && !sites.some((s) => s.id === query.site)) {
    throw new PackRefusal("unknown_site", "no such site for this client");
  }
  const sources = await tx
    .select()
    .from(searchSource)
    .where(
      and(
        eq(searchSource.tenantId, tenantId),
        ...(query.site ? [eq(searchSource.siteId, query.site)] : []),
      ),
    )
    .orderBy(asc(searchSource.createdAt));
  const conns = await tx
    .select({
      id: connection.id,
      connector: connection.connector,
      status: connection.status,
      config: connection.config,
    })
    .from(connection)
    .where(
      and(
        eq(connection.tenantId, tenantId),
        inArray(connection.connector, Object.values(SEARCH_CONNECTOR)),
      ),
    )
    .orderBy(asc(connection.createdAt));
  return {
    sites,
    sources: sources.map(toRow),
    connections: conns.flatMap((c) => {
      const provider = providerOfConnector(c.connector);
      return provider
        ? [{ id: c.id, provider, status: c.status, property: propertyOf(c.config, provider) }]
        : [];
    }),
  };
}

export const SetSearchSourceInput = z.strictObject({
  siteId: z.uuid(),
  provider: z.enum(SEARCH_PROVIDERS),
  /** The connection to read; null stops reading (the figures already in stay). */
  connectionId: z.uuid().nullable(),
});

/**
 * Points a site's figures from one provider at one of the client's connections, and brings in
 * what that connection has already synced. Pointing it elsewhere starts the site's figures from
 * that provider afresh (the old connection's are removed); stopping keeps them.
 */
export async function setSearchSource(
  db: Db,
  ctx: { tenantId: string; input: z.infer<typeof SetSearchSourceInput>; now?: Date },
): Promise<{ source: SearchSourceRow; imported: NormaliseResult | null }> {
  const { tenantId, input } = ctx;
  const now = ctx.now ?? new Date();
  return withTenant(db, tenantId, async (tx) => {
    const [s] = await tx
      .select({ id: site.id })
      .from(site)
      .where(and(eq(site.tenantId, tenantId), eq(site.id, input.siteId)));
    if (!s) throw new PackRefusal("unknown_site", "no such site for this client");
    if (input.connectionId) {
      const [c] = await tx
        .select({ connector: connection.connector })
        .from(connection)
        .where(and(eq(connection.tenantId, tenantId), eq(connection.id, input.connectionId)));
      if (!c) throw new PackRefusal("unknown_connection", "no such connection for this client");
      if (providerOfConnector(c.connector) !== input.provider) {
        throw new PackRefusal(
          "wrong_connection",
          input.provider === "google"
            ? "that connection isn't a Search Console one"
            : "that connection isn't a Bing Webmaster Tools one",
        );
      }
    }
    const [existing] = await tx
      .select()
      .from(searchSource)
      .where(
        and(
          eq(searchSource.tenantId, tenantId),
          eq(searchSource.siteId, input.siteId),
          eq(searchSource.provider, input.provider),
        ),
      );
    let row: typeof searchSource.$inferSelect | undefined;
    if (!existing) {
      [row] = await tx
        .insert(searchSource)
        .values({
          tenantId,
          siteId: input.siteId,
          provider: input.provider,
          connectionId: input.connectionId,
        })
        .returning();
    } else if (input.connectionId && existing.connectionId !== input.connectionId) {
      await clearSearchFigures(tx, { tenantId, siteId: input.siteId, provider: input.provider });
      [row] = await tx
        .update(searchSource)
        .set({
          connectionId: input.connectionId,
          dataRunsTo: null,
          lastImportedAt: null,
          lastError: null,
        })
        .where(and(eq(searchSource.tenantId, tenantId), eq(searchSource.id, existing.id)))
        .returning();
    } else if (!input.connectionId && existing.connectionId) {
      [row] = await tx
        .update(searchSource)
        .set({ connectionId: null })
        .where(and(eq(searchSource.tenantId, tenantId), eq(searchSource.id, existing.id)))
        .returning();
    } else {
      row = existing;
    }
    if (!row) throw new Error("search source not written");
    const imported = row.connectionId
      ? await normaliseSource(tx, { tenantId, sourceId: row.id, now })
      : null;
    const [after] = await tx
      .select()
      .from(searchSource)
      .where(and(eq(searchSource.tenantId, tenantId), eq(searchSource.id, row.id)));
    return { source: toRow(after ?? row), imported };
  });
}

export const ImportSearchInput = z.strictObject({
  siteId: z.uuid().optional(),
  provider: z.enum(SEARCH_PROVIDERS).optional(),
});

/**
 * Builds a site's search figures again from everything its connections have synced (every day
 * replaced whole), now rather than in tonight's pass. Reading the provider stays the nightly
 * sync's: a person can't make us call Google or Bing more often.
 */
// DECISION: `import-search` rebuilds from the stored raw records, all of them; the provider is read
// only by the platform's sync (03:11 nightly, and within the hour for a connection never synced),
// which holds the key. A rebuild is idempotent: the same records give the same rows.
export async function importSearch(
  db: Db,
  ctx: { tenantId: string; input: z.infer<typeof ImportSearchInput>; now?: Date },
): Promise<{ imported: NormaliseResult[] }> {
  const now = ctx.now ?? new Date();
  return withTenant(db, ctx.tenantId, async (tx) => {
    if (ctx.input.siteId) {
      const [s] = await tx
        .select({ id: site.id })
        .from(site)
        .where(and(eq(site.tenantId, ctx.tenantId), eq(site.id, ctx.input.siteId)));
      if (!s) throw new PackRefusal("unknown_site", "no such site for this client");
    }
    return {
      imported: await normaliseClient(tx, ctx.tenantId, now, {
        ...(ctx.input.siteId ? { siteId: ctx.input.siteId } : {}),
        ...(ctx.input.provider ? { provider: ctx.input.provider } : {}),
        full: true,
      }),
    };
  });
}
