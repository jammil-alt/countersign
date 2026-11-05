// Access, phase 1 (docs/plan.md §1.26) at the database: one active data key per client, a destroyed
// key keeps no wrapped key, a grant joins an agent and a connection of the same client, and both
// tables stay per client for the Worker's role (invariant 1).

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "./client";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import { agentGrant, tenantKey } from "./schema";
import { asWorker, createTestDatabase, databaseAvailable, type TestDatabase } from "./testing";

const online = await databaseAvailable();

const WRAPPED = { v: 1 as const, alg: "A256GCM" as const, kid: "k", iv: "aXY=", ct: "Y3Q=" };

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code ?? "unknown";
  }
  return undefined;
}

describe.skipIf(!online)("tenant_key and agent_grant", () => {
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

  it("allows one active key per client; retired keys may sit beside it", async () => {
    // The fixture gave A an active key already.
    expect(
      await errorCode(t.db.insert(tenantKey).values({ tenantId: A.tenantId, wrappedKey: WRAPPED })),
    ).toBe("23505");
    await t.db
      .update(tenantKey)
      .set({ status: "retired", retiredAt: new Date() })
      .where(eq(tenantKey.tenantId, A.tenantId));
    await t.db.insert(tenantKey).values({ tenantId: A.tenantId, wrappedKey: WRAPPED });
    const rows = await t.db.select().from(tenantKey).where(eq(tenantKey.tenantId, A.tenantId));
    expect(rows.map((r) => r.status).sort()).toEqual(["active", "retired"]);
  });

  it("a destroyed key has no wrapped key, and only a destroyed one", async () => {
    expect(
      await errorCode(
        t.db
          .update(tenantKey)
          .set({ status: "destroyed" })
          .where(eq(tenantKey.tenantId, B.tenantId)),
      ),
    ).toBe("23514");
    expect(
      await errorCode(
        t.db.update(tenantKey).set({ wrappedKey: null }).where(eq(tenantKey.tenantId, B.tenantId)),
      ),
    ).toBe("23514");
    await t.db
      .update(tenantKey)
      .set({ status: "destroyed", wrappedKey: null })
      .where(eq(tenantKey.tenantId, B.tenantId));
  });

  it("one grant per agent and connection, both of the grant's client", async () => {
    expect(
      await errorCode(
        t.db
          .insert(agentGrant)
          .values({ tenantId: A.tenantId, agentId: A.agentId, connectionId: A.connectionId }),
      ),
    ).toBe("23505");
    // A's agent on B's connection, or B's agent under A's id: refused by the composite keys.
    expect(
      await errorCode(
        t.db
          .insert(agentGrant)
          .values({ tenantId: A.tenantId, agentId: A.agentId, connectionId: B.connectionId }),
      ),
    ).toBe("23503");
    expect(
      await errorCode(
        t.db
          .insert(agentGrant)
          .values({ tenantId: A.tenantId, agentId: B.agentId, connectionId: A.connectionId }),
      ),
    ).toBe("23503");
  });

  it("the Worker's role sees and changes only its own client's keys and grants", async () => {
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      const keys = await tx.select({ tenantId: tenantKey.tenantId }).from(tenantKey);
      expect(new Set(keys.map((k) => k.tenantId))).toEqual(new Set([A.tenantId]));
      const grants = await tx.select({ tenantId: agentGrant.tenantId }).from(agentGrant);
      expect(new Set(grants.map((g) => g.tenantId))).toEqual(new Set([A.tenantId]));
      // B's rows match nothing.
      const updated = await tx
        .update(agentGrant)
        .set({ limits: {} })
        .where(and(eq(agentGrant.tenantId, B.tenantId), eq(agentGrant.agentId, B.agentId)))
        .returning();
      expect(updated).toEqual([]);
    });
    expect(
      await errorCode(
        withTenant(t.db, A.tenantId, async (tx) => {
          await asWorker(tx);
          await tx.insert(tenantKey).values({ tenantId: B.tenantId, wrappedKey: WRAPPED });
        }),
      ),
    ).toBe("42501");
    expect(
      await errorCode(
        withTenant(t.db, A.tenantId, async (tx) => {
          await asWorker(tx);
          await tx.execute(sql`delete from agent_grant`);
        }),
      ),
    ).toBe("42501");
  });
});
