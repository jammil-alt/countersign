// The vendor catalog's tools on a throwaway database (docs/plan.md §1.88): matching a vendor, the
// catalog's Save to records writes (upsert, preferred, discontinued), the last price (the newer date
// wins), an older alias with no vendor item, a test run's Register item writing nothing, the
// embedding write (idempotent), and one client never reaching another's vendor items (invariant 1).

import { type Db, vendor, withTenant } from "@countersign/db";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "@countersign/db/testing";
import { createLlmClient } from "@countersign/llm";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseLine } from "../catalog/keys";
import { mergeItems } from "../catalog/merge";
import { descriptionHash, normalize } from "../catalog/normalize";
import { openLines } from "../catalog/split";
import { backfillFromBillsTool } from "../purchasing/tools";
import { catalogItem, itemAlias, priceObservation, vendorItem } from "../schema";
import { insertShop, type ShopFixture } from "../testing.test-helper";
import { type PackToolContext, packToolContext } from "../tools";
import { EMBEDDING_TEMPLATE } from "./embedding-text";
import { registerLines } from "./pipeline";
import { priceForVendorItem, recordLastPrice, recordLeadTime } from "./store";
import {
  embeddingsWrite,
  vendorItemDiscontinue,
  vendorItemSetPreferred,
  vendorItemsForItem,
  vendorItemsImport,
  vendorItemsList,
  vendorItemsLookup,
  vendorItemUpsert,
  vendorMatch,
} from "./tools";

const online = await databaseAvailable();

// biome-ignore lint/suspicious/noExplicitAny: jsonb read loosely in tests.
type J = any;

async function errorOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    return (error as Error).message;
  }
  return "";
}

