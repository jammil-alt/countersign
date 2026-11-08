// The matching pipeline against a throwaway database, as the Worker's role (cs_worker, so RLS
// applies): Baltic birch from three vendors is one item, near-misses are new items, the model
// adjudicates only what the rules can't settle (scripted answers), the hard rules veto it,
// people's decisions teach aliases, learning stays with its client, and merges move history.

import { closeDb, createDb, type Db, event } from "@countersign/db";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "@countersign/db/testing";
import { createLlmClient, FakeModel, type FakeTurn } from "@countersign/llm";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { catalogItem, itemAlias, itemMatch, priceObservation } from "../schema";
import { insertShop, type ShopFixture } from "../testing.test-helper";
import { parseLine } from "./keys";
import { decideLine, MatchError, matchLine } from "./match";
import { mergeItems } from "./merge";
import { descriptionHash, normalize } from "./normalize";
import { createItem, learnAlias } from "./store";

const online = await databaseAvailable();

function scripted(turns: FakeTurn[]) {
  const model = new FakeModel(turns);
  return { model, llm: createLlmClient({ transport: model }) };
}

const answer = (input: Record<string, unknown>): FakeTurn => ({
  toolUse: { name: "record_match", input },
});

describe.skipIf(!online)("matching lines (database)", () => {
  let t: TestDatabase;
  /** As cs_worker: row-level security applies to everything the pipeline does. */
  let db: Db;
  let A: ShopFixture;
  let B: ShopFixture;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    const url = new URL(t.url);
    url.searchParams.set("options", "-c role=cs_worker");
    db = createDb(url.toString(), { max: 2 });
    A = await insertShop(t.db, "Millwork A");
    B = await insertShop(t.db, "Millwork B");
  });
  afterAll(async () => {
    if (db) await closeDb(db);
    await t?.drop();
  });

  const items = (tenantId: string) =>
    t.db.select().from(catalogItem).where(eq(catalogItem.tenantId, tenantId));

  it("runs as cs_worker", async () => {
    const [row] = await db.execute<{ r: string }>(sql`select current_user as r`);
    expect(row?.r).toBe("cs_worker");
  });

  it("matches Baltic birch from three vendors to one catalog item", async () => {
    const northline = await A.vendor("Northline Plywood");
    const keystone = await A.vendor("Keystone Lumber");
    const cedar = await A.vendor("Cedar Ridge Supply");
    const [l1] = await A.invoice(northline, [{ description: "3/4 BB/BB BALTIC BIRCH 5X5" }]);
    const [l2] = await A.invoice(keystone, [
      { description: "BALTIC BIRCH PLYWOOD 18MM BB/BB 60X60" },
    ]);
    const [l3] = await A.invoice(cedar, [
      { description: 'BIRCH BALTIC 3/4" 1525X1525MM BB/BB', sku: "BB34-55" },
    ]);
    const base = { tenantId: A.tenantId, agentVersionId: A.agentVersionId };
    const r1 = await matchLine({ db }, { ...base, docLineId: l1 as string });
    expect(r1).toMatchObject({
      decision: "new_item",
      method: "rules",
      createdItem: true,
      needsReview: false,
    });
    const r2 = await matchLine({ db }, { ...base, docLineId: l2 as string });
    expect(r2).toMatchObject({
      decision: "matched",
      method: "rules",
      catalogItemId: r1.catalogItemId,
    });
    const r3 = await matchLine({ db }, { ...base, docLineId: l3 as string });
    expect(r3).toMatchObject({
      decision: "matched",
      method: "rules",
      catalogItemId: r1.catalogItemId,
    });
    expect(r1.confidence).toBeGreaterThanOrEqual(0.9);

    const catalog = await items(A.tenantId);
    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.canonicalName).toBe("Baltic birch plywood 3/4in 60x60in BB/BB");
    expect(catalog[0]?.standardUom).toBe("sheet");
    expect(catalog[0]?.createdByAgentVersionId).toBe(A.agentVersionId);

    // Each decision is recorded with the agent version that made it (invariant 10).
    const matches = await t.db.select().from(itemMatch).where(eq(itemMatch.tenantId, A.tenantId));
    expect(matches).toHaveLength(3);
    expect(matches.every((m) => m.agentVersionId === A.agentVersionId)).toBe(true);

    // The next invoice from Cedar Ridge is an alias hit, by SKU even with other words.
    const [l4] = await A.invoice(cedar, [{ description: "BALTIC BIRCH SHEET", sku: "bb34-55" }]);
    const r4 = await matchLine({ db }, { ...base, docLineId: l4 as string });
    expect(r4).toMatchObject({
      decision: "matched",
      method: "alias",
      confidence: 1,
      catalogItemId: r1.catalogItemId,
    });
    // And Northline's same description, by description hash.
    const [l5] = await A.invoice(northline, [{ description: "3/4  bb/bb baltic birch 5 x 5" }]);
    const r5 = await matchLine({ db }, { ...base, docLineId: l5 as string });
    expect(r5).toMatchObject({ method: "alias", catalogItemId: r1.catalogItemId });
  });

  it("makes near-misses their own items: 3/4 vs 1/2, BB/BB vs B/BB, 5x5 vs 4x8, prefinished", async () => {
    const vendorId = await A.vendor("Northline Plywood");
    const lines = await A.invoice(vendorId, [
      { description: "1/2 BB/BB BALTIC BIRCH 5X5" },
      { description: "3/4 B/BB BALTIC BIRCH 5X5" },
      { description: "3/4 BB/BB BALTIC BIRCH 4X8" },
      { description: "3/4 BB/BB BALTIC BIRCH 5X5 UV1S" },
    ]);
    const before = (await items(A.tenantId)).length;
    for (const docLineId of lines) {
      const r = await matchLine(
        { db },
        { tenantId: A.tenantId, agentVersionId: A.agentVersionId, docLineId },
      );
      expect(r.decision, r.attributes.thickness).toBe("new_item");
      expect(r.candidates.some((c) => c.vetoed)).toBe(true);
    }
    expect((await items(A.tenantId)).length).toBe(before + 4);
  });

  it("asks the model only when the rules can't settle it, and takes a sure answer", async () => {
    const vendorId = await A.vendor("Keystone Lumber");
    const [lineId] = await A.invoice(vendorId, [{ description: "3/4 BALTIC BIRCH PLY 5X5" }]);
    const all = await items(A.tenantId);
    const bbbb = all.find((i) => i.canonicalName === "Baltic birch plywood 3/4in 60x60in BB/BB");
    const { model, llm } = scripted([
      answer({
        decision: "matched",
        catalog_item_id: bbbb?.id,
        confidence: 0.93,
        hinge_attribute: "grade",
      }),
    ]);
    const r = await matchLine(
      { db, llm },
      { tenantId: A.tenantId, agentVersionId: A.agentVersionId, docLineId: lineId as string },
    );
    expect(r).toMatchObject({
      decision: "matched",
      method: "llm",
      catalogItemId: bbbb?.id,
      hingeAttribute: "grade",
    });
    expect(model.requests).toHaveLength(1);
    // The vendor's text is data in the user message, never in the instructions (invariant 9).
    const request = model.requests[0];
    expect(JSON.stringify(request?.system)).not.toContain("3/4 BALTIC BIRCH PLY 5X5");
    expect(JSON.stringify(request?.messages)).toContain("<line>3/4 BALTIC BIRCH PLY 5X5</line>");
  });

  it("sends a model answer below the threshold to review", async () => {
    const vendorId = await A.vendor("Keystone Lumber");
    const [lineId] = await A.invoice(vendorId, [
      { description: "BALTIC BIRCH 3/4 60X60 PLYWOOD SHEET" },
    ]);
    const bbbb = (await items(A.tenantId)).find(
      (i) =>
        i.keySignature?.includes("grade=bb/bb") &&
        i.keySignature.includes("size=60x60in") &&
        i.keySignature.includes("finish=unfinished") &&
        i.keySignature.includes("thickness=3/4in"),
    );
    const { llm } = scripted([
      answer({
        decision: "matched",
        catalog_item_id: bbbb?.id,
        confidence: 0.8,
        hinge_attribute: "grade",
      }),
    ]);
    const r = await matchLine(
      { db, llm },
      { tenantId: A.tenantId, agentVersionId: A.agentVersionId, docLineId: lineId as string },
    );
    expect(r).toMatchObject({
      decision: "unsure",
      needsReview: true,
      catalogItemId: null,
      method: "llm",
    });
    const [ev] = await t.db
      .select()
      .from(event)
      .where(and(eq(event.tenantId, A.tenantId), eq(event.subjectId, lineId as string)));
    expect(ev?.type).toBe("materials.line.needs_review");
  });

  it("vetoes a model match whose key attributes differ (hard rule)", async () => {
    const vendorId = await A.vendor("Keystone Lumber");
    const [lineId] = await A.invoice(vendorId, [{ description: "BALTIC BIRCH PLY 3/4 5X5 SHEET" }]);
    const half = (await items(A.tenantId)).find((i) => i.keySignature?.includes("thickness=1/2in"));
    expect(half).toBeDefined();
    const { llm } = scripted([
      answer({
        decision: "matched",
        catalog_item_id: half?.id,
        confidence: 0.99,
        hinge_attribute: null,
      }),
    ]);
    const r = await matchLine(
      { db, llm },
      { tenantId: A.tenantId, agentVersionId: A.agentVersionId, docLineId: lineId as string },
    );
    expect(r).toMatchObject({ decision: "unsure", needsReview: true, hingeAttribute: "thickness" });
    expect(r.confidence).toBeLessThanOrEqual(0.5);
  });

  it("without a model, what the rules can't settle goes to review", async () => {
    const vendorId = await A.vendor("Keystone Lumber");
    const [lineId] = await A.invoice(vendorId, [{ description: "FREIGHT CHARGE" }]);
    const r = await matchLine(
      { db },
      { tenantId: A.tenantId, agentVersionId: A.agentVersionId, docLineId: lineId as string },
    );
    expect(r).toMatchObject({ decision: "unsure", needsReview: true, category: "other" });
  });

  it("an unusable model answer is unsure, never a guess", async () => {
    const vendorId = await A.vendor("Keystone Lumber");
    const [lineId] = await A.invoice(vendorId, [{ description: "BALTIC BIRCH 3/4 5X5 PANEL" }]);
    const { llm } = scripted([{ text: "It is probably the first one." }]);
    const r = await matchLine(
      { db, llm },
      { tenantId: A.tenantId, agentVersionId: A.agentVersionId, docLineId: lineId as string },
    );
    expect(r).toMatchObject({ decision: "unsure", method: "llm" });
  });

  it("learns from a person's decision: the vendor's next identical line is an alias hit", async () => {
    const vendorId = await A.vendor("Keystone Lumber");
    const [lineId] = await A.invoice(vendorId, [
      { description: "BB PLY 3/4 5X5 SHT", sku: "KS-BB34" },
    ]);
    const first = await matchLine(
      { db },
      { tenantId: A.tenantId, agentVersionId: A.agentVersionId, docLineId: lineId as string },
    );
    expect(first.needsReview).toBe(true);
    const bbbb = (await items(A.tenantId)).find(
      (i) => i.canonicalName === "Baltic birch plywood 3/4in 60x60in BB/BB",
    );
    const decided = await decideLine(db, {
      tenantId: A.tenantId,
      docLineId: lineId as string,
      userId: A.userId,
      decision: "matched",
      catalogItemId: bbbb?.id,
    });
    expect(decided).toMatchObject({
      method: "human",
      decision: "matched",
      catalogItemId: bbbb?.id,
    });
    const aliases = await t.db
      .select()
      .from(itemAlias)
      .where(and(eq(itemAlias.tenantId, A.tenantId), eq(itemAlias.vendorId, vendorId)));
    expect(
      aliases
        .filter((a) => a.source === "human")
        .map((a) => a.vendorSku ?? "hash")
        .sort(),
    ).toEqual(["KS-BB34", "hash"]);
    const history = await t.db
      .select()
      .from(itemMatch)
      .where(eq(itemMatch.docLineId, lineId as string));
    expect(history.map((h) => h.method)).toEqual(["rules", "human"]);
    expect(history[1]?.decidedByUserId).toBe(A.userId);

    const [next] = await A.invoice(vendorId, [{ description: "BB PLY 3/4 5X5 SHT" }]);
    const r = await matchLine(
      { db },
      { tenantId: A.tenantId, agentVersionId: A.agentVersionId, docLineId: next as string },
    );
    expect(r).toMatchObject({ method: "alias", catalogItemId: bbbb?.id });
  });

  it("never lets an automatic alias replace a person's", async () => {
    const vendorId = await A.vendor("Keystone Lumber");
    const normalized = normalize("BB PLY 3/4 5X5 SHT");
    const hash = await descriptionHash(normalized);
    const other = (await items(A.tenantId)).find((i) =>
      i.keySignature?.includes("thickness=1/2in"),
    );
    await t.db.transaction(async (tx) => {
      await learnAlias(tx, A.tenantId, {
        vendorId,
        vendorSku: null,
        descriptionHash: hash,
        normalizedDescription: normalized,
        catalogItemId: other?.id as string,
        source: "auto",
      });
    });
    const [alias] = await t.db
      .select()
      .from(itemAlias)
      .where(and(eq(itemAlias.vendorId, vendorId), eq(itemAlias.descriptionHash, hash)));
    expect(alias?.source).toBe("human");
    expect(alias?.catalogItemId).not.toBe(other?.id);
  });

  it("keeps learning per client: another client's same vendor and line start fresh", async () => {
    const vendorId = await B.vendor("Northline Plywood");
    const [lineId] = await B.invoice(vendorId, [{ description: "3/4 BB/BB BALTIC BIRCH 5X5" }]);
    const r = await matchLine(
      { db },
      { tenantId: B.tenantId, agentVersionId: B.agentVersionId, docLineId: lineId as string },
    );
    expect(r).toMatchObject({ decision: "new_item", method: "rules", createdItem: true });
    const bItems = await items(B.tenantId);
    expect(bItems).toHaveLength(1);
    const aIds = new Set((await items(A.tenantId)).map((i) => i.id));
    expect(aIds.has(r.catalogItemId as string)).toBe(false);
    // A's line is invisible from B's session: no reading another client's documents.
    const [aLine] = await A.invoice(await A.vendor("Northline Plywood"), [
      { description: "3/4 MDF 4X8" },
    ]);
    await expect(
      matchLine(
        { db },
        { tenantId: B.tenantId, agentVersionId: B.agentVersionId, docLineId: aLine as string },
      ),
    ).rejects.toBeInstanceOf(MatchError);
  });

  it("emits nothing for a test run, and an event for a live one", async () => {
    const vendorId = await A.vendor("Northline Plywood");
    const [live, test] = await A.invoice(vendorId, [
      { description: "3/4 MDF 4X10" },
      { description: "1/2 MDF 4X10" },
    ]);
    await matchLine(
      { db },
      { tenantId: A.tenantId, agentVersionId: A.agentVersionId, docLineId: live as string },
    );
    await matchLine(
      { db },
      {
        tenantId: A.tenantId,
        agentVersionId: A.agentVersionId,
        docLineId: test as string,
        testRun: true,
      },
    );
    const events = await t.db.select().from(event).where(eq(event.tenantId, A.tenantId));
    expect(events.some((e) => e.subjectId === live && e.type === "materials.line.matched")).toBe(
      true,
    );
    expect(events.some((e) => e.subjectId === test)).toBe(false);
  });

  it("creates one item when two runs make the same item at once", async () => {
    const parsed = parseLine("3/4 WHITE MEL PB 4X8");
    const [a, b] = await Promise.all([
      t.db.transaction((tx) =>
        createItem(tx, A.tenantId, parsed, { agentVersionId: A.agentVersionId }),
      ),
      t.db.transaction((tx) =>
        createItem(tx, A.tenantId, parsed, { agentVersionId: A.agentVersionId }),
      ),
    ]);
    expect(a.item.id).toBe(b.item.id);
    expect([a.created, b.created].sort()).toEqual([false, true]);
  });

  it("merges a duplicate: aliases and prices follow, history keeps its ids", async () => {
    const vendorId = await A.vendor("Cedar Ridge Supply");
    const dup = await t.db.transaction((tx) =>
      createItem(tx, A.tenantId, parseLine("3/4 WHITE MELAMINE PARTICLEBOARD 48X96 SHEET 2S"), {
        userId: A.userId,
      }),
    );
    const keep = await t.db.transaction((tx) =>
      createItem(tx, A.tenantId, parseLine("3/4 WHITE MEL PB 4X8"), { userId: A.userId }),
    );
    // Same signature, so the "duplicate" is the existing item: make a real one by hand.
    expect(dup.item.id).toBe(keep.item.id);
    const [twin] = await t.db
      .insert(catalogItem)
      .values({
        tenantId: A.tenantId,
        category: "sheet_goods",
        canonicalName: "White melamine 3/4in 48x96in",
        attributes: { material: "melamine", face: "white", thickness: "3/4in", size: "48x96in" },
        standardUom: "sheet",
      })
      .returning();
    const [lineId] = await A.invoice(vendorId, [{ description: "WHITE MEL 3/4 4X8 CUSTOM" }]);
    await t.db.transaction((tx) =>
      learnAlias(tx, A.tenantId, {
        vendorId,
        vendorSku: "CR-MEL34",
        descriptionHash: "b".repeat(64),
        normalizedDescription: "WHITE MEL 3/4 4X8 CUSTOM",
        catalogItemId: twin?.id as string,
        source: "human",
      }),
    );
    await t.db.insert(priceObservation).values({
      tenantId: A.tenantId,
      catalogItemId: twin?.id as string,
      vendorId,
      observedOn: "2026-11-01",
      unitPriceStd: "41.2500",
      qtyStd: "20.0000",
      standardUom: "sheet",
      docLineId: lineId as string,
    });
    const result = await mergeItems(db, {
      tenantId: A.tenantId,
      fromId: twin?.id as string,
      intoId: keep.item.id,
      userId: A.userId,
    });
    expect(result).toMatchObject({
      intoId: keep.item.id,
      aliasesMoved: 2,
      pricesMoved: 1,
      differingKeys: [],
    });
    const [merged] = await t.db
      .select()
      .from(catalogItem)
      .where(eq(catalogItem.id, twin?.id as string));
    expect(merged?.mergedIntoId).toBe(keep.item.id);
    // The vendor's SKU now reaches the item that stayed.
    const [next] = await A.invoice(vendorId, [{ description: "SOMETHING ELSE", sku: "CR-MEL34" }]);
    const r = await matchLine(
      { db },
      { tenantId: A.tenantId, agentVersionId: A.agentVersionId, docLineId: next as string },
    );
    expect(r).toMatchObject({ method: "alias", catalogItemId: keep.item.id });
  });

  it("refuses to merge items priced in different units (invariant 7)", async () => {
    const sheet = (await items(A.tenantId)).find(
      (i) => i.standardUom === "sheet" && !i.mergedIntoId,
    );
    const lumber = await t.db.transaction((tx) =>
      createItem(tx, A.tenantId, parseLine("4/4 RED OAK FAS RGH"), { userId: A.userId }),
    );
    await expect(
      mergeItems(db, {
        tenantId: A.tenantId,
        fromId: lumber.item.id,
        intoId: sheet?.id as string,
        userId: A.userId,
      }),
    ).rejects.toMatchObject({ code: "different_category" });
    const [each] = await t.db
      .insert(catalogItem)
      .values({
        tenantId: A.tenantId,
        category: "sheet_goods",
        canonicalName: "Odd sheet",
        standardUom: "each",
      })
      .returning();
    await expect(
      mergeItems(db, {
        tenantId: A.tenantId,
        fromId: each?.id as string,
        intoId: sheet?.id as string,
        userId: A.userId,
      }),
    ).rejects.toMatchObject({ code: "different_uom" });
  });
});
