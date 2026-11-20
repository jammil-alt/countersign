// Test runs (PLATFORM_QA TOOL-5). A test run never writes (invariant 8): the runtime hands every
// pack tool `mode: "test"` and leaves it to the tool, as vendor_items.register, vendor_items.import
// and contract.save do. These Save to records tools do the work and roll it back too.

import { createTestDatabase, databaseAvailable, type TestDatabase } from "@countersign/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseLine } from "../catalog/keys";
import { catalogItem, vendorItem } from "../schema";
import { insertShop, type ShopFixture } from "../testing.test-helper";
import { catalogCreateItem, packToolContext } from "../tools";
import { vendorItemDiscontinue, vendorItemSetPreferred, vendorItemUpsert } from "./tools";

for (const level of ["warn", "error"] as const) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const online = await databaseAvailable();

describe.skipIf(!online)("Save to records tools in a test run", () => {
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

  it("(PLATFORM_QA TOOL-5) a test run's set_preferred leaves the client's preferred vendor as it was", async () => {
    // It answers what it would have done.
    const out = (await vendorItemSetPreferred.run({ vendorItemId: otherId }, test())) as {
      item: { preferred: boolean };
      cleared: string[];
    };
    expect({ preferred: out.item.preferred, cleared: out.cleared }).toEqual({
      preferred: true,
      cleared: [preferredId],
    });
    expect.soft((await row(preferredId))?.preferred).toBe(true);
    expect.soft((await row(otherId))?.preferred).toBe(false);
  });

  it("(PLATFORM_QA TOOL-5) a test run's discontinue leaves the vendor item in the live catalog", async () => {
    const out = (await vendorItemDiscontinue.run({ vendorItemId: preferredId }, test())) as {
      item: { status: string };
    };
    expect(out.item.status).toBe("discontinued");
    expect((await row(preferredId))?.status).not.toBe("discontinued");
  });

  it("(PLATFORM_QA TOOL-5) a test run's vendor_item.upsert changes no live vendor item", async () => {
    const out = (await vendorItemUpsert.run(
      { vendorId: otherVendorId, sku: "PLY-18-BB", name: "Renamed in a test run" },
      test(),
    )) as { item: { id: string; name: string }; embedded: boolean };
    expect(out).toMatchObject({
      item: { id: otherId, name: "Renamed in a test run" },
      embedded: false,
    });
    expect((await row(otherId))?.name).toBe("PLY 18MM BB");
  });

  it("(PLATFORM_QA TOOL-5) a test run's catalog.create_item adds nothing to the client's catalog", async () => {
    const before = await t.db
      .select({ id: catalogItem.id })
      .from(catalogItem)
      .where(eq(catalogItem.tenantId, A.tenantId));
    const out = (await catalogCreateItem.run({ description: "WALNUT 4/4 FAS" }, test())) as {
      created: boolean;
    };
    expect(out.created).toBe(true);
    const after = await t.db
      .select({ id: catalogItem.id })
      .from(catalogItem)
      .where(eq(catalogItem.tenantId, A.tenantId));
    expect(after.length).toBe(before.length);
  });
});
