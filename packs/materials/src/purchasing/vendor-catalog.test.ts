// The vendor catalog in purchasing (docs/plan.md §1.189), against a throwaway database as the
// Worker's role: a description named by a vendor item's SKU or name matches through `vendor_item`
// alone (the rules veto, and a box of another size is not taken); the bill-price import and quotes
// fill the catalog, each only with a conversion rule (invariant 7); the client's preferred vendor
// leads the vendors found and wins a tie in the comparison; one client's catalog never matches
// another's lines (invariant 1).

import { closeDb, createDb, type Db, withTenant } from "@countersign/db";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "@countersign/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalName, keySignature, parseLine } from "../catalog/keys";
import { descriptionHash, normalize } from "../catalog/normalize";
import { catalogItem, itemAlias, priceObservation, vendorItem } from "../schema";
import { insertShop, type ShopFixture } from "../testing.test-helper";
import { type PackTool, packToolContext } from "../tools";
import { compareOffers } from "./compare";
import { skuTokens } from "./match-text";
import { vendorAliases } from "./quotes";
import {
  backfillFromBillsTool,
  catalogMatchText,
  quoteCreate,
  quoteRecord,
  requestCreate,
  vendorsForItemsTool,
} from "./tools";

const online = await databaseAvailable();

// biome-ignore lint/suspicious/noExplicitAny: tool outputs are read loosely in tests.
type J = any;

describe("skuTokens", () => {
  it("reads the words with a digit that could name an item", () => {
    expect(skuTokens("baltic birch KB-3455, (SCR-8114)")).toEqual(["KB-3455", "SCR-8114"]);
    // Too short, a fraction, or no digit: none.
    expect(skuTokens("12 sheets of 3/4 birch")).toEqual([]);
  });
});

describe("the preferred vendor in a comparison", () => {
  const line = {
    id: "l1",
    lineNo: 1,
    description: "plywood",
    qty: "10",
    unit: "sheet",
    catalogItemId: "i1",
    standardUom: "sheet",
    qtyStd: "10",
  };
  const offer = (quoteRequestId: string, unitPrice: string) => ({
    id: `o-${quoteRequestId}`,
    quoteRequestId,
    requestLineId: "l1",
    qty: null,
    unit: "sheet",
    unitPrice,
    currency: "USD",
    unitPriceStd: unitPrice,
    standardUom: "sheet",
    qtyStd: null,
    leadTimeDays: null,
    available: true,
  });
  const compare = (prices: [string, string], preferred: number) =>
    compareOffers({
      requestId: "r1",
      neededBy: null,
      asOf: "2026-11-20",
      lines: [line],
      quotes: [
        { id: "qa", vendorId: "va", vendorName: "Alder Supply", receivedAt: null },
        {
          id: "qz",
          vendorId: "vz",
          vendorName: "Zephyr Lumber",
          receivedAt: null,
          preferredLines: preferred,
        },
      ],
      offers: [offer("qa", prices[0]), offer("qz", prices[1])],
    });

  it("wins a tie on the total, and is named in the reasons", () => {
    const c = compare(["60.00", "60.00"], 1);
    expect(c.suggestion).toMatchObject({ kind: "single", vendorId: "vz" });
    expect(c.suggestion.reasons).toContain("Zephyr Lumber is your preferred vendor for 1 line.");
    // With no preferred vendor, the tie goes by name, as before.
    expect(compare(["60.00", "60.00"], 0).suggestion.vendorId).toBe("va");
  });

  it("is never suggested at a higher total; the reasons say what it would cost", () => {
    const c = compare(["58.00", "60.00"], 1);
    expect(c.suggestion).toMatchObject({ kind: "single", vendorId: "va" });
    expect(c.suggestion.reasons).toContain(
      "Zephyr Lumber, your preferred vendor for 1 line, quoted every line for $600.00, $20.00 more.",
    );
  });
});

