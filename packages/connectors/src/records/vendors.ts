// Vendors (ARCHITECTURE §5.2) as connectors and the documents capability find them: by normalized
// name within one client, created on first sight.

import { normalizeVendorName } from "@countersign/core";
import { type Tx, vendor } from "@countersign/db";
import { and, eq, sql } from "drizzle-orm";

export type VendorRow = typeof vendor.$inferSelect;

/** The client's vendor with this name (or alias), or null. */
export async function findVendor(
  tx: Tx,
  tenantId: string,
  name: string,
): Promise<VendorRow | null> {
  const key = normalizeVendorName(name);
  if (!key) return null;
  const [row] = await tx
    .select()
    .from(vendor)
    .where(
      and(
        eq(vendor.tenantId, tenantId),
        sql`(${vendor.normalizedName} = ${key} or ${key} = any(${vendor.aliases}))`,
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The client's vendor with this name, created when there is none. Null for an empty name. */
export async function findOrCreateVendor(
  tx: Tx,
  tenantId: string,
  name: string,
): Promise<VendorRow | null> {
  const found = await findVendor(tx, tenantId, name);
  if (found) return found;
  const key = normalizeVendorName(name);
  if (!key) return null;
  await tx
    .insert(vendor)
    .values({ tenantId, name: name.trim(), normalizedName: key })
    .onConflictDoNothing({ target: [vendor.tenantId, vendor.normalizedName] });
  return findVendor(tx, tenantId, name);
}
