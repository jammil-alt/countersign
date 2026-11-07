// Purging a retired client (docs/plan.md §1.35): every row of it goes, in every table, and nothing
// of any other client; the audit log stays.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ClientFixture, insertClient, insertOperatorRows } from "./fixtures.test-helper";
import { deleteOrder, PurgeRefused, purgeClient } from "./purge";
import { TENANT_TABLES } from "./schema";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "./testing";

const online = await databaseAvailable();

describe("deleteOrder", () => {
  it("puts children before parents, and refuses a cycle", () => {
    const order = deleteOrder(
      new Map([
        ["run", new Set(["agent"])],
        ["agent", new Set<string>()],
        ["step_run", new Set(["run"])],
      ]),
    );
    expect(order.indexOf("step_run")).toBeLessThan(order.indexOf("run"));
    expect(order.indexOf("run")).toBeLessThan(order.indexOf("agent"));
    expect(() =>
      deleteOrder(
        new Map([
          ["a", new Set(["b"])],
          ["b", new Set(["a"])],
        ]),
      ),
    ).toThrow(/cycle/);
  });
});

describe.skipIf(!online)("purgeClient", () => {
  let t: TestDatabase;
  let A: ClientFixture;
  let B: ClientFixture;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    A = await insertClient(t.db, "A");
    B = await insertClient(t.db, "B");
    await insertOperatorRows(t.db);
  });
  afterAll(async () => {
    await t?.drop();
  });

  const count = async (table: string, tenantId: string) =>
    Number(
      [
        ...(await t.db.execute<{ n: string }>(
          sql.raw(`select count(*) as n from ${table} where tenant_id = '${tenantId}'`),
        )),
      ][0]?.n ?? 0,
    );

  it("refuses a client that isn't retired, retired too recently, or whose files remain", async () => {
    await expect(purgeClient(t.db, A.tenantId)).rejects.toBeInstanceOf(PurgeRefused);
    await t.db.execute(sql`update tenant set retired_at = now() where id = ${A.tenantId}`);
    await expect(purgeClient(t.db, A.tenantId)).rejects.toThrow(/can be purged from/);
    await t.db.execute(
      sql`update tenant set retired_at = now() - interval '31 days' where id = ${A.tenantId}`,
    );
    await expect(purgeClient(t.db, A.tenantId)).rejects.toThrow(/files are not deleted/);
  });

  it("deletes every row of the client in every table but the audit log, and nothing of another", async () => {
    await t.db.execute(sql`update tenant set settings = settings || '{"purge":{"files_deleted_at":"2026-01-01T00:00:00Z"}}'::jsonb
      where id = ${A.tenantId}`);
    const beforeB = Object.fromEntries(
      await Promise.all(TENANT_TABLES.map(async (tb) => [tb, await count(tb, B.tenantId)])),
    );
    const report = await purgeClient(t.db, A.tenantId);
    expect(report.name).toBe("A");
    for (const table of TENANT_TABLES) {
      const left = await count(table, A.tenantId);
      if (table === "audit_event") expect(left, table).toBeGreaterThan(0);
      else expect(left, table).toBe(0);
      expect(await count(table, B.tenantId), `${table} of B`).toBe(beforeB[table]);
    }
    const [tenantRow] = [
      ...(await t.db.execute(sql`select 1 from tenant where id = ${A.tenantId}`)),
    ];
    expect(tenantRow).toBeUndefined();
    expect(report.usersDeleted).toBeGreaterThan(0);
    // The purge itself is in the audit log.
    expect([
      ...(await t.db.execute(
        sql`select 1 from audit_event where tenant_id = ${A.tenantId} and action = 'client.purge'`,
      )),
    ]).toHaveLength(1);
    // The history triggers are back on.
    await expect(
      t.db.execute(sql`delete from agent_version where tenant_id = ${B.tenantId}`),
    ).rejects.toThrow();
  });
});
