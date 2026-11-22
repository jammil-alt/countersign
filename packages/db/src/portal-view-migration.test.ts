// Migration 0088 (docs/reporting-plan.md R6; docs/plan.md §1.236): `portal_view`, a client person's
// saved views of the portal's runs list, which a client admin may share with the client's team. A
// new table only: it applies on a database the previous Worker used, and that Worker's rows stay as
// they were. A view is its client's: forced row-level security keeps a shared view inside it.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "./client";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import { portalView, run } from "./schema";
import {
  asWorker,
  createTestDatabase,
  databaseAvailable,
  migrateAsOwner,
  type TestDatabase,
} from "./testing";

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

describe.skipIf(!online)("0088 on a database the previous Worker used", () => {
  let t: TestDatabase;
  let A: ClientFixture;
  let B: ClientFixture;

  beforeAll(async () => {
    const created = await createTestDatabase({ migrate: false });
    if (!created) throw new Error("database vanished");
    t = created;
    await migrateAsOwner(t.url, { upTo: "0087_process_interview" });
    A = await insertClient(t.db, "A");
    await migrateAsOwner(t.url);
    B = await insertClient(t.db, "B");
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("keeps the previous Worker's rows and adds the table, empty for a client made before it", async () => {
    const runs = await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      return tx.select({ id: run.id }).from(run);
    });
    expect(runs.map((r) => r.id)).toContain(A.runId);
    const [n] = await t.db.$client<{ n: number }[]>`
      select count(*)::int as n from portal_view where tenant_id = ${A.tenantId}`;
    expect(n?.n).toBe(0);
  });

  it("keeps a view, shared or not, inside its client", async () => {
    const seen = await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      return tx.select({ name: portalView.name }).from(portalView);
    });
    expect(seen).toEqual([]);
    const own = await withTenant(t.db, B.tenantId, async (tx) => {
      await asWorker(tx);
      return tx.select({ name: portalView.name, shared: portalView.shared }).from(portalView);
    });
    expect(own).toEqual([{ name: "Waiting on us", shared: true }]);
    // A client's session can't write a view into another client, nor delete one there.
    expect(
      await errorCode(
        withTenant(t.db, A.tenantId, async (tx) => {
          await asWorker(tx);
          await tx.insert(portalView).values({ tenantId: B.tenantId, userId: A.userId, name: "x" });
        }),
      ),
    ).toBe("42501");
    const deleted = await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      return (await tx.execute(sql`delete from portal_view returning id`)).length;
    });
    expect(deleted).toBe(0);
  });

  it("takes one name per person, never a blank one", async () => {
    const add = (name: string) =>
      withTenant(t.db, A.tenantId, async (tx) => {
        await asWorker(tx);
        await tx.insert(portalView).values({ tenantId: A.tenantId, userId: A.userId, name });
      });
    expect(await errorCode(add("Failed this month"))).toBeUndefined();
    expect(await errorCode(add("Failed this month"))).toBe("23505");
    expect(await errorCode(add("   "))).toBe("23514");
    expect(await errorCode(add("x".repeat(81)))).toBe("23514");
  });

  it("has forced row-level security", async () => {
    const [row] = await t.db.$client<{ rls: boolean; forced: boolean }[]>`
      select relrowsecurity as rls, relforcerowsecurity as forced
      from pg_class where relname = 'portal_view'`;
    expect(row).toEqual({ rls: true, forced: true });
  });
});
