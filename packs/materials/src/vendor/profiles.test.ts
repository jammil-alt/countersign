// The Purchasing area's match profiles on a throwaway database (step model §7, §10d): Vendors,
// Vendor items (a SKU match or nothing) and Master items (the vendors' names and key attributes,
// then a shortlist a model chooses from), through the one Match port, with a person's answer
// learned as an exact hit, a test run learning nothing, and one client never reaching another's
// records (invariant 1).

import { createMatchPort, type ProfileChooser, steps } from "@countersign/core";
import { type Db, vendor } from "@countersign/db";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "@countersign/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseLine } from "../catalog/keys";
import { catalogItem, vendorItem } from "../schema";
import { insertShop, type ShopFixture } from "../testing.test-helper";
import { type PackToolContext, packToolContext } from "../tools";
import { MATERIALS_MATCHERS } from "./matchers";

const online = await databaseAvailable();

const settings = (over: Record<string, unknown>) => steps.MatchSettings.parse(over);

describe.skipIf(!online)("the Purchasing area's match profiles", () => {
  let t: TestDatabase;
  let A: ShopFixture;
  let B: ShopFixture;
  let ctxA: PackToolContext;
  let ctxB: PackToolContext;
  let northline = "";
  let cedar = "";
  let otherNorthline = "";
  let baltic34 = "";
  let baltic12 = "";
  let walnut = "";
  let viBaltic = "";
  const port = createMatchPort(MATERIALS_MATCHERS);

  const item = async (shop: ShopFixture, text: string) => {
    const p = parseLine(text);
    const [row] = await t.db
      .insert(catalogItem)
      .values({
        tenantId: shop.tenantId,
        category: p.category,
        canonicalName: p.normalized,
        attributes: p.attributes,
        standardUom: p.standardUom,
      })
      .returning();
    return row?.id ?? "";
  };
  const ctx = (shop: ShopFixture, db: Db, mode: "live" | "test" = "live") =>
    packToolContext({ tenantId: shop.tenantId, agentVersionId: shop.agentVersionId, mode, db });

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    A = await insertShop(t.db, "Millwork A");
    B = await insertShop(t.db, "Millwork B");
    northline = await A.vendor("Northline Panel Supply");
    cedar = await A.vendor("Cedar Ridge Lumber");
    otherNorthline = await B.vendor("Northline Panel Supply");
    await t.db
      .update(vendor)
      .set({
        ext: { domains: ["northline.example"], taxId: "12-3456789" },
        externalRefs: { qbo: "56" },
      })
      .where(eq(vendor.id, northline));
    await t.db
      .update(vendor)
      .set({ aliases: ["cedar ridge"] })
      .where(eq(vendor.id, cedar));
    baltic34 = await item(A, 'BALTIC BIRCH PLYWOOD 3/4" 5X5 BB/BB');
    baltic12 = await item(A, 'BALTIC BIRCH PLYWOOD 1/2" 5X5 BB/BB');
    walnut = await item(A, "WALNUT 4/4 FAS");
    const [vi] = await t.db
      .insert(vendorItem)
      .values({
        tenantId: A.tenantId,
        vendorId: northline,
        catalogItemId: baltic34,
        sku: "BB34-55",
        name: 'BALTIC BIRCH 3/4" 5X5',
      })
      .returning();
    viBaltic = vi?.id ?? "";
    ctxA = ctx(A, t.db);
    ctxB = ctx(B, t.db);
  });
  afterAll(async () => {
    await t?.drop();
  });

  const one = async (
    c: PackToolContext,
    s: Record<string, unknown>,
    item: Record<string, unknown>,
    choose?: ProfileChooser,
  ) => {
    const r = await port.match({ ctx: c, settings: settings(s), items: [item], choose });
    return { ...r.output.items[0], note: r.notes[0] };
  };

  it("declares Vendors, Vendor items and Master items, each held to its own rules", () => {
    expect(port.profiles().map((p) => [p.id, p.types])).toEqual([
      ["vendors", ["exact", "semantic", "hybrid"]],
      ["vendor-items", ["exact"]],
      ["master-items", ["exact", "semantic", "hybrid"]],
    ]);
    const profile = port.profile("vendor-items") as steps.MatchProfile;
    expect(
      steps.matchSettingsProblems(settings({ to: "vendor-items", type: "hybrid" }), profile),
    ).toEqual(["Vendor items can be matched by exact only"]);
  });

  it("matches a vendor by accounting id, tax id, email domain, then name", async () => {
    const v = (item: Record<string, unknown>, keys?: string[]) =>
      one(ctxA, { to: "vendors", type: "exact", ...(keys ? { keys } : {}) }, item);
    expect(await v({ accountingId: "56" })).toMatchObject({ matched: northline, how: "exact" });
    expect((await v({ accountingId: "56" })).note?.rule).toBe("key:accounting_id");
    expect(await v({ taxId: "123456789" })).toMatchObject({ matched: northline, confidence: 100 });
    expect(await v({ email: "ap@northline.example" })).toMatchObject({ matched: northline });
    expect(await v({ name: "NORTHLINE PANEL SUPPLY, INC." })).toMatchObject({ matched: northline });
    expect(await v({ name: "Cedar Ridge" })).toMatchObject({ matched: cedar, how: "learned" });
    // The step's keys only: a name isn't tried when the step says tax id.
    expect(await v({ name: "Northline Panel Supply" }, ["tax_id"])).toMatchObject({
      matched: null,
    });
    // Two different tax ids are never the same vendor, whatever the name says.
    const vetoed = await v({ name: "Northline Panel Supply", taxId: "99-9999999" });
    expect(vetoed.matched).toBeNull();
    expect(vetoed.note?.vetoed).toEqual([{ record: northline, rule: "tax_id" }]);
    // Another client's vendor of the same name is never reached.
    expect(await one(ctxB, { to: "vendors", type: "exact" }, { accountingId: "56" })).toMatchObject(
      {
        matched: null,
      },
    );
    expect(
      await one(ctxB, { to: "vendors", type: "exact" }, { name: "Northline Panel Supply" }),
    ).toMatchObject({
      matched: otherNorthline,
    });
  });

  it("shortlists vendors by name for a model, and learns a person's answer as a known name", async () => {
    let shown: string[] = [];
    const choose: ProfileChooser = async (q) => {
      shown = q.candidates.map((c) => c.id);
      return { record_id: northline, confidence: 0.95, reason: "same company" };
    };
    const hybrid = { to: "vendors", type: "hybrid" };
    expect(await one(ctxA, hybrid, { name: "Northline Panel Sup." }, choose)).toMatchObject({
      matched: northline,
      how: "semantic",
      confidence: 95,
    });
    expect(shown).toContain(northline);
    const item = { name: "NPS Panels" };
    // A test run learns nothing.
    expect(
      await port.learn({
        ctx: ctx(A, t.db, "test"),
        profile: "vendors",
        item,
        recordId: northline,
        by: { personId: A.userId },
      }),
    ).toBe(true);
    expect(await one(ctxA, { to: "vendors", type: "exact" }, item)).toMatchObject({
      matched: null,
    });
    expect(
      await port.learn({
        ctx: ctxA,
        profile: "vendors",
        item,
        recordId: northline,
        by: { personId: A.userId },
      }),
    ).toBe(true);
    expect(await one(ctxA, { to: "vendors", type: "exact" }, item)).toMatchObject({
      matched: northline,
      how: "learned",
    });
    // Another vendor's own name is never taught to this one.
    expect(
      await port.learn({
        ctx: ctxA,
        profile: "vendors",
        item: { name: "Cedar Ridge Lumber" },
        recordId: northline,
        by: { personId: A.userId },
      }),
    ).toBe(false);
  });

  it("matches a vendor item by SKU or not at all, the line's words checked", async () => {
    const vi = (item: Record<string, unknown>) =>
      one(ctxA, { to: "vendor-items", type: "exact" }, item);
    expect(await vi({ vendorId: northline, sku: "bb34-55" })).toMatchObject({
      matched: viBaltic,
      how: "exact",
      confidence: 100,
    });
    // The same SKU from another vendor, or a near SKU, is nothing.
    expect(await vi({ vendorId: cedar, sku: "BB34-55" })).toMatchObject({
      matched: null,
      unsure: false,
    });
    expect(await vi({ vendorId: northline, sku: "BB34-56" })).toMatchObject({ matched: null });
    // A SKU never outvotes the line's own words: 1/2" isn't the 3/4" item.
    const differ = await vi({
      vendorId: northline,
      sku: "BB34-55",
      description: 'BALTIC BIRCH PLY 1/2" 5X5',
    });
    expect(differ.matched).toBeNull();
    expect(differ.note?.vetoed).toEqual([{ record: viBaltic, rule: "words" }]);
    // A person's answer is learned as a SKU for the item, never as its wording.
    const item = { vendorId: northline, sku: "NP-0034", description: "the 3/4 baltic" };
    expect(await vi(item)).toMatchObject({ matched: null });
    expect(
      await port.learn({
        ctx: ctxA,
        profile: "vendor-items",
        item,
        recordId: viBaltic,
        by: { personId: A.userId },
      }),
    ).toBe(true);
    expect(await vi(item)).toMatchObject({ matched: viBaltic, how: "learned" });
    expect(await vi({ ...item, sku: "NP-0035" })).toMatchObject({ matched: null });
  });

  it("matches a master item by a vendor's name for it and key attributes, then a model", async () => {
    const m = (
      item: Record<string, unknown>,
      s: Record<string, unknown> = {},
      choose?: ProfileChooser,
    ) => one(ctxA, { to: "master-items", type: "hybrid", ...s }, item, choose);
    // A vendor item's exact name or SKU names its master item.
    expect(await m({ description: 'BALTIC BIRCH 3/4" 5X5', vendorId: northline })).toMatchObject({
      matched: baltic34,
      how: "exact",
    });
    expect(
      (await m({ description: 'BALTIC BIRCH 3/4" 5X5', vendorId: northline })).note?.rule,
    ).toBe("key:vendor_name");
    // Every key attribute equal: the rules' match.
    const byAttributes = await m({ description: 'Baltic birch plywood 1/2" 5x5 BB/BB' });
    expect(byAttributes).toMatchObject({ matched: baltic12, how: "exact" });
    expect(byAttributes.note?.rule).toBe("key:attributes");
    // A line the rules can't settle goes to the model, which never sees what a key attribute rules
    // out; with no model it waits for a person.
    let shown: string[] = [];
    const choose: ProfileChooser = async (q) => {
      shown = q.candidates.map((c) => c.id);
      return { record_id: walnut, confidence: 0.92, reason: "walnut" };
    };
    const open = await m({ description: "walnut boards" }, {}, choose);
    expect(open).toMatchObject({ matched: walnut, how: "semantic" });
    expect(shown).not.toContain(baltic34);
    expect(await m({ description: "walnut boards" })).toMatchObject({
      matched: null,
      unsure: true,
    });
    // Exact match never takes a near one.
    expect(
      await m({ description: "walnut boards" }, { type: "exact", noMatch: "new" }, choose),
    ).toMatchObject({
      matched: null,
      isNew: true,
    });
    // A person's answer is the vendor's wording next time.
    const item = { description: "WLNT BDS LOT 77", vendorId: cedar };
    expect(
      await port.learn({
        ctx: ctxA,
        profile: "master-items",
        item,
        recordId: walnut,
        by: { personId: A.userId },
      }),
    ).toBe(true);
    expect(await m(item, { type: "exact" })).toMatchObject({ matched: walnut, how: "learned" });
    // A taught name never ties an item a key attribute rules out.
    await expect(
      port.learn({
        ctx: ctxA,
        profile: "master-items",
        item: { description: 'BALTIC BIRCH PLY 1/2" 5X5 BB/BB', vendorId: cedar },
        recordId: baltic34,
        by: { personId: A.userId },
      }),
    ).rejects.toThrow(/key_attribute/);
    // Another client's items are never reached.
    expect(
      await one(
        ctxB,
        { to: "master-items", type: "exact" },
        { description: 'Baltic birch plywood 1/2" 5x5 BB/BB' },
      ),
    ).toMatchObject({
      matched: null,
    });
  });
});
