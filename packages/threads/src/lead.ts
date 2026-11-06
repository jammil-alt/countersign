// The client's lead (ARCHITECTURE §4, §11.2): `tenant.settings.lead = {userId}`, an operator who
// serves the client, set by the operator. The portal shows the lead by name; lead checks (person
// steps with `assignee: 'lead'`) go to them.

import { appUser, type Db, membership, type Tx, tenant } from "@countersign/db";
import { and, eq, sql } from "drizzle-orm";

export const LEAD_SETTING = "lead";

export interface Lead {
  userId: string;
  name: string | null;
  email: string;
}

/** The lead's user id from a client's settings, or null. */
export function leadUserId(settings: unknown): string | null {
  const lead = (settings as { lead?: { userId?: unknown } } | null)?.lead;
  return typeof lead?.userId === "string" ? lead.userId : null;
}

/** The client's lead, or null when none is set (or the user is gone). */
export async function leadOf(tx: Db | Tx, tenantId: string): Promise<Lead | null> {
  const [t] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  const userId = leadUserId(t?.settings);
  if (!userId) return null;
  const [u] = await tx
    .select({ id: appUser.id, name: appUser.name, email: appUser.email })
    .from(appUser)
    .where(eq(appUser.id, userId));
  return u ? { userId: u.id, name: u.name, email: u.email } : null;
}

/** The name the client sees: the lead's name, else the part of their email before the @. */
export function leadDisplayName(lead: Pick<Lead, "name" | "email">): string {
  return lead.name?.trim() || (lead.email.split("@")[0] ?? lead.email);
}

/** True when the user is an operator member of the client (one who serves it). */
export async function servesClient(tx: Tx, tenantId: string, userId: string): Promise<boolean> {
  const [m] = await tx
    .select({ userId: membership.userId })
    .from(membership)
    .where(
      and(
        eq(membership.tenantId, tenantId),
        eq(membership.userId, userId),
        eq(membership.role, "operator"),
      ),
    );
  return !!m;
}

/**
 * Sets (or clears, with null) the lead in place, so concurrent changes to other settings keys are
 * kept. Returns the previous lead's user id. The caller checks `servesClient` and logs the change.
 */
export async function setLead(
  tx: Tx,
  tenantId: string,
  userId: string | null,
): Promise<string | null> {
  const [before] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId))
    .for("update");
  if (!before) throw new Error("client not found");
  const value = userId ? sql`jsonb_build_object('userId', ${userId}::text)` : sql`'null'::jsonb`;
  await tx
    .update(tenant)
    .set({ settings: sql`jsonb_set(${tenant.settings}, '{lead}'::text[], ${value})` })
    .where(eq(tenant.id, tenantId));
  return leadUserId(before.settings);
}
