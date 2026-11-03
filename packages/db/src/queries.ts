// Small typed queries the platform needs before it has a client scope. Everything else reads and
// writes inside withTenant / withTenants / withOperator, in the package that owns the data.

import { eq } from "drizzle-orm";
import { type Db, withUser } from "./client";
import { membership, tenant } from "./schema";

export interface UserMembership {
  tenantId: string;
  tenantName: string;
  role: (typeof membership.$inferSelect)["role"];
}

/**
 * The clients a user belongs to, with their role in each: what a session may name in
 * `app.tenant_ids`. Runs under the `own_memberships` policy, so it sees this user's rows only.
 */
export function userMemberships(db: Db, userId: string): Promise<UserMembership[]> {
  return withUser(db, userId, (tx) =>
    tx
      .select({ tenantId: membership.tenantId, tenantName: tenant.name, role: membership.role })
      .from(membership)
      .innerJoin(tenant, eq(tenant.id, membership.tenantId))
      .where(eq(membership.userId, userId))
      .orderBy(tenant.name),
  );
}
