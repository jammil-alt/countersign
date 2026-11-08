// A client's measured websites: added and changed by a person in the back office (the pack's
// actions, `/api/ops/clients/:id/packs/marketing/actions/:action`), never by an agent. Each site's
// snippet posts to the platform's inbound route with the client's and the site's ids.

import { type Db, type Tx, withTenant } from "@countersign/db";
import { and, asc, eq } from "drizzle-orm";
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

/** `https://www.Example.com/path` → `example.com`; null when it is not a domain. */
export function normalizeDomain(input: string): string | null {
  let host = input.trim().toLowerCase();
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) host = new URL(host).hostname;
  } catch {
    return null;
  }
  host = host
    .replace(/\/.*$/, "")
    .replace(/^www\./, "")
    .replace(/\.$/, "");
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)
    ? host
    : null;
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
