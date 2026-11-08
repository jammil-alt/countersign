// Prices from QuickBooks bills against a throwaway database, as the Worker's role: item lines
// become catalog matches and prices (deterministic, a new item when the rules say so), account
// lines and unsure lines are counted and left, a re-run and a bill's next version add nothing
// twice, a test run writes nothing, the range is read in pages, and one client's bills never
// price another's catalog (invariant 1).

import { closeDb, createDb, type Db } from "@countersign/db";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "@countersign/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { catalogItem, priceObservation } from "../schema";
import { insertShop, type ShopFixture } from "../testing.test-helper";
import { packToolContext } from "../tools";
import { backfillFromBillsTool } from "./tools";

const online = await databaseAvailable();

// biome-ignore lint/suspicious/noExplicitAny: tool outputs are read loosely in tests.
type J = any;

describe.skipIf(!online)("prices from QuickBooks bills (database)", () => {
  let t: TestDatabase;
  let db: Db;
  let A: ShopFixture;
  let B: ShopFixture;
  let northline: string;

  const run = async (input: unknown, shop: ShopFixture = A, mode: "live" | "test" = "live") =>
    backfillFromBillsTool.output.parse(
      await backfillFromBillsTool.run(
        input,
        packToolContext({
          tenantId: shop.tenantId,
          agentVersionId: shop.agentVersionId,
          mode,
          db,
        }),
      ),
    ) as J;
  const prices = (tenantId: string) =>
    t.db.select().from(priceObservation).where(eq(priceObservation.tenantId, tenantId));

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    const url = new URL(t.url);
    url.searchParams.set("options", "-c role=cs_worker");
    db = createDb(url.toString(), { max: 2 });
    A = await insertShop(t.db, "Millwork A");
    B = await insertShop(t.db, "Millwork B");
    northline = await A.vendor("Northline Plywood");
    await A.qboBill({
      id: "145",
      vendorId: northline,
      date: "2026-08-03",
      lines: [
        {
          id: "1",
          item: "Plywood",
          description: "3/4 BB/BB BALTIC BIRCH 5X5",
          qty: 10,
          unitPrice: 62.5,
        },
        // No description: the item's name is read instead.
        { id: "2", item: "4/4 RED OAK FAS", qty: 250, unitPrice: 4.85 },
        { id: "3", account: "Freight", description: "Delivery", amount: 85 },
        // Too vague for the rules: counted for review, never guessed.
        { id: "4", item: "Misc", description: "SHOP SUPPLIES", qty: 1, unitPrice: 14.99 },
      ],
    });
    await A.qboBill({
      id: "146",
      vendorId: northline,
      date: "2026-09-10",
      lines: [
        {
          id: "1",
          item: "Plywood",
          description: "3/4 BB/BB BALTIC BIRCH 5X5",
          qty: 20,
          unitPrice: 64,
        },
      ],
    });
    // Outside the range.
    await A.qboBill({
      id: "147",
      vendorId: northline,
      date: "2025-12-30",
      lines: [
        {
          id: "1",
          item: "Plywood",
          description: "3/4 BB/BB BALTIC BIRCH 5X5",
          qty: 1,
          unitPrice: 50,
        },
      ],
    });
    const bVendor = await B.vendor("Northline Plywood");
    await B.qboBill({
      id: "145",
      vendorId: bVendor,
      date: "2026-08-03",
      lines: [
        {
          id: "1",
          item: "Plywood",
          description: "3/4 BB/BB BALTIC BIRCH 5X5",
          qty: 3,
          unitPrice: 70,
        },
      ],
    });
  });
  afterAll(async () => {
    if (db) await closeDb(db);
    await t?.drop();
  });

  it("writes nothing in a test run, and says what it would have done", async () => {
    const r = await run({ from: "2026-01-01", to: "2026-12-31" }, A, "test");
    expect(r).toMatchObject({ bills: 2, itemLines: 4, accountLines: 1, recorded: 0 });
    expect(await prices(A.tenantId)).toEqual([]);
    expect(
      await t.db.select().from(catalogItem).where(eq(catalogItem.tenantId, A.tenantId)),
    ).toEqual([]);
  });

  it("matches item lines, records their prices, and leaves account and unsure lines", async () => {
    const r = await run({ from: "2026-01-01", to: "2026-12-31" });
    expect(r).toMatchObject({
      bills: 2,
      lines: 5,
      itemLines: 4,
      accountLines: 1,
      recorded: 3,
      alreadyRecorded: 0,
      // The plywood and the oak are new items by the rules; the second plywood line matches by
      // the alias the first one taught.
      newItems: 2,
      matched: 1,
      needsReview: 1,
      skipped: 0,
      next: null,
    });
    expect(r.review).toEqual([
      expect.objectContaining({ lineId: "4", description: "SHOP SUPPLIES" }),
    ]);
    const rows = await prices(A.tenantId);
    expect(rows.map((p) => [p.observedOn, p.unitPriceStd, p.qtyStd, p.standardUom]).sort()).toEqual(
      [
        ["2026-08-03", "4.8500", "250.0000", "board_foot"],
        ["2026-08-03", "62.5000", "10.0000", "sheet"],
        ["2026-09-10", "64.0000", "20.0000", "sheet"],
      ],
    );
    for (const p of rows) {
      expect(p.rawRecordId).not.toBeNull();
      expect(p.rawLineId).not.toBeNull();
      expect(p.agentVersionId).toBe(A.agentVersionId);
      expect(p.ext).toMatchObject({ source: "qbo_bill", uomAssumed: true });
    }
    expect(r.sources).toEqual(expect.arrayContaining(rows.map((p) => p.id)));
  });

  it("adds nothing twice: a re-run, or a bill's next version", async () => {
    const again = await run({ from: "2026-01-01", to: "2026-12-31" });
    expect(again).toMatchObject({ recorded: 0, alreadyRecorded: 3, needsReview: 1 });
    // QuickBooks sends bill 146 again with a new SyncToken (edited after the price was recorded).
    await A.qboBill({
      id: "146",
      syncToken: "1",
      vendorId: northline,
      date: "2026-09-10",
      lines: [
        {
          id: "1",
          item: "Plywood",
          description: "3/4 BB/BB BALTIC BIRCH 5X5",
          qty: 20,
          unitPrice: 63,
        },
      ],
    });
    const edited = await run({ from: "2026-01-01", to: "2026-12-31" });
    expect(edited).toMatchObject({ recorded: 0, alreadyRecorded: 3 });
    expect(await prices(A.tenantId)).toHaveLength(3);
  });

  it("reads a long range in pages, continuing from `next`", async () => {
    const first = await run({ from: "2025-01-01", to: "2026-12-31", limit: 1 });
    expect(first).toMatchObject({ bills: 1, recorded: 1 });
    expect(first.next).toMatch(/^2025-12-30:/);
    const second = await run({ from: "2025-01-01", to: "2026-12-31", limit: 1, after: first.next });
    expect(second).toMatchObject({ bills: 1, recorded: 0, alreadyRecorded: 2 });
    const third = await run({ from: "2025-01-01", to: "2026-12-31", limit: 5, after: second.next });
    expect(third).toMatchObject({ bills: 1, next: null });
    expect(await prices(A.tenantId)).toHaveLength(4);
    await expect(async () =>
      backfillFromBillsTool.run({ from: "2026-02-01", to: "2026-01-01" }, {} as never),
    ).rejects.toThrow(/after/);
  });

  it("prices each client's bills into its own catalog only", async () => {
    const r = await run({ from: "2026-01-01", to: "2026-12-31" }, B);
    expect(r).toMatchObject({ bills: 1, recorded: 1, newItems: 1 });
    const bPrices = await prices(B.tenantId);
    expect(bPrices.map((p) => p.unitPriceStd)).toEqual(["70.0000"]);
    const aItems = await t.db
      .select()
      .from(catalogItem)
      .where(eq(catalogItem.tenantId, A.tenantId));
    expect(aItems.map((i) => i.id)).not.toContain(bPrices[0]?.catalogItemId);
    expect(await prices(A.tenantId)).toHaveLength(4);
  });
});
