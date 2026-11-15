// §1.104: vendor contracts against a throwaway database, as the Worker's role (RLS applies).
// Saving a contract keeps its terms and puts its agreed prices on the vendor's items (saving again
// updates, a test run saves nothing); the price check then checks an invoice against it: a price
// above the agreed one (per standard unit, through the vendor's pack), an item not on it, payment
// terms and freight that differ, an invoice outside its dates; the review notes for AP lay it out;
// a test run prices an invoice with no purchase yet; and each client's contracts stay its own.

import { alert, closeDb, createDb, type Db } from "@countersign/db";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "@countersign/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matchLine } from "../catalog/match";
import { latestMatch } from "../catalog/store";
import { checkPrices } from "../pricing/check";
import { recordPrices } from "../pricing/record";
import { priceSettingsFrom } from "../pricing/rules";
import { vendorContract, vendorItem } from "../schema";
import {
  type InvoiceLine,
  type InvoiceOptions,
  insertShop,
  type ShopFixture,
} from "../testing.test-helper";
import { packToolContext } from "../tools";
import { contractGet, contractSave, invoiceReview } from "./tools";

const online = await databaseAvailable();

const BB = "3/4 BB/BB BALTIC BIRCH 5X5";
const OAK = "4/4 RED OAK FAS";
const VENDOR = "Northline Plywood";

