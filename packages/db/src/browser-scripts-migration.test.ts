// Migration 0045 (docs/plan.md §1.86 "Scripts (wave 4)"): `browser_script` and
// `browser_script_version`, a client's recorded scripts. It applies on a database the previous
// Worker used (new tables only), that Worker's writes still work, both tables have forced
// row-level security, the Worker's role reads and writes only its own client's scripts, and a
// saved version never changes and is never deleted (invariant 3).

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withOperator, withTenant } from "./client";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import { browserScript, browserScriptVersion } from "./schema";
import {
  asWorker,
  createTestDatabase,
  databaseAvailable,
  migrateAsOwner,
  type TestDatabase,
} from "./testing";

const online = await databaseAvailable();

describe.skipIf(!online)("0045 on a database the previous Worker used", () => {
  let t: TestDatabase;
  let tenantId = "";

  beforeAll(async () => {
    const created = await createTestDatabase({ migrate: false });
    if (!created) throw new Error("database vanished");
    t = created;
    await migrateAsOwner(t.url, { upTo: "0044_external_action_after" });
    const [tn] = await t.db.$client<{ id: string }[]>`
      insert into tenant (name) values ('Earlier') returning id`;
    tenantId = tn?.id ?? "";
    await t.db.$client`
      insert into connection (tenant_id, connector, config)
      values (${tenantId}, 'browser', ${JSON.stringify({ site: "supplier" })}::jsonb)`;
    await migrateAsOwner(t.url);
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("adds both tables, empty, with forced row-level security", async () => {
    const rows = await t.db.$client<{ relname: string; rls: boolean; forced: boolean }[]>`
      select relname, relrowsecurity as rls, relforcerowsecurity as forced
      from pg_class where relname in ('browser_script', 'browser_script_version')
      order by relname`;
    expect(rows).toEqual([
      { relname: "browser_script", rls: true, forced: true },
      { relname: "browser_script_version", rls: true, forced: true },
    ]);
    const [count] = await t.db.$client<{ n: number }[]>`
      select count(*)::int as n from browser_script`;
    expect(count?.n).toBe(0);
  });

  it("leaves the previous Worker's browser connections as they were", async () => {
    await t.db.$client`
      insert into connection (tenant_id, connector) values (${tenantId}, 'browser')`;
    const [row] = await t.db.$client<{ n: number }[]>`
      select count(*)::int as n from connection where tenant_id = ${tenantId}`;
    expect(row?.n).toBe(2);
  });
});

describe.skipIf(!online)("browser scripts under the Worker's role (0045)", () => {
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

  it("a client sees and changes only its own scripts", async () => {
    const seen = await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      await tx.update(browserScript).set({ name: "Check the stock" });
      return tx
        .select({ tenantId: browserScript.tenantId, name: browserScript.name })
        .from(browserScript);
    });
    expect(seen).toEqual([{ tenantId: A.tenantId, name: "Check the stock" }]);
    const [b] = await t.db
      .select({ name: browserScript.name })
      .from(browserScript)
      .where(eq(browserScript.tenantId, B.tenantId));
    expect(b?.name).toBe("Check stock");
  });

  it("never writes a script or a version into another client", async () => {
    const [bScript] = await t.db
      .select({ id: browserScript.id, connectionId: browserScript.connectionId })
      .from(browserScript)
      .where(eq(browserScript.tenantId, B.tenantId));
    await expect(
      withTenant(t.db, A.tenantId, async (tx) => {
        await asWorker(tx);
        await tx.insert(browserScriptVersion).values({
          tenantId: B.tenantId,
          scriptId: bScript?.id ?? "",
          version: 2,
          definition: {},
          recordedSide: "operator",
        });
      }),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });

  it("an operator serving A sees A's scripts and none of B's", async () => {
    const seen = await withOperator(t.db, [A.tenantId], async (tx) => {
      await asWorker(tx);
      return tx.select({ tenantId: browserScriptVersion.tenantId }).from(browserScriptVersion);
    });
    expect(new Set(seen.map((r) => r.tenantId))).toEqual(new Set([A.tenantId]));
  });

  it("keeps a saved version as it was: never updated, never deleted", async () => {
    // The Worker's role has no grant to do either.
    for (const change of [
      (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) =>
        tx.update(browserScriptVersion).set({ definition: { changed: true } }),
      (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => tx.delete(browserScriptVersion),
    ]) {
      await expect(
        withTenant(t.db, A.tenantId, async (tx) => {
          await asWorker(tx);
          await change(tx);
        }),
      ).rejects.toMatchObject({ cause: { code: "42501" } });
    }
    // And the trigger stops whoever has one (the owner included).
    await expect(
      t.db.update(browserScriptVersion).set({ definition: { changed: true } }),
    ).rejects.toMatchObject({ cause: { code: "23001" } });
    await expect(t.db.delete(browserScriptVersion)).rejects.toMatchObject({
      cause: { code: "23001" },
    });
  });
});
