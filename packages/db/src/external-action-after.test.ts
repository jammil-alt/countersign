// Migration 0044 (R5 undo, docs/plan.md §1.86): `external_action.after`, the state a write left. It
// applies on a database the previous Worker used (a nullable column, no backfill), the previous
// Worker's insert (which never names it) still works, and row-level security on the table is
// unchanged: the Worker's role reads and writes it only within its client, as before.

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "./client";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import { externalAction } from "./schema";
import {
  asWorker,
  createTestDatabase,
  databaseAvailable,
  migrateAsOwner,
  type TestDatabase,
} from "./testing";

const online = await databaseAvailable();

const AFTER = { Id: "42", SyncToken: "3", Active: true };

describe.skipIf(!online)("0044 on a database the previous Worker used", () => {
  let t: TestDatabase;
  let tenantId = "";
  let connectionId = "";

  beforeAll(async () => {
    const created = await createTestDatabase({ migrate: false });
    if (!created) throw new Error("database vanished");
    t = created;
    await migrateAsOwner(t.url, { upTo: "0043_person_hours" });
    const [tn] = await t.db.$client<{ id: string }[]>`
      insert into tenant (name) values ('Earlier') returning id`;
    tenantId = tn?.id ?? "";
    const [c] = await t.db.$client<{ id: string }[]>`
      insert into connection (tenant_id, connector) values (${tenantId}, 'qbo') returning id`;
    connectionId = c?.id ?? "";
    await t.db.$client`
      insert into external_action (tenant_id, connection_id, tool, idempotency_key, status, before)
      values (${tenantId}, ${connectionId}, 'qbo.vendor.update', 'earlier:s1:0', 'done',
        ${JSON.stringify({ Id: "42" })}::jsonb)`;
    await migrateAsOwner(t.url);
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("adds the column, null for every existing write", async () => {
    const rows = await t.db.$client<{ after: unknown; before: unknown }[]>`
      select after, before from external_action`;
    expect(rows).toEqual([{ after: null, before: { Id: "42" } }]);
  });

  it("still takes the previous Worker's insert, which never names it", async () => {
    await t.db.$client`
      insert into external_action (tenant_id, connection_id, tool, idempotency_key)
      values (${tenantId}, ${connectionId}, 'qbo.vendor.update', 'earlier:s2:0')`;
    const [row] = await t.db.$client<{ after: unknown }[]>`
      select after from external_action where idempotency_key = 'earlier:s2:0'`;
    expect(row?.after).toBeNull();
  });

  it("keeps the table's forced row-level security", async () => {
    const [row] = await t.db.$client<{ rls: boolean; forced: boolean }[]>`
      select relrowsecurity as rls, relforcerowsecurity as forced
      from pg_class where relname = 'external_action'`;
    expect(row).toEqual({ rls: true, forced: true });
  });
});

describe.skipIf(!online)("external_action.after under the Worker's role (0044)", () => {
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

  it("writes and reads its own client's", async () => {
    const read = await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      await tx
        .update(externalAction)
        .set({ after: AFTER })
        .where(eq(externalAction.tenantId, A.tenantId));
      return tx.select({ after: externalAction.after }).from(externalAction);
    });
    expect(read.length).toBeGreaterThan(0);
    for (const r of read) expect(r.after).toEqual(AFTER);
  });

  it("never reaches another client's", async () => {
    const changed = await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      const rows = await tx
        .update(externalAction)
        .set({ after: AFTER })
        .where(eq(externalAction.tenantId, B.tenantId))
        .returning();
      return rows.length;
    });
    expect(changed).toBe(0);
    const rows = await t.db
      .select({ after: externalAction.after })
      .from(externalAction)
      .where(eq(externalAction.tenantId, B.tenantId));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.after).toBeNull();
  });
});