describe.skipIf(!online)("the vendor catalog's tools", () => {
  let t: TestDatabase;
  let A: ShopFixture;
  let B: ShopFixture;
  let ctxA: PackToolContext;
  let ctxB: PackToolContext;
  let northline = "";
  let cedar = "";
  let other = "";
  let baltic = "";
  let walnut = "";

  const item = async (shop: ShopFixture, text: string) => {
    const p = parseLine(text);
    const [row] = await t.db
      .insert(catalogItem)
      .values({
        tenantId: shop.tenantId,
        category: p.category,
        canonicalName: text,
        attributes: p.attributes,
        standardUom: p.standardUom,
      })
      .returning();
    return row?.id ?? "";
  };
  const ctx = (shop: ShopFixture, db: Db, extra: Partial<PackToolContext> = {}) => ({
    ...packToolContext({
      tenantId: shop.tenantId,
      agentVersionId: shop.agentVersionId,
      mode: "live",
      db,
    }),
    ...extra,
  });

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    A = await insertShop(t.db, "Millwork A");
    B = await insertShop(t.db, "Millwork B");
    northline = await A.vendor("Northline Panel Supply");
    cedar = await A.vendor("Cedar Ridge Lumber");
    other = await B.vendor("Northline Panel Supply");
    await t.db
      .update(vendor)
      .set({ ext: { domains: ["northline.example"], taxId: "12-3456789" } })
      .where(eq(vendor.id, northline));
    await t.db
      .update(vendor)
      .set({ aliases: ["cedar ridge"] })
      .where(eq(vendor.id, cedar));
    baltic = await item(A, 'BALTIC BIRCH PLYWOOD 3/4" 5X5 BB/BB');
    walnut = await item(A, "WALNUT 4/4 FAS");
    ctxA = ctx(A, t.db);
    ctxB = ctx(B, t.db);
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("matches a vendor by id, tax id, email domain and known name; a near name only when asked", async () => {
    const run = (input: Record<string, unknown>, settings: Record<string, unknown> = {}) =>
      vendorMatch.run(input, { ...ctxA, settings }) as Promise<{
        matched: boolean;
        vendorId: string | null;
        method: string | null;
        candidates: unknown[];
      }>;
    expect(await run({ vendorId: northline })).toMatchObject({ vendorId: northline, method: "id" });
    expect(await run({ taxId: "123456789" })).toMatchObject({
      vendorId: northline,
      method: "tax_id",
    });
    expect(await run({ email: "ap@northline.example" })).toMatchObject({
      vendorId: northline,
      method: "email_domain",
    });
    expect(await run({ name: "Cedar Ridge" })).toMatchObject({ vendorId: cedar, method: "name" });
    expect(await run({ name: "Northline Panel Suply" })).toMatchObject({ matched: false });
    expect(
      await run({ name: "Northline Panel Suply" }, { min_name_similarity: 0.5 }),
    ).toMatchObject({
      vendorId: northline,
      method: "similar_name",
    });
    // Another client's vendor is never found.
    expect(await errorOf(run({ vendorId: other }))).toMatch(/not found/);
  });

  it("adds and changes a vendor's item, by id or SKU, refusing what doesn't fit", async () => {
    const made = (await vendorItemUpsert.run(
      {
        vendorId: northline,
        catalogItemId: baltic,
        sku: "bb34-55",
        name: "BALTIC BIRCH PLY 3/4 5X5",
        vendorUom: "bundle",
        packSize: "bundle of 5",
        stdPerVendorUom: "5",
        listPrice: "330.0000",
        listPriceOn: "2026-10-01",
      },
      ctxA,
    )) as { item: { id: string; sku: string; stdPerVendorUom: string }; created: boolean };
    expect(made).toMatchObject({
      created: true,
      item: { sku: "BB34-55", stdPerVendorUom: "5.0000" },
    });
    const changed = (await vendorItemUpsert.run(
      { vendorId: northline, sku: "BB34-55", leadTimeDays: 3, minOrderQty: "2" },
      ctxA,
    )) as { item: { id: string; leadTimeDays: number }; created: boolean };
    expect(changed).toMatchObject({ created: false, item: { id: made.item.id, leadTimeDays: 3 } });
    expect(
      await errorOf(
        vendorItemUpsert.run(
          { vendorId: northline, catalogItemId: baltic, name: "x", listPrice: "1" },
          ctxA,
        ),
      ),
    ).toMatch(/needs its date/);
    expect(
      await errorOf(vendorItemUpsert.run({ id: made.item.id, vendorId: cedar }, ctxA)),
    ).toMatch(/another vendor/);
    expect(
      await errorOf(vendorItemUpsert.run({ vendorId: northline, sku: "NEW-1" }, ctxA)),
    ).toMatch(/needs its master item/);
    // B can neither see nor change A's item.
    expect(
      await errorOf(vendorItemUpsert.run({ id: made.item.id, vendorId: other }, ctxB)),
    ).toMatch(/not found/);
    expect(await errorOf(vendorItemsList.run({ vendorId: northline }, ctxB))).toMatch(/not found/);
  });

  it("keeps the newest price by date: an older document never overwrites it", async () => {
    const [vi] = await t.db.select().from(vendorItem).where(eq(vendorItem.sku, "BB34-55"));
    const id = vi?.id ?? "";
    const set = (price: string, on: string) =>
      t.db.transaction((tx) =>
        recordLastPrice(tx as never, A.tenantId, id, {
          price,
          priceStd: (Number(price) / 5).toFixed(4),
          on,
          source: "invoice",
          sourceId: null,
          currency: "USD",
        }),
      );
    expect(await set("340.00", "2026-11-02")).toBe(true);
    expect(await set("320.00", "2026-10-15")).toBe(false);
    expect(await set("345.00", "2026-11-02")).toBe(true);
    const [after] = await t.db.select().from(vendorItem).where(eq(vendorItem.id, id));
    expect(after).toMatchObject({
      lastPrice: "345.0000",
      lastPriceStd: "69.0000",
      lastPriceOn: "2026-11-02",
    });
  });

  it("marks one preferred vendor per master item, side by side, and discontinues", async () => {
    const cedarItem = (await vendorItemUpsert.run(
      {
        vendorId: cedar,
        catalogItemId: baltic,
        name: "BALTIC 3/4 5X5",
        vendorUom: "sheet",
        stdPerVendorUom: "1",
      },
      ctxA,
    )) as { item: { id: string } };
    await t.db
      .update(vendorItem)
      .set({ lastPrice: "66.0000", lastPriceStd: "66.0000", lastPriceOn: "2026-11-01" })
      .where(eq(vendorItem.id, cedarItem.item.id));
    const [nl] = await t.db.select().from(vendorItem).where(eq(vendorItem.sku, "BB34-55"));
    // Cheapest per sheet first (66 < 69), until one is preferred.
    const side = async () =>
      (
        (await vendorItemsForItem.run({ catalogItemId: baltic }, ctxA)) as {
          vendors: { id: string }[];
        }
      ).vendors.map((v) => v.id);
    expect(await side()).toEqual([cedarItem.item.id, nl?.id]);
    await vendorItemSetPreferred.run({ vendorItemId: nl?.id }, ctxA);
    expect(await side()).toEqual([nl?.id, cedarItem.item.id]);
    const moved = (await vendorItemSetPreferred.run({ vendorItemId: cedarItem.item.id }, ctxA)) as {
      cleared: string[];
    };
    expect(moved.cleared).toEqual([nl?.id]);
    const gone = (await vendorItemDiscontinue.run({ vendorItemId: cedarItem.item.id }, ctxA)) as {
      item: { status: string; preferred: boolean };
    };
    expect(gone.item).toMatchObject({ status: "discontinued", preferred: false });
    expect(
      await errorOf(vendorItemSetPreferred.run({ vendorItemId: cedarItem.item.id }, ctxA)),
    ).toMatch(/discontinued/);
    expect(await side()).toEqual([nl?.id]);
  });

  it("reads an alias kept before the vendor catalog through the vendor's only item for it", async () => {
    const [walnutItem] = await t.db
      .insert(vendorItem)
      .values({
        tenantId: A.tenantId,
        vendorId: northline,
        catalogItemId: walnut,
        name: "WALNUT 4/4 FAS KD",
      })
      .returning();
    const wording = normalize("WALNUT 4/4 FAS KD");
    await t.db.insert(itemAlias).values({
      tenantId: A.tenantId,
      vendorId: northline,
      descriptionHash: await descriptionHash(wording),
      normalizedDescription: wording,
      catalogItemId: walnut,
      source: "auto",
    });
    const { documentId } = await A.invoiceDoc(northline, [
      { description: "WALNUT 4/4 FAS KD", qty: "100", uom: "BF", unitPrice: "9.80" },
      { description: "BB34-55 SOMETHING", sku: "bb34-55", qty: "2", uom: "BDL", unitPrice: "340" },
      { description: "MYSTERY ITEM", qty: "1", unitPrice: "5" },
    ]);
    const r = (await vendorItemsLookup.run({ documentId, vendorId: northline }, ctxA)) as {
      known: { lineNo: number; vendorItemId: string; via: string }[];
      openCount: number;
    };
    expect(r.known.map((k) => [k.lineNo, k.via, k.vendorItemId])).toEqual([
      [1, "wording", walnutItem?.id],
      [2, "sku", expect.any(String)],
    ]);
    expect(r.openCount).toBe(1);
    // The same lookup from another client finds nothing of A's.
    expect(await errorOf(vendorItemsLookup.run({ documentId, vendorId: northline }, ctxB))).toMatch(
      /no reading|not found/,
    );
  });

  it("writes nothing in a test run's Register item, and answers what it would have", async () => {
    const { documentId } = await A.invoiceDoc(cedar, [
      { description: "CHERRY 4/4 FAS", qty: "50", uom: "BF", unitPrice: "8.40" },
    ]);
    const before = await t.db
      .select()
      .from(catalogItem)
      .where(eq(catalogItem.tenantId, A.tenantId));
    const line = {
      docLineId: "",
      lineNo: 1,
      decision: "new_item" as const,
      catalogItemId: null,
      confidence: 0.95,
      method: "rules" as const,
      hingeAttribute: null,
      needsReview: false,
      vetoed: null,
      category: "hardwood" as const,
      attributes: parseLine("CHERRY 4/4 FAS").attributes,
      candidates: [],
    };
    const r = await registerLines(t.db, {
      tenantId: A.tenantId,
      agentVersionId: A.agentVersionId,
      documentId,
      vendorId: cedar,
      lines: [line],
      testRun: true,
    });
    expect(r).toMatchObject({ testRun: true });
    expect(r.lines[0]).toMatchObject({
      decision: "new_item",
      createdItem: true,
      createdVendorItem: true,
    });
    const after = await t.db.select().from(catalogItem).where(eq(catalogItem.tenantId, A.tenantId));
    expect(after).toHaveLength(before.length);
  });

  it("embeds what has no embedding, once; without a model it says what is left", async () => {
    const none = (await embeddingsWrite.run({ catalogItemIds: [baltic, walnut] }, ctxA)) as {
      embedded: number;
      left: number;
    };
    expect(none).toMatchObject({ embedded: 0, left: 2 });
    const seen: string[][] = [];
    const llm = createLlmClient({
      transport: {
        create: () => Promise.reject(new Error("no")),
        embed: async (request) => {
          seen.push([...request.input]);
          return {
            model: "text-embedding-3-large",
            embeddings: request.input.map((_, i) =>
              Array.from({ length: request.dimensions }, (_, j) => (j === i ? 1 : 0)),
            ),
            usage: { inputTokens: 10 },
          };
        },
      },
    });
    const withModel = { ...ctxA, llm };
    const first = (await embeddingsWrite.run({ catalogItemIds: [baltic, walnut] }, withModel)) as {
      embedded: number;
    };
    expect(first.embedded).toBe(2);
    const again = (await embeddingsWrite.run({ catalogItemIds: [baltic, walnut] }, withModel)) as {
      embedded: number;
      left: number;
    };
    expect(again).toMatchObject({ embedded: 0, left: 0 });
    expect(seen).toHaveLength(1);
    const [row] = await t.db.select().from(catalogItem).where(eq(catalogItem.id, baltic));
    expect(row?.embedding).toHaveLength(1024);
    // A test run makes none.
    const test = (await embeddingsWrite.run({ missing: 10 }, { ...withModel, mode: "test" })) as {
      embedded: number;
      testRun: boolean;
    };
    expect(test).toMatchObject({ embedded: 0, testRun: true });
  });

  it("embeds name, description and specs, when an item is saved and again when they change", async () => {
    const seen: string[] = [];
    const llm = createLlmClient({
      transport: {
        create: () => Promise.reject(new Error("no")),
        embed: async (request) => {
          seen.push(...request.input);
          return {
            model: "text-embedding-3-large",
            embeddings: request.input.map(() =>
              Array.from({ length: request.dimensions }, (_, j) => (j === 0 ? 1 : 0)),
            ),
            usage: { inputTokens: 10 },
          };
        },
      },
    });
    const withModel = { ...ctxA, llm };
    const walnutText =
      "Name: WALNUT 4/4 FAS\nSpecs: category hardwood; species walnut; thickness 4/4; grade fas; surfacing rough; cut plain";
    // The master item embedded above went in the one template.
    const [master] = await t.db.select().from(catalogItem).where(eq(catalogItem.id, walnut));
    expect((master?.ext as J)?.embedding).toEqual({
      text: walnutText,
      template: EMBEDDING_TEMPLATE,
    });
    // Saved: embedded at once, with the vendor's wording and its master item's specs.
    const saved = (await vendorItemUpsert.run(
      {
        vendorId: cedar,
        catalogItemId: walnut,
        sku: "WAL44",
        name: "WALNUT 4/4 FAS KD",
        description: "Kiln dried, $9.80/BF, QTY 120",
        vendorUom: "board_foot",
      },
      withModel,
    )) as { item: { id: string }; embedded: boolean };
    expect(saved.embedded).toBe(true);
    expect(seen.at(-1)).toBe(
      "Name: WALNUT 4/4 FAS KD\nDescription: Kiln dried\nSpecs: category hardwood; species walnut; thickness 4/4; grade fas; surfacing rough; cut plain",
    );
    const count = seen.length;
    // A lead time changes nothing it is embedded from.
    const lead = (await vendorItemUpsert.run(
      { vendorId: cedar, sku: "WAL44", leadTimeDays: 5 },
      withModel,
    )) as { embedded: boolean };
    expect(lead.embedded).toBe(false);
    expect(seen).toHaveLength(count);
    // A new description does: embedded again.
    const desc = (await vendorItemUpsert.run(
      { vendorId: cedar, sku: "WAL44", description: "Kiln dried, select and better" },
      withModel,
    )) as { embedded: boolean };
    expect(desc.embedded).toBe(true);
    expect(seen.at(-1)).toContain("Description: Kiln dried, select and better");
    // Without a model the change is remembered: `missing` finds it later.
    await vendorItemUpsert.run(
      { vendorId: cedar, sku: "WAL44", name: "WALNUT 4/4 FAS KD S2S" },
      ctxA,
    );
    const [due] = await t.db.select().from(vendorItem).where(eq(vendorItem.sku, "WAL44"));
    expect((due?.ext as J)?.embedding).toBeUndefined();
    expect(due?.embedding).toHaveLength(1024);
    // An item embedded before the template was named is due again too.
    await t.db
      .update(catalogItem)
      .set({ ext: { embedding: { text: "WALNUT 4/4 FAS" } } })
      .where(eq(catalogItem.id, walnut));
    const before = seen.length;
    const missing = (await embeddingsWrite.run({ missing: 500 }, withModel)) as {
      catalogItems: number;
      vendorItems: number;
    };
    expect(missing.catalogItems).toBeGreaterThanOrEqual(1);
    expect(missing.vendorItems).toBeGreaterThanOrEqual(1);
    const texts = seen.slice(before);
    expect(texts).toContain(walnutText);
    expect(texts.some((x) => x.startsWith("Name: WALNUT 4/4 FAS KD S2S\n"))).toBe(true);
    // Everything is embedded under the template now: nothing is due.
    const after = (await embeddingsWrite.run({ missing: 500 }, withModel)) as { embedded: number };
    expect(after.embedded).toBe(0);
  });

  it("imports a vendor's price list: by SKU, by the vendor's wording, by a named master item", async () => {
    const csv = [
      "SKU,Description,Pack,UOM,Units per pack,List Price,Lead time",
      'BB34-55,"BALTIC BIRCH PLY 3/4 5X5 BB/BB",bundle of 5,bundle,5,"$335.00",4 days',
      ",WALNUT 4/4 FAS KD,,BF,,9.95,",
      "NEW-77,MYSTERY PANEL,,EA,,12.00,",
      "BB34-55,the same SKU again,,,,1,",
      ",,,,,,",
    ].join("\r\n");
    const r = (await vendorItemsImport.run(
      { vendorId: northline, listPriceOn: "2026-11-01", csv },
      ctxA,
    )) as J;
    expect(r.rows.map((x: J) => [x.rowNo, x.outcome])).toEqual([
      [1, "updated"],
      [2, "updated"],
      [3, "unplaced"],
      [4, "skipped"],
    ]);
    expect(r).toMatchObject({ updated: 2, created: 0, unplaced: 1, skipped: 1 });
    const [bb] = await t.db.select().from(vendorItem).where(eq(vendorItem.sku, "BB34-55"));
    expect(bb).toMatchObject({
      listPrice: "335.0000",
      listPriceOn: "2026-11-01",
      leadTimeDays: 4,
      stdPerVendorUom: "5.0000",
      packSize: "bundle of 5",
      name: "BALTIC BIRCH PLY 3/4 5X5 BB/BB",
    });
    // The wording found the vendor's only item for the walnut (an alias kept before 0047).
    const walnutRow = r.rows[1];
    expect(walnutRow.catalogItemId).toBe(walnut);
    const [wal] = await t.db
      .select()
      .from(vendorItem)
      .where(eq(vendorItem.id, walnutRow.vendorItemId));
    expect(wal).toMatchObject({ vendorUom: "board_foot", listPrice: "9.9500" });
    // The renamed BB item is to embed again; the walnut kept its name.
    expect(r.vendorItemIds).toEqual([bb?.id]);
    // A row that names its master item adds the vendor's item; a test run writes nothing.
    const rows = [
      { sku: "BB12-55", name: "BB PLY 1/2 5X5", catalogItemId: baltic, vendorUom: "SHT" },
    ];
    const test = (await vendorItemsImport.run(
      { vendorId: northline, listPriceOn: "2026-11-01", rows },
      { ...ctxA, mode: "test" },
    )) as J;
    expect(test).toMatchObject({ created: 1, testRun: true });
    expect(await t.db.select().from(vendorItem).where(eq(vendorItem.sku, "BB12-55"))).toEqual([]);
    const made = (await vendorItemsImport.run(
      { vendorId: northline, listPriceOn: "2026-11-01", rows },
      ctxA,
    )) as J;
    expect(made).toMatchObject({ created: 1 });
    const [half] = await t.db.select().from(vendorItem).where(eq(vendorItem.sku, "BB12-55"));
    expect(half).toMatchObject({ catalogItemId: baltic, vendorUom: "sheet", listPrice: null });
    // Another client's vendor can't be imported into.
    expect(
      await errorOf(
        vendorItemsImport.run({ vendorId: northline, listPriceOn: "2026-11-01", rows }, ctxB),
      ),
    ).toMatch(/not found/);
    expect(
      await errorOf(
        vendorItemsImport.run(
          { vendorId: northline, listPriceOn: "2026-11-01", csv: "Price,Pack\n1,2" },
          ctxA,
        ),
      ),
    ).toMatch(/SKU or a name column/);
  });

  it("takes a QuickBooks bill's price as the vendor item's last price, in its own unit", async () => {
    await A.qboBill({
      id: "901",
      vendorId: cedar,
      date: "2026-11-05",
      lines: [{ id: "1", item: "Walnut", description: "WALNUT 4/4 FAS", qty: 100, unitPrice: 9.5 }],
    });
    const r = (await backfillFromBillsTool.run(
      { from: "2026-11-01", to: "2026-11-30" },
      ctxA,
    )) as J;
    expect(r).toMatchObject({ recorded: 1, matched: 1 });
    const [wal] = await t.db.select().from(vendorItem).where(eq(vendorItem.sku, "WAL44"));
    expect(wal).toMatchObject({
      lastPrice: "9.5000",
      lastPriceStd: "9.5000",
      lastPriceOn: "2026-11-05",
      lastPriceSource: "qbo_bill",
    });
    const [price] = await t.db
      .select()
      .from(priceObservation)
      .where(eq(priceObservation.vendorId, cedar));
    expect(price?.vendorItemId).toBe(wal?.id);
  });

  it("reads a price in the vendor item's own unit only, never by guessing a conversion", () => {
    const p = { price: "61.00", unit: "sheet", priceStd: "61.0000", standardUom: "sheet" };
    expect(priceForVendorItem({ vendorUom: "sheet", stdPerVendorUom: null }, p)).toEqual({
      price: "61.0000",
      priceStd: "61.0000",
    });
    expect(priceForVendorItem({ vendorUom: "bundle", stdPerVendorUom: "5" }, p)).toEqual({
      price: "305.0000",
      priceStd: "61.0000",
    });
    expect(priceForVendorItem({ vendorUom: "bundle", stdPerVendorUom: null }, p)).toBeNull();
    expect(
      priceForVendorItem(
        { vendorUom: "bundle", stdPerVendorUom: "5" },
        { price: "300", unit: "bundle", priceStd: null, standardUom: "sheet" },
      ),
    ).toEqual({ price: "300.0000", priceStd: "60.0000" });
    expect(
      priceForVendorItem(
        { vendorUom: null, stdPerVendorUom: null },
        { price: "2", unit: "linear_foot", priceStd: null, standardUom: "board_foot" },
      ),
    ).toBeNull();
  });

  // ── The review of vendor/web3 ──────────────────────────────────────────────────────────────

  /** A line Check matches decided, as Register item takes it. */
  const decided = (
    lineNo: number,
    text: string,
    d: { decision: "matched" | "new_item"; catalogItemId?: string | null },
  ) => {
    const p = parseLine(text);
    return {
      docLineId: "",
      lineNo,
      decision: d.decision,
      catalogItemId: d.catalogItemId ?? null,
      confidence: 0.97,
      method: "rules" as const,
      hingeAttribute: null,
      needsReview: false,
      vetoed: null,
      category: p.category,
      attributes: p.attributes,
      candidates: [],
    };
  };

  it("matches a vendor only on what the agent's match_on names, and refuses a word it doesn't know", async () => {
    const run = (input: Record<string, unknown>, settings: Record<string, unknown>) =>
      vendorMatch.run(input, { ...ctxA, settings }) as Promise<{
        matched: boolean;
        method: string | null;
      }>;
    expect(await run({ taxId: "123456789" }, { match_on: "name" })).toMatchObject({
      matched: false,
    });
    expect(
      await run({ taxId: "123456789", name: "Cedar Ridge" }, { match_on: "Tax ID, name" }),
    ).toMatchObject({ method: "tax_id" });
    expect(await run({ email: "ap@northline.example" }, { match_on: "" })).toMatchObject({
      method: "email_domain",
    });
    // A vendor id given is always taken.
    expect(await run({ vendorId: cedar }, { match_on: "name" })).toMatchObject({ method: "id" });
    expect(await errorOf(run({ name: "Cedar Ridge" }, { match_on: "name, phone" }))).toMatch(
      /phone/,
    );
  });

  it("hands on the agent's shortlist sizes, 1 to 10, else the defaults", async () => {
    const { documentId } = await A.invoiceDoc(cedar, [
      { description: "ASH 4/4 FAS", qty: "10", uom: "BF", unitPrice: "6.00" },
    ]);
    const sizes = async (settings: Record<string, unknown>) =>
      (
        (await vendorItemsLookup.run({ documentId, vendorId: cedar }, { ...ctxA, settings })) as {
          shortlist: unknown;
        }
      ).shortlist;
    expect(await sizes({})).toEqual({ vendorItems: 5, masterItems: 5 });
    expect(await sizes({ vendor_shortlist_size: 3, master_shortlist_size: 8 })).toEqual({
      vendorItems: 3,
      masterItems: 8,
    });
    expect(await sizes({ vendor_shortlist_size: 40 })).toEqual({ vendorItems: 5, masterItems: 5 });
  });

  it("keeps the last price in the vendor item's own unit when the line is in another", async () => {
    const oak = await item(A, "WHITE OAK 8/4 FAS");
    const [w44] = await t.db
      .insert(vendorItem)
      .values({
        tenantId: A.tenantId,
        vendorId: northline,
        catalogItemId: oak,
        sku: "W44",
        name: "WHITE OAK 8/4 FAS",
        vendorUom: "board_foot",
        stdPerVendorUom: "1",
      })
      .returning();
    const { documentId } = await A.invoiceDoc(
      northline,
      [{ description: "WHITE OAK 8/4 FAS", sku: "W44", qty: "1", uom: "MBF", unitPrice: "8400" }],
      { date: "2026-11-03" },
    );
    await registerLines(t.db, {
      tenantId: A.tenantId,
      agentVersionId: A.agentVersionId,
      documentId,
      vendorId: northline,
      lines: [decided(1, "WHITE OAK 8/4 FAS", { decision: "matched", catalogItemId: oak })],
      testRun: false,
    });
    const [after] = await t.db
      .select()
      .from(vendorItem)
      .where(eq(vendorItem.id, w44?.id ?? ""));
    // 8,400 per thousand board feet is 8.40 per board foot, the vendor item's unit.
    expect(after).toMatchObject({
      lastPrice: "8.4000",
      lastPriceStd: "8.4000",
      lastPriceOn: "2026-11-03",
    });
  });

  it("makes vendor-neutral master items: no pack size, no vendor's wording; one vendor's box never converts another's", async () => {
    const text = "BLUM 71B3550 CLIP TOP HINGE 110 DEG 100/BOX";
    const first = await A.invoiceDoc(northline, [
      { description: text, sku: "71B3550-100", qty: "2", uom: "BX", unitPrice: "180.00" },
    ]);
    const r = await registerLines(t.db, {
      tenantId: A.tenantId,
      agentVersionId: A.agentVersionId,
      documentId: first.documentId,
      vendorId: northline,
      lines: [decided(1, text, { decision: "new_item" })],
      testRun: false,
    });
    const masterId = r.lines[0]?.catalogItemId ?? "";
    expect(r.lines[0]).toMatchObject({ createdItem: true, createdVendorItem: true });
    const [master] = await t.db.select().from(catalogItem).where(eq(catalogItem.id, masterId));
    expect(master?.attributes).not.toHaveProperty("pack_size");
    expect(master?.ext).not.toHaveProperty("firstDescription");
    expect(master?.canonicalName).not.toMatch(/100\/BOX|71B3550-100/i);
    // The pack is the vendor item's.
    const [mine] = await t.db
      .select()
      .from(vendorItem)
      .where(eq(vendorItem.id, r.lines[0]?.vendorItemId ?? ""));
    expect(mine?.packSize).toContain("100");
    // A second vendor's box that doesn't say how many it holds is never priced per hinge.
    const second = await A.invoiceDoc(cedar, [
      { description: "BLUM 71B3550 HINGE", qty: "1", uom: "BX", unitPrice: "25.00" },
    ]);
    const r2 = await registerLines(t.db, {
      tenantId: A.tenantId,
      agentVersionId: A.agentVersionId,
      documentId: second.documentId,
      vendorId: cedar,
      lines: [decided(1, "BLUM 71B3550 HINGE", { decision: "matched", catalogItemId: masterId })],
      testRun: false,
    });
    expect(r2.lines[0]?.observationId).toBeNull();
    expect(r2.lines[0]?.priceSkipped).toMatch(/no conversion/);
    const [theirs] = await t.db
      .select()
      .from(vendorItem)
      .where(eq(vendorItem.id, r2.lines[0]?.vendorItemId ?? ""));
    expect(theirs).toMatchObject({ lastPrice: "25.0000", lastPriceStd: null });
  });

  it("moves a merged master item's vendor items to the one that stays", async () => {
    const from = await item(A, "MAPLE 4/4 FAS");
    const into = await item(A, "HARD MAPLE 4/4 FAS");
    const [m44] = await t.db
      .insert(vendorItem)
      .values({
        tenantId: A.tenantId,
        vendorId: northline,
        catalogItemId: from,
        sku: "M44",
        name: "MAPLE 4/4 FAS",
        vendorUom: "board_foot",
        preferred: true,
      })
      .returning();
    const [keep] = await t.db
      .insert(vendorItem)
      .values({
        tenantId: A.tenantId,
        vendorId: cedar,
        catalogItemId: into,
        name: "HARD MAPLE 4/4",
        vendorUom: "board_foot",
        preferred: true,
        lastPrice: "5.0000",
        lastPriceOn: "2026-10-01",
        lastPriceSource: "invoice",
      })
      .returning();
    const [twin] = await t.db
      .insert(vendorItem)
      .values({
        tenantId: A.tenantId,
        vendorId: cedar,
        catalogItemId: from,
        name: "MAPLE 4/4",
        vendorUom: "board_foot",
        lastPrice: "5.5000",
        lastPriceOn: "2026-11-01",
        lastPriceSource: "invoice",
      })
      .returning();
    const wording = normalize("MAPLE 4/4");
    await t.db.insert(itemAlias).values({
      tenantId: A.tenantId,
      vendorId: cedar,
      descriptionHash: await descriptionHash(wording),
      normalizedDescription: wording,
      catalogItemId: from,
      vendorItemId: twin?.id ?? null,
      source: "auto",
    });
    const merged = await mergeItems(t.db, {
      tenantId: A.tenantId,
      fromId: from,
      intoId: into,
      userId: A.userId,
    });
    expect(merged.vendorItemsMoved).toBe(2);
    const byId = async (id: string | undefined) =>
      (
        await t.db
          .select()
          .from(vendorItem)
          .where(eq(vendorItem.id, id ?? ""))
      )[0];
    // The SKU's item moved; the item that stays keeps its own preferred vendor.
    expect(await byId(m44?.id)).toMatchObject({ catalogItemId: into, preferred: false });
    // The same vendor's item in the same unit is folded into the one that stays.
    expect(await byId(twin?.id)).toMatchObject({ catalogItemId: from, status: "discontinued" });
    expect((await byId(twin?.id))?.ext).toMatchObject({ foldedInto: keep?.id });
    expect(await byId(keep?.id)).toMatchObject({
      lastPrice: "5.5000",
      lastPriceOn: "2026-11-01",
    });
    const [alias] = await t.db
      .select()
      .from(itemAlias)
      .where(eq(itemAlias.normalizedDescription, wording));
    expect(alias).toMatchObject({ catalogItemId: into, vendorItemId: keep?.id });
    // The vendor's next invoice with the SKU registers on the item that stays, no person asked.
    const { documentId } = await A.invoiceDoc(northline, [
      { description: "MAPLE 4/4 FAS", sku: "M44", qty: "10", uom: "BF", unitPrice: "5.20" },
    ]);
    const looked = (await vendorItemsLookup.run({ documentId, vendorId: northline }, ctxA)) as {
      known: { catalogItemId: string; vendorItemId: string }[];
    };
    expect(looked.known[0]).toMatchObject({ catalogItemId: into, vendorItemId: m44?.id });
    const r = await registerLines(t.db, {
      tenantId: A.tenantId,
      agentVersionId: A.agentVersionId,
      documentId,
      vendorId: northline,
      lines: [decided(1, "MAPLE 4/4 FAS", { decision: "matched", catalogItemId: into })],
      testRun: false,
    });
    expect(r.needsPerson).toEqual([]);
    expect(r.lines[0]).toMatchObject({ decision: "matched", vendorItemId: m44?.id });
  });

  it("keeps the newest lead time: a quote dated earlier never replaces it", async () => {
    const [vi] = await t.db
      .insert(vendorItem)
      .values({
        tenantId: A.tenantId,
        vendorId: cedar,
        catalogItemId: walnut,
        sku: "LEAD-1",
        name: "WALNUT 4/4 FAS",
      })
      .returning();
    const id = vi?.id ?? "";
    const set = (days: number, on: string) =>
      withTenant(t.db, A.tenantId, (tx) => recordLeadTime(tx, A.tenantId, id, days, on));
    expect(await set(7, "2026-11-05")).toBe(true);
    expect(await set(3, "2026-11-01")).toBe(false);
    expect(await set(9, "2026-11-05")).toBe(true);
    const [row] = await t.db.select().from(vendorItem).where(eq(vendorItem.id, id));
    expect(row).toMatchObject({ leadTimeDays: 9 });
    expect(row?.ext).toMatchObject({ leadTimeOn: "2026-11-05" });
  });
});

describe("the vendor-first shortlist", () => {
  it("leaves out the candidates a key attribute rules out, for the model only", () => {
    const line = {
      docLineId: "d1",
      lineNo: 1,
      description: 'BALTIC BIRCH PLY 1/2"',
      category: "sheet_goods" as const,
      attributes: { thickness: "1/2in" },
      missing: ["size"],
      decision: "open" as const,
      catalogItemId: null,
      catalogItemName: null,
      method: null,
      confidence: 0.4,
      hinge: "size",
      candidates: [
        { ...candidate("a", "1/2in"), vetoed: false },
        { ...candidate("b", "3/4in"), vetoed: true },
      ],
    };
    expect(openLines([line])[0]?.candidates.map((c) => c.catalogItemId)).toEqual(["a", "b"]);
    expect(
      openLines([line], { withoutVetoed: true })[0]?.candidates.map((c) => c.catalogItemId),
    ).toEqual(["a"]);
  });
});

function candidate(id: string, thickness: string) {
  return {
    catalogItemId: id,
    name: `BALTIC BIRCH ${thickness}`,
    category: "sheet_goods" as const,
    attributes: { thickness },
    standardUom: "sheet",
    similarity: null,
    confidence: 0.5,
    hinge: null,
  };
}
