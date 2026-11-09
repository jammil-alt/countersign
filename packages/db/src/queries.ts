// Small typed queries the platform needs before it has a client scope. Everything else reads and
// writes inside withTenant / withTenants / withOperator, in the package that owns the data.

import { and, eq, isNull, or, sql } from "drizzle-orm";
import { type Db, type Tx, withUser } from "./client";
import { appUser, membership, tenant } from "./schema";

export interface UserMembership {
  tenantId: string;
  tenantName: string;
  role: (typeof membership.$inferSelect)["role"];
}

/**
 * The clients a user belongs to, with their role in each: what a session may name in
 * `app.tenant_ids`. Runs under the `own_memberships` policy, so it sees this user's rows only.
 * A retired client (docs/plan.md §1.35) is left out for its own users, so they can no longer sign
 * in to it; operators keep it, to see its retirement through.
 */
export function userMemberships(db: Db, userId: string): Promise<UserMembership[]> {
  return withUser(db, userId, (tx) => membershipsQuery(tx, userId));
}

function membershipsQuery(tx: Tx, userId: string) {
  return tx
    .select({ tenantId: membership.tenantId, tenantName: tenant.name, role: membership.role })
    .from(membership)
    .innerJoin(tenant, eq(tenant.id, membership.tenantId))
    .where(
      and(
        eq(membership.userId, userId),
        or(isNull(tenant.retiredAt), eq(membership.role, "operator")),
      ),
    )
    .orderBy(tenant.name);
}

/**
 * A signed-in user and their memberships, for a request's session: both reads in one transaction,
 * sent with its scope, instead of a lookup and then a transaction of its own (docs/plan.md §1.82).
 * `user` is null when the row is gone.
 */
export function userWithMemberships(
  db: Db,
  userId: string,
): Promise<{
  user: { id: string; email: string; name: string | null } | null;
  memberships: UserMembership[];
}> {
  return withUser(db, userId, async (tx) => {
    const [users, memberships] = await Promise.all([
      tx
        .select({ id: appUser.id, email: appUser.email, name: appUser.name })
        .from(appUser)
        .where(eq(appUser.id, userId)),
      membershipsQuery(tx, userId),
    ]);
    return { user: users[0] ?? null, memberships };
  });
}

/**
 * Every membership one user has, in any client, read from inside a request's transaction: inviting
 * an address must know whether it already belongs to another client (client users belong to
 * exactly one) or is an operator, which the request's own scope can't see. Names the user for the
 * `own_memberships` policy for this one read, then clears it again. Only client ids and roles come
 * back, and the caller must not show them to the person who asked.
 */
// DECISION: the check runs in the request's own transaction (the Worker has one connection per
// request) rather than in a second `withUser` transaction, which would wait on that connection.
export async function membershipsOfUser(
  tx: Tx,
  userId: string,
): Promise<{ tenantId: string; role: UserMembership["role"] }[]> {
  await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
  const rows = await tx
    .select({ tenantId: membership.tenantId, role: membership.role })
    .from(membership)
    .where(eq(membership.userId, userId));
  await tx.execute(sql`select set_config('app.user_id', '', true)`);
  return rows;
}
