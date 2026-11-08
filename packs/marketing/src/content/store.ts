// Guides and the claims list over the database (migration 0038; docs/marketing-plan.md §4.5,
// §11.4): pages and their versions, publishes, redirects and claims versions, for one client,
// always inside that client's transaction (withTenant) and filtered by its id (invariant 1).
//
// A page's address is fixed when it is created: `content_page.path` never changes (0038's trigger),
// so a guide that has been published keeps its address, and a guide that must move is a new page
// with a redirect from the old path. Versions are never changed: an edit, a restore and an agent's
// draft are each a new version. Publishing goes through the `website` connector's
// `website.publish`, a change a person always signs (./publish.ts); this file records the outcome.

import { connection, type Tx } from "@countersign/db";
import { and, asc, count, desc, eq, inArray, max, sql } from "drizzle-orm";
import { PackRefusal } from "../pack";
import {
  claimsVersion,
  contentPage,
  contentPublish,
  contentRedirect,
  contentVersion,
  searchQueryDaily,
  site,
  siteDailyPage,
} from "../schema";
import { type Checked, checkGuide, GUIDES_PREFIX, queryInTitle, slugOf } from "./checks";
import { type ClaimsList, ClaimsList as ClaimsListSchema, EMPTY_CLAIMS } from "./claims";

type PageRow = typeof contentPage.$inferSelect;
type VersionRow = typeof contentVersion.$inferSelect;

export const WEBSITE_CONNECTOR = "website";

/** Who wrote a version: a person, or an agent version (with its run). */
export type Author =
  | { kind: "person"; userId: string }
  | { kind: "agent"; agentVersionId: string; runId: string | null };

export interface VersionOut {
  id: string;
  version: number;
  title: string;
  description: string;
  body: string;
  targetQueries: string[];
  author: "person" | "agent";
  authorUserId: string | null;
  authorAgentVersionId: string | null;
  runId: string | null;
  why: string | null;
  createdAt: string;
  live: boolean;
}

