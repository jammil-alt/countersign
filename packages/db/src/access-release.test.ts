// Access, phase 4 (docs/plan.md §1.26 "Human release") at the database: `access_release` is per
// client for the Worker's role (invariant 1), joins a connection, an agent and a run of the same
// client, and is append-mostly: only its status columns change, and nothing is deleted.

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "./client";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import { accessRelease } from "./schema";
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

describe.skipIf(!online)("access_release", () => {
  let t: TestDatabase;
  let A: ClientFixture;
  let B: ClientFixture;

  const row = (c: ClientFixture) => ({
    tenantId: c.tenantId,
    connectionId: c.connectionId,
    agentId: c.agentId,
    runId: c.runId,
    personId: c.userId,
    channel: "sms" as const,
    codeHash: "a".repeat(64),
    expiresAt: new Date(Date.now() + 600_000),
  });

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

  it("changes only its status columns, and is never deleted", async () => {
    const [r] = await t.db.insert(accessRelease).values(row(A)).returning();
    if (!r) throw new Error("no row");
    const where = eq(accessRelease.id, r.id);
    // A wrong try, then the release with its window, then a revoke: all status columns.
    await t.db.update(accessRelease).set({ tries: 1 }).where(where);
    const at = new Date();
    await t.db
      .update(accessRelease)
      .set({ status: "released", releasedAt: at, validUntil: new Date(at.getTime() + 3_600_000) })
      .where(where);
    await t.db.update(accessRelease).set({ status: "revoked", revokedBy: A.userId }).where(where);
    const [after] = await t.db.select().from(accessRelease).where(where);
    expect(after).toMatchObject({ status: "revoked", tries: 1, revokedBy: A.userId });

    // Who, what, and the code's hash never change.
    for (const change of [
      { codeHash: "b".repeat(64) },
      { personId: B.userId },
      { channel: "email" as const },
      { expiresAt: new Date(Date.now() + 3_600_000) },
      { agentId: B.agentId },
    ]) {
      expect(
        await errorCode(t.db.update(accessRelease).set(change).where(where)),
        JSON.stringify(Object.keys(change)),
      ).toBe("23001");
    }
    expect(await errorCode(t.db.delete(accessRelease).where(where))).toBe("23001");
  });

  it("keeps released_at with released and revoked rows only, and at most 5 tries", async () => {
    expect(
      await errorCode(t.db.insert(accessRelease).values({ ...row(A), status: "released" })),
    ).toBe("23514");
    expect(await errorCode(t.db.insert(accessRelease).values({ ...row(A), tries: 6 }))).toBe(
      "23514",
    );
    expect(
      await errorCode(t.db.insert(accessRelease).values({ ...row(A), status: "granted" as never })),
    ).toBe("23514");
  });

  it("joins a connection, an agent and a run of the same client", async () => {
    for (const other of [
      { connectionId: B.connectionId },
      { agentId: B.agentId },
      { runId: B.runId },
    ]) {
      expect(await errorCode(t.db.insert(accessRelease).values({ ...row(A), ...other }))).toBe(
        "23503",
      );
    }
  });

  it("the Worker's role sees and changes only its own client's requests", async () => {
    await t.db.insert(accessRelease).values(row(B));
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      const rows = await tx.select({ tenantId: accessRelease.tenantId }).from(accessRelease);
      expect(rows.length).toBeGreaterThan(0);
      expect(new Set(rows.map((r) => r.tenantId))).toEqual(new Set([A.tenantId]));
      const touched = await tx
        .update(accessRelease)
        .set({ status: "void" })
        .where(and(eq(accessRelease.tenantId, B.tenantId), eq(accessRelease.status, "pending")))
        .returning();
      expect(touched).toEqual([]);
    });
    expect(
      await errorCode(
        withTenant(t.db, A.tenantId, async (tx) => {
          await asWorker(tx);
          await tx.insert(accessRelease).values(row(B));
        }),
      ),
    ).toBe("42501");
    expect(
      await errorCode(
        withTenant(t.db, A.tenantId, async (tx) => {
          await asWorker(tx);
          await tx.execute(sql`delete from access_release`);
        }),
      ),
    ).toBe("42501");
  });
});