describe.skipIf(!online)("the vendor catalog in purchasing (database)", () => {
  let t: TestDatabase;
  let db: Db;
  let A: ShopFixture;
  let B: ShopFixture;
  const ids = { keystone: "", northline: "", bb: "", oak: "", screws: "", kbb: "", kscr: "" };

  const call = async (
    tool: PackTool,
    input: unknown,
    shop: ShopFixture = A,
    mode: "live" | "test" = "live",
  ): Promise<J> =>
    tool.output.parse(
      await tool.run(
        input,
        packToolContext({ tenantId: shop.tenantId, agentVersionId: shop.agentVersionId, mode, db }),
      ),
    );
  const item = async (shop: ShopFixture, description: string) => {
    const p = parseLine(description);
    const [row] = await t.db
      .insert(catalogItem)
      .values({
        tenantId: shop.tenantId,
        category: p.category,
        canonicalName: canonicalName(p.category, p.attributes, p.normalized),
        attributes: p.attributes,
        standardUom: p.standardUom,
        keySignature: keySignature(p.category, p.attributes),
      })
      .returning();
    return row?.id as string;
  };
  const listed = async (values: Omit<typeof vendorItem.$inferInsert, "tenantId">) => {
    const [row] = await t.db
      .insert(vendorItem)
      .values({ tenantId: A.tenantId, ...values })
      .returning();
    return row?.id as string;
  };
  const vendorItems = (vendorId: string, catalogItemId: string) =>
    t.db
      .select()
      .from(vendorItem)
      .where(and(eq(vendorItem.vendorId, vendorId), eq(vendorItem.catalogItemId, catalogItemId)));

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    const url = new URL(t.url);
    url.searchParams.set("options", "-c role=cs_worker");
    db = createDb(url.toString(), { max: 2 });
    A = await insertShop(t.db, "Millwork A");
    B = await insertShop(t.db, "Millwork B");
    ids.keystone = await A.vendor("Keystone Lumber");
    ids.northline = await A.vendor("Northline Panel Supply");
    ids.bb = await item(A, "3/4 BB/BB BALTIC BIRCH 5X5");
    ids.oak = await item(A, "4/4 RED OAK FAS");
    ids.screws = await item(A, "#8 X 1-1/4 FLAT HEAD WOOD SCREW");
    // Keystone's catalog: the plywood by the sheet as KB-3455, the screws by the box of 100.
    ids.kbb = await listed({
      vendorId: ids.keystone,
      catalogItemId: ids.bb,
      sku: "KB-3455",
      name: "BALTIC BIRCH PLY 18MM BB/BB 1525",
      vendorUom: "sheet",
      stdPerVendorUom: "1",
      preferred: true,
    });
    ids.kscr = await listed({
      vendorId: ids.keystone,
      catalogItemId: ids.screws,
      sku: "SCR-8114",
      name: "WOOD SCREW 8 X 1-1/4 FH",
      packSize: "100 per pack",
      vendorUom: "pack",
      stdPerVendorUom: "100",
      ext: { unitWord: "box" },
    });
  });
  afterAll(async () => {
    if (db) await closeDb(db);
    await t?.drop();
  });

  it("matches a description that names a vendor item's SKU or name, and nothing else", async () => {
    const r = await call(catalogMatchText, {
      descriptions: [
        "baltic birch KB-3455",
        // Keystone's own name for it, as its price list writes it.
        "baltic birch ply 18mm bb/bb 1525",
        "12 sheets of birch",
      ],
    });
    expect(r.lines.map((l: J) => [l.decision, l.catalogItemId, l.method, l.vendorItemId])).toEqual([
      ["matched", ids.bb, "alias", ids.kbb],
      ["matched", ids.bb, "alias", ids.kbb],
      ["unsure", null, null, null],
    ]);
    expect(r.sources).toEqual(expect.arrayContaining([ids.bb, ids.kbb]));
    // Through the vendor catalog only: no alias names the SKU or the words.
    expect(await t.db.select().from(itemAlias).where(eq(itemAlias.tenantId, A.tenantId))).toEqual(
      [],
    );
    // With a vendor, only that vendor's catalog counts.
    const other = await call(catalogMatchText, {
      descriptions: ["KB-3455"],
      vendorId: ids.northline,
    });
    expect(other.lines[0].decision).toBe("unsure");
  });

  it("lets the line's own words veto the SKU (invariant 7)", async () => {
    // The SKU is the plywood's, but the words say red oak lumber: never that item.
    const r = await call(catalogMatchText, { descriptions: ["4/4 red oak KB-3455"] });
    expect(r.lines[0]).toMatchObject({ decision: "unsure", catalogItemId: null });
  });

  it("takes a box line named by the SKU only when its size is the vendor's", async () => {
    const r = await call(requestCreate, {
      channel: "email",
      lines: [
        // No size in its words: the vendor's catalog knows the box holds 100.
        { description: "SCR-8114", qty: "3", unit: "box" },
        // Another size: not the vendor's box of 100.
        { description: "SCR-8114 50/BX", qty: "3", unit: "box" },
        // Another pack word than the one the item was recorded in.
        { description: "SCR-8114", qty: "1", unit: "case" },
      ],
    });
    expect(r.request.lines.map((l: J) => [l.catalogItemId, l.matchMethod])).toEqual([
      [ids.screws, "alias"],
      [null, null],
      [null, null],
    ]);
  });

  it("never matches one client's lines through another client's catalog", async () => {
    const r = await call(catalogMatchText, { descriptions: ["baltic birch KB-3455"] }, B);
    expect(r.lines[0]).toMatchObject({ decision: "unsure", catalogItemId: null });
  });

  it("fills the vendor catalog from QuickBooks bills, never from a pack it can't size", async () => {
    await A.qboBill({
      id: "201",
      vendorId: ids.northline,
      date: "2026-10-05",
      lines: [
        {
          id: "1",
          item: "Plywood",
          description: "3/4 BB/BB BALTIC BIRCH 5X5",
          qty: 10,
          unitPrice: 62.5,
        },
      ],
    });
    await A.qboBill({
      id: "202",
      vendorId: ids.keystone,
      date: "2026-10-06",
      lines: [
        // Keystone's box of screws, by its SKU: QuickBooks gives no unit, so no price.
        { id: "1", item: "Screws", description: "SCR-8114", qty: 4, unitPrice: 9.5 },
      ],
    });
    const test = await call(
      backfillFromBillsTool,
      { from: "2026-10-01", to: "2026-10-31" },
      A,
      "test",
    );
    expect(test).toMatchObject({ recorded: 0, newVendorItems: 0 });
    expect(await vendorItems(ids.northline, ids.bb)).toEqual([]);

    const r = await call(backfillFromBillsTool, { from: "2026-10-01", to: "2026-10-31" });
    expect(r).toMatchObject({ recorded: 1, matched: 2, newVendorItems: 1, skipped: 1 });
    const [made] = await vendorItems(ids.northline, ids.bb);
    expect(made).toMatchObject({
      sku: null,
      name: "3/4 BB/BB BALTIC BIRCH 5X5",
      vendorUom: "sheet",
      stdPerVendorUom: "1.0000",
      lastPrice: "62.5000",
      lastPriceStd: "62.5000",
      lastPriceOn: "2026-10-05",
      lastPriceSource: "qbo_bill",
      createdByAgentVersionId: A.agentVersionId,
      ext: { from: "qbo_bill" },
    });
    // Keystone's box was left as it was.
    const [box] = await t.db.select().from(vendorItem).where(eq(vendorItem.id, ids.kscr));
    expect(box?.lastPrice).toBeNull();
  });

  it("neither prices nor fills the catalog from a bill line the vendor's alias names as its box", async () => {
    // Keystone's invoice taught its wording for the box of screws (Register item), naming the box.
    const wording = "WOOD SCREWS FH 8 PER BX";
    const normalized = normalize(wording);
    await t.db.insert(itemAlias).values({
      tenantId: A.tenantId,
      vendorId: ids.keystone,
      descriptionHash: await descriptionHash(normalized),
      normalizedDescription: normalized,
      catalogItemId: ids.screws,
      source: "auto",
      vendorItemId: ids.kscr,
    });
    const match = await call(catalogMatchText, {
      descriptions: [wording],
      vendorId: ids.keystone,
    });
    expect(match.lines[0]).toMatchObject({
      decision: "matched",
      catalogItemId: ids.screws,
      vendorItemId: ids.kscr,
    });
    const bill = await A.qboBill({
      id: "203",
      vendorId: ids.keystone,
      date: "2026-11-03",
      lines: [{ id: "1", item: "Screws", description: wording, qty: 4, unitPrice: 9.5 }],
    });
    const r = await call(backfillFromBillsTool, { from: "2026-11-01", to: "2026-11-30" });
    expect(r).toMatchObject({ recorded: 0, matched: 1, newVendorItems: 0, skipped: 1 });
    // No each item made at the box's price, and no price per screw read from it.
    expect((await vendorItems(ids.keystone, ids.screws)).map((v) => v.id)).toEqual([ids.kscr]);
    expect(
      await t.db
        .select()
        .from(priceObservation)
        .where(eq(priceObservation.transactionId, bill.transactionId)),
    ).toEqual([]);
    await t.db.delete(itemAlias).where(eq(itemAlias.vendorId, ids.keystone));
  });

  it("fills the vendor catalog from quotes, only where the quote converts", async () => {
    const req = await call(requestCreate, {
      channel: "email",
      lines: [
        { description: "4/4 RED OAK FAS", qty: "200", unit: "BF" },
        { description: "#8 X 1-1/4 FLAT HEAD WOOD SCREW", qty: "500", unit: "each" },
      ],
    });
    const [oak, screws] = req.request.lines;
    expect([oak.catalogItemId, screws.catalogItemId]).toEqual([ids.oak, ids.screws]);
    const q = await call(quoteCreate, {
      requestId: req.request.id,
      vendorIds: [ids.northline],
    });
    await call(quoteRecord, {
      quoteRequestId: q.quotes[0].id,
      lines: [
        // Per thousand board feet: a rule, so Northline's oak by the MBF is added.
        { requestLineId: oak.id, unitPrice: "4800", unit: "MBF", description: "RED OAK 4/4 FAS" },
        // A box with no size in its words: no rule, so no vendor item.
        { requestLineId: screws.id, unitPrice: "9.00", unit: "BX" },
      ],
    });
    const [oakItem] = await vendorItems(ids.northline, ids.oak);
    expect(oakItem).toMatchObject({
      name: "RED OAK 4/4 FAS",
      vendorUom: "thousand_board_feet",
      stdPerVendorUom: "1000.0000",
      lastPrice: "4800.0000",
      lastPriceStd: "4.8000",
      lastPriceSource: "quote",
      ext: { from: "quote", unitWord: "thousand_board_feet" },
    });
    expect(await vendorItems(ids.northline, ids.screws)).toEqual([]);
  });

  it("adds a box from a quote only with the size its own line states, in that word", async () => {
    const req = await call(requestCreate, {
      channel: "email",
      lines: [{ description: "#8 X 1-1/4 FLAT HEAD WOOD SCREW", qty: "500", unit: "each" }],
    });
    const q = await call(quoteCreate, {
      requestId: req.request.id,
      vendorIds: [ids.northline],
    });
    await call(quoteRecord, {
      quoteRequestId: q.quotes[0].id,
      lines: [
        {
          requestLineId: req.request.lines[0].id,
          unitPrice: "9.00",
          unit: "BX",
          description: "WOOD SCREW 8 X 1-1/4 100/BX",
        },
      ],
    });
    const made = await vendorItems(ids.northline, ids.screws);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({
      sku: null,
      name: "WOOD SCREW 8 X 1-1/4 100/BX",
      vendorUom: "pack",
      stdPerVendorUom: "100.0000",
      lastPrice: "9.0000",
      lastPriceStd: "0.0900",
      lastPriceSource: "quote",
      ext: { from: "quote", unitWord: "box" },
    });
    // An RFQ asks in the newest priced item's words, never an item not yet priced.
    await listed({
      vendorId: ids.northline,
      catalogItemId: ids.screws,
      name: "SCREW FH 8 X 1-1/4 LOOSE",
      vendorUom: "each",
      stdPerVendorUom: "1",
    });
    const words = await withTenant(db, A.tenantId, (tx) =>
      vendorAliases(tx, A.tenantId, ids.northline, ids.screws),
    );
    expect(words).toEqual({ sku: null, description: "WOOD SCREW 8 X 1-1/4 100/BX" });
  });

  it("finds the preferred vendor first, and a vendor the catalog alone knows", async () => {
    const r = await call(vendorsForItemsTool, { catalogItemIds: [ids.bb] });
    expect(r.items[0].vendors.map((v: J) => [v.vendorName, v.preferred])).toEqual([
      // Keystone has no price yet, only its catalog item, but it is the client's first choice.
      ["Keystone Lumber", true],
      ["Northline Panel Supply", false],
    ]);
    expect(r.items[0].vendors[0].sources).toEqual([ids.kbb]);
    expect(r.vendorIds.sort()).toEqual([ids.keystone, ids.northline].sort());
  });
});
