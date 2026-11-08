// P-9 (docs/plan.md §1.71): QuickBooks pieces of the buyer, against a throwaway database as the
// Worker's role: a vendor tied to its QuickBooks vendor (kept, found by name, or a new one's id),
// a chosen quote laid out as a QuickBooks purchase order's account lines in cents, a split ordered
// as one order per vendor, and the back office's bill-price import paging to the end and safe to
// run again. Client B never reaches client A's rows (invariant 1).

import { closeDb, createDb, type Db, vendor } from "@countersign/db";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "@countersign/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importBillPrices, MATERIALS_ACTIONS } from "../api";
import { insertShop, type ShopFixture } from "../testing.test-helper";
import { type PackTool, packToolContext } from "../tools";
import { cents } from "./qbo";
import {
  poQboLinesTool,
  quoteCreate,
  quoteMarkSent,
  quoteRecord,
  requestCreate,
  requestUpdate,
  vendorQboTool,
} from "./tools";

const online = await databaseAvailable();

// biome-ignore lint/suspicious/noExplicitAny: tool outputs are read loosely in tests.
type J = any;

describe("cents", () => {
  it("rounds half up to two places, in decimal", () => {
    expect(cents("3.9999")).toBe("4.00");
    expect(cents("10.005")).toBe("10.01");
    expect(cents("10.0049")).toBe("10.00");
    expect(cents("0")).toBe("0.00");
  });
});

