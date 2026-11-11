// The vendor catalog's tools on a throwaway database (docs/plan.md §1.88): matching a vendor, the
// catalog's Save to records writes (upsert, preferred, discontinued), the last price (the newer date
// wins), an older alias with no vendor item, a test run's Register item writing nothing, the
// embedding write (idempotent), and one client never reaching another's vendor items (invariant 1).

import { type Db, vendor } from "@countersign/db";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "@countersign/db/testing";
import { createLlmClient } from "@countersign/llm";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseLine } from "../catalog/keys";
import { descriptionHash, normalize } from "../catalog/normalize";
import { catalogItem, itemAlias, vendorItem } from "../schema";
import { insertShop, type ShopFixture } from "../testing.test-helper";
import { type PackToolContext, packToolContext } from "../tools";
import { EMBEDDING_TEMPLATE } from "./embedding-text";
import { registerLines } from "./pipeline";
import { recordLastPrice } from "./store";
import {
  embeddingsWrite,
  vendorItemDiscontinue,
  vendorItemSetPreferred,
  vendorItemsForItem,
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
});
