// Plan entry §1.233: the AP pack against a throwaway database, as the Worker's role (RLS applies).
// A bill is prepared from an invoice's purchase: matched to its purchase order by the engine
// (reference, a part of it with freight, the vendor and amount; a different PO number never),
// coded from the vendor's history only when it is unanimous, a model's suggestion kept apart, and
// flagged (a duplicate, a price above the order, a unit not compared, more billed than ordered or
// received, no order). The week's list puts the due bills on it; a person approves the ready ones
// together, a flagged one only with a note, holds and rejects with a reason, codes a line, marks
// an order received. A test run keeps nothing; each client's bills stay its own. Nothing pays.

import { createHash, randomBytes } from "node:crypto";
import {
  closeDb,
  connection,
  createDb,
  type Db,
  docExtraction,
  docLine,
  document,
  ledgerAccount,
  transaction,
  withTenant,
} from "@countersign/db";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "@countersign/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  catalogItem,
  itemMatch,
  purchaseRequest,
  purchaseRequestLine,
  quoteLine,
  quoteRequest,
} from "../schema";
import { insertShop, type ShopFixture } from "../testing.test-helper";
import { packToolContext } from "../tools";
import { AP_PAY_LIST_REVIEW, AP_REPORTS, AP_REVIEWS } from "./api";
import { apBill, apBillLine, apReceipt } from "./schema";
import { type ApFlag, addDays, billView, nextPayDay, weekOf } from "./store";
import { getTool, payListTool, prepareTool, proposeCodingTool, receiptTool } from "./tools";

const online = await databaseAvailable();

function defined<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`no ${what}`);
  return value;
}
const card = defined(AP_REVIEWS[AP_PAY_LIST_REVIEW], "card");
const report = defined(AP_REPORTS.bills, "report");

describe("pay days", () => {
  it("finds the next pay day and its week's Monday", () => {
    // 2026-11-22 is a Sunday.
    expect(nextPayDay("2026-11-22", "friday")).toBe("2026-11-27");
    expect(nextPayDay("2026-11-27", "friday")).toBe("2026-11-27");
    expect(nextPayDay("2026-11-28", "monday")).toBe("2026-11-30");
    expect(weekOf("2026-11-27")).toBe("2026-11-23");
    expect(weekOf("2026-11-23")).toBe("2026-11-23");
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
  });
});

interface BillLineIn {
  description: string;
  qty: string;
  uom?: string | null;
  unitPrice: string;
  item?: string;
}

