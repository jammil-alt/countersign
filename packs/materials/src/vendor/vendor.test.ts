// The vendor catalog's tools on a throwaway database (docs/plan.md §1.88): matching a vendor, the
// catalog's Save to records writes (upsert, preferred, discontinued), the last price (the newer date
// wins), an older alias with no vendor item, a test run's Register item writing nothing, the
// embedding write (idempotent), and one client never reaching another's vendor items (invariant 1).

import { dec } from "@countersign/core";
import { type Db, vendor, withTenant } from "@countersign/db";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "@countersign/db/testing";
import { createLlmClient } from "@countersign/llm";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseLine } from "../catalog/keys";
import { mergeItems } from "../catalog/merge";
import { descriptionHash, normalize } from "../catalog/normalize";
import { openLines } from "../catalog/split";
import { loadPricedDocument, priceLines } from "../pricing/record";
import { standardPrice } from "../purchasing/quotes";
import {
  backfillFromBillsTool,
  quoteCreate,
  quoteRecord,
  requestCreate,
} from "../purchasing/tools";
import {
  catalogItem,
  itemAlias,
  priceObservation,
  purchaseRequestLine,
  vendorItem,
} from "../schema";
import { type InvoiceLine, insertShop, type ShopFixture } from "../testing.test-helper";
import { type PackToolContext, packToolContext } from "../tools";
import { EMBEDDING_TEMPLATE } from "./embedding-text";
import { importPriceList } from "./import";
import { registerLines } from "./pipeline";
import {
  priceForVendorItem,
  recordLastPrice,
  recordLeadTime,
  updateVendorItem,
  vendorItemForUnit,
} from "./store";
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

  it("never lets a SKU outvote the line's words, nor takes a special-order code as one", async () => {
    await t.db.insert(vendorItem).values([
      {
        tenantId: A.tenantId,
        vendorId: cedar,
        catalogItemId: baltic,
        sku: "CRL-BB34",
        name: "BALTIC BIRCH 3/4 5X5",
      },
      // Kept before codes like this were refused as SKUs.
      { tenantId: A.tenantId, vendorId: cedar, catalogItemId: baltic, sku: "SPO", name: "SPO" },
    ]);
    const { documentId } = await A.invoiceDoc(cedar, [
      { description: 'BALTIC BIRCH PLYWOOD 3/4" 5X5 BB/BB', sku: "crl-bb34", qty: "2" },
      { description: 'BALTIC BIRCH PLYWOOD 1/2" 5X5 BB/BB', sku: "CRL-BB34", qty: "2" },
      { description: "WALNUT 4/4 FAS", sku: "SPO", qty: "40", uom: "BF" },
    ]);
    const r = (await vendorItemsLookup.run({ documentId, vendorId: cedar }, ctxA)) as {
      lines: { lineNo: number; decision: string; hinge: string | null }[];
      known: { lineNo: number; via: string }[];
    };
    expect(r.known.map((k) => [k.lineNo, k.via])).toEqual([[1, "sku"]]);
    expect(r.lines.map((l) => [l.lineNo, l.decision, l.hinge])).toEqual([
      [1, "matched", null],
      [2, "open", "thickness"],
      [3, "open", null],
    ]);
  });

  it("takes a pack size for a line without a SKU only from the one vendor item in its very word", async () => {
    const screws = await item(A, "#8 X 1-1/4 WOOD SCREW");
    const [box, kase] = await t.db
      .insert(vendorItem)
      .values([
        {
          tenantId: A.tenantId,
          vendorId: cedar,
          catalogItemId: screws,
          sku: "CRL-S100",
          name: "#8 SCREW 100/BX",
          vendorUom: "pack",
          stdPerVendorUom: "100",
          ext: { unitWord: "box" },
        },
        {
          tenantId: A.tenantId,
          vendorId: cedar,
          catalogItemId: screws,
          sku: "CRL-S1000",
          name: "#8 SCREW 1000/CS",
          vendorUom: "pack",
          stdPerVendorUom: "1000",
          ext: { unitWord: "case" },
        },
      ])
      .returning();
    const forUnit = (unitRaw: string | null, catalogItemId = screws) =>
      withTenant(t.db, A.tenantId, (tx) =>
        vendorItemForUnit(tx, A.tenantId, { vendorId: cedar, catalogItemId, unitRaw }),
      );
    expect((await forUnit("CS"))?.id).toBe(kase?.id);
    expect((await forUnit("box"))?.id).toBe(box?.id);
    // A pack, a carton: neither is recorded in that word, so no size is known.
    expect(await forUnit("PK")).toBeNull();
    expect(await forUnit("CTN")).toBeNull();
    // A box without a SKU recorded before words were kept: the lines filed under it never say
    // what it is (one may have been filed wrongly); only a line that states its 500 is it.
    const nails = await item(A, "16D COMMON NAIL");
    const older = await A.vendor("Older Nail Supply");
    const inUnit = (unitRaw: string, lineText = "16D COMMON NAIL") =>
      withTenant(t.db, A.tenantId, (tx) =>
        vendorItemForUnit(tx, A.tenantId, {
          vendorId: older,
          catalogItemId: nails,
          unitRaw,
          lineText,
        }),
      );
    const [legacy] = await t.db
      .insert(vendorItem)
      .values({
        tenantId: A.tenantId,
        vendorId: older,
        catalogItemId: nails,
        name: "16D NAIL BOX",
        vendorUom: "pack",
        stdPerVendorUom: "500",
      })
      .returning();
    const filed = await A.invoiceDoc(older, [
      { description: "16D COMMON NAIL", qty: "2", uom: "BX", unitPrice: "30.00" },
    ]);
    await t.db.insert(priceObservation).values({
      tenantId: A.tenantId,
      catalogItemId: nails,
      vendorId: older,
      vendorItemId: legacy?.id ?? null,
      observedOn: "2026-10-01",
      unitPriceStd: "0.0600",
      qtyStd: "1000.0000",
      standardUom: "each",
      docLineId: filed.lineIds[0] as string,
    });
    expect(await inUnit("CS")).toBeNull();
    expect(await inUnit("BX")).toBeNull();
    expect(await inUnit("BX", "16D COMMON NAIL 100/BX")).toBeNull();
    expect(await inUnit("BX", "16D COMMON NAIL 500/BX BOX OF 100")).toBeNull();
    expect((await inUnit("BX", "16D COMMON NAIL 500/BX"))?.id).toBe(legacy?.id);
    expect(await inUnit("CS", "16D COMMON NAIL 500/BX")).toBeNull();
  });

  it("keeps the unit's word with the unit when a vendor item's unit is corrected", async () => {
    const nails = await item(A, "8D COMMON NAIL");
    const [vi] = await t.db
      .insert(vendorItem)
      .values({
        tenantId: A.tenantId,
        vendorId: cedar,
        catalogItemId: nails,
        sku: "CRL-N8",
        name: "8D NAIL 100/BX",
        vendorUom: "pack",
        stdPerVendorUom: "100",
        ext: { unitWord: "box" },
      })
      .returning();
    const forUnit = (unitRaw: string) =>
      withTenant(t.db, A.tenantId, (tx) =>
        vendorItemForUnit(tx, A.tenantId, { vendorId: cedar, catalogItemId: nails, unitRaw }),
      );
    // Corrected to a case of 1000: a box line no longer converts by it; a case line does.
    await withTenant(t.db, A.tenantId, (tx) =>
      updateVendorItem(tx, A.tenantId, vi?.id ?? "", {
        vendorUom: "pack",
        unitWord: "case",
        stdPerVendorUom: "1000",
      }),
    );
    expect(await forUnit("BX")).toBeNull();
    expect((await forUnit("CS"))?.id).toBe(vi?.id);
    // A unit set without a word clears the old one.
    const cleared = await withTenant(t.db, A.tenantId, (tx) =>
      updateVendorItem(tx, A.tenantId, vi?.id ?? "", { vendorUom: "pack" }),
    );
    expect(cleared.ext).not.toHaveProperty("unitWord");
  });

  it("refuses a code that can't be a SKU when a vendor item is saved, rather than dropping it", async () => {
    const save = () =>
      vendorItemUpsert.run(
        { vendorId: northline, catalogItemId: baltic, name: "BALTIC BIRCH SPECIAL", sku: "SPO" },
        ctxA,
      );
    expect(await errorOf(save())).toMatch(/can't be a SKU/);
    expect(await errorOf(save())).toMatch(/can't be a SKU/);
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

  it("files a case line under the case, never the vendor's box: Register item, prices, last price", async () => {
    const shop = await insertShop(t.db, "Millwork R");
    const cedarR = await shop.vendor("Cedar Ridge Supply");
    const text = "#8 X 1-1/4 WOOD SCREW";
    const screws = await item(shop, text);
    const [box] = await t.db
      .insert(vendorItem)
      .values({
        tenantId: shop.tenantId,
        vendorId: cedarR,
        catalogItemId: screws,
        sku: "CRL-S100",
        name: "#8 SCREW 100/BX",
        vendorUom: "pack",
        stdPerVendorUom: "100",
        ext: { unitWord: "box" },
        lastPrice: "9.0000",
        lastPriceStd: "0.0900",
        lastPriceOn: "2026-10-01",
      })
      .returning();
    const register = (documentId: string, catalogItemId: string, vendorId: string) =>
      registerLines(t.db, {
        tenantId: shop.tenantId,
        agentVersionId: shop.agentVersionId,
        documentId,
        vendorId,
        lines: [decided(1, text, { decision: "matched", catalogItemId })],
        testRun: false,
      });
    // A case with no SKU and no size stated: its own new vendor item, no price per screw, and
    // the box keeps its price.
    const first = await shop.invoiceDoc(
      cedarR,
      [{ description: text, qty: "2", uom: "CS", unitPrice: "85.00" }],
      { date: "2026-11-03" },
    );
    const r = await register(first.documentId, screws, cedarR);
    expect(r.lines[0]).toMatchObject({ createdVendorItem: true, observationId: null });
    expect(r.lines[0]?.vendorItemId).not.toBe(box?.id);
    expect(r.lines[0]?.priceSkipped).toMatch(/no conversion rule/);
    const [boxAfter] = await t.db
      .select()
      .from(vendorItem)
      .where(eq(vendorItem.id, box?.id ?? ""));
    expect(boxAfter).toMatchObject({ lastPrice: "9.0000", stdPerVendorUom: "100.0000" });
    const [kase] = await t.db
      .select()
      .from(vendorItem)
      .where(eq(vendorItem.id, r.lines[0]?.vendorItemId ?? ""));
    expect(kase).toMatchObject({
      vendorUom: "pack",
      lastPrice: "85.0000",
      ext: { unitWord: "case" },
    });

    // With a box and a case of 1000 on file: the case line is the case's, at 0.085 a screw.
    const two = await shop.vendor("Cedar Two");
    const other = await item(shop, "#10 X 2 WOOD SCREW");
    const [box2, case2] = await t.db
      .insert(vendorItem)
      .values([
        {
          tenantId: shop.tenantId,
          vendorId: two,
          catalogItemId: other,
          sku: "CT-B100",
          name: "BOX",
          vendorUom: "pack",
          stdPerVendorUom: "100",
          ext: { unitWord: "box" },
          lastPrice: "9.0000",
          lastPriceOn: "2026-10-20",
        },
        {
          tenantId: shop.tenantId,
          vendorId: two,
          catalogItemId: other,
          sku: "CT-C1000",
          name: "CASE",
          vendorUom: "pack",
          stdPerVendorUom: "1000",
          ext: { unitWord: "case" },
          lastPrice: "80.0000",
          lastPriceOn: "2026-10-01",
        },
      ])
      .returning();
    const second = await shop.invoiceDoc(
      two,
      [{ description: "#10 X 2 WOOD SCREW", qty: "2", uom: "CS", unitPrice: "85.00" }],
      { date: "2026-11-03" },
    );
    const r2 = await registerLines(t.db, {
      tenantId: shop.tenantId,
      agentVersionId: shop.agentVersionId,
      documentId: second.documentId,
      vendorId: two,
      lines: [decided(1, "#10 X 2 WOOD SCREW", { decision: "matched", catalogItemId: other })],
      testRun: false,
    });
    expect(r2.lines[0]?.vendorItemId).toBe(case2?.id);
    const [obs] = await t.db
      .select()
      .from(priceObservation)
      .where(eq(priceObservation.id, r2.lines[0]?.observationId ?? ""));
    expect(obs).toMatchObject({
      unitPriceStd: "0.0850",
      qtyStd: "2000.0000",
      vendorItemId: case2?.id,
    });
    const byId = async (id: string | undefined) =>
      (
        await t.db
          .select()
          .from(vendorItem)
          .where(eq(vendorItem.id, id ?? ""))
      )[0];
    expect((await byId(box2?.id))?.lastPrice).toBe("9.0000");
    expect((await byId(case2?.id))?.lastPrice).toBe("85.0000");
    const priced = await withTenant(t.db, shop.tenantId, async (tx) =>
      priceLines(tx, shop.tenantId, await loadPricedDocument(tx, shop.tenantId, second.documentId)),
    );
    expect(priced.lines[0]?.unitPriceStd).toBe("0.0850");
    expect(priced.drafts[0]?.vendorItem?.id).toBe(case2?.id);
  });

  it("never takes a semantic match's hint across a box and a case, and keeps an older box item in use", async () => {
    const shop = await insertShop(t.db, "Millwork P");
    const text = "#8 X 1-1/4 WOOD SCREW";
    // P1: the semantic match names the box for a case line.
    const hint = await shop.vendor("Hint Supply");
    const screws = await item(shop, text);
    const [box] = await t.db
      .insert(vendorItem)
      .values({
        tenantId: shop.tenantId,
        vendorId: hint,
        catalogItemId: screws,
        sku: "CRL-S100",
        name: "#8 SCREW 100/BX",
        vendorUom: "pack",
        stdPerVendorUom: "100",
        ext: { unitWord: "box" },
        lastPrice: "9.0000",
        lastPriceStd: "0.0900",
        lastPriceOn: "2026-10-01",
      })
      .returning();
    const p1 = await shop.invoiceDoc(
      hint,
      [{ description: text, qty: "2", uom: "CS", unitPrice: "85.00" }],
      { date: "2026-11-03" },
    );
    const r1 = await registerLines(t.db, {
      tenantId: shop.tenantId,
      agentVersionId: shop.agentVersionId,
      documentId: p1.documentId,
      vendorId: hint,
      lines: [decided(1, text, { decision: "matched", catalogItemId: screws })],
      vendorItemHints: [{ lineNo: 1, vendorItemId: box?.id ?? "" }],
      testRun: false,
    });
    expect(r1.lines[0]?.vendorItemId).not.toBe(box?.id);
    const byId = async (id: string | undefined) =>
      (
        await t.db
          .select()
          .from(vendorItem)
          .where(eq(vendorItem.id, id ?? ""))
      )[0];
    expect((await byId(box?.id))?.lastPrice).toBe("9.0000");

    // P2: an older box item of 100 without a SKU or a word: a box line that states its 100 is
    // filed under it, priced by it, and gives it its word.
    const legacyVendor = await shop.vendor("Legacy Supply");
    const tens = await item(shop, "#10 X 2 WOOD SCREW");
    const [legacy] = await t.db
      .insert(vendorItem)
      .values({
        tenantId: shop.tenantId,
        vendorId: legacyVendor,
        catalogItemId: tens,
        name: "#10 SCREW 100/BX",
        vendorUom: "pack",
        stdPerVendorUom: "100",
        lastPrice: "9.0000",
        lastPriceStd: "0.0900",
        lastPriceOn: "2026-10-01",
      })
      .returning();
    const p2 = await shop.invoiceDoc(
      legacyVendor,
      [{ description: "#10 X 2 WOOD SCREW 100/BX", qty: "2", uom: "BX", unitPrice: "11.00" }],
      { date: "2026-11-03" },
    );
    const r2 = await registerLines(t.db, {
      tenantId: shop.tenantId,
      agentVersionId: shop.agentVersionId,
      documentId: p2.documentId,
      vendorId: legacyVendor,
      lines: [
        decided(1, "#10 X 2 WOOD SCREW 100/BX", { decision: "matched", catalogItemId: tens }),
      ],
      testRun: false,
    });
    expect(r2.lines[0]).toMatchObject({ vendorItemId: legacy?.id, priceSkipped: null, note: null });
    const [obs] = await t.db
      .select()
      .from(priceObservation)
      .where(eq(priceObservation.id, r2.lines[0]?.observationId ?? ""));
    expect(obs?.unitPriceStd).toBe("0.1100");
    expect(await byId(legacy?.id)).toMatchObject({
      lastPrice: "11.0000",
      ext: { unitWord: "box" },
    });

    // P3: a case line where the vendor's one item without a SKU is its box: filed under none,
    // and the line says why.
    const p3 = await shop.invoiceDoc(
      legacyVendor,
      [{ description: "#10 X 2 WOOD SCREW 1000/CS", qty: "1", uom: "CS", unitPrice: "80.00" }],
      { date: "2026-11-05" },
    );
    const r3 = await registerLines(t.db, {
      tenantId: shop.tenantId,
      agentVersionId: shop.agentVersionId,
      documentId: p3.documentId,
      vendorId: legacyVendor,
      lines: [
        decided(1, "#10 X 2 WOOD SCREW 1000/CS", { decision: "matched", catalogItemId: tens }),
      ],
      testRun: false,
    });
    expect(r3.lines[0]?.vendorItemId).toBeNull();
    expect(r3.lines[0]?.note).toMatch(
      /^filed under no vendor item: .* is another box, not this case/,
    );
    expect((await byId(legacy?.id))?.lastPrice).toBe("11.0000");
  });

  it("never takes an older box item for a case line before anything says what the item is", async () => {
    const shop = await insertShop(t.db, "Millwork Q");
    const v = await shop.vendor("Older Box Supply");
    const text = "#8 X 1-1/4 WOOD SCREW";
    const screws = await item(shop, text);
    // An older item of 100 without a SKU or a word, nothing filed under it.
    const [box] = await t.db
      .insert(vendorItem)
      .values({
        tenantId: shop.tenantId,
        vendorId: v,
        catalogItemId: screws,
        name: "#8 SCREW 100/BX",
        vendorUom: "pack",
        stdPerVendorUom: "100",
        lastPrice: "9.0000",
        lastPriceStd: "0.0900",
        lastPriceOn: "2026-10-01",
      })
      .returning();
    const register = async (line: InvoiceLine, date: string) => {
      const d = await shop.invoiceDoc(v, [line], { date });
      return registerLines(t.db, {
        tenantId: shop.tenantId,
        agentVersionId: shop.agentVersionId,
        documentId: d.documentId,
        vendorId: v,
        lines: [decided(1, line.description, { decision: "matched", catalogItemId: screws })],
        testRun: false,
      });
    };
    const byId = async (id: string | undefined) =>
      (
        await t.db
          .select()
          .from(vendorItem)
          .where(eq(vendorItem.id, id ?? ""))
      )[0];
    // The first line is a case: never filed under the box, never 0.85 a screw.
    const r = await register(
      { description: text, qty: "2", uom: "CS", unitPrice: "85.00" },
      "2026-11-03",
    );
    expect(r.lines[0]?.vendorItemId).not.toBe(box?.id);
    expect(r.lines[0]?.observationId).toBeNull();
    expect(r.lines[0]?.note).toMatch(/^filed under no vendor item/);
    expect(await byId(box?.id)).toMatchObject({ lastPrice: "9.0000" });
    expect((await byId(box?.id))?.ext).not.toHaveProperty("unitWord");
    const prices = await t.db
      .select()
      .from(priceObservation)
      .where(eq(priceObservation.vendorId, v));
    expect(prices).toEqual([]);
    // Nor is a box line that doesn't state its size (its own name is never read); one that
    // states 100 a box is the box's, at 0.11 a screw.
    const r1 = await register(
      { description: text, qty: "2", uom: "BX", unitPrice: "11.00" },
      "2026-11-04",
    );
    expect(r1.lines[0]?.vendorItemId).toBeNull();
    expect((await byId(box?.id))?.ext).not.toHaveProperty("unitWord");
    const r2 = await register(
      { description: `${text} BOX OF 100`, qty: "2", uom: "BX", unitPrice: "11.00" },
      "2026-11-05",
    );
    expect(r2.lines[0]?.vendorItemId).toBe(box?.id);
    const [obs] = await t.db
      .select()
      .from(priceObservation)
      .where(eq(priceObservation.id, r2.lines[0]?.observationId ?? ""));
    expect(obs?.unitPriceStd).toBe("0.1100");
    expect(await byId(box?.id)).toMatchObject({ lastPrice: "11.0000", ext: { unitWord: "box" } });

    // A line that states the item's pack size in its own word gives it that word; one that
    // doesn't is no match.
    const w = await shop.vendor("Plain Name Supply");
    const tens = await item(shop, "#10 X 2 WOOD SCREW");
    const [plain] = await t.db
      .insert(vendorItem)
      .values({
        tenantId: shop.tenantId,
        vendorId: w,
        catalogItemId: tens,
        name: "#10 WOOD SCREW",
        vendorUom: "pack",
        stdPerVendorUom: "100",
      })
      .returning();
    const forUnit = (unitRaw: string, lineText: string) =>
      withTenant(t.db, shop.tenantId, (tx) =>
        vendorItemForUnit(tx, shop.tenantId, {
          vendorId: w,
          catalogItemId: tens,
          unitRaw,
          lineText,
        }),
      );
    expect(await forUnit("CS", "#10 X 2 WOOD SCREW")).toBeNull();
    expect(await forUnit("CS", "#10 X 2 WOOD SCREW 1000/CS")).toBeNull();
    expect((await forUnit("CS", "#10 X 2 WOOD SCREW 100/CS"))?.id).toBe(plain?.id);
  });

  it("skips a price list's case row that would land on the vendor's box item", async () => {
    const shop = await insertShop(t.db, "Millwork I");
    const v = await shop.vendor("Import Supply");
    const screws = await item(shop, "#8 X 1-1/4 WOOD SCREW");
    const r = await importPriceList(t.db, {
      tenantId: shop.tenantId,
      vendorId: v,
      listPriceOn: "2026-11-01",
      by: { agentVersionId: shop.agentVersionId },
      testRun: false,
      rows: [
        {
          name: "#8 SCREW 100/BX",
          vendorUom: "BX",
          stdPerVendorUom: "100",
          listPrice: "9.00",
          catalogItemId: screws,
        },
        {
          name: "#8 SCREW 1000/CS",
          vendorUom: "CS",
          stdPerVendorUom: "1000",
          listPrice: "80.00",
          catalogItemId: screws,
        },
      ],
    } as never);
    expect(r.rows.map((x) => x.outcome)).toEqual(["created", "skipped"]);
    expect(r.rows[1]?.reason).toMatch(/its box, not this case/);
    const [boxItem] = await t.db.select().from(vendorItem).where(eq(vendorItem.vendorId, v));
    expect(boxItem).toMatchObject({
      stdPerVendorUom: "100.0000",
      listPrice: "9.0000",
      ext: { unitWord: "box" },
    });
  });

  // An older item: a box, case or pail vendor item without a SKU, recorded before its word was
  // kept. It takes a line only when the line states its very pack size.
  const olderItem = async (
    shop: ShopFixture,
    vendorId: string,
    catalogItemId: string,
    f: { name: string; stdPerVendorUom: string; packSize?: string; lastPrice?: string },
  ) => {
    const [row] = await t.db
      .insert(vendorItem)
      .values({
        tenantId: shop.tenantId,
        vendorId,
        catalogItemId,
        name: f.name,
        packSize: f.packSize ?? null,
        vendorUom: "pack",
        stdPerVendorUom: f.stdPerVendorUom,
        ...(f.lastPrice
          ? {
              lastPrice: f.lastPrice,
              lastPriceStd: dec(f.lastPrice).dividedBy(f.stdPerVendorUom).toFixed(4),
              lastPriceOn: "2026-10-01",
            }
          : {}),
      })
      .returning();
    if (!row) throw new Error("no vendor item");
    return row;
  };
  const vendorItemRow = async (id: string) =>
    (await t.db.select().from(vendorItem).where(eq(vendorItem.id, id)))[0];
  const registerOne = async (
    shop: ShopFixture,
    vendorId: string,
    catalogItemId: string,
    line: InvoiceLine,
    date: string,
  ) => {
    const d = await shop.invoiceDoc(vendorId, [line], { date });
    return registerLines(t.db, {
      tenantId: shop.tenantId,
      agentVersionId: shop.agentVersionId,
      documentId: d.documentId,
      vendorId,
      lines: [decided(1, line.description, { decision: "matched", catalogItemId })],
      testRun: false,
    });
  };

  it("never reads an older case item's word from its own name: a box line stating no size isn't it", async () => {
    const shop = await insertShop(t.db, "Millwork S");
    const v = await shop.vendor("Fastener Supply");
    const text = "#8 X 1-1/4 WOOD SCREW";
    const screws = await item(shop, text);
    const kase = await olderItem(shop, v, screws, {
      name: "#8 SCREW 100/BX 10 BX/CS",
      stdPerVendorUom: "1000",
      lastPrice: "80.0000",
    });
    const forUnit = (unitRaw: string, lineText: string) =>
      withTenant(t.db, shop.tenantId, (tx) =>
        vendorItemForUnit(tx, shop.tenantId, {
          vendorId: v,
          catalogItemId: screws,
          unitRaw,
          lineText,
        }),
      );
    expect(await forUnit("BX", text)).toBeNull();
    expect(await forUnit("CS", text)).toBeNull();
    const r = await registerOne(
      shop,
      v,
      screws,
      { description: text, qty: "2", uom: "BX", unitPrice: "9.00" },
      "2026-11-03",
    );
    expect(r.lines[0]?.vendorItemId).toBeNull();
    expect(r.lines[0]?.observationId).toBeNull();
    expect(r.lines[0]?.note).toMatch(/^filed under no vendor item: .*pack size of 1000/);
    const after = await vendorItemRow(kase.id);
    expect(after).toMatchObject({ lastPrice: "80.0000", stdPerVendorUom: "1000.0000" });
    expect(after?.ext).not.toHaveProperty("unitWord");
    // A case line that states its 1000 is the case's, at 0.08 a screw, and gives it its word.
    const r2 = await registerOne(
      shop,
      v,
      screws,
      { description: `${text} 1000/CS`, qty: "1", uom: "CS", unitPrice: "80.00" },
      "2026-11-04",
    );
    expect(r2.lines[0]?.vendorItemId).toBe(kase.id);
    const [obs] = await t.db
      .select()
      .from(priceObservation)
      .where(eq(priceObservation.id, r2.lines[0]?.observationId ?? ""));
    expect(obs?.unitPriceStd).toBe("0.0800");
    expect((await vendorItemRow(kase.id))?.ext).toMatchObject({ unitWord: "case" });
  });

  it("takes a line for an older item made with a pack size only when the line states that size", async () => {
    const shop = await insertShop(t.db, "Millwork T");
    const v = await shop.vendor("Main Era Supply");
    const text = "#8 X 1-1/4 WOOD SCREW";
    const screws = await item(shop, text);
    // As an earlier Register item made it: the line's text, `<pack> per <unit>`, no word.
    const old = await olderItem(shop, v, screws, {
      name: `${text} 100/BX`,
      packSize: "100 per pack",
      stdPerVendorUom: "100",
      lastPrice: "9.0000",
    });
    const r = await registerOne(
      shop,
      v,
      screws,
      { description: text, qty: "2", uom: "BX", unitPrice: "11.00" },
      "2026-11-03",
    );
    expect(r.lines[0]?.vendorItemId).toBeNull();
    expect(r.lines[0]?.note).toMatch(/pack size of 100\b.*this line states none/);
    expect((await vendorItemRow(old.id))?.lastPrice).toBe("9.0000");
    const r2 = await registerOne(
      shop,
      v,
      screws,
      { description: `${text} 100/BX`, qty: "2", uom: "BX", unitPrice: "11.00" },
      "2026-11-04",
    );
    expect(r2.lines[0]).toMatchObject({ vendorItemId: old.id, note: null, priceSkipped: null });
    expect(await vendorItemRow(old.id)).toMatchObject({
      lastPrice: "11.0000",
      ext: { unitWord: "box" },
    });
  });

  it("never lets a price list row move a box item to another pack, by its wording or its unit", async () => {
    const shop = await insertShop(t.db, "Millwork U");
    const text = "#8 X 1-1/4 WOOD SCREW";
    const screws = await item(shop, text);
    const importRows = (vendorId: string, rows: unknown[]) =>
      importPriceList(t.db, {
        tenantId: shop.tenantId,
        vendorId,
        listPriceOn: "2026-11-10",
        by: { agentVersionId: shop.agentVersionId },
        testRun: false,
        rows,
      } as never);
    // By the vendor's wording: Register item made a box of 100 from an invoice line.
    const v = await shop.vendor("Alias Supply");
    const r = await registerOne(
      shop,
      v,
      screws,
      { description: `${text} 100/BX`, qty: "2", uom: "BX", unitPrice: "9.00" },
      "2026-11-03",
    );
    const boxId = r.lines[0]?.vendorItemId ?? "";
    const box = await vendorItemRow(boxId);
    expect(box).toMatchObject({ stdPerVendorUom: "100.0000", ext: { unitWord: "box" } });
    const kaseRow = { name: `${text} 100/BX`, vendorUom: "CS", stdPerVendorUom: "1000" };
    const i1 = await importRows(v, [{ ...kaseRow, listPrice: "80.00" }]);
    expect(i1.rows[0]).toMatchObject({ outcome: "skipped", vendorItemId: null });
    expect(i1.rows[0]?.reason).toMatch(/box, not this case/);
    expect(await vendorItemRow(boxId)).toEqual(box);
    const i2 = await importRows(v, [
      { name: `${text} 100/BX`, vendorUom: "BX", stdPerVendorUom: "100", listPrice: "9.50" },
    ]);
    expect(i2.rows[0]).toMatchObject({ outcome: "updated", vendorItemId: boxId });
    expect(await vendorItemRow(boxId)).toMatchObject({
      stdPerVendorUom: "100.0000",
      listPrice: "9.5000",
      ext: { unitWord: "box" },
    });
    // An older box item without a word: a case row is skipped, a row of its own size is taken.
    const w = await shop.vendor("Older Supply");
    const old = await olderItem(shop, w, screws, {
      name: "#8 SCREW 100/BX",
      stdPerVendorUom: "100",
      lastPrice: "9.0000",
    });
    const i3 = await importRows(w, [
      {
        name: "#8 SCREW 1000/CS",
        vendorUom: "CS",
        stdPerVendorUom: "1000",
        listPrice: "80.00",
        catalogItemId: screws,
      },
    ]);
    expect(i3.rows[0]).toMatchObject({ outcome: "skipped", vendorItemId: null });
    expect(i3.rows[0]?.reason).toMatch(/pack size of 100\b/);
    expect(await vendorItemRow(old.id)).toEqual(old);
    const i4 = await importRows(w, [
      {
        name: "#8 SCREW 100/BX",
        vendorUom: "BX",
        stdPerVendorUom: "100",
        listPrice: "9.50",
        catalogItemId: screws,
      },
    ]);
    expect(i4.rows[0]).toMatchObject({ outcome: "updated", vendorItemId: old.id });
    expect(await vendorItemRow(old.id)).toMatchObject({
      stdPerVendorUom: "100.0000",
      listPrice: "9.5000",
      ext: { unitWord: "box" },
    });
  });

  it("gives a quote's price to an older box item when the quote's line states its pack size", async () => {
    const shop = await insertShop(t.db, "Millwork V");
    const v = await shop.vendor("Quote Supply");
    const text = "#8 X 1-1/4 WOOD SCREW";
    const screws = await item(shop, text);
    const old = await olderItem(shop, v, screws, { name: "#8 WOOD SCREW", stdPerVendorUom: "100" });
    const c = ctx(shop, t.db);
    const req = (await requestCreate.run(
      { channel: "email", lines: [{ description: text, qty: "500", unit: "EA" }] },
      c,
    )) as J;
    const lineId = req.request.lines[0].id as string;
    await t.db
      .update(purchaseRequestLine)
      .set({ catalogItemId: screws })
      .where(eq(purchaseRequestLine.id, lineId));
    const quotes = (await quoteCreate.run({ requestId: req.request.id, vendorIds: [v] }, c)) as J;
    await quoteRecord.run(
      {
        quoteRequestId: quotes.quotes[0].id,
        lines: [
          {
            requestLineId: lineId,
            unit: "BX",
            unitPrice: "9.50",
            qty: "5",
            description: `${text} 100/BX`,
          },
        ],
      },
      c,
    );
    expect(await vendorItemRow(old.id)).toMatchObject({
      lastPrice: "9.5000",
      lastPriceStd: "0.0950",
      lastPriceSource: "quote",
    });
  });

  it("converts a line at the size it states for its own unit, never at another pack's beside it", async () => {
    const shop = await insertShop(t.db, "Millwork W");
    const text = "#8 X 1-1/4 WOOD SCREW";
    const screws = await item(shop, text);
    const stdOf = async (observationId: string | null | undefined) =>
      (
        await t.db
          .select()
          .from(priceObservation)
          .where(eq(priceObservation.id, observationId ?? ""))
      )[0]?.unitPriceStd;
    // S1: a box line naming the case beside it, on an older box of 100.
    const v1 = await shop.vendor("Box Beside Case Supply");
    const box = await olderItem(shop, v1, screws, { name: text, stdPerVendorUom: "100" });
    const s1Line = `${text} 1000/CS 100/BX`;
    const s1 = await registerOne(
      shop,
      v1,
      screws,
      { description: s1Line, qty: "2", uom: "BX", unitPrice: "9.00" },
      "2026-11-03",
    );
    expect(s1.lines[0]?.vendorItemId).toBe(box.id);
    expect(await stdOf(s1.lines[0]?.observationId)).toBe("0.0900");
    const s1Doc = await shop.invoiceDoc(
      v1,
      [{ description: s1Line, qty: "2", uom: "BX", unitPrice: "9.00" }],
      { date: "2026-11-04" },
    );
    await registerLines(t.db, {
      tenantId: shop.tenantId,
      agentVersionId: shop.agentVersionId,
      documentId: s1Doc.documentId,
      vendorId: v1,
      lines: [decided(1, s1Line, { decision: "matched", catalogItemId: screws })],
      testRun: false,
    });
    const priced = await withTenant(t.db, shop.tenantId, async (tx) =>
      priceLines(tx, shop.tenantId, await loadPricedDocument(tx, shop.tenantId, s1Doc.documentId)),
    );
    expect(priced.lines[0]?.unitPriceStd).toBe("0.0900");
    // S3: a case line naming the box first, on an older case of 1000.
    const v3 = await shop.vendor("Case After Box Supply");
    const kase = await olderItem(shop, v3, screws, { name: text, stdPerVendorUom: "1000" });
    const s3 = await registerOne(
      shop,
      v3,
      screws,
      { description: `${text} BX/100 CS/1000`, qty: "1", uom: "CS", unitPrice: "80.00" },
      "2026-11-03",
    );
    expect(s3.lines[0]?.vendorItemId).toBe(kase.id);
    expect(await stdOf(s3.lines[0]?.observationId)).toBe("0.0800");
    // S2: a case of ten boxes of 100 is 1000, on an older case and on a new one.
    const s2Line = `${text} 100/BX 10 BX/CS`;
    const v2 = await shop.vendor("Ten Boxes Supply");
    const kase2 = await olderItem(shop, v2, screws, { name: text, stdPerVendorUom: "1000" });
    const s2 = await registerOne(
      shop,
      v2,
      screws,
      { description: s2Line, qty: "1", uom: "CS", unitPrice: "80.00" },
      "2026-11-03",
    );
    expect(s2.lines[0]?.vendorItemId).toBe(kase2.id);
    expect(await stdOf(s2.lines[0]?.observationId)).toBe("0.0800");
    const v4 = await shop.vendor("New Case Supply");
    const s4 = await registerOne(
      shop,
      v4,
      screws,
      { description: s2Line, qty: "1", uom: "CS", unitPrice: "80.00" },
      "2026-11-03",
    );
    expect(await vendorItemRow(s4.lines[0]?.vendorItemId ?? "")).toMatchObject({
      stdPerVendorUom: "1000.0000",
      ext: { unitWord: "case" },
    });
    expect(await stdOf(s4.lines[0]?.observationId)).toBe("0.0800");
    // A quote's box line: per screw at the box's size, never the case's beside it.
    const screwItem = (await t.db.select().from(catalogItem).where(eq(catalogItem.id, screws)))[0];
    expect(
      standardPrice(
        screwItem ?? null,
        { unit: "BX", unitPrice: "9.00", description: s1Line },
        { description: text },
        null,
      ).unitPriceStd,
    ).toBe("0.0900");
  });

  it("never takes a line or a price list row whose stated size isn't the item's, by word or SKU", async () => {
    const shop = await insertShop(t.db, "Millwork X");
    const v = await shop.vendor("Fifty Supply");
    const text = "#8 X 1-1/4 WOOD SCREW";
    const screws = await item(shop, text);
    const first = await registerOne(
      shop,
      v,
      screws,
      { description: `${text} 100/BX`, qty: "1", uom: "BX", unitPrice: "9.00" },
      "2026-11-01",
    );
    const boxId = first.lines[0]?.vendorItemId ?? "";
    const second = await registerOne(
      shop,
      v,
      screws,
      { description: `${text} 50/BX`, qty: "1", uom: "BX", unitPrice: "5.00" },
      "2026-11-05",
    );
    expect(second.lines[0]?.vendorItemId).toBeNull();
    expect(second.lines[0]?.note).toMatch(/^filed under no vendor item: this line states 50 a box/);
    expect(await vendorItemRow(boxId)).toMatchObject({
      lastPrice: "9.0000",
      stdPerVendorUom: "100.0000",
    });
    // The same with the vendor's SKU.
    const w = await shop.vendor("Fifty SKU Supply");
    const skuFirst = await registerOne(
      shop,
      w,
      screws,
      { description: `${text} 100/BX`, sku: "FS-100", qty: "1", uom: "BX", unitPrice: "9.00" },
      "2026-11-01",
    );
    const skuId = skuFirst.lines[0]?.vendorItemId ?? "";
    expect(await vendorItemRow(skuId)).toMatchObject({
      sku: "FS-100",
      stdPerVendorUom: "100.0000",
    });
    const skuSecond = await registerOne(
      shop,
      w,
      screws,
      { description: `${text} 50/BX`, sku: "FS-100", qty: "1", uom: "BX", unitPrice: "5.00" },
      "2026-11-05",
    );
    expect(skuSecond.lines[0]?.vendorItemId).toBeNull();
    expect(skuSecond.lines[0]?.note).toMatch(/with this SKU holds 100/);
    expect((await vendorItemRow(skuId))?.lastPrice).toBe("9.0000");
    // A price list row by that SKU: a case row, or a box of 50, is skipped; a box row is taken.
    const before = await vendorItemRow(skuId);
    const bySku = (row: Record<string, string>) =>
      importPriceList(t.db, {
        tenantId: shop.tenantId,
        vendorId: w,
        listPriceOn: "2026-11-10",
        by: { agentVersionId: shop.agentVersionId },
        testRun: false,
        rows: [{ sku: "FS-100", ...row }],
      } as never);
    const caseRow = await bySku({ name: `${text} CASE`, vendorUom: "CS", listPrice: "80.00" });
    expect(caseRow.rows[0]).toMatchObject({ outcome: "skipped" });
    expect(caseRow.rows[0]?.reason).toMatch(/its box, not this case/);
    const fifty = await bySku({ name: `${text} 50/BX`, vendorUom: "BX", stdPerVendorUom: "50" });
    expect(fifty.rows[0]).toMatchObject({ outcome: "skipped" });
    expect(fifty.rows[0]?.reason).toMatch(/pack size of 100 per unit, and this row states 50/);
    expect(await vendorItemRow(skuId)).toEqual(before);
    const taken = await importPriceList(t.db, {
      tenantId: shop.tenantId,
      vendorId: w,
      listPriceOn: "2026-11-11",
      by: { agentVersionId: shop.agentVersionId },
      testRun: false,
      rows: [{ sku: "FS-100", name: `${text} 100/BX`, vendorUom: "BX", listPrice: "9.50" }],
    } as never);
    expect(taken.rows[0]?.outcome).toBe("updated");
    expect((await vendorItemRow(skuId))?.listPrice).toBe("9.5000");
  });

  it("holds a line whose wording leaves its own pack's size in doubt, or whose SKU is another pack", async () => {
    const shop = await insertShop(t.db, "Millwork K");
    const text = "#8 X 1-1/4 WOOD SCREW";
    const screws = await item(shop, text);
    const held = async (name: string, line: InvoiceLine) => {
      const v = await shop.vendor(name);
      const r = await registerOne(shop, v, screws, line, "2026-11-05");
      return { line: r.lines[0], made: await vendorItemRow(r.lines[0]?.vendorItemId ?? "") };
    };
    // K4, K5: a count beside a nested pack is no size for the line's unit.
    for (const [name, line] of [
      [
        "Count Case Supply",
        { description: `${text} 100CT 10 BX/CS`, qty: "1", uom: "CS", unitPrice: "80.00" },
      ],
      [
        "Count Box Supply",
        { description: `${text} 100PK 10 PK/BX`, qty: "1", uom: "BX", unitPrice: "90.00" },
      ],
      // K2: ten to a case beside a box of 100 is ten boxes, not a case of ten.
      [
        "Ten Case Supply",
        { description: `${text} 100/BX 10/CS`, qty: "1", uom: "CS", unitPrice: "80.00" },
      ],
    ] as const) {
      const r = await held(name, line);
      expect(r.line?.observationId).toBeNull();
      expect(r.made?.stdPerVendorUom ?? null).toBeNull();
    }
    // K2 on a case recorded at 1000: the agreeing vendor item converts it.
    const v2 = await shop.vendor("Recorded Case Supply");
    const kase = await registerOne(
      shop,
      v2,
      screws,
      { description: `${text} 1000/CS`, qty: "1", uom: "CS", unitPrice: "80.00" },
      "2026-11-01",
    );
    const k2 = await registerOne(
      shop,
      v2,
      screws,
      { description: `${text} 100/BX 10/CS`, qty: "1", uom: "CS", unitPrice: "82.00" },
      "2026-11-05",
    );
    expect(k2.lines[0]?.vendorItemId).toBe(kase.lines[0]?.vendorItemId);
    const [obs] = await t.db
      .select()
      .from(priceObservation)
      .where(eq(priceObservation.id, k2.lines[0]?.observationId ?? ""));
    expect(obs?.unitPriceStd).toBe("0.0820");
    // K1: a case line with the SKU of the vendor's box of 100 is not the box.
    const v1 = await shop.vendor("Box SKU Supply");
    const box = await registerOne(
      shop,
      v1,
      screws,
      { description: `${text} 100/BX`, sku: "FS-8114", qty: "1", uom: "BX", unitPrice: "9.00" },
      "2026-11-01",
    );
    const boxId = box.lines[0]?.vendorItemId ?? "";
    const k1 = await registerOne(
      shop,
      v1,
      screws,
      { description: text, sku: "FS-8114", qty: "1", uom: "CS", unitPrice: "80.00" },
      "2026-11-05",
    );
    expect(k1.lines[0]?.vendorItemId).toBeNull();
    expect(k1.lines[0]?.observationId).toBeNull();
    expect(k1.lines[0]?.note).toMatch(/with this SKU is another box, not this case/);
    expect(await vendorItemRow(boxId)).toMatchObject({
      lastPrice: "9.0000",
      stdPerVendorUom: "100.0000",
      ext: { unitWord: "box" },
    });
  });

  it("never folds a box into the case on a merge: each keeps its own prices", async () => {
    const shop = await insertShop(t.db, "Millwork Y");
    const v = await shop.vendor("Merge Pack Supply");
    const into = await item(shop, "#8 X 1-1/4 WOOD SCREW");
    const from = await item(shop, "#8 X 1-1/4 WOOD SCREWS");
    const c = await registerOne(
      shop,
      v,
      into,
      { description: "#8 X 1-1/4 WOOD SCREW 1000/CS", qty: "1", uom: "CS", unitPrice: "80.00" },
      "2026-11-01",
    );
    const b = await registerOne(
      shop,
      v,
      from,
      { description: "#8 X 1-1/4 WOOD SCREWS 100/BX", qty: "1", uom: "BX", unitPrice: "9.00" },
      "2026-11-05",
    );
    const caseId = c.lines[0]?.vendorItemId ?? "";
    const boxId = b.lines[0]?.vendorItemId ?? "";
    const caseBefore = await vendorItemRow(caseId);
    await mergeItems(t.db, {
      tenantId: shop.tenantId,
      fromId: from,
      intoId: into,
      userId: shop.userId,
    });
    expect(await vendorItemRow(caseId)).toMatchObject({
      status: "active",
      lastPrice: caseBefore?.lastPrice,
      lastPriceStd: caseBefore?.lastPriceStd,
      stdPerVendorUom: "1000.0000",
    });
    const boxAfter = await vendorItemRow(boxId);
    expect(boxAfter).toMatchObject({ status: "discontinued", lastPrice: "9.0000" });
    expect(boxAfter?.ext).toMatchObject({ notFoldedInto: caseId });
    const boxPrices = await t.db
      .select()
      .from(priceObservation)
      .where(eq(priceObservation.id, b.lines[0]?.observationId ?? ""));
    expect(boxPrices[0]?.vendorItemId).toBe(boxId);
    const aliases = await t.db.select().from(itemAlias).where(eq(itemAlias.vendorId, v));
    expect(aliases.map((a) => a.vendorItemId)).not.toContain(boxId);
    expect(aliases.filter((a) => a.vendorItemId === caseId)).toHaveLength(1);
  });

  it("never gives a QuickBooks bill line without a unit to the vendor's only item when it is a box", async () => {
    const shop = await insertShop(t.db, "Millwork Z");
    const v = await shop.vendor("Bill Box Supply");
    const text = "#8 X 1-1/4 WOOD SCREW";
    const screws = await item(shop, text);
    const box = await olderItem(shop, v, screws, {
      name: `${text} 100/BX`,
      stdPerVendorUom: "100",
      lastPrice: "9.0000",
    });
    await shop.qboBill({
      id: "77",
      vendorId: v,
      date: "2026-11-05",
      lines: [{ id: "1", item: "Screws", description: text, qty: 200, unitPrice: 0.11 }],
    });
    const r = (await backfillFromBillsTool.run(
      { from: "2026-11-01", to: "2026-11-30" },
      ctx(shop, t.db),
    )) as J;
    expect(r).toMatchObject({ recorded: 1 });
    const [price] = await t.db
      .select()
      .from(priceObservation)
      .where(eq(priceObservation.vendorId, v));
    expect(price).toMatchObject({ unitPriceStd: "0.1100", vendorItemId: null });
    expect(await vendorItemRow(box.id)).toMatchObject({ lastPrice: "9.0000" });
  });

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
        // One board foot a unit, as the item that stays has none: the same unit, so it folds.
        stdPerVendorUom: "1",
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
