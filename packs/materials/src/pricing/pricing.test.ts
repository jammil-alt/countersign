// Recording prices and raising alerts against a throwaway database, as the Worker's role (RLS
// applies): standard-unit prices with freight kept apart, the UOM guard, recording twice adds
// nothing, a price jump raises one alert with its evidence and agent version (invariant 10), a
// repeat finds the open alert, a new fee, test runs write nothing, and each client's history and
// alerts stay its own (invariant 1).

import {
  alert,
  closeDb,
  createDb,
  type Db,
  docExtraction,
  docLine,
  event,
  withTenant,
} from "@countersign/db";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "@countersign/db/testing";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matchLine } from "../catalog/match";
import { priceObservation } from "../schema";
import {
  type InvoiceLine,
  type InvoiceOptions,
  insertShop,
  type ShopFixture,
} from "../testing.test-helper";
import { checkPrices } from "./check";
import { compareVendors, priceHistory } from "./history";
import { recordPrices } from "./record";
import { priceSettingsFrom } from "./rules";

const online = await databaseAvailable();

describe.skipIf(!online)("prices and alerts (database)", () => {
  let t: TestDatabase;
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

  const ctx = (shop: ShopFixture, testRun = false) => ({
    tenantId: shop.tenantId,
    agentVersionId: shop.agentVersionId,
    runId: null,
    testRun,
  });

  /** An invoice whose lines are matched by the rules, as Pia's match step does. */
  async function matchedInvoice(
    shop: ShopFixture,
    vendorName: string,
    lines: InvoiceLine[],
    options: InvoiceOptions,
  ) {
    const vendorId = await shop.vendor(vendorName);
    const doc = await shop.invoiceDoc(vendorId, lines, options);
    for (const docLineId of doc.lineIds) {
      await matchLine(
        { db },
        { tenantId: shop.tenantId, agentVersionId: shop.agentVersionId, docLineId },
      );
    }
    return { ...doc, vendorId };
  }

  const observations = (tenantId: string) =>
    t.db.select().from(priceObservation).where(eq(priceObservation.tenantId, tenantId));
  const alerts = (tenantId: string) =>
    t.db.select().from(alert).where(eq(alert.tenantId, tenantId));

  const BB = "3/4 BB/BB BALTIC BIRCH 5X5";

  it("records prices in the standard unit, freight apart, and adds nothing the second time", async () => {
    const doc = await matchedInvoice(
      A,
      "Northline Plywood",
      [
        { description: BB, qty: "10", uom: "SHT", unitPrice: "62.50" },
        { description: "4/4 RED OAK FAS", qty: "1", uom: "MBF", unitPrice: "4850.00" },
        // No rule turns board feet into sheets (invariant 7): skipped, not priced.
        { description: "1/2 BB/BB BALTIC BIRCH 5X5", qty: "3", uom: "BF", unitPrice: "40" },
      ],
      {
        date: "2026-09-01",
        freight: "100.00",
        surcharges: [{ label: "Fuel surcharge", amount: "35.00" }],
      },
    );
    const r = await recordPrices(db, ctx(A), { documentId: doc.documentId });
    expect(r).toMatchObject({ total: 3, recorded: 2, skipped: 1, observedOn: "2026-09-01" });
    const [bb, oak, half] = r.lines;
    expect(bb).toMatchObject({ unitPriceStd: "62.5000", qtyStd: "10.0000", standardUom: "sheet" });
    expect(oak).toMatchObject({
      unitPriceStd: "4.8500",
      qtyStd: "1000.0000",
      standardUom: "board_foot",
    });
    expect(half?.skipped).toBe("no conversion rule from board_foot to sheet");
    // Freight and surcharges ($135) shared by amount: $625 of $5,595 lines → $15.08 → $6.40 landed.
    expect(bb?.landedUnitPriceStd).toBe("64.0080");
    expect(r.sources).toContain(bb?.observationId);

    const again = await recordPrices(db, ctx(A), { documentId: doc.documentId });
    expect(again.lines.map((l) => l.observationId)).toEqual(r.lines.map((l) => l.observationId));
    expect(await observations(A.tenantId)).toHaveLength(2);
    const observed = await t.db
      .select()
      .from(event)
      .where(and(eq(event.tenantId, A.tenantId), eq(event.type, "materials.price.observed")));
    expect(observed).toHaveLength(2);
  });

  it("raises a price_jump with its evidence and agent version, once while it is open", async () => {
    const doc = await matchedInvoice(
      A,
      "Northline Plywood",
      [{ description: BB, qty: "20", uom: "SHT", unitPrice: "68.50" }],
      { date: "2026-10-01" },
    );
    await recordPrices(db, ctx(A), { documentId: doc.documentId });
    const changed = await t.db
      .select()
      .from(event)
      .where(and(eq(event.tenantId, A.tenantId), eq(event.type, "materials.price.changed")));
    expect(changed).toHaveLength(1);

    const settings = priceSettingsFrom({ price_change_pct: 5 });
    const r = await checkPrices(db, ctx(A), { documentId: doc.documentId, settings });
    expect(r.raised).toBe(1);
    const [jump] = r.alerts;
    expect(jump).toMatchObject({ kind: "price_jump", deduped: false });
    // $6 more a sheet × 30 sheets in the last 90 days.
    expect(jump?.dollarImpact).toBe("180.0000");
    expect(jump?.evidence).toContain(doc.lineIds[0]);

    const [row] = await alerts(A.tenantId);
    expect(row).toMatchObject({
      pack: "materials",
      kind: "price_jump",
      status: "open",
      agentVersionId: A.agentVersionId,
      subjectType: "catalog_item",
    });
    expect(row?.evidence.length).toBeGreaterThanOrEqual(2);
    const raised = await t.db
      .select()
      .from(event)
      .where(and(eq(event.tenantId, A.tenantId), eq(event.type, "alert.raised")));
    expect(raised).toHaveLength(1);
    expect(raised[0]?.payload).toMatchObject({ alertId: row?.id, kind: "price_jump" });

    // Up again two weeks later: the open alert stands; no second one.
    const next = await matchedInvoice(
      A,
      "Northline Plywood",
      [{ description: BB, qty: "5", uom: "SHT", unitPrice: "75.00" }],
      { date: "2026-10-15" },
    );
    await recordPrices(db, ctx(A), { documentId: next.documentId });
    const r2 = await checkPrices(db, ctx(A), { documentId: next.documentId, settings });
    const jump2 = r2.alerts.find((a) => a.kind === "price_jump");
    expect(jump2).toMatchObject({ deduped: true, id: row?.id });
    const open = (await alerts(A.tenantId)).filter((a) => a.kind === "price_jump");
    expect(open).toHaveLength(1);
  });

  it("raises new_fee for a surcharge the vendor never charged before", async () => {
    const doc = await matchedInvoice(
      A,
      "Northline Plywood",
      [{ description: BB, qty: "1", uom: "SHT", unitPrice: "75.00" }],
      { date: "2026-10-20", surcharges: [{ label: "Pallet fee", amount: "25.00" }] },
    );
    await recordPrices(db, ctx(A), { documentId: doc.documentId });
    const r = await checkPrices(db, ctx(A), {
      documentId: doc.documentId,
      settings: priceSettingsFrom({}),
    });
    const fee = r.alerts.find((a) => a.kind === "new_fee");
    expect(fee).toMatchObject({ dollarImpact: "25.0000", catalogItemId: null, deduped: false });
    // The fuel surcharge was on the first invoice: not new.
    expect(r.alerts.filter((a) => a.kind === "new_fee")).toHaveLength(1);
  });

  it("leaves out vendors the client's settings name", async () => {
    const doc = await matchedInvoice(
      A,
      "Northline Plywood",
      [{ description: BB, qty: "1", uom: "SHT", unitPrice: "99.00" }],
      { date: "2026-10-25", surcharges: [{ label: "Hazmat fee", amount: "9.00" }] },
    );
    await recordPrices(db, ctx(A), { documentId: doc.documentId });
    const r = await checkPrices(db, ctx(A), {
      documentId: doc.documentId,
      settings: priceSettingsFrom({}),
      ignoreVendors: ["northline plywood"],
    });
    expect(r.alerts).toEqual([]);
  });

  it("writes nothing on a test run, but says what it would raise", async () => {
    const before = {
      obs: (await observations(A.tenantId)).length,
      alerts: (await alerts(A.tenantId)).length,
      events: await t.db.select({ n: sql<number>`count(*)::int` }).from(event),
    };
    const doc = await matchedInvoice(
      A,
      "Keystone Lumber",
      [{ description: BB, qty: "10", uom: "SHT", unitPrice: "90.00" }],
      { date: "2026-10-16" },
    );
    const eventsAfterMatch = await t.db.select({ n: sql<number>`count(*)::int` }).from(event);
    const rec = await recordPrices(db, ctx(A, true), { documentId: doc.documentId });
    expect(rec.recorded).toBe(1);
    expect(rec.lines[0]?.observationId).toBeNull();
    const chk = await checkPrices(db, ctx(A, true), {
      documentId: doc.documentId,
      settings: priceSettingsFrom({}),
    });
    // Keystone at $90 against Northline's cheaper prices this month.
    expect(chk.alerts.some((a) => a.kind === "vendor_spread" && a.id === null)).toBe(true);
    expect(await observations(A.tenantId)).toHaveLength(before.obs);
    expect(await alerts(A.tenantId)).toHaveLength(before.alerts);
    const eventsNow = await t.db.select({ n: sql<number>`count(*)::int` }).from(event);
    expect(eventsNow[0]?.n).toBe(eventsAfterMatch[0]?.n);
    expect(before.events[0]?.n).toBeLessThanOrEqual(eventsNow[0]?.n ?? 0);
  });

  it("counts a document read again once: its latest reading's prices only", async () => {
    const C = await insertShop(t.db, "Millwork C");
    const settings = priceSettingsFrom({ price_change_pct: 5 });
    await matchedInvoice(
      C,
      "Northline Plywood",
      [{ description: BB, qty: "10", uom: "SHT", unitPrice: "1.25" }],
      { date: "2026-09-01" },
    ).then((d) => recordPrices(db, ctx(C), { documentId: d.documentId }));
    // Read as 7.25, recorded; then read again as 1.25 (the earlier reading and its price stay).
    const misread = await matchedInvoice(
      C,
      "Northline Plywood",
      [{ description: BB, qty: "10", uom: "SHT", unitPrice: "7.25" }],
      { date: "2026-09-15" },
    );
    await recordPrices(db, ctx(C), { documentId: misread.documentId });
    // A newer reading that is never priced (a test run's) replaces nothing.
    const [dryRead] = await t.db
      .insert(docExtraction)
      .values({
        tenantId: C.tenantId,
        documentId: misread.documentId,
        model: "test-model",
        header: { vendorName: "Vendor", invoiceDate: "2026-09-15" },
        subtotal: "72.5",
        total: "72.5",
        linesSum: "72.5",
        totalsMatch: true,
        createdAt: new Date(Date.now() + 30_000),
      })
      .returning();
    await t.db.insert(docLine).values({
      tenantId: C.tenantId,
      extractionId: dryRead?.id as string,
      lineNo: 1,
      rawDescription: BB,
      qty: "10",
      uomRaw: "SHT",
      unitPrice: "7.25",
      extPrice: "72.50",
    });
    const kept = await withTenant(db, C.tenantId, async (tx) =>
      priceHistory(tx, C.tenantId, {
        catalogItemId: (await observations(C.tenantId))[0]?.catalogItemId as string,
        today: "2026-09-30",
      }),
    );
    expect(kept.map((o) => o.unitPriceStd)).toEqual(["1.2500", "7.2500"]);
    const [reread] = await t.db
      .insert(docExtraction)
      .values({
        tenantId: C.tenantId,
        documentId: misread.documentId,
        model: "test-model",
        header: { vendorName: "Vendor", invoiceDate: "2026-09-15" },
        subtotal: "12.5",
        total: "12.5",
        linesSum: "12.5",
        totalsMatch: true,
        createdAt: new Date(Date.now() + 60_000),
      })
      .returning();
    const [line] = await t.db
      .insert(docLine)
      .values({
        tenantId: C.tenantId,
        extractionId: reread?.id as string,
        lineNo: 1,
        rawDescription: BB,
        qty: "10",
        uomRaw: "SHT",
        unitPrice: "1.25",
        extPrice: "12.50",
      })
      .returning();
    await matchLine(
      { db },
      { tenantId: C.tenantId, agentVersionId: C.agentVersionId, docLineId: line?.id as string },
    );
    await recordPrices(db, ctx(C), { documentId: misread.documentId });
    expect(await observations(C.tenantId)).toHaveLength(3);

    // Another vendor's line with no unit: its price is taken per sheet, so it is never compared.
    const assumed = await matchedInvoice(
      C,
      "Keystone Lumber",
      [{ description: BB, qty: "10", unitPrice: "1.00" }],
      { date: "2026-10-01" },
    );
    await recordPrices(db, ctx(C), { documentId: assumed.documentId });
    // A real rise to 1.40: 12% over the last price (1.25), and over the 90-day average (1.25).
    const rise = await matchedInvoice(
      C,
      "Northline Plywood",
      [{ description: BB, qty: "10", uom: "SHT", unitPrice: "1.40" }],
      { date: "2026-10-01" },
    );
    await recordPrices(db, ctx(C), { documentId: rise.documentId });
    const r = await checkPrices(db, ctx(C), { documentId: rise.documentId, settings });
    const jump = r.alerts.find((a) => a.kind === "price_jump");
    // 0.15 a sheet more × 30 sheets bought in 90 days (not 40: the misread line is not a purchase).
    expect(jump?.dollarImpact).toBe("4.5000");
    expect(jump?.evidence).not.toContain(misread.lineIds[0]);
    expect(r.alerts.some((a) => a.kind === "vendor_spread")).toBe(false);
    expect(r.alerts.find((a) => a.kind === "price_vs_avg")?.body).toBe(
      "$1.40 a sheet against an average of $1.25 over 2 earlier purchases.",
    );

    const read = await withTenant(db, C.tenantId, async (tx) => {
      const itemId = (await observations(C.tenantId))[0]?.catalogItemId as string;
      return {
        history: await priceHistory(tx, C.tenantId, { catalogItemId: itemId, today: "2026-10-02" }),
        vendors: await compareVendors(tx, C.tenantId, {
          catalogItemId: itemId,
          today: "2026-10-02",
        }),
      };
    });
    expect(read.history.map((o) => [o.unitPriceStd, o.uomAssumed])).toEqual([
      ["1.2500", false],
      ["1.2500", false],
      ["1.0000", true],
      ["1.4000", false],
    ]);
    expect(read.vendors.vendors).toHaveLength(1);
    expect(read.vendors.vendors[0]).toMatchObject({
      lastPrice: "1.4000",
      averagePrice: "1.3000",
      purchases: 3,
      qtyStd: "30.0000",
      currency: "USD",
    });
  });

  it("keeps each client's prices and alerts its own", async () => {
    const doc = await matchedInvoice(
      B,
      "Northline Plywood",
      [{ description: BB, qty: "10", uom: "SHT", unitPrice: "80.00" }],
      { date: "2026-10-01" },
    );
    await recordPrices(db, ctx(B), { documentId: doc.documentId });
    const r = await checkPrices(db, ctx(B), {
      documentId: doc.documentId,
      settings: priceSettingsFrom({}),
    });
    // A's history would make this a jump; B has only this price.
    expect(r.alerts).toEqual([]);
    expect(await alerts(B.tenantId)).toEqual([]);
    expect(await observations(B.tenantId)).toHaveLength(1);
  });
});
