// The deletion drill (docs/plan.md §1.218): a Sandbox client with weeks of rows is retired and
// purged, nothing of it is left, nothing of another client is touched, and the result is in the
// audit log where an operator session can read it.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withOperator } from "./client";
import { DELETION_DRILL_ACTION, leftovers, runDeletionDrill } from "./deletion-drill";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import { TENANT_TABLES } from "./schema";
import { seed } from "./seed";
import { asWorker, createTestDatabase, databaseAvailable, type TestDatabase } from "./testing";

const online = await databaseAvailable();

describe.skipIf(!online)("the deletion drill", () => {
  let t: TestDatabase;
  let B: ClientFixture;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    await seed(t.db);
    B = await insertClient(t.db, "B");
  }, 120_000);
  afterAll(async () => {
    await t?.drop();
  });

  const counts = async (tenantId: string) =>
    Object.fromEntries(
      await Promise.all(
        TENANT_TABLES.map(async (table) => {
          const [r] = [
            ...(await t.db.execute<{ n: number }>(
              sql.raw(`select count(*)::int as n from ${table} where tenant_id = '${tenantId}'`),
            )),
          ];
          return [table, r?.n ?? 0] as const;
        }),
      ),
    );

  it("finds what a live client still holds", async () => {
    const left = await leftovers(t.db, B.tenantId);
    expect(left.map((l) => l.table)).toEqual(expect.arrayContaining(["tenant", "membership"]));
  });

  it("fills, retires and purges a Sandbox client, leaves nothing of it, and records it", async () => {
    const beforeB = await counts(B.tenantId);
    const report = await runDeletionDrill(t.db, { now: new Date("2026-11-22T15:30:00Z") });
    expect(report.failed).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.tables).toBeGreaterThan(20);
    expect(report.rows).toBeGreaterThan(100);
    // Its operator and its two people.
    expect(report.usersDeleted).toBe(3);
    expect(await leftovers(t.db, report.tenantId ?? "")).toEqual([]);
    expect(await counts(B.tenantId)).toEqual(beforeB);

    // The result, readable by an operator session that serves other clients.
    const rows = await withOperator(t.db, [B.tenantId], async (tx) => {
      await asWorker(tx);
      return [
        ...(await tx.execute<{ outcome: string; target: Record<string, string> }>(sql`
          select outcome, target from audit_event where action = ${DELETION_DRILL_ACTION}`)),
      ];
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("ok");
    expect(rows[0]?.target).toMatchObject({
      client: report.tenantId,
      tables: String(report.tables),
      rows: String(report.rows),
    });
  }, 120_000);

  it("records a failure when it can't finish", async () => {
    // Its operator's address is taken: it stops before making anything, and says so.
    await t.db.execute(sql`insert into app_user (email, name) values
      ('operator@drill-20261122160000.deletion-drill.example.com', 'Someone')`);
    const report = await runDeletionDrill(t.db, { now: new Date("2026-11-22T16:00:00Z") });
    expect(report.ok).toBe(false);
    expect(report.failed[0]).toMatch(/^the drill stopped/);
    const [row] = [
      ...(await t.db.execute<{ outcome: string; target: Record<string, string> }>(sql`
        select outcome, target from audit_event where action = ${DELETION_DRILL_ACTION}
        order by created_at desc, id desc limit 1`)),
    ];
    expect(row?.outcome).toBe("error");
    expect(row?.target.failed).toMatch(/^the drill stopped/);
  }, 120_000);
});
