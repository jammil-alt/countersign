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
 * A signed-in user and their memberships, for a request's session: one statement, sent with its
 * scope, instead of a lookup and then a transaction of its own (docs/plan.md §1.82).
 * `user` is null when the row is gone.
 */
export function userWithMemberships(
  db: Db,
  userId: string,
): Promise<{
  user: { id: string; email: string; name: string | null } | null;
  memberships: UserMembership[];
}> {
  return withUser(db, userId, (tx) => accountIn(tx, userId));
}

/**
 * `userWithMemberships` inside a transaction that already names `userId` in `app.user_id` (the
 * first half of `withSession`): the user row and their memberships, read under `own_memberships`,
 * with retired clients left out for their own users as `userMemberships` leaves them out.
 */
// DECISION: one statement for both reads (docs/plan.md §1.84, 5.1): the memberships come back as
// a JSON array beside the user row, so the session costs one statement, not two. The same join,
// filter and order as `membershipsQuery`; RLS applies to the subquery as to any read.
export async function accountIn(
  tx: Tx,
  userId: string,
): Promise<{
  user: { id: string; email: string; name: string | null } | null;
  memberships: UserMembership[];
}> {
  const rows = await tx.execute<{
    id: string;
    email: string;
    name: string | null;
    memberships: UserMembership[] | string;
  }>(sql`select ${appUser.id} as id, ${appUser.email} as email, ${appUser.name} as name,
      coalesce((
        select json_agg(json_build_object(
            'tenantId', ${membership.tenantId}, 'tenantName', ${tenant.name}, 'role', ${membership.role})
          order by ${tenant.name})
        from ${membership} inner join ${tenant} on ${tenant.id} = ${membership.tenantId}
        where ${membership.userId} = ${appUser.id}
          and (${tenant.retiredAt} is null or ${membership.role} = 'operator')
      ), '[]'::json) as memberships
    from ${appUser} where ${appUser.id} = ${userId}`);
  const row = [...rows][0];
  if (!row) return { user: null, memberships: [] };
  // postgres-js parses json; a driver that hands back text is parsed here.
  const memberships =
    typeof row.memberships === "string"
      ? (JSON.parse(row.memberships) as UserMembership[])
      : row.memberships;
  return { user: { id: row.id, email: row.email, name: row.name }, memberships };
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
