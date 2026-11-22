// SOC 2 readiness (docs/plan.md §1.218): the facts the readiness checklist reads from the database
// (the recent access reviews and the last deletion drill), and the quarterly access review's
// record. Operator only; mount() audits every route. The checklist itself is computed from core's
// register on the screen (`soc2Readiness`), so it changes with the code, not the data.

import { quarterOf, soc2Routes } from "@countersign/core";
import { accessReview, accessReviewItem, auditEvent, type Tx, tenant } from "@countersign/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, HttpError, iso, mount, notFound } from "../http";
import { accessReviewUsers } from "./compliance";

/** The deletion drill's audit action (packages/db/src/deletion-drill.ts). */
const DRILL_ACTION = "client.deletion_drill";
/** How many past reviews the readiness view lists. */
const REVIEWS_SHOWN = 8;

const summaryOf = (r: typeof accessReview.$inferSelect) => ({
  id: r.id,
  period: r.period,
  createdAt: r.createdAt.toISOString(),
  reviewerEmail: r.reviewerEmail,
  clients: r.clients,
  people: r.people,
  removals: r.removals,
});

/** A review with the people it found in the clients this session serves (row-level security). */
async function reviewView(tx: Tx, id: string, tenantIds: readonly string[]) {
  const [r] = await tx.select().from(accessReview).where(eq(accessReview.id, id));
  if (!r) throw notFound("access review");
  const items = tenantIds.length
    ? await tx
        .select({ item: accessReviewItem, clientName: tenant.name })
        .from(accessReviewItem)
        .leftJoin(tenant, eq(tenant.id, accessReviewItem.tenantId))
        .where(
          and(
            eq(accessReviewItem.reviewId, id),
            inArray(accessReviewItem.tenantId, [...tenantIds]),
          ),
        )
        .orderBy(accessReviewItem.email, tenant.name)
    : [];
  return {
    ...summaryOf(r),
    note: r.note,
    items: items.map(({ item, clientName }) => ({
      client: { id: item.tenantId, name: clientName },
      userId: item.userId,
      email: item.email,
      name: item.name,
      role: item.role,
      lastSignInAt: iso(item.lastSignInAt),
      lastSeenAt: iso(item.lastSeenAt),
      decision: item.decision,
      note: item.note,
    })),
  };
}

export function soc2RouteHandlers(app: Hono<AppEnv>): void {
  mount(app, soc2Routes.opsSoc2Facts, async ({ tx }) => {
    const reviews = await tx
      .select()
      .from(accessReview)
      .orderBy(desc(accessReview.createdAt), desc(accessReview.id))
      .limit(REVIEWS_SHOWN);
    // The drill's row has no client and no actor, so every operator session reads it (0071).
    const [drill] = await tx
      .select({ at: auditEvent.createdAt, outcome: auditEvent.outcome, target: auditEvent.target })
      .from(auditEvent)
      .where(and(eq(auditEvent.action, DRILL_ACTION), isNull(auditEvent.tenantId)))
      .orderBy(desc(auditEvent.createdAt), desc(auditEvent.id))
      .limit(1);
    const target = (drill?.target ?? {}) as Record<string, unknown>;
    const count = (v: unknown) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
    return {
      now: new Date().toISOString(),
      accessReviews: reviews.map(summaryOf),
      deletionDrill: drill
        ? {
            at: drill.at.toISOString(),
            ok: drill.outcome === "ok",
            tables: count(target.tables),
            rows: count(target.rows),
            failed: typeof target.failed === "string" ? target.failed : null,
          }
        : null,
    };
  });

  mount(app, soc2Routes.opsAccessReviewRecord, async ({ tx, params, tenantIds }) =>
    reviewView(tx, params.id, tenantIds),
  );

  mount(app, soc2Routes.opsAccessReviewCreate, async ({ tx, body, session, tenantIds }) => {
    if (tenantIds.length === 0) {
      throw new HttpError(409, "no_clients", "You serve no clients, so there is no one to review.");
    }
    // Everyone as they are now, read here: the body only says who should lose access.
    const users = await accessReviewUsers(tx, tenantIds);
    const found = new Set(users.flatMap((u) => u.memberships.map((m) => `${m.client.id}:${u.id}`)));
    const removals = new Map<string, string>();
    for (const r of body.remove) {
      const key = `${r.clientId}:${r.userId}`;
      if (!found.has(key)) {
        throw new HttpError(
          400,
          "not_in_review",
          "One of the people to remove isn't in a client you serve any more. Reload and try again.",
        );
      }
      removals.set(key, r.note);
    }
    const items = users.flatMap((u) =>
      u.memberships.map((m) => {
        const key = `${m.client.id}:${u.id}`;
        const decision: "keep" | "remove" = removals.has(key) ? "remove" : "keep";
        return {
          tenantId: m.client.id,
          userId: u.id,
          email: u.email,
          name: u.name,
          role: m.role,
          lastSignInAt: u.lastSignInAt ? new Date(u.lastSignInAt) : null,
          lastSeenAt: u.lastSeenAt ? new Date(u.lastSeenAt) : null,
          decision,
          note: removals.get(key) ?? "",
        };
      }),
    );
    // DECISION (§1.218): recording is a record, not the removal itself. Access is removed where it
    // is today (the client's People page, remove-operator.yml), and the next review shows whether
    // it was; a review can't be edited, so a correction is a second review in the same quarter.
    const [r] = await tx
      .insert(accessReview)
      .values({
        period: quarterOf(new Date()),
        reviewedBy: session.user.id,
        reviewerEmail: session.user.email,
        clients: tenantIds.length,
        people: items.length,
        removals: removals.size,
        note: body.note,
      })
      .returning({ id: accessReview.id });
    if (!r) throw new Error("access review insert returned nothing");
    if (items.length > 0) {
      await tx.insert(accessReviewItem).values(items.map((i) => ({ ...i, reviewId: r.id })));
    }
    return reviewView(tx, r.id, tenantIds);
  });
}
