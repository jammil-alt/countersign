// Alerts (migration 0007): evidence is never empty (CLAUDE.md invariant 10), a client has at most one
// open alert per dedupe key, the Worker may change an alert's status but never delete one, and a
// client sees only its own.

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "./client";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import { alert } from "./schema";
import { asWorker, createTestDatabase, databaseAvailable, type TestDatabase } from "./testing";

const online = await databaseAvailable();

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code ?? "unknown";
  }
  return undefined;
}

describe.skipIf(!online)("alerts", () => {
  let t: TestDatabase;
  let A: ClientFixture;
  let B: ClientFixture;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    A = await insertClient(t.db, "A");
    B = await insertClient(t.db, "B");
  });
  afterAll(async () => {
    await t?.drop();
  });

  const row = (c: ClientFixture, over: Partial<typeof alert.$inferInsert> = {}) => ({
    tenantId: c.tenantId,
    pack: "materials",
    kind: "price_jump",
    subjectType: "catalog_item",
    subjectId: c.documentId,
    severity: "warning" as const,
    title: "Price up",
    body: "Up 9%.",
    evidence: [c.docLineId],
    agentVersionId: c.agentVersionId,
    ...over,
  });

  it("refuses an alert without evidence", async () => {
    expect(await errorCode(t.db.insert(alert).values(row(A, { evidence: [] })))).toBe("23514");
  });

  it("keeps one open alert per dedupe key; a closed one doesn't count", async () => {
    const key = "price_jump:item:vendor";
    const [first] = await t.db
      .insert(alert)
      .values(row(A, { dedupeKey: key }))
      .returning();
    expect(await errorCode(t.db.insert(alert).values(row(A, { dedupeKey: key })))).toBe("23505");
    // Another client may have the same key.
    await t.db.insert(alert).values(row(B, { dedupeKey: key }));
    await t.db
      .update(alert)
      .set({ status: "dismissed" })
      .where(eq(alert.id, first?.id as string));
    await t.db.insert(alert).values(row(A, { dedupeKey: key }));
    const open = await t.db
      .select()
      .from(alert)
      .where(and(eq(alert.tenantId, A.tenantId), eq(alert.status, "open")));
    expect(open.filter((a) => a.dedupeKey === key)).toHaveLength(1);
  });

  it("lets the Worker read its client's alerts and change a status, never delete", async () => {
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      const rows = await tx.select().from(alert);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.tenantId === A.tenantId)).toBe(true);
    });
    const code = await errorCode(
      withTenant(t.db, A.tenantId, async (tx) => {
        await asWorker(tx);
        await tx.execute(sql`delete from alert`);
      }),
    );
    expect(code).toBe("42501");
  });
});
