// §1.164 "Where matching happens": after a Zoho sync page commits, the Sales area builds the record
// keys of what it stored, for a client with the area on, and only that client's; a client with it
// off keeps none; a pack whose pass fails is reported and the sync goes on.

import { connection, type Db, rawRecord, tenant, tenantPack } from "@countersign/db";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "@countersign/db/testing";
import { crmRecordKey } from "@countersign/pack-sales";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEPLOYMENT_PACKS, type RegisteredPack } from "./packs";
import { packsSynced } from "./zoho/sync";

for (const level of ["warn", "error"] as const) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const online = await databaseAvailable();

async function client(db: Db, name: string, salesOn: boolean) {
  const [t] = await db.insert(tenant).values({ name }).returning();
  if (!t) throw new Error("no tenant");
  const [c] = await db
    .insert(connection)
    .values({ tenantId: t.id, connector: "zoho_crm", status: "connected" })
    .returning();
  if (!c) throw new Error("no connection");
  if (salesOn)
    await db.insert(tenantPack).values({ tenantId: t.id, pack: "sales", version: "0.1.0" });
  const [r] = await db
    .insert(rawRecord)
    .values({
      tenantId: t.id,
      connectionId: c.id,
      connector: "zoho_crm",
      entityType: "Leads",
      externalId: "5725767000000411001",
      externalVersion: "2026-11-01T10:00:00+00:00",
      payload: {
        id: "5725767000000411001",
        First_Name: "Jane",
        Last_Name: "Doe",
        Company: "Blue Ridge Millwork",
        Email: "Jane.Doe@BlueRidgeMillwork.com",
      },
    })
    .returning();
  if (!r) throw new Error("no raw record");
  return { tenantId: t.id, connectionId: c.id, rawRecordIds: [r.id], connector: "zoho_crm" };
}

describe.skipIf(!online)("the packs' pass after a sync page", () => {
  let t: TestDatabase;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
  });
  afterAll(async () => {
    await t?.drop();
  });

  const keys = (tenantId: string) =>
    t.db.select().from(crmRecordKey).where(eq(crmRecordKey.tenantId, tenantId));

  it("builds the Sales area's keys for a client with it on, and none for one with it off", async () => {
    const on = await client(t.db, "On", true);
    const off = await client(t.db, "Off", false);
    await packsSynced(t.db, DEPLOYMENT_PACKS, on);
    await packsSynced(t.db, DEPLOYMENT_PACKS, off);
    const [key] = await keys(on.tenantId);
    expect(key).toMatchObject({
      module: "Leads",
      externalId: "5725767000000411001",
      email: "jane.doe@blueridgemillwork.com",
      matchText: "jane doe | blue ridge millwork",
    });
    expect(await keys(off.tenantId)).toEqual([]);
  });

  it("goes on when a pack's pass fails, and skips connectors a pack doesn't key", async () => {
    const on = await client(t.db, "Failing", true);
    const run = vi.fn(async () => {
      throw new Error("boom");
    });
    const failing = {
      ...DEPLOYMENT_PACKS[0],
      synced: { connectors: ["zoho_crm"], run },
    } as RegisteredPack;
    await expect(packsSynced(t.db, [failing], on)).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
    await packsSynced(t.db, [failing], { ...on, connector: "podio" });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
