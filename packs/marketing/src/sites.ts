// A client's measured websites: added and changed by a person in the back office (the pack's
// actions, `/api/ops/clients/:id/packs/marketing/actions/:action`), never by an agent. Each site's
// snippet posts to the platform's inbound route with the client's and the site's ids.

import { complianceOf, inboundHeld } from "@countersign/core";
import { type Db, type Tx, tenant, withTenant } from "@countersign/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { TRACK_NAME } from "./measure/events";
import { SITE_STATUSES, site } from "./schema";

/** A refused site change; apps/api answers it 422 `refused` (`PackRefusal`, like Materials'). */
export class SiteError extends Error {
  override name = "PackRefusal";
  constructor(
    readonly code: "invalid_domain" | "site_exists" | "unknown_site",
    message: string,
  ) {
    super(message);
  }
}

/** One DNS label: letters, digits and inner hyphens, at most 63 characters. */
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** `https://www.Example.com/path` → `example.com`; null when it is not a domain. */
export function normalizeDomain(input: string): string | null {
  let host = input.trim().toLowerCase();
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) host = new URL(host).hostname;
  } catch {
    return null;
  }
  // No regular expression runs over the whole input (CodeQL: a backtracking pattern on a long
  // string of slashes): cut at the first slash, then check each label on its own.
  const slash = host.indexOf("/");
  if (slash !== -1) host = host.slice(0, slash);
  if (host.startsWith("www.")) host = host.slice(4);
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.length === 0 || host.length > 253) return null;
  const labels = host.split(".");
  return labels.length >= 2 && labels.every((l) => DNS_LABEL.test(l)) ? host : null;
}

const Goals = z.array(z.string().regex(TRACK_NAME, "a data-track name")).max(20);

export const AddSiteInput = z.strictObject({
  domain: z.string().min(3).max(253),
  name: z.string().trim().min(1).max(120),
  goals: Goals.default([]),
});

export const UpdateSiteInput = z.strictObject({
  siteId: z.uuid(),
  name: z.string().trim().min(1).max(120).optional(),
  goals: Goals.optional(),
  status: z.enum(SITE_STATUSES).optional(),
});

export interface SiteRow {
  id: string;
  domain: string;
  name: string;
  goals: string[];
  status: string;
  createdAt: string;
}

const toRow = (r: typeof site.$inferSelect): SiteRow => ({
  id: r.id,
  domain: r.domain,
  name: r.name,
  goals: r.goals,
  status: r.status,
  createdAt: r.createdAt.toISOString(),
});

export async function listSites(tx: Tx, tenantId: string): Promise<SiteRow[]> {
  const rows = await tx
    .select()
    .from(site)
    .where(eq(site.tenantId, tenantId))
    .orderBy(asc(site.createdAt));
  return rows.map(toRow);
}

export interface SiteStatusRow extends SiteRow {
  /** The last day a beacon was stored (today's included); null before the first. */
  lastEventDay: string | null;
  /** The last day the nightly build finished; null before the first. */
  dataThrough: string | null;
  /** Visits in the seven finished days to yesterday. */
  visitsLast7: number;
}

/**
 * The Sites report (M44): each of the client's sites, and whether its figures are coming in.
 * M50: `measurementHeld` when the client is in HIPAA mode, so the platform stores nothing its
 * sites send (docs/plan.md §1.78).
 */
export async function sitesReport(
  tx: Tx,
  tenantId: string,
  today: string,
): Promise<{ sites: SiteStatusRow[]; measurementHeld: boolean }> {
  const [client] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  const measurementHeld = inboundHeld(
    complianceOf(client?.settings as Record<string, unknown> | undefined),
  );
  const sites = await listSites(tx, tenantId);
  const rows = await tx.execute<{
    site_id: string;
    last_event: string | null;
    built: string | null;
    visits: number;
  }>(sql`
    select s.id as site_id,
           (select max(day)::text from site_event e
             where e.tenant_id = s.tenant_id and e.site_id = s.id) as last_event,
           (select max(day)::text from site_daily_total t
             where t.tenant_id = s.tenant_id and t.site_id = s.id and t.dimension = 'all') as built,
           (select coalesce(sum(visits), 0)::int from site_daily_total t
             where t.tenant_id = s.tenant_id and t.site_id = s.id and t.dimension = 'all'
               and t.day between ${today}::date - 7 and ${today}::date - 1) as visits
    from site s where s.tenant_id = ${tenantId}`);
  const by = new Map([...rows].map((r) => [r.site_id, r]));
  return {
    sites: sites.map((s) => ({
      ...s,
      lastEventDay: by.get(s.id)?.last_event ?? null,
      dataThrough: by.get(s.id)?.built ?? null,
      visitsLast7: Number(by.get(s.id)?.visits ?? 0),
    })),
    measurementHeld,
  };
}

export async function addSite(
  db: Db,
  ctx: { tenantId: string; userId: string; input: z.infer<typeof AddSiteInput> },
): Promise<SiteRow> {
  const domain = normalizeDomain(ctx.input.domain);
  if (!domain) throw new SiteError("invalid_domain", `${ctx.input.domain} is not a domain`);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .insert(site)
      .values({
        tenantId: ctx.tenantId,
        domain,
        name: ctx.input.name,
        goals: [...new Set(ctx.input.goals)],
        createdByUserId: ctx.userId,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new SiteError("site_exists", `${domain} is already measured for this client`);
    return toRow(row);
  });
}

export async function updateSite(
  db: Db,
  ctx: { tenantId: string; input: z.infer<typeof UpdateSiteInput> },
): Promise<SiteRow> {
  const { siteId, ...change } = ctx.input;
  return withTenant(db, ctx.tenantId, async (tx) => {
    const set = {
      ...(change.name !== undefined ? { name: change.name } : {}),
      ...(change.goals !== undefined ? { goals: [...new Set(change.goals)] } : {}),
      ...(change.status !== undefined ? { status: change.status } : {}),
    };
    const where = and(eq(site.tenantId, ctx.tenantId), eq(site.id, siteId));
    const [row] = Object.keys(set).length
      ? await tx.update(site).set(set).where(where).returning()
      : await tx.select().from(site).where(where);
    if (!row) throw new SiteError("unknown_site", "no such site for this client");
    return toRow(row);
  });
}
