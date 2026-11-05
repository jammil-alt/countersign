// The operator's catalogue of browser sites (docs/plan.md §1.26 "Browser sites", migration 0012):
// reads and writes for the back office (inside its operator transaction), the portal's offers and
// setup (inside the client's transaction, through readOperatorCatalogue: an operator scope with no
// clients, for these reads only), and a run's pinned site (its own operator transaction with no
// clients). Profiles are parsed on every read (invariant 5); one that no longer parses is unusable.

import {
  type BrowserSiteOffer,
  BrowserSiteProfile,
  type BrowserSiteView,
  type BrowserTier,
  type PinnedBrowserSite,
} from "@countersign/core";
import {
  browserSite,
  browserSiteVersion,
  connection,
  type Db,
  readOperatorCatalogue,
  type Tx,
  withOperator,
} from "@countersign/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

type SiteRow = typeof browserSite.$inferSelect;
type VersionRow = typeof browserSiteVersion.$inferSelect;

export interface CatalogueSite {
  site: SiteRow;
  current: VersionRow & { parsed: BrowserSiteProfile | null };
  versions: number;
}

function parsed(row: VersionRow): VersionRow & { parsed: BrowserSiteProfile | null } {
  const p = BrowserSiteProfile.safeParse(row.profile);
  return { ...row, parsed: p.success ? p.data : null };
}

/** Every site with its newest version. `tx` must be in an operator scope. */
export async function catalogue(tx: Tx, slugs?: readonly string[]): Promise<CatalogueSite[]> {
  const sites = await tx
    .select()
    .from(browserSite)
    .where(slugs ? inArray(browserSite.slug, [...slugs]) : undefined)
    .orderBy(browserSite.name);
  if (sites.length === 0) return [];
  const versions = await tx
    .select()
    .from(browserSiteVersion)
    .where(
      inArray(
        browserSiteVersion.siteId,
        sites.map((s) => s.id),
      ),
    )
    .orderBy(desc(browserSiteVersion.version));
  return sites.flatMap((site) => {
    const mine = versions.filter((v) => v.siteId === site.id);
    const newest = mine[0];
    return newest ? [{ site, current: parsed(newest), versions: mine.length }] : [];
  });
}

/** The back office's view of one site; `tx` is the operator's (connections of its clients). */
export async function siteView(tx: Tx, entry: CatalogueSite): Promise<BrowserSiteView> {
  const [count] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(connection)
    .where(
      and(
        eq(connection.connector, "browser"),
        sql`${connection.config}->>'site' = ${entry.site.slug}`,
      ),
    );
  const profile = entry.current.parsed ?? BrowserSiteProfile.parse(entry.current.profile);
  return {
    id: entry.site.id,
    slug: entry.site.slug,
    name: entry.site.name,
    tier: entry.site.tier,
    notes: entry.site.notes,
    updatedAt: entry.site.updatedAt.toISOString(),
    current: {
      id: entry.current.id,
      version: entry.current.version,
      profile,
      changeNote: entry.current.changeNote,
      createdAt: entry.current.createdAt.toISOString(),
    },
    versions: entry.versions,
    connections: count?.n ?? 0,
  };
}

/** Sites a client may set up a browser login on: never blocked ones, nor broken profiles. */
export function offers(entries: CatalogueSite[]): BrowserSiteOffer[] {
  return entries.flatMap((e) =>
    e.site.tier === "blocked" || !e.current.parsed
      ? []
      : [
          {
            slug: e.site.slug,
            name: e.site.name,
            tier: e.site.tier,
            secondFactor: e.current.parsed.login.secondFactor.kind,
          },
        ],
  );
}

/** The catalogue from inside a client's transaction (portal requests). */
export function catalogueForClient(tx: Tx, slugs?: readonly string[]): Promise<CatalogueSite[]> {
  return readOperatorCatalogue(tx, (inner) => catalogue(inner, slugs));
}

/** What a run signs in with: the site's live tier and the version the connection pinned. */
export async function pinnedSite(
  db: Db,
  ref: { slug: string; versionId: string },
): Promise<PinnedBrowserSite | null> {
  return withOperator(db, [], async (tx) => {
    const [row] = await tx
      .select({ site: browserSite, version: browserSiteVersion })
      .from(browserSiteVersion)
      .innerJoin(browserSite, eq(browserSite.id, browserSiteVersion.siteId))
      .where(and(eq(browserSiteVersion.id, ref.versionId), eq(browserSite.slug, ref.slug)));
    if (!row) return null;
    const profile = BrowserSiteProfile.safeParse(row.version.profile);
    if (!profile.success) return null;
    return {
      slug: row.site.slug,
      name: row.site.name,
      tier: row.site.tier as BrowserTier,
      versionId: row.version.id,
      version: row.version.version,
      profile: profile.data,
    };
  });
}
