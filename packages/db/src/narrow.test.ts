// narrowToTenant: inside a back-office transaction over several clients, withTenant's scope for one
// of them (that client's rows only, no templates), never a client outside the transaction, and the
// wider scope put back afterwards, even when `fn` fails.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { narrowToTenant, ScopeError, type Tx, withOperator } from "./client";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import { asWorker, createTestDatabase, databaseAvailable, type TestDatabase } from "./testing";

const online = await databaseAvailable();

describe.skipIf(!online)("narrowToTenant", () => {
  let t: TestDatabase;
  let A: ClientFixture;
  let B: ClientFixture;
  let C: ClientFixture;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    A = await insertClient(t.db, "A");
    B = await insertClient(t.db, "B");
    C = await insertClient(t.db, "C");
  });
  afterAll(async () => {
    await t?.drop();
  });

  const tenantsSeen = async (tx: Tx) =>
    [
      ...(await tx.execute<{ tenant_id: string }>(
        sql`select distinct tenant_id from connection order by tenant_id`,
      )),
    ].map((r) => r.tenant_id);
  const operatorOn = async (tx: Tx) =>
    [...(await tx.execute<{ op: string }>(sql`select current_setting('app.operator') as op`))][0]
      ?.op;

  it("sees one client's rows, as withTenant does, then the operator's scope again", async () => {
    await withOperator(t.db, [A.tenantId, B.tenantId], async (tx) => {
      await asWorker(tx);
      expect(await tenantsSeen(tx)).toEqual([A.tenantId, B.tenantId].sort());
      const inside = await narrowToTenant(tx, B.tenantId, async (inner) => ({
        seen: await tenantsSeen(inner),
        operator: await operatorOn(inner),
      }));
      expect(inside).toEqual({ seen: [B.tenantId], operator: "off" });
      expect(await tenantsSeen(tx)).toEqual([A.tenantId, B.tenantId].sort());
      expect(await operatorOn(tx)).toBe("on");
      // Put back when `fn` throws too.
      await expect(
        narrowToTenant(tx, A.tenantId, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await tenantsSeen(tx)).toEqual([A.tenantId, B.tenantId].sort());
    });
  });

  it("never widens: a client outside the transaction is refused", async () => {
    await withOperator(t.db, [A.tenantId], async (tx) => {
      await asWorker(tx);
      await expect(narrowToTenant(tx, C.tenantId, async () => "no")).rejects.toThrow(ScopeError);
      await expect(narrowToTenant(tx, "not-an-id", async () => "no")).rejects.toThrow(ScopeError);
      expect(await tenantsSeen(tx)).toEqual([A.tenantId]);
    });
  });
});