describe.skipIf(!online)("the AP pack (database)", () => {
  let t: TestDatabase;
  let db: Db;
  let A: ShopFixture;
  let B: ShopFixture;
  let northline: string;
  let baltic: string;
  let materialsAccount: string;
  let freightAccount: string;
  let qboConnection: string;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    const url = new URL(t.url);
    url.searchParams.set("options", "-c role=cs_worker");
    db = createDb(url.toString(), { max: 2 });
    A = await insertShop(t.db, "Millwork A");
    B = await insertShop(t.db, "Millwork B");
    northline = await A.vendor("Northline Lumber");
    baltic = await A.vendor("Baltic Supply");
    const [conn] = await t.db
      .insert(connection)
      .values({
        tenantId: A.tenantId,
        connector: "qbo",
        status: "connected",
        externalAccountId: "r",
      })
      .returning();
    qboConnection = conn?.id ?? "";
    const account = async (externalId: string, name: string, kind: "cost_of_goods" | "expense") =>
      (
        await t.db
          .insert(ledgerAccount)
          .values({
            tenantId: A.tenantId,
            connectionId: qboConnection,
            connector: "qbo",
            externalId,
            name,
            fullName: name,
            kind,
            accountType: kind === "expense" ? "Expense" : "Cost of Goods Sold",
          })
          .returning()
      )[0]?.id ?? "";
    materialsAccount = await account("80", "Materials", "cost_of_goods");
    freightAccount = await account("81", "Freight in", "expense");
  });
  afterAll(async () => {
    if (db) await closeDb(db);
    await t?.drop();
  });

  const tools = (shop: ShopFixture, mode: "live" | "test" = "live") =>
    packToolContext({ tenantId: shop.tenantId, agentVersionId: shop.agentVersionId, mode, db });

  /** An invoice from email: its purchase, document, reading and lines, totals that add up. */
  async function bill(
    shop: ShopFixture,
    vendorId: string,
    lines: BillLineIn[],
    opts: {
      number: string;
      date?: string;
      due?: string | null;
      po?: string | null;
      freight?: string;
      meta?: Record<string, unknown>;
    },
  ): Promise<{ documentId: string; transactionId: string; lineIds: string[] }> {
    const ref = randomBytes(8).toString("hex");
    const sub = lines.reduce((s, l) => s + Number(l.qty) * Number(l.unitPrice), 0);
    const total = (sub + Number(opts.freight ?? "0")).toFixed(2);
    const [txn] = await t.db
      .insert(transaction)
      .values({
        tenantId: shop.tenantId,
        kind: "bill",
        connector: "document",
        vendorId,
        txnDate: opts.date ?? "2026-11-16",
        total,
        externalId: ref,
        status: "extracted",
      })
      .returning();
    const sha = createHash("sha256").update(ref).digest("hex");
    const [d] = await t.db
      .insert(document)
      .values({
        tenantId: shop.tenantId,
        transactionId: txn?.id ?? null,
        source: "email",
        storageKey: `tenants/${shop.tenantId}/content/${sha}`,
        mimeType: "application/pdf",
        filename: `${opts.number}.pdf`,
        sizeBytes: 10,
        sha256: sha,
        meta: opts.meta ?? {},
      })
      .returning();
    const [ex] = await t.db
      .insert(docExtraction)
      .values({
        tenantId: shop.tenantId,
        documentId: d?.id ?? "",
        model: "test-model",
        header: {
          vendorName: "Vendor",
          invoiceNumber: opts.number,
          invoiceDate: opts.date ?? "2026-11-16",
          dueDate: opts.due === undefined ? "2026-11-26" : opts.due,
          poNumber: opts.po ?? null,
        },
        freight: opts.freight ?? "0",
        subtotal: sub.toFixed(2),
        total,
        linesSum: sub.toFixed(2),
        totalsMatch: true,
      })
      .returning();
    const lineIds: string[] = [];
    for (const [i, l] of lines.entries()) {
      const [dl] = await t.db
        .insert(docLine)
        .values({
          tenantId: shop.tenantId,
          extractionId: ex?.id ?? "",
          lineNo: i + 1,
          rawDescription: l.description,
          qty: l.qty,
          uomRaw: l.uom ?? null,
          unitPrice: l.unitPrice,
          extPrice: (Number(l.qty) * Number(l.unitPrice)).toFixed(2),
        })
        .returning();
      lineIds.push(dl?.id ?? "");
      if (l.item) {
        await t.db.insert(itemMatch).values({
          tenantId: shop.tenantId,
          docLineId: dl?.id ?? "",
          catalogItemId: l.item,
          decision: "matched",
          confidence: "1",
          method: "alias",
          agentVersionId: shop.agentVersionId,
        });
      }
    }
    return { documentId: d?.id ?? "", transactionId: txn?.id ?? "", lineIds };
  }

  /** An order placed with a vendor: a request, a received quote, its lines, the order's id. */
  async function order(
    shop: ShopFixture,
    vendorId: string,
    lines: {
      description: string;
      qty: string;
      unit: string | null;
      unitPrice: string;
      item?: string;
    }[],
    externalId: string,
  ): Promise<{ requestId: string; lineIds: string[] }> {
    const [r] = await t.db
      .insert(purchaseRequest)
      .values({
        tenantId: shop.tenantId,
        channel: "portal",
        status: "ordered",
        orderConnector: "qbo",
        orderExternalId: externalId,
        orderedAt: new Date("2026-11-02T15:00:00Z"),
      })
      .returning();
    const [q] = await t.db
      .insert(quoteRequest)
      .values({
        tenantId: shop.tenantId,
        purchaseRequestId: r?.id ?? "",
        vendorId,
        status: "received",
        receivedAt: new Date("2026-11-01T15:00:00Z"),
      })
      .returning();
    const lineIds: string[] = [];
    for (const [i, l] of lines.entries()) {
      const [rl] = await t.db
        .insert(purchaseRequestLine)
        .values({
          tenantId: shop.tenantId,
          purchaseRequestId: r?.id ?? "",
          lineNo: i + 1,
          description: l.description,
          qty: l.qty,
          unit: l.unit,
          catalogItemId: l.item ?? null,
          ...(l.item ? { matchMethod: "chosen" as const, matchConfidence: "1" } : {}),
        })
        .returning();
      await t.db.insert(quoteLine).values({
        tenantId: shop.tenantId,
        quoteRequestId: q?.id ?? "",
        purchaseRequestLineId: rl?.id ?? "",
        qty: l.qty,
        unit: l.unit,
        unitPrice: l.unitPrice,
      });
      lineIds.push(rl?.id ?? "");
    }
    return { requestId: r?.id ?? "", lineIds };
  }

  const prepare = (shop: ShopFixture, documentId: string, mode: "live" | "test" = "live") =>
    prepareTool.run({ documentId }, tools(shop, mode)) as Promise<{
      status: string;
      billId: string;
      matchStatus: string;
      ready: boolean;
      uncoded: number;
      summary: string;
      sources: string[];
    }>;
  const view = (shop: ShopFixture, billId: string) =>
    withTenant(db, shop.tenantId, (tx) => billView(tx, shop.tenantId, billId));
  const kinds = (flags: ApFlag[]) => flags.map((f) => f.kind).sort();

  let sheet: string;
  let matched: {
    billId: string;
    documentId: string;
    order: { requestId: string; lineIds: string[] };
  };

  it("matches a bill to its order by PO number and checks each line against it", async () => {
    const [item] = await t.db
      .insert(catalogItem)
      .values({
        tenantId: A.tenantId,
        category: "sheet_goods",
        canonicalName: "Baltic birch 3/4",
        standardUom: "sheet",
      })
      .returning();
    sheet = item?.id ?? "";
    const o = await order(
      A,
      northline,
      [
        { description: "Baltic birch 3/4", qty: "10", unit: "sheet", unitPrice: "60", item: sheet },
        { description: "Edge banding", qty: "2", unit: "roll", unitPrice: "40" },
      ],
      "PO-1A2B3C4D",
    );
    const inv = await bill(
      A,
      northline,
      [
        // 5% above the order's price, more than the 2% tolerance.
        {
          description: "3/4 BB/BB BALTIC BIRCH",
          qty: "10",
          uom: "sheet",
          unitPrice: "63",
          item: sheet,
        },
      ],
      { number: "INV-20418", po: "PO-1A2B3C4D", freight: "25" },
    );
    const r = await prepare(A, inv.documentId);
    expect(r).toMatchObject({ status: "prepared", matchStatus: "partial", ready: false });
    const v = await view(A, r.billId);
    expect(v.order?.id).toBe(o.requestId);
    expect(v.lines.map((l) => [l.description, l.amount, l.orderLineId])).toEqual([
      ["3/4 BB/BB BALTIC BIRCH", "630.0000", o.lineIds[0]],
      ["Freight", "25.0000", null],
    ]);
    expect(kinds(v.flags)).toEqual(
      ["amount_differs", "not_received", "price_over_order", "uncoded"].sort(),
    );
    const price = v.flags.find((f) => f.kind === "price_over_order");
    expect(price).toMatchObject({ severity: "block", lineNo: 1, impact: "30.0000" });
    expect(price?.sources).toEqual([inv.lineIds[0], o.lineIds[0]]);
    // Evidence: the bill rests on its document, reading, purchase and order.
    expect(r.sources).toEqual(
      expect.arrayContaining([inv.documentId, inv.transactionId, o.requestId]),
    );
    matched = { billId: r.billId, documentId: inv.documentId, order: o };
  });

  it("never compares a price billed in another unit than its order's", async () => {
    const o = await order(
      A,
      baltic,
      [{ description: "Oak", qty: "1", unit: "mbf", unitPrice: "4850" }],
      "PO-99990000",
    );
    const inv = await bill(
      A,
      baltic,
      [{ description: "4/4 RED OAK", qty: "1000", uom: "bf", unitPrice: "4.85" }],
      { number: "B-77", po: "PO-99990000" },
    );
    const r = await prepare(A, inv.documentId);
    const v = await view(A, r.billId);
    expect(v.order?.id).toBe(o.requestId);
    expect(v.matchStatus).toBe("matched");
    const flags = kinds(v.flags);
    expect(flags).toContain("unit_not_compared");
    expect(flags).not.toContain("price_over_order");
    expect(flags).not.toContain("qty_over_order");
  });

  it("never takes an order whose PO number differs, however alike", async () => {
    const atlas = await A.vendor("Atlas Hardware");
    await order(
      A,
      atlas,
      [{ description: "Hinges", qty: "10", unit: "each", unitPrice: "8.85" }],
      "PO-77770001",
    );
    const inv = await bill(
      A,
      atlas,
      [{ description: "Hinges", qty: "10", uom: "each", unitPrice: "8.85" }],
      {
        number: "AH-1",
        po: "PO-77770000",
      },
    );
    const r = await prepare(A, inv.documentId);
    expect(r.matchStatus).toBe("none");
    expect(kinds((await view(A, r.billId)).flags)).toContain("no_order");
  });

  it("flags the same invoice twice, and the same amount days apart", async () => {
    const again = await bill(
      A,
      northline,
      [
        {
          description: "3/4 BB/BB BALTIC BIRCH",
          qty: "10",
          uom: "sheet",
          unitPrice: "63",
          item: sheet,
        },
      ],
      { number: "inv 20418", po: "PO-1A2B3C4D", freight: "25" },
    );
    const r = await prepare(A, again.documentId);
    const v = await view(A, r.billId);
    const dup = v.flags.find((f) => f.kind === "duplicate");
    expect(dup).toMatchObject({ severity: "block" });
    expect(dup?.sources).toContain(matched.billId);
    // Both bills billed ten sheets of a ten-sheet order line: twenty billed.
    expect(kinds(v.flags)).toContain("qty_over_order");

    const near = await bill(
      A,
      northline,
      [{ description: "Misc", qty: "1", uom: null, unitPrice: "655" }],
      { number: "INV-20999", date: "2026-11-20" },
    );
    const n = await view(A, (await prepare(A, near.documentId)).billId);
    expect(kinds(n.flags)).toContain("possible_duplicate");
  });

  it("codes from the vendor's history only when it is unanimous; a model only suggests", async () => {
    const pine = await A.vendor("Pine Co");
    await A.qboBill({
      id: "501",
      vendorId: pine,
      date: "2026-10-01",
      lines: [{ id: "1", account: "80", amount: 120 }],
    });
    const inv = await bill(
      A,
      pine,
      [{ description: "Pine 1x4", qty: "4", uom: "each", unitPrice: "3" }],
      {
        number: "P-1",
      },
    );
    const r = await prepare(A, inv.documentId);
    expect(r.uncoded).toBe(0);
    const v = await view(A, r.billId);
    expect(v.lines[0]).toMatchObject({ account: { id: materialsAccount }, codedBy: "history" });

    // Northline has no history: its lines stay uncoded, and a suggestion doesn't code them.
    const s = (await proposeCodingTool.run(
      {
        billId: matched.billId,
        proposals: [
          { lineNo: 1, ledgerAccountId: materialsAccount, reason: "Plywood is a material" },
          { lineNo: 2, ledgerAccountId: freightAccount, reason: "Freight line" },
        ],
      },
      tools(A),
    )) as { proposed: number };
    expect(s.proposed).toBe(2);
    const m = await view(A, matched.billId);
    expect(m.lines.map((l) => [l.account, l.proposal?.account.id])).toEqual([
      [null, materialsAccount],
      [null, freightAccount],
    ]);
    // Another client's account is refused.
    await expect(
      proposeCodingTool.run(
        {
          billId: matched.billId,
          proposals: [{ lineNo: 1, ledgerAccountId: B.agentVersionId, reason: "x" }],
        },
        tools(A),
      ),
    ).rejects.toThrow(/isn't one of the client's accounts/);
  });

  it("keeps nothing in a test run", async () => {
    const inv = await bill(
      A,
      baltic,
      [{ description: "Glue", qty: "2", uom: "each", unitPrice: "9" }],
      {
        number: "T-1",
      },
    );
    const r = await prepare(A, inv.documentId, "test");
    expect(r.status).toBe("prepared");
    const rows = await t.db.select().from(apBill).where(eq(apBill.documentId, inv.documentId));
    expect(rows).toEqual([]);
    const w = (await payListTool.run({}, tools(A, "test"))) as { count: number };
    expect(w.count).toBeGreaterThan(0);
    const listed = await t.db
      .select({ week: apBill.payWeek })
      .from(apBill)
      .where(eq(apBill.tenantId, A.tenantId));
    expect(listed.every((x) => x.week === null)).toBe(true);
  });

  let week: string;

  it("puts the due bills on the week's list and pays nothing", async () => {
    // A bill due far later stays off this week's list.
    const later = await bill(
      A,
      baltic,
      [{ description: "Clamps", qty: "1", uom: "each", unitPrice: "50" }],
      {
        number: "L-1",
        due: "2027-03-01",
      },
    );
    const laterBill = (await prepare(A, later.documentId)).billId;
    const r = (await payListTool.run({}, tools(A))) as {
      week: string;
      payDay: string;
      count: number;
      billIds: string[];
      summary: string;
    };
    week = r.week;
    expect(new Date(`${r.payDay}T00:00:00Z`).getUTCDay()).toBe(5);
    expect(r.billIds).toContain(matched.billId);
    expect(r.billIds).not.toContain(laterBill);
    expect(r.summary).toMatch(/bills to approve for/);
    // Run again: nothing moves.
    const again = (await payListTool.run({}, tools(A))) as { added: number; count: number };
    expect(again).toMatchObject({ added: 0, count: r.count });
  });

  const decide = (
    shop: ShopFixture,
    decision: { action: string; input: Record<string, unknown> },
  ) =>
    card.decide(db, {
      tenantId: shop.tenantId,
      userId: shop.userId,
      payload: { review: AP_PAY_LIST_REVIEW, week },
      decision,
      testRun: false,
    });

  it("approves the ready bills together, a flagged one only with a note", async () => {
    const before = await withTenant(db, A.tenantId, (tx) => card.load(tx, A.tenantId, { week }));
    const list = before.list as { bills: { id: string; ready: boolean; status: string }[] };
    const ready = list.bills.filter((b) => b.ready).map((b) => b.id);
    expect(ready.length).toBeGreaterThan(0);
    expect(list.bills.find((b) => b.id === matched.billId)?.ready).toBe(false);
    await decide(A, { action: "approve_ready", input: {} });
    const rows = await t.db.select().from(apBill).where(eq(apBill.tenantId, A.tenantId));
    for (const id of ready) {
      expect(rows.find((r) => r.id === id)).toMatchObject({
        status: "approved",
        decidedBy: A.userId,
      });
    }
    expect(rows.find((r) => r.id === matched.billId)?.status).toBe("open");
    // The flagged bill: refused without a note.
    await expect(
      decide(A, { action: "approve", input: { billId: matched.billId } }),
    ).rejects.toThrow(/say why it is approved anyway/);
  });

  it("lets a person code a line, take a suggestion and mark the order received", async () => {
    const v = await view(A, matched.billId);
    await decide(A, { action: "take_proposal", input: { billLineId: v.lines[0]?.id } });
    await decide(A, {
      action: "code_line",
      input: { billLineId: v.lines[1]?.id, ledgerAccountId: freightAccount },
    });
    const coded = await t.db
      .select()
      .from(apBillLine)
      .where(eq(apBillLine.apBillId, matched.billId));
    expect(coded.map((l) => [l.ledgerAccountId, l.codedBy, l.codedByUserId]).sort()).toEqual(
      [
        [materialsAccount, "person", A.userId],
        [freightAccount, "person", A.userId],
      ].sort(),
    );
    await decide(A, { action: "received", input: { billId: matched.billId } });
    const receipts = await t.db
      .select()
      .from(apReceipt)
      .where(eq(apReceipt.purchaseRequestId, matched.order.requestId));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ recordedByUserId: A.userId, purchaseRequestLineId: null });
    const after = await view(A, matched.billId);
    expect(kinds(after.flags)).not.toContain("uncoded");
    expect(kinds(after.flags)).not.toContain("not_received");
    // The price is still above the order: approved with a note, by the person.
    await decide(A, {
      action: "approve",
      input: { billId: matched.billId, note: "Northline's new price list, agreed by phone" },
    });
    const [row] = await t.db.select().from(apBill).where(eq(apBill.id, matched.billId));
    expect(row).toMatchObject({
      status: "approved",
      decisionNote: "Northline's new price list, agreed by phone",
    });
    // Approved is final.
    await expect(
      decide(A, { action: "reject", input: { billId: matched.billId, note: "no" } }),
    ).rejects.toThrow(/already approved/);
  });

  it("records a line's receipt by an agent and checks bills against it", async () => {
    const o = await order(
      A,
      baltic,
      [{ description: "Screws", qty: "100", unit: "each", unitPrice: "0.10" }],
      "PO-31310000",
    );
    await receiptTool.run(
      {
        purchaseRequestId: o.requestId,
        lines: [{ purchaseRequestLineId: o.lineIds[0], qty: "60" }],
        receivedOn: "2026-11-18",
      },
      tools(A),
    );
    const inv = await bill(
      A,
      baltic,
      [{ description: "Screws", qty: "100", uom: "each", unitPrice: "0.10" }],
      {
        number: "S-1",
        po: "PO-31310000",
      },
    );
    const v = await view(A, (await prepare(A, inv.documentId)).billId);
    const over = v.flags.find((f) => f.kind === "qty_over_received");
    expect(over).toMatchObject({ severity: "block", impact: "4.0000" });
  });

  it("holds and rejects only with a reason", async () => {
    const inv = await bill(
      A,
      baltic,
      [{ description: "Tape", qty: "3", uom: "each", unitPrice: "4" }],
      {
        number: "H-1",
      },
    );
    const id = (await prepare(A, inv.documentId)).billId;
    await payListTool.run({}, tools(A));
    await expect(decide(A, { action: "hold", input: { billId: id, note: "" } })).rejects.toThrow();
    await decide(A, { action: "hold", input: { billId: id, note: "Waiting on a credit" } });
    const [held] = await t.db.select().from(apBill).where(eq(apBill.id, id));
    expect(held).toMatchObject({ status: "held", decisionNote: "Waiting on a credit" });
    await decide(A, { action: "reject", input: { billId: id, note: "Credit came" } });
    const [rejected] = await t.db.select().from(apBill).where(eq(apBill.id, id));
    expect(rejected?.status).toBe("rejected");
  });

  it("reports the week for the portal, one client's, with no agent or cost", async () => {
    const today = "2026-11-22";
    const r = await withTenant(db, A.tenantId, (tx) =>
      report.json(tx, A.tenantId, today, { week }),
    );
    const json = JSON.stringify(r);
    expect(json).not.toMatch(/agentVersionId|instructions|costUsd|bundle/);
    expect((r.list as { count: number }).count).toBeGreaterThan(0);
    const csv = await withTenant(db, A.tenantId, (tx) =>
      report.csv(tx, A.tenantId, today, { week }),
    );
    expect(csv.split("\n")[0]).toMatch(/^pay_day,vendor,invoice/);
    // B sees nothing of A's: not its list, not its bill.
    const b = await withTenant(db, B.tenantId, (tx) =>
      report.json(tx, B.tenantId, today, { week }),
    );
    expect((b.list as { count: number }).count).toBe(0);
    const item = await withTenant(db, B.tenantId, (tx) =>
      report.item(tx, B.tenantId, matched.billId),
    );
    expect(item).toBeNull();
    await expect(getTool.run({ billId: matched.billId }, tools(B))).rejects.toThrow(/not found/);
    await expect(
      decide(B, { action: "approve", input: { billId: matched.billId, note: "x" } }),
    ).rejects.toThrow();
    // Nor prepares a bill from A's invoice.
    await expect(prepare(B, matched.documentId)).rejects.toThrow(/not found/);
  });

  it("leaves a decided bill as it is when prepared again", async () => {
    const r = await prepare(A, matched.documentId);
    expect(r).toMatchObject({ status: "decided", billId: matched.billId });
    const rows = await t.db.select().from(apBill).where(eq(apBill.documentId, matched.documentId));
    expect(rows).toHaveLength(1);
  });
});