export interface PageOut {
  id: string;
  siteId: string;
  path: string;
  slug: string | null;
  kind: string;
  status: string;
  title: string;
  latestVersion: number | null;
  liveVersion: number | null;
  /** Whether the newest version is the one visitors see. */
  changedSinceLive: boolean;
  createdBy: "person" | "agent";
  createdAt: string;
  updatedAt: string;
  lastPublishedAt: string | null;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function versionOut(v: VersionRow, liveId: string | null): VersionOut {
  return {
    id: v.id,
    version: v.version,
    title: v.title,
    description: v.description,
    body: v.bodyMd,
    targetQueries: v.targetQueries,
    author: v.authorAgentVersionId ? "agent" : "person",
    authorUserId: v.authorUserId,
    authorAgentVersionId: v.authorAgentVersionId,
    runId: v.runId,
    why: v.why,
    createdAt: v.createdAt.toISOString(),
    live: v.id === liveId,
  };
}

// ── Sites and the website connection ─────────────────────────────────────────────────────────────

export async function siteOf(tx: Tx, tenantId: string, siteId: string) {
  const [row] = await tx
    .select()
    .from(site)
    .where(and(eq(site.tenantId, tenantId), eq(site.id, siteId)));
  return row ?? null;
}

/** The client's site a query names, or its first one; null when it has none. */
export async function pickSite(tx: Tx, tenantId: string, siteId: string | undefined) {
  if (siteId) {
    const row = await siteOf(tx, tenantId, siteId);
    if (!row) throw new PackRefusal("unknown_site", "That site isn't one of this client's.");
    return row;
  }
  const [first] = await tx
    .select()
    .from(site)
    .where(eq(site.tenantId, tenantId))
    .orderBy(asc(site.createdAt))
    .limit(1);
  return first ?? null;
}

export interface WebsiteConnection {
  id: string;
  status: string;
  /** The domain it publishes to (`connection.config.domain`), set by the operator. */
  domain: string | null;
}

/** The client's website connection (the newest; a client has at most one per connector in v1). */
export async function websiteConnection(
  tx: Tx,
  tenantId: string,
): Promise<WebsiteConnection | null> {
  const [row] = await tx
    .select({ id: connection.id, status: connection.status, config: connection.config })
    .from(connection)
    .where(and(eq(connection.tenantId, tenantId), eq(connection.connector, WEBSITE_CONNECTOR)))
    .orderBy(desc(connection.createdAt))
    .limit(1);
  if (!row) return null;
  const domain = (row.config as { domain?: unknown } | null)?.domain;
  return { id: row.id, status: row.status, domain: typeof domain === "string" ? domain : null };
}

/**
 * Points the client's website connection at one of its sites: what `website.publish` writes to.
 * A person's (the operator's) action; an agent never sets it, and the connector only ever writes
 * under this domain.
 */
// DECISION: the domain lives on the connection's config, set from a site of the same client, so
// a website connection can never be pointed at another client's domain by an agent's input; the
// connector writes only under `site/<config.domain>/`.
export async function pointWebsite(
  tx: Tx,
  tenantId: string,
  siteId: string,
  userId: string,
): Promise<WebsiteConnection> {
  const target = await siteOf(tx, tenantId, siteId);
  if (!target) throw new PackRefusal("unknown_site", "That site isn't one of this client's.");
  const conn = await websiteConnection(tx, tenantId);
  if (!conn) {
    throw new PackRefusal(
      "no_website_connection",
      "Add the Website connection for this client first (its connections page).",
    );
  }
  const [row] = await tx
    .select({ config: connection.config })
    .from(connection)
    .where(and(eq(connection.tenantId, tenantId), eq(connection.id, conn.id)));
  const config = { ...((row?.config as Record<string, unknown> | null) ?? {}) };
  config.domain = target.domain;
  config.domainSetBy = userId;
  config.domainSetAt = new Date().toISOString();
  await tx
    .update(connection)
    .set({ config })
    .where(and(eq(connection.tenantId, tenantId), eq(connection.id, conn.id)));
  return { ...conn, domain: target.domain };
}

// ── Claims ───────────────────────────────────────────────────────────────────────────────────────

export interface ClaimsVersionOut {
  id: string;
  version: number;
  list: ClaimsList;
  createdByUserId: string | null;
  createdAt: string;
}

/** The client's claims list in force: its newest version, or none. */
export async function latestClaims(tx: Tx, tenantId: string): Promise<ClaimsVersionOut | null> {
  const [row] = await tx
    .select()
    .from(claimsVersion)
    .where(eq(claimsVersion.tenantId, tenantId))
    .orderBy(desc(claimsVersion.version))
    .limit(1);
  if (!row) return null;
  const parsed = ClaimsListSchema.safeParse(row.body);
  return {
    id: row.id,
    version: row.version,
    // A stored list that no longer parses (the schema grew stricter) still gives the house rules.
    list: parsed.success ? parsed.data : { ...EMPTY_CLAIMS, title: "Unreadable list" },
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function claimsHistory(tx: Tx, tenantId: string) {
  const rows = await tx
    .select({
      id: claimsVersion.id,
      version: claimsVersion.version,
      createdByUserId: claimsVersion.createdByUserId,
      createdAt: claimsVersion.createdAt,
    })
    .from(claimsVersion)
    .where(eq(claimsVersion.tenantId, tenantId))
    .orderBy(desc(claimsVersion.version))
    .limit(100);
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

/** A new version of the client's claims list (never an edit of the old one). */
export async function saveClaims(
  tx: Tx,
  tenantId: string,
  list: ClaimsList,
  userId: string,
  options: { onlyIfNone?: boolean } = {},
): Promise<ClaimsVersionOut> {
  const [top] = await tx
    .select({ n: max(claimsVersion.version) })
    .from(claimsVersion)
    .where(eq(claimsVersion.tenantId, tenantId));
  const current = top?.n ?? 0;
  if (options.onlyIfNone && current > 0) {
    throw new PackRefusal(
      "claims_exist",
      "This client already has a claims list; save a new version from the Claims page.",
    );
  }
  const [row] = await tx
    .insert(claimsVersion)
    .values({ tenantId, version: current + 1, body: list, createdByUserId: userId })
    .returning();
  if (!row) throw new Error("claims_version insert returned nothing");
  return {
    id: row.id,
    version: row.version,
    list,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

// ── Where a link may point ───────────────────────────────────────────────────────────────────────

/**
 * Every path an internal link in a guide may point at: the site's front page, the pages its
 * measurement has seen, its live guides, the paths its redirects answer, and the guide's own.
 */
// DECISION: the site's own pages are the paths measurement has counted (site_daily_page), so the
// pack needs no list of a client's pages; a page nobody has visited yet is the one false refusal,
// and the person links it once it has had a view (or publishes without the link).
export async function linkPaths(
  tx: Tx,
  tenantId: string,
  siteId: string,
  own?: string,
): Promise<Set<string>> {
  const out = new Set<string>(["/"]);
  if (own) out.add(own);
  const measured = await tx
    .selectDistinct({ path: siteDailyPage.path })
    .from(siteDailyPage)
    .where(and(eq(siteDailyPage.tenantId, tenantId), eq(siteDailyPage.siteId, siteId)))
    .limit(5000);
  for (const r of measured) out.add(r.path.length > 1 ? r.path.replace(/\/$/, "") : r.path);
  const live = await tx
    .select({ path: contentPage.path })
    .from(contentPage)
    .where(
      and(
        eq(contentPage.tenantId, tenantId),
        eq(contentPage.siteId, siteId),
        eq(contentPage.status, "published"),
      ),
    );
  for (const r of live) out.add(r.path);
  const redirects = await tx
    .select({ from: contentRedirect.fromPath })
    .from(contentRedirect)
    .where(and(eq(contentRedirect.tenantId, tenantId), eq(contentRedirect.siteId, siteId)));
  for (const r of redirects) out.add(r.from);
  return out;
}

/** A draft checked as publishing would check it, with this client's paths and claims list. */
export async function checkFor(
  tx: Tx,
  tenantId: string,
  siteId: string,
  draft: { title: string; description: string; body: string },
  own?: string,
): Promise<Checked> {
  const [target, claims, paths] = await Promise.all([
    siteOf(tx, tenantId, siteId),
    latestClaims(tx, tenantId),
    linkPaths(tx, tenantId, siteId, own),
  ]);
  return checkGuide(draft, {
    paths,
    ...(claims ? { claims: claims.list } : {}),
    ...(target ? { domain: target.domain } : {}),
  });
}

// ── Pages and versions ───────────────────────────────────────────────────────────────────────────

export async function pageOf(tx: Tx, tenantId: string, pageId: string): Promise<PageRow | null> {
  const [row] = await tx
    .select()
    .from(contentPage)
    .where(and(eq(contentPage.tenantId, tenantId), eq(contentPage.id, pageId)));
  return row ?? null;
}

export async function versionOf(
  tx: Tx,
  tenantId: string,
  versionId: string,
): Promise<VersionRow | null> {
  const [row] = await tx
    .select()
    .from(contentVersion)
    .where(and(eq(contentVersion.tenantId, tenantId), eq(contentVersion.id, versionId)));
  return row ?? null;
}

export async function latestVersion(
  tx: Tx,
  tenantId: string,
  pageId: string,
): Promise<VersionRow | null> {
  const [row] = await tx
    .select()
    .from(contentVersion)
    .where(and(eq(contentVersion.tenantId, tenantId), eq(contentVersion.pageId, pageId)))
    .orderBy(desc(contentVersion.version))
    .limit(1);
  return row ?? null;
}

/** A client's guides on one site (or all its sites), newest change first. */
export async function listPages(
  tx: Tx,
  tenantId: string,
  filter: { siteId?: string; status?: string } = {},
): Promise<PageOut[]> {
  const pages = await tx
    .select()
    .from(contentPage)
    .where(
      and(
        eq(contentPage.tenantId, tenantId),
        filter.siteId ? eq(contentPage.siteId, filter.siteId) : undefined,
        filter.status ? eq(contentPage.status, filter.status as PageRow["status"]) : undefined,
      ),
    )
    .limit(1000);
  if (pages.length === 0) return [];
  const ids = pages.map((p) => p.id);
  const versions = await tx
    .select({
      id: contentVersion.id,
      pageId: contentVersion.pageId,
      version: contentVersion.version,
      title: contentVersion.title,
      createdAt: contentVersion.createdAt,
    })
    .from(contentVersion)
    .where(and(eq(contentVersion.tenantId, tenantId), inArray(contentVersion.pageId, ids)))
    .orderBy(asc(contentVersion.version));
  const publishes = await tx
    .select({ pageId: contentPublish.pageId, at: max(contentPublish.at) })
    .from(contentPublish)
    .where(
      and(
        eq(contentPublish.tenantId, tenantId),
        inArray(contentPublish.pageId, ids),
        eq(contentPublish.action, "publish"),
      ),
    )
    .groupBy(contentPublish.pageId);
  const lastPublished = new Map(publishes.map((p) => [p.pageId, p.at]));
  const byPage = new Map<string, typeof versions>();
  for (const v of versions) byPage.set(v.pageId, [...(byPage.get(v.pageId) ?? []), v]);
  const out = pages.map((p): PageOut => {
    const vs = byPage.get(p.id) ?? [];
    const newest = vs[vs.length - 1];
    const live = vs.find((v) => v.id === p.liveVersionId);
    return {
      id: p.id,
      siteId: p.siteId,
      path: p.path,
      slug: slugOf(p.path),
      kind: p.kind,
      status: p.status,
      title: newest?.title ?? "",
      latestVersion: newest?.version ?? null,
      liveVersion: live?.version ?? null,
      changedSinceLive: p.status === "published" && newest !== undefined && newest.id !== live?.id,
      createdBy: p.createdByAgentVersionId ? "agent" : "person",
      createdAt: p.createdAt.toISOString(),
      updatedAt: (newest?.createdAt ?? p.createdAt).toISOString(),
      lastPublishedAt: iso(lastPublished.get(p.id)),
    };
  });
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export interface PublishOut {
  id: string;
  action: string;
  version: number | null;
  externalActionId: string | null;
  byUserId: string;
  at: string;
}

/** One guide in full, for the editor: its versions, publishes, the newest checked. */
export async function pageDetail(tx: Tx, tenantId: string, pageId: string) {
  const page = await pageOf(tx, tenantId, pageId);
  if (!page) return null;
  const target = await siteOf(tx, tenantId, page.siteId);
  const versions = await tx
    .select()
    .from(contentVersion)
    .where(and(eq(contentVersion.tenantId, tenantId), eq(contentVersion.pageId, pageId)))
    .orderBy(desc(contentVersion.version))
    .limit(200);
  const numbers = new Map(versions.map((v) => [v.id, v.version]));
  const publishes = await tx
    .select()
    .from(contentPublish)
    .where(and(eq(contentPublish.tenantId, tenantId), eq(contentPublish.pageId, pageId)))
    .orderBy(desc(contentPublish.at))
    .limit(100);
  const newest = versions[0] ?? null;
  const check = newest
    ? await checkFor(
        tx,
        tenantId,
        page.siteId,
        { title: newest.title, description: newest.description, body: newest.bodyMd },
        page.path,
      )
    : null;
  const conn = await websiteConnection(tx, tenantId);
  return {
    page: {
      id: page.id,
      siteId: page.siteId,
      path: page.path,
      slug: slugOf(page.path),
      kind: page.kind,
      status: page.status,
      createdBy: page.createdByAgentVersionId ? "agent" : "person",
      createdAt: page.createdAt.toISOString(),
      // DECISION: the address is fixed from the start (0038 lets only status and live version
      // change); a guide that must move is a new page and a redirect.
      addressFixed: true,
    },
    site: target ? { id: target.id, domain: target.domain, name: target.name } : null,
    liveVersion: page.liveVersionId ? (numbers.get(page.liveVersionId) ?? null) : null,
    versions: versions.map((v) => versionOut(v, page.liveVersionId)),
    publishes: publishes.map(
      (p): PublishOut => ({
        id: p.id,
        action: p.action,
        version: numbers.get(p.versionId) ?? null,
        externalActionId: p.externalActionId,
        byUserId: p.byUserId,
        at: p.at.toISOString(),
      }),
    ),
    check: check
      ? {
          html: check.rendered.html,
          headings: check.rendered.headings,
          problems: check.problems,
          words: check.words,
          publishable: check.publishable,
        }
      : null,
    queries: await queryFigures(
      tx,
      tenantId,
      page.siteId,
      newest?.targetQueries ?? [],
      newest?.title ?? "",
    ),
    website: websiteState(conn, target?.domain ?? null),
  };
}

/** Whether publishing can reach this site: a website connection pointed at its domain. */
export function websiteState(conn: WebsiteConnection | null, domain: string | null) {
  return {
    connected: conn !== null && conn.status !== "disconnected",
    domain: conn?.domain ?? null,
    pointsHere: conn !== null && domain !== null && conn.domain === domain,
  };
}

/** A new guide at `/guides/<slug>` on one of the client's sites. Its address never changes. */
export async function createPage(
  tx: Tx,
  tenantId: string,
  input: { siteId: string; slug: string },
  by: Author,
): Promise<PageRow> {
  const target = await siteOf(tx, tenantId, input.siteId);
  if (!target) throw new PackRefusal("unknown_site", "That site isn't one of this client's.");
  const path = `${GUIDES_PREFIX}${input.slug}`;
  if (slugOf(path) === null) {
    throw new PackRefusal(
      "invalid_slug",
      "An address is lowercase words joined by single hyphens, e.g. approval-workflows.",
    );
  }
  const [taken] = await tx
    .select({ id: contentPage.id })
    .from(contentPage)
    .where(
      and(
        eq(contentPage.tenantId, tenantId),
        eq(contentPage.siteId, input.siteId),
        eq(contentPage.path, path),
      ),
    );
  if (taken) throw new PackRefusal("address_taken", `There is already a guide at ${path}.`);
  const [redirected] = await tx
    .select({ id: contentRedirect.id })
    .from(contentRedirect)
    .where(
      and(
        eq(contentRedirect.tenantId, tenantId),
        eq(contentRedirect.siteId, input.siteId),
        eq(contentRedirect.fromPath, path),
      ),
    );
  if (redirected) {
    throw new PackRefusal(
      "address_redirected",
      `${path} redirects elsewhere; pick another address.`,
    );
  }
  const [row] = await tx
    .insert(contentPage)
    .values({
      tenantId,
      siteId: input.siteId,
      path,
      kind: "guide",
      ...(by.kind === "person"
        ? { createdByUserId: by.userId }
        : { createdByAgentVersionId: by.agentVersionId }),
    })
    .returning();
  if (!row) throw new Error("content_page insert returned nothing");
  return row;
}

export interface VersionInput {
  title: string;
  description: string;
  body: string;
  targetQueries: string[];
  why?: string | null;
}

/** A new version of a page: the next number, never a change to an old one. */
export async function addVersion(
  tx: Tx,
  tenantId: string,
  pageId: string,
  input: VersionInput,
  by: Author,
): Promise<VersionRow> {
  const page = await pageOf(tx, tenantId, pageId);
  if (!page) throw new PackRefusal("unknown_page", "That guide isn't one of this client's.");
  const [top] = await tx
    .select({ n: max(contentVersion.version) })
    .from(contentVersion)
    .where(and(eq(contentVersion.tenantId, tenantId), eq(contentVersion.pageId, pageId)));
  const [row] = await tx
    .insert(contentVersion)
    .values({
      tenantId,
      pageId,
      version: (top?.n ?? 0) + 1,
      title: input.title.trim(),
      description: input.description.trim(),
      bodyMd: input.body,
      targetQueries: [...new Set(input.targetQueries.map((q) => q.trim()).filter(Boolean))],
      why: input.why?.trim() || null,
      ...(by.kind === "person"
        ? { authorUserId: by.userId }
        : { authorAgentVersionId: by.agentVersionId, runId: by.runId }),
    })
    .returning();
  if (!row) throw new Error("content_version insert returned nothing");
  return row;
}

/** How many times a page has gone up or come down: part of a publish's idempotency key. */
export async function publishCount(tx: Tx, tenantId: string, pageId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(contentPublish)
    .where(and(eq(contentPublish.tenantId, tenantId), eq(contentPublish.pageId, pageId)));
  return Number(row?.n ?? 0);
}

/** Records a publish or unpublish that went through, with the external action that did it. */
export async function recordPublish(
  tx: Tx,
  tenantId: string,
  input: {
    pageId: string;
    versionId: string;
    action: "publish" | "unpublish";
    externalActionId: string | null;
    userId: string;
  },
): Promise<void> {
  await tx.insert(contentPublish).values({
    tenantId,
    pageId: input.pageId,
    versionId: input.versionId,
    action: input.action,
    externalActionId: input.externalActionId,
    byUserId: input.userId,
  });
  await tx
    .update(contentPage)
    .set(
      input.action === "publish"
        ? { status: "published", liveVersionId: input.versionId }
        : { status: "unpublished" },
    )
    .where(and(eq(contentPage.tenantId, tenantId), eq(contentPage.id, input.pageId)));
}

// ── Redirects ────────────────────────────────────────────────────────────────────────────────────

export async function redirectsOf(tx: Tx, tenantId: string, siteId: string) {
  const rows = await tx
    .select({ from: contentRedirect.fromPath, to: contentRedirect.toPath })
    .from(contentRedirect)
    .where(and(eq(contentRedirect.tenantId, tenantId), eq(contentRedirect.siteId, siteId)))
    .orderBy(asc(contentRedirect.fromPath))
    .limit(1000);
  return rows;
}

/** A redirect from an old path to another; adding one for a path again re-points it. */
export async function addRedirect(
  tx: Tx,
  tenantId: string,
  input: { siteId: string; from: string; to: string },
  userId: string,
): Promise<void> {
  const target = await siteOf(tx, tenantId, input.siteId);
  if (!target) throw new PackRefusal("unknown_site", "That site isn't one of this client's.");
  if (input.from === input.to) {
    throw new PackRefusal("redirect_self", "A redirect goes to a different path.");
  }
  const [live] = await tx
    .select({ id: contentPage.id })
    .from(contentPage)
    .where(
      and(
        eq(contentPage.tenantId, tenantId),
        eq(contentPage.siteId, input.siteId),
        eq(contentPage.path, input.from),
        eq(contentPage.status, "published"),
      ),
    );
  if (live) {
    throw new PackRefusal(
      "redirect_live",
      `${input.from} is a live guide; unpublish it before redirecting its address.`,
    );
  }
  await tx
    .insert(contentRedirect)
    .values({
      tenantId,
      siteId: input.siteId,
      fromPath: input.from,
      toPath: input.to,
      createdByUserId: userId,
    })
    .onConflictDoUpdate({
      target: [contentRedirect.tenantId, contentRedirect.siteId, contentRedirect.fromPath],
      set: { toPath: input.to },
    });
}

/**
 * Each target query's search figures on the site over the last 28 days of search data (all
 * pages and both providers), and whether the title has its words.
 */
export async function queryFigures(
  tx: Tx,
  tenantId: string,
  siteId: string,
  queries: readonly string[],
  title: string,
) {
  if (queries.length === 0) return [];
  const lower = queries.map((q) => q.toLowerCase());
  const rows = await tx
    .select({
      query: sql<string>`lower(${searchQueryDaily.query})`,
      impressions: sql<number>`coalesce(sum(${searchQueryDaily.impressions}), 0)::int`,
      clicks: sql<number>`coalesce(sum(${searchQueryDaily.clicks}), 0)::int`,
      position: sql<
        string | null
      >`round(sum(${searchQueryDaily.position} * ${searchQueryDaily.impressions}) / nullif(sum(${searchQueryDaily.impressions}) filter (where ${searchQueryDaily.position} is not null), 0), 1)::text`,
    })
    .from(searchQueryDaily)
    .where(
      and(
        eq(searchQueryDaily.tenantId, tenantId),
        eq(searchQueryDaily.siteId, siteId),
        inArray(sql`lower(${searchQueryDaily.query})`, lower),
        sql`${searchQueryDaily.day} > (select max(d.day) from search_query_daily d where d.tenant_id = ${tenantId} and d.site_id = ${siteId}) - 28`,
      ),
    )
    .groupBy(sql`lower(${searchQueryDaily.query})`);
  const byQuery = new Map(rows.map((r) => [r.query, r]));
  return queries.map((q) => {
    const r = byQuery.get(q.toLowerCase());
    return {
      query: q,
      impressions: r?.impressions ?? 0,
      clicks: r?.clicks ?? 0,
      position: r?.position ?? null,
      inTitle: queryInTitle(q, title),
    };
  });
}
