// SOC 2 readiness (docs/plan.md §1.218): the facts route, and recording the quarterly access
// review: every person in the clients served as they are now, the reviewer's removals, never a
// client the operator doesn't serve, never a client person, and the record as each operator sees it.

import { quarterOf } from "@countersign/core";
import { accessReviewItem, auditEvent } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { admin, createApiHarness, OPERATOR, OTHER_OPERATOR } from "./api.test-helper";

const h = await createApiHarness();
afterAll(() => h?.close());

type Review = {
  id: string;
  period: string;
  reviewerEmail: string;
  clients: number;
  people: number;
  removals: number;
  note: string;
  items: {
    client: { id: string };
    userId: string;
    email: string;
    decision: string;
    note: string;
  }[];
};
type Facts = {
  accessReviews: { id: string; period: string }[];
  deletionDrill: { ok: boolean; rows: number; tables: number; failed: string | null } | null;
};

describe.skipIf(!h)("SOC 2 readiness", () => {
  const harness = h as NonNullable<typeof h>;
  const call = harness.call.bind(harness);
  const { A, B, C } = harness;

  it("is the operator's only", async () => {
    for (const [method, path] of [
      ["GET", "/api/ops/security/soc2"],
      ["POST", "/api/ops/access-reviews"],
    ] as const) {
      const res = await call(admin("a"), method, path, method === "POST" ? {} : undefined);
      expect(res.status, path).toBe(403);
    }
  });

  it("has no reviews and no drill before either is done", async () => {
    const res = await call(OPERATOR, "GET", "/api/ops/security/soc2");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ accessReviews: [], deletionDrill: null });
  });

  it("records a review of everyone in the clients served, with the removals asked for", async () => {
    const people = await call(OPERATOR, "GET", "/api/ops/access-review");
    const users = (
      people.json as {
        users: { id: string; email: string; memberships: { client: { id: string } }[] }[];
      }
    ).users;
    const a = users.find((u) => u.email === admin("a"));
    if (!a) throw new Error("A's admin is missing");
    const memberships = users.reduce((n, u) => n + u.memberships.length, 0);

    const res = await call(OPERATOR, "POST", "/api/ops/access-reviews", {
      note: "App and consoles reviewed.",
      remove: [{ clientId: A.tenantId, userId: a.id, note: "Left in October" }],
    });
    expect(res.status).toBe(200);
    const review = res.json as Review;
    expect(review).toMatchObject({
      period: quarterOf(new Date()),
      reviewerEmail: OPERATOR,
      people: memberships,
      removals: 1,
      note: "App and consoles reviewed.",
    });
    expect(review.items).toHaveLength(memberships);
    expect(review.items.find((i) => i.email === admin("a"))).toMatchObject({
      client: { id: A.tenantId },
      decision: "remove",
      note: "Left in October",
    });
    expect(review.items.filter((i) => i.decision === "remove")).toHaveLength(1);
    expect(review.items.some((i) => i.client.id === C.tenantId)).toBe(false);

    const facts = (await call(OPERATOR, "GET", "/api/ops/security/soc2")).json as Facts;
    expect(facts.accessReviews.map((r) => r.id)).toEqual([review.id]);

    // Another operator sees the review, and none of the people in clients it doesn't serve.
    const other = await call(OTHER_OPERATOR, "GET", `/api/ops/access-reviews/${review.id}`);
    expect(other.status).toBe(200);
    const seen = (other.json as Review).items.map((i) => i.client.id);
    expect(seen.includes(A.tenantId) || seen.includes(B.tenantId)).toBe(false);

    // Recorded, never changed: and audited like every back-office write.
    const items = await harness.t.db
      .select()
      .from(accessReviewItem)
      .where(eq(accessReviewItem.reviewId, review.id));
    expect(items).toHaveLength(memberships);
    const [audited] = (
      await harness.t.db
        .select()
        .from(auditEvent)
        .where(eq(auditEvent.action, "POST /api/ops/access-reviews"))
    ).slice(-1);
    expect(audited).toMatchObject({ outcome: "ok", actorEmail: OPERATOR });
  });

  it("refuses a removal of someone not in a client served", async () => {
    // C's admin (the harness's `admin` is a user id).
    const res = await call(OPERATOR, "POST", "/api/ops/access-reviews", {
      remove: [{ clientId: C.tenantId, userId: C.admin }],
    });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: { code: "not_in_review" } });
  });

  it("reads the last deletion drill from the audit log", async () => {
    await harness.t.db.insert(auditEvent).values({
      actorKind: "system",
      action: "client.deletion_drill",
      outcome: "error",
      target: { client: "", tables: "0", rows: "0", users: "0", failed: "the drill stopped" },
    });
    await harness.t.db.insert(auditEvent).values({
      actorKind: "system",
      action: "client.deletion_drill",
      outcome: "ok",
      target: { client: A.tenantId, tables: "41", rows: "812", users: "3" },
    });
    const facts = (await call(OPERATOR, "GET", "/api/ops/security/soc2")).json as Facts;
    expect(facts.deletionDrill).toMatchObject({ ok: true, tables: 41, rows: 812, failed: null });
  });
});