describe.skipIf(!online)("QuickBooks pieces of the buyer (database)", () => {
  let t: TestDatabase;
  let db: Db;
  let A: ShopFixture;
  let B: ShopFixture;
  const settings: Record<string, unknown> = {};
  const ctx = (shop: ShopFixture) =>
    packToolContext({
      tenantId: shop.tenantId,
      agentVersionId: shop.agentVersionId,
      mode: "live",
      settings,
      db,
    });
  const call = async (tool: PackTool, input: unknown, shop: ShopFixture = A): Promise<J> =>
    tool.output.parse(await tool.run(input, ctx(shop)));
  const fails = async (tool: PackTool, input: unknown, shop: ShopFixture = A) => {
    try {
      await tool.run(input, ctx(shop));
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return null;
  };
  const v: Record<string, string> = {};

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    const url = new URL(t.url);
    url.searchParams.set("options", "-c role=cs_worker");
    db = createDb(url.toString(), { max: 2 });
    A = await insertShop(t.db, "Millwork A");
    B = await insertShop(t.db, "Millwork B");
    v.keystone = await A.vendor("Keystone Lumber");
    v.northline = await A.vendor("Northline Plywood");
    v.cedar = await A.vendor("Cedar Ridge Supply");
    await t.db
      .update(vendor)
      .set({ externalRefs: { qbo: "56" } })
      .where(eq(vendor.id, v.keystone as string));
  });
  afterAll(async () => {
    if (db) await closeDb(db);
    await t?.drop();
  });

  it("ties a vendor to QuickBooks: kept, found by its one same name, or the new one's id", async () => {
    expect(await call(vendorQboTool, { vendorId: v.keystone })).toMatchObject({
      qboVendorId: "56",
      how: "stored",
      create: null,
    });
    // Northline: one active QuickBooks vendor of the same name, spacing and case aside.
    const found = await call(vendorQboTool, {
      vendorId: v.northline,
      qboVendors: [
        { id: "71", name: "NORTHLINE  plywood", active: true },
        { id: "72", name: "Northline Plywood", active: false },
        { id: "90", name: "Keystone Lumber" },
      ],
    });
    expect(found).toMatchObject({ qboVendorId: "71", how: "found" });
    const [row] = await t.db
      .select()
      .from(vendor)
      .where(eq(vendor.id, v.northline as string));
    expect(row?.externalRefs).toMatchObject({ qbo: "71" });
    // Cedar Ridge: two of the same name is no match; the step is told what to create.
    const none = await call(vendorQboTool, {
      vendorId: v.cedar,
      qboVendors: [
        { id: "80", name: "Cedar Ridge Supply" },
        { id: "81", name: "Cedar Ridge Supply." },
      ],
    });
    expect(none).toMatchObject({
      qboVendorId: null,
      create: { displayName: "Cedar Ridge Supply" },
    });
    // qbo.vendor.create made it: its id is kept, and a different one later is refused.
    expect(await call(vendorQboTool, { vendorId: v.cedar, qboVendorId: "99" })).toMatchObject({
      qboVendorId: "99",
      how: "given",
    });
    expect(await fails(vendorQboTool, { vendorId: v.cedar, qboVendorId: "100" })).toMatch(
      /already QuickBooks vendor 99/,
    );
    expect(await fails(vendorQboTool, { vendorId: v.cedar }, B)).toMatch(/not found/);
  });

  let requestId: string;
  let lineIds: string[];
  let quotes: Record<string, string>;

  it("lays out the chosen quote as QuickBooks account lines in cents, and refuses without an account", async () => {
    const r = await call(requestCreate, {
      channel: "email",
      neededBy: "2099-12-01",
      lines: [
        { description: "3/4 BB/BB BALTIC BIRCH 5X5", qty: "3", unit: "sheets" },
        { description: "4/4 RED OAK FAS", qty: "150", unit: "BF" },
      ],
    });
    requestId = r.request.id;
    lineIds = r.request.lines.map((l: J) => l.id);
    const rfq = await call(quoteCreate, { requestId, vendorIds: [v.keystone, v.northline] });
    quotes = Object.fromEntries(rfq.quotes.map((q: J) => [q.vendorName, q.id]));
    for (const id of Object.values(quotes)) {
      await call(quoteMarkSent, { quoteRequestId: id, sentVia: "email" });
    }
    await call(quoteRecord, {
      quoteRequestId: quotes["Keystone Lumber"],
      lines: [
        { requestLineId: lineIds[0], unitPrice: "61.3333", unit: "SHT" },
        { requestLineId: lineIds[1], unitPrice: "4.605", unit: "BF" },
      ],
    });
    await call(quoteRecord, {
      quoteRequestId: quotes["Northline Plywood"],
      lines: [{ requestLineId: lineIds[1], unitPrice: "4.50", unit: "BF" }],
    });
    const input = {
      requestId,
      quoteRequestId: quotes["Keystone Lumber"],
      txnDate: "2026-11-08",
    };
    expect(await fails(poQboLinesTool, input)).toMatch(/set the QuickBooks account/);
    settings.qbo_account_id = "33";
    const out = await call(poQboLinesTool, input);
    expect(out.order).toMatchObject({
      vendorId: "56",
      txnDate: "2026-11-08",
      dueDate: "2099-12-01",
      currency: "USD",
      // 3 × 61.3333 = 183.9999 → 184.00; 150 × 4.605 = 690.75.
      expectedTotal: "874.75",
    });
    expect(out.order.lines.map((l: J) => [l.accountId, l.amount])).toEqual([
      ["33", "184.00"],
      ["33", "690.75"],
    ]);
    expect(out.order.lines[0].description).toContain("3 SHT at 61.3333");
    expect(out.order.docNumber).toMatch(/^PO-[0-9A-F]{8}$/);
    expect(out.sources).toEqual(expect.arrayContaining([requestId, quotes["Keystone Lumber"]]));
    // The step's own account wins; another client can't lay out A's order.
    expect(
      (await call(poQboLinesTool, { ...input, accountId: "44" })).order.lines[0].accountId,
    ).toBe("44");
    expect(await fails(poQboLinesTool, input, B)).toMatch(/not found/);
    settings.qbo_account_id = undefined;
  });

  it("orders a split as one QuickBooks order per vendor, each quote once", async () => {
    settings.qbo_account_id = "33";
    const northline = await call(poQboLinesTool, {
      requestId,
      quoteRequestId: quotes["Northline Plywood"],
      requestLineIds: [lineIds[1]],
      txnDate: "2026-11-08",
    });
    expect(northline.order).toMatchObject({ vendorId: "71", expectedTotal: "675.00" });
    expect(northline.order.docNumber).toMatch(/^PO-[0-9A-F]{8}-[0-9A-F]{4}$/);
    const first = await call(requestUpdate, {
      requestId,
      order: { connector: "qbo", externalId: "1001", quoteRequestId: quotes["Keystone Lumber"] },
    });
    expect(first.request.status).toBe("ordered");
    const second = await call(requestUpdate, {
      requestId,
      order: { connector: "qbo", externalId: "1002", quoteRequestId: quotes["Northline Plywood"] },
    });
    expect(second.request.orders.map((o: J) => [o.externalId, o.quoteRequestId])).toEqual([
      ["1001", quotes["Keystone Lumber"]],
      ["1002", quotes["Northline Plywood"]],
    ]);
    expect(second.request.orderExternalId).toBe("1001");
    // A quote is ordered once, and an order without its quote is not a split.
    expect(
      await fails(requestUpdate, {
        requestId,
        order: { connector: "qbo", externalId: "1003", quoteRequestId: quotes["Keystone Lumber"] },
      }),
    ).toMatch(/already ordered/);
    expect(
      await fails(requestUpdate, { requestId, order: { connector: "qbo", externalId: "1004" } }),
    ).toMatch(/already ordered/);
    // The same order again changes nothing.
    expect(
      (
        await call(requestUpdate, {
          requestId,
          order: {
            connector: "qbo",
            externalId: "1002",
            quoteRequestId: quotes["Northline Plywood"],
          },
        })
      ).changed,
    ).toEqual([]);
    settings.qbo_account_id = undefined;
  });

  it("imports bill prices page after page to the end, as the person's, and again adds nothing", async () => {
    for (const [id, date] of [
      ["501", "2026-08-03"],
      ["502", "2026-08-10"],
      ["503", "2026-08-17"],
    ] as const) {
      await A.qboBill({
        id,
        vendorId: v.northline as string,
        date,
        lines: [
          {
            id: "1",
            item: "Plywood",
            description: "3/4 BB/BB BALTIC BIRCH 5X5",
            qty: 4,
            unitPrice: 60,
          },
        ],
      });
    }
    const first = await importBillPrices(
      db,
      { tenantId: A.tenantId, userId: A.userId },
      { from: "2026-08-01", to: "2026-08-31" },
      1,
    );
    expect(first).toMatchObject({ bills: 3, recorded: 3, more: false });
    expect(first.pages).toBeGreaterThanOrEqual(3);
    const again = await importBillPrices(
      db,
      { tenantId: A.tenantId, userId: A.userId },
      { from: "2026-08-01", to: "2026-08-31" },
    );
    expect(again).toMatchObject({ recorded: 0, alreadyRecorded: 3 });
    // B has no bills of A's to read; the action checks its range.
    expect(
      await importBillPrices(
        db,
        { tenantId: B.tenantId, userId: B.userId },
        { from: "2026-08-01", to: "2026-08-31" },
      ),
    ).toMatchObject({ bills: 0, recorded: 0 });
    const action = MATERIALS_ACTIONS["import-bill-prices"];
    expect(action?.input.safeParse({ from: "2026-09-01", to: "2026-08-01" }).success).toBe(false);
    expect(action?.input.safeParse({ from: "2026-08-01", to: "2026-08-31" }).success).toBe(true);
  });
});
