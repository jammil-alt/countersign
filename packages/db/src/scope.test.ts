// The scope goes to the database in the same round trip as a transaction's first queries
// (docs/plan.md §1.82): every statement `fn` issues, even at once and before awaiting anything,
// still runs after the scope is set, and a failing `fn` still rolls back.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Tx, withOperator, withTenant, withUser } from "./client";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "./testing";

const online = await databaseAvailable();

describe.skipIf(!online)("a transaction's scope", () => {
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

  const settings = (tx: Tx) =>
    tx
      .execute<{ ids: string; op: string; user: string }>(
        sql`select current_setting('app.tenant_ids', true) as ids,
          current_setting('app.operator', true) as op,
          current_setting('app.user_id', true) as user`,
      )
      .then((rows) => [...rows][0]);

  it("is set before the first statement, issued at once", async () => {
    const first = await withTenant(t.db, A.tenantId, (tx) => settings(tx));
    expect(first).toEqual({ ids: `{${A.tenantId}}`, op: "off", user: "" });
    const user = "00000000-0000-4000-8000-0000000000aa";
    expect(await withUser(t.db, user, (tx) => settings(tx))).toEqual({
      ids: "{}",
      op: "off",
      user,
    });
  });

  it("covers every statement issued together, as a pipelined route issues them", async () => {
    const [ids, op] = await withOperator(t.db, [A.tenantId, B.tenantId], (tx) =>
      Promise.all([settings(tx).then((s) => s?.ids), settings(tx).then((s) => s?.op)]),
    );
    expect(ids).toBe(`{${[A.tenantId, B.tenantId].join(",")}}`);
    expect(op).toBe("on");
  });

  it("rolls back when `fn` fails, even before its first await", async () => {
    await expect(
      withTenant(t.db, A.tenantId, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(
      withTenant(t.db, A.tenantId, async (tx) => {
        await tx.execute(sql`create temporary table scope_probe (n int)`);
        throw new Error("late");
      }),
    ).rejects.toThrow("late");
    const left = await t.db.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_class where relname = 'scope_probe'`,
    );
    expect([...left][0]?.n).toBe(0);
  });
});
