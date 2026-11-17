// The back office's Users screen (docs/plan.md §1.122): the operators who serve the clients you
// serve, inviting another and removing one. Every operator is equal for now (an admin of the back
// office). An invite is an `app_user` row (claimed by the first WorkOS sign-in with that verified
// address, as for client people) and an `operator` membership in each client the inviting operator
// serves, never one they don't: the request's scope is those clients (RLS), so an operator can only
// hand on what they have. Removing takes away the memberships in the clients the remover serves.
// The by-hand Add operator and Remove operator workflows stay for a fresh environment and for
// clients nobody signed in serves (packages/db/src/operators.ts).

import { type OperatorMember, routes } from "@countersign/core";
import {
  appUser,
  inboxItem,
  membership,
  membershipsOfUser,
  type Tx,
  tenant,
} from "@countersign/db";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, HttpError, mount, notFound } from "../http";
import { knowsSignIns } from "./onboarding";

/** The operators in these clients, with how many of them each serves. */
async function operatorsIn(
  tx: Tx,
  tenantIds: readonly string[],
  me: string,
  signIns: boolean,
): Promise<OperatorMember[]> {
  if (tenantIds.length === 0) return [];
  const rows = await tx
    .select({
      userId: membership.userId,
      email: appUser.email,
      name: appUser.name,
      workosUserId: appUser.workosUserId,
      clients: count(),
    })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    .where(and(eq(membership.role, "operator"), inArray(membership.tenantId, [...tenantIds])))
    .groupBy(membership.userId, appUser.email, appUser.name, appUser.workosUserId)
    .orderBy(appUser.email);
  return rows.map((r) => ({
    userId: r.userId,
    email: r.email,
    name: r.name,
    signedIn: signIns ? r.workosUserId !== null : null,
    clients: Number(r.clients),
    you: r.userId === me,
  }));
}

export function operatorRouteHandlers(app: Hono<AppEnv>): void {
  mount(app, routes.opsOperators, async (ctx) => ({
    operators: await operatorsIn(ctx.tx, ctx.tenantIds, ctx.session.user.id, knowsSignIns(ctx)),
    clients: ctx.tenantIds.length,
  }));

  // Invite (or, for an operator already here, give them the clients of yours they don't serve).
  // DECISION: a client's own person is never made an operator: that would hand them every client.
  mount(app, routes.opsInviteOperator, async (ctx) => {
    const { tx, body } = ctx;
    const email = body.email.trim().toLowerCase();
    const name = body.name?.trim() || null;
    const [existing] = await tx.select().from(appUser).where(eq(appUser.email, email));
    if (existing) {
      const theirs = await membershipsOfUser(tx, existing.id);
      if (theirs.some((m) => m.role !== "operator")) {
        throw new HttpError(409, "client_person", "that address belongs to a client's people");
      }
    }
    let userId = existing?.id;
    if (!userId) {
      const [row] = await tx
        .insert(appUser)
        .values({ email, name })
        .onConflictDoNothing()
        .returning({ id: appUser.id });
      userId = row?.id;
      if (!userId) throw new HttpError(409, "conflict", "that address was just invited; try again");
    } else if (name && !existing?.name) {
      await tx.update(appUser).set({ name }).where(eq(appUser.id, userId));
    }
    const added = ctx.tenantIds.length
      ? await tx
          .insert(membership)
          .values(
            ctx.tenantIds.map((tenantId) => ({ tenantId, userId, role: "operator" as const })),
          )
          .onConflictDoNothing()
          .returning({ tenantId: membership.tenantId })
      : [];
    const signIns = knowsSignIns(ctx);
    const [operator] = (await operatorsIn(tx, ctx.tenantIds, ctx.session.user.id, signIns)).filter(
      (o) => o.userId === userId,
    );
    if (!operator) throw notFound("operator");
    const result = {
      operator,
      added: added.length,
      email: {
        status: "failed" as "sent" | "not_sent" | "failed",
        reason: "not_attempted" as string | null,
      },
    };
    if (existing?.workosUserId) {
      result.email = { status: "not_sent", reason: "already_signed_up" };
    } else {
      // After the commit, so nobody is emailed about an invite that rolled back (as for clients).
      ctx.afterCommit(async () => {
        const choice = ctx.services.auth();
        if (!choice.ok) return;
        const delivery = await choice.adapter.invite(email);
        result.email =
          delivery.status === "sent"
            ? { status: "sent", reason: null }
            : { status: delivery.status, reason: delivery.reason };
      });
    }
    return result;
  });

  // DECISION: you can't remove yourself here, so the clients you serve always keep an operator
  // (you); the by-hand Remove operator workflow is for the rest.
  mount(app, routes.opsRemoveOperator, async (ctx) => {
    const { tx, params } = ctx;
    if (params.userId === ctx.session.user.id) {
      throw new HttpError(409, "self", "you can't remove yourself; ask another operator");
    }
    const [user] = await tx
      .select({ email: appUser.email })
      .from(appUser)
      .where(eq(appUser.id, params.userId));
    const scope = [...ctx.tenantIds];
    if (!user || scope.length === 0) throw notFound("operator");
    const removed = await tx
      .delete(membership)
      .where(
        and(
          eq(membership.userId, params.userId),
          eq(membership.role, "operator"),
          inArray(membership.tenantId, scope),
        ),
      )
      .returning({ tenantId: membership.tenantId });
    if (removed.length === 0) throw notFound("operator");
    const gone = removed.map((r) => r.tenantId);
    // What waited on them goes to any operator; a client they led has no lead until one is set.
    const moved = await tx
      .update(inboxItem)
      .set({ assigneeUserId: null, assigneeRole: "operator" })
      .where(
        and(
          eq(inboxItem.assigneeUserId, params.userId),
          eq(inboxItem.status, "open"),
          inArray(inboxItem.tenantId, gone),
        ),
      )
      .returning({ id: inboxItem.id });
    await tx
      .update(tenant)
      .set({ settings: sql`jsonb_set(${tenant.settings}, '{lead}'::text[], 'null'::jsonb)` })
      .where(
        and(
          inArray(tenant.id, gone),
          sql`${tenant.settings}->'lead'->>'userId' = ${params.userId}`,
        ),
      );
    return {
      removed: { userId: params.userId, email: user.email },
      clients: removed.length,
      reassigned: moved.length,
    };
  });
}