describe.skipIf(!online)("vendor contracts (database)", () => {
  let t: TestDatabase;
  let db: Db;
  let A: ShopFixture;
  let B: ShopFixture;
  let bbItem: string;
  let vendorA: string;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    const url = new URL(t.url);
    url.searchParams.set("options", "-c role=cs_worker");
    db = createDb(url.toString(), { max: 2 });
    A = await insertShop(t.db, "Millwork A");
    B = await insertShop(t.db, "Millwork B");
    // The catalog learns the two items from an earlier invoice.
    const first = await matchedInvoice(
      A,
      [
        { description: BB, qty: "10", uom: "SHT", unitPrice: "60.00" },
        { description: OAK, qty: "1", uom: "MBF", unitPrice: "4850.00" },
      ],
      { date: "2026-12-10" },
    );
    vendorA = first.vendorId;
    const m = await t.db.transaction((tx) => latestMatch(tx, A.tenantId, first.lineIds[0] ?? ""));
    if (!m?.catalogItemId) throw new Error("no match");
    bbItem = m.catalogItemId;
  });
  afterAll(async () => {
    if (db) await closeDb(db);
    await t?.drop();
  });

  const tools = (shop: ShopFixture, mode: "live" | "test" = "live", settings = {}) =>
    packToolContext({
      tenantId: shop.tenantId,
      agentVersionId: shop.agentVersionId,
      mode,
      db,
      settings,
    });
  const pricing = (shop: ShopFixture, testRun = false) => ({
    tenantId: shop.tenantId,
    agentVersionId: shop.agentVersionId,
    runId: null,
    testRun,
  });

  async function matchedInvoice(shop: ShopFixture, lines: InvoiceLine[], options: InvoiceOptions) {
    const vendorId = await shop.vendor(VENDOR);
    const doc = await shop.invoiceDoc(vendorId, lines, options);
    for (const docLineId of doc.lineIds) {
      await matchLine(
        { db },
        // The vendor given: an invoice with no purchase yet names none.
        { tenantId: shop.tenantId, agentVersionId: shop.agentVersionId, docLineId, vendorId },
      );
    }
    return { ...doc, vendorId };
  }

  const CONTRACT = {
    name: "2027 supply agreement",
    effectiveFrom: "2027-01-01",
    effectiveTo: "2027-12-31",
    paymentTerms: "2% 10, net 30",
    netDays: 30,
    earlyPayDiscountPct: "2",
    earlyPayDays: 10,
    freight: "included" as const,
  };

  const save = (shop: ShopFixture, mode: "live" | "test" = "live") =>
    contractSave.run(
      {
        vendorId: vendorA,
        contract: CONTRACT,
        // $300 a bundle of 5 sheets: $60 a sheet. Red oak is not on it.
        items: [
          {
            sku: "BB34-55",
            name: "3/4 BB/BB Baltic birch 5x5",
            vendorUom: "bundle",
            stdPerVendorUom: "5",
            listPrice: "300.00",
            catalogItemId: bbItem,
          },
        ],
      },
      tools(shop, mode),
    ) as Promise<{
      contract: { id: string };
      created: boolean;
      prices: { created: number; updated: number; unplaced: number };
      testRun: boolean;
      sources: string[];
    }>;

  it("saves a contract and its agreed prices; again updates it; a test run saves nothing", async () => {
    const dry = await save(A, "test");
    expect(dry.testRun).toBe(true);
    expect(
      await t.db.select().from(vendorContract).where(eq(vendorContract.tenantId, A.tenantId)),
    ).toEqual([]);

    const r = await save(A);
    expect(r.created).toBe(true);
    expect(r.prices.created + r.prices.updated).toBe(1);
    expect(r.sources).toContain(r.contract.id);
    const [c] = await t.db
      .select()
      .from(vendorContract)
      .where(eq(vendorContract.tenantId, A.tenantId));
    expect(c).toMatchObject({
      netDays: 30,
      earlyPayDiscountPct: "2.00",
      earlyPayDays: 10,
      freight: "included",
      createdByAgentVersionId: A.agentVersionId,
    });
    const [vi] = await t.db
      .select()
      .from(vendorItem)
      .where(and(eq(vendorItem.tenantId, A.tenantId), eq(vendorItem.contractId, r.contract.id)));
    expect(vi).toMatchObject({
      listPrice: "300.0000",
      listPriceOn: "2027-01-01",
      stdPerVendorUom: "5.0000",
      catalogItemId: bbItem,
    });

    const again = await save(A);
    expect(again).toMatchObject({ created: false, contract: { id: r.contract.id } });
    expect(
      await t.db.select().from(vendorContract).where(eq(vendorContract.tenantId, A.tenantId)),
    ).toHaveLength(1);

    const read = (await contractGet.run({ vendorId: vendorA, on: "2027-03-01" }, tools(A))) as {
      inEffect: { id: string } | null;
      prices: { price: string; vendorUom: string | null }[];
    };
    expect(read.inEffect?.id).toBe(r.contract.id);
    expect(read.prices).toEqual([expect.objectContaining({ price: "300.0000" })]);
  });

  it("checks an invoice against the contract: price, items, payment terms and freight", async () => {
    const doc = await matchedInvoice(
      A,
      [
        { description: BB, qty: "20", uom: "SHT", unitPrice: "62.50" },
        { description: OAK, qty: "1", uom: "MBF", unitPrice: "4850.00" },
      ],
      {
        date: "2027-02-01",
        freight: "75.00",
        header: { invoiceNumber: "20501", dueDate: "2027-02-16", paymentTerms: "Net 15" },
      },
    );
    await recordPrices(db, pricing(A), { documentId: doc.documentId });
    const r = await checkPrices(db, pricing(A), {
      documentId: doc.documentId,
      settings: priceSettingsFrom({}),
    });
    const byKind = (kind: string) => r.alerts.filter((a) => a.kind === kind);
    // $62.50 a sheet against $60 agreed (a bundle of 5 at $300), 20 sheets: $50 over.
    const [above] = byKind("above_contract");
    expect(above).toMatchObject({ dollarImpact: "50.0000", catalogItemId: bbItem, deduped: false });
    expect(above?.evidence).toEqual(expect.arrayContaining([doc.lineIds[0]]));
    expect(byKind("not_on_contract")).toHaveLength(1);
    const terms = byKind("terms_mismatch");
    expect(terms.map((a) => a.title).sort()).toEqual([
      "Northline Plywood charged $75.00 freight the contract includes",
      "Northline Plywood's invoice asks for payment in 15 days, not 30",
    ]);
    expect(terms.find((a) => a.dollarImpact)?.dollarImpact).toBe("75.0000");
    const [row] = await t.db
      .select()
      .from(alert)
      .where(and(eq(alert.tenantId, A.tenantId), eq(alert.kind, "above_contract")));
    expect(row).toMatchObject({
      pack: "materials",
      status: "open",
      agentVersionId: A.agentVersionId,
    });
    expect(row?.evidence.length).toBeGreaterThanOrEqual(3);

    // The review notes for AP, with the mailbox the client's agent set.
    const notes = (await invoiceReview.run(
      { documentId: doc.documentId, findings: r.alerts },
      tools(A, "live", { ap_email: "ap@millwork-a.example" }),
    )) as Record<string, unknown>;
    expect(notes).toMatchObject({
      hasApEmail: true,
      apEmail: "ap@millwork-a.example",
      findings: 4,
      dollarImpact: "125.00",
      subject: "Invoice 20501 from Northline Plywood: 4 findings, $125.00 at stake",
      attachments: [{ documentId: doc.documentId }],
    });
    expect(String(notes.body)).toContain('against "2027 supply agreement"');
    const none = (await invoiceReview.run(
      { documentId: doc.documentId, findings: [] },
      tools(A),
    )) as Record<string, unknown>;
    expect(none).toMatchObject({ hasApEmail: false, apEmail: null });
  });

  it("says when no contract holds on the invoice's date, and checks nothing against it", async () => {
    const doc = await matchedInvoice(
      A,
      [{ description: BB, qty: "5", uom: "SHT", unitPrice: "70.00" }],
      { date: "2028-03-01", freight: "40.00" },
    );
    const r = await checkPrices(db, pricing(A, true), {
      documentId: doc.documentId,
      settings: priceSettingsFrom({}),
    });
    const kinds = r.alerts.map((a) => a.kind);
    expect(kinds).toContain("contract_not_in_effect");
    expect(kinds).not.toContain("above_contract");
    expect(kinds).not.toContain("terms_mismatch");
  });

  it("prices a test run's invoice with no purchase yet; a live run needs its purchase", async () => {
    const doc = await matchedInvoice(
      A,
      [{ description: BB, qty: "10", uom: "SHT", unitPrice: "61.00" }],
      { date: "2027-03-01", unlinked: true, header: { vendorName: VENDOR } },
    );
    const dry = await checkPrices(db, pricing(A, true), {
      documentId: doc.documentId,
      settings: priceSettingsFrom({}),
    });
    expect(dry.alerts.find((a) => a.kind === "above_contract")?.dollarImpact).toBe("10.0000");
    await expect(
      checkPrices(db, pricing(A), { documentId: doc.documentId, settings: priceSettingsFrom({}) }),
    ).rejects.toThrow(/isn't linked to a purchase/);
  });

  it("keeps each client's contracts its own", async () => {
    // B buys from a vendor of the same name: none of A's contract reaches it.
    const doc = await matchedInvoice(
      B,
      [{ description: BB, qty: "20", uom: "SHT", unitPrice: "62.50" }],
      { date: "2027-02-01", freight: "75.00" },
    );
    const r = await checkPrices(db, pricing(B, true), {
      documentId: doc.documentId,
      settings: priceSettingsFrom({}),
    });
    expect(
      r.alerts.filter((a) => a.kind.includes("contract") || a.kind === "terms_mismatch"),
    ).toEqual([]);
    const read = (await contractGet.run({ vendorId: vendorA }, tools(B))) as {
      contracts: unknown[];
    };
    expect(read.contracts).toEqual([]);
    await expect(save(B)).rejects.toThrow(/vendor isn't known/);
  });
});
