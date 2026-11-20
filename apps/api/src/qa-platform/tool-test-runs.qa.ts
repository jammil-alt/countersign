// TOOL lens: test runs. A test run never writes (invariant 8), and the Materials pack's Save to
// records tools say so one by one ("a test run keeps nothing", "a test run rolls back":
// vendor_items.register, vendor_items.import, contract.save, set_tolerance, vendor.qbo, the
// purchasing tools). The runtime hands every pack tool `mode: "test"` (call-tool.ts dispatch,
// apps/api packs.ts `adapt`) and leaves it to the tool. These Save to records tools ignore it and
// change the client's live catalog during a test run.

import { createTestDatabase, databaseAvailable, type TestDatabase } from "@countersign/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseLine } from "../../../../packs/materials/src/catalog/keys";
import { catalogItem, vendorItem } from "../../../../packs/materials/src/schema";
import { insertShop, type ShopFixture } from "../../../../packs/materials/src/testing.test-helper";
import { catalogCreateItem, packToolContext } from "../../../../packs/materials/src/tools";
import {
  vendorItemDiscontinue,
  vendorItemSetPreferred,
  vendorItemUpsert,
} from "../../../../packs/materials/src/vendor/tools";

for (const level of ["warn", "error"] as const) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const online = await databaseAvailable();

describe.skipIf(!online)("TOOL: pack Save to records tools in a test run", () => {
  let t: TestDatabase;
  let A: ShopFixture;
  let vendorId = "";
  let otherVendorId = "";
  let baltic = "";
  let preferredId = "";
  let otherId = "";

  const live = () =>
    packToolContext({
      tenantId: A.tenantId,
      agentVersionId: A.agentVersionId,
      mode: "live",
      db: t.db,
    });
  const test = () =>
    packToolContext({
      tenantId: A.tenantId,
      agentVersionId: A.agentVersionId,
      runId: null,
      mode: "test",
      db: t.db,
    });
  const row = async (id: string) =>
    (await t.db.select().from(vendorItem).where(eq(vendorItem.id, id)))[0];

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    A = await insertShop(t.db, "Millwork A");
    vendorId = await A.vendor("Northline Panel Supply");
    otherVendorId = await A.vendor("Cedar Ridge Lumber");
    const p = parseLine('BALTIC BIRCH PLYWOOD 3/4" 5X5 BB/BB');
    const [item] = await t.db
      .insert(catalogItem)
      .values({
        tenantId: A.tenantId,
        category: p.category,
        canonicalName: 'BALTIC BIRCH PLYWOOD 3/4" 5X5 BB/BB',
        attributes: p.attributes,
        standardUom: p.standardUom,
      })
      .returning();
    baltic = item?.id ?? "";
    const one = (await vendorItemUpsert.run(
      { vendorId, catalogItemId: baltic, sku: "BB34-55", name: "BALTIC 3/4 5X5" },
      live(),
    )) as { item: { id: string } };
    const two = (await vendorItemUpsert.run(
      { vendorId: otherVendorId, catalogItemId: baltic, sku: "PLY-18-BB", name: "PLY 18MM BB" },
      live(),
    )) as { item: { id: string } };
    preferredId = one.item.id;
    otherId = two.item.id;
    await vendorItemSetPreferred.run({ vendorItemId: preferredId }, live());
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("TOOL-5: a test run's set_preferred leaves the client's preferred vendor as it was", async () => {
    await vendorItemSetPreferred.run({ vendorItemId: otherId }, test());
    expect.soft((await row(preferredId))?.preferred).toBe(true);
    expect.soft((await row(otherId))?.preferred).toBe(false);
  });

  it("TOOL-5: a test run's discontinue leaves the vendor item in the live catalog", async () => {
    await vendorItemDiscontinue.run({ vendorItemId: preferredId }, test());
    expect((await row(preferredId))?.status).not.toBe("discontinued");
  });

  it("TOOL-5: a test run's vendor_item.upsert changes no live vendor item", async () => {
    await vendorItemUpsert.run(
      { vendorId: otherVendorId, sku: "PLY-18-BB", name: "Renamed in a test run" },
      test(),
    );
    expect((await row(otherId))?.name).toBe("PLY 18MM BB");
  });

  it("TOOL-5: a test run's catalog.create_item adds nothing to the client's catalog", async () => {
    const before = await t.db
      .select({ id: catalogItem.id })
      .from(catalogItem)
      .where(eq(catalogItem.tenantId, A.tenantId));
    await catalogCreateItem.run({ description: "WALNUT 4/4 FAS" }, test());
    const after = await t.db
      .select({ id: catalogItem.id })
      .from(catalogItem)
      .where(and(eq(catalogItem.tenantId, A.tenantId)));
    expect(after.length).toBe(before.length);
  });
});
