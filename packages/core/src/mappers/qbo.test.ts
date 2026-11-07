import { describe, expect, it } from "vitest";
import cdc from "../../../../fixtures/qbo/cdc.json";
import attachables from "../../../../fixtures/qbo/query-attachable.json";
import bills from "../../../../fixtures/qbo/query-bill.json";
import invoices from "../../../../fixtures/qbo/query-invoice.json";
import purchases from "../../../../fixtures/qbo/query-purchase.json";
import vendors from "../../../../fixtures/qbo/query-vendor.json";
import credits from "../../../../fixtures/qbo/query-vendorcredit.json";
import { dec } from "../money";
import {
  isVoidedQboInvoice,
  mapQboAttachable,
  mapQboInvoice,
  mapQboTransaction,
  mapQboVendor,
  qboAmount,
  qboTransactionExternalId,
} from "./qbo";
import { MapperError } from "./upload";

const bill = (id: string) => bills.QueryResponse.Bill.find((b) => b.Id === id);
const purchase = (id: string) => purchases.QueryResponse.Purchase.find((p) => p.Id === id);

describe("qboAmount", () => {
  it("reads JSON numbers as their decimal text, never as float arithmetic", () => {
    expect(qboAmount(214.6)).toBe("214.6000");
    expect(qboAmount(1352.75)).toBe("1352.7500");
    expect(qboAmount(130)).toBe("130.0000");
    expect(qboAmount("8.75")).toBe("8.7500");
    expect(qboAmount(-32)).toBe("-32.0000");
    // A unit price with more places than money is rounded half up to numeric(14,4).
    expect(qboAmount(1.23456)).toBe("1.2346");
  });

  it("refuses what is not an amount", () => {
    expect(() => qboAmount(Number.NaN)).toThrow(MapperError);
    expect(() => qboAmount("12,50")).toThrow(MapperError);
    expect(() => qboAmount(null)).toThrow(MapperError);
  });
});

describe("mapQboTransaction", () => {
  it("maps a bill with one account line", () => {
    const t = mapQboTransaction("Bill", bill("145"));
    expect(t).toMatchObject({
      kind: "bill",
      connector: "qbo",
      externalId: "Bill:145",
      vendorName: "Northwest Plywood Supply",
      vendorExternalId: "56",
      txnDate: "2026-10-28",
      total: "1352.7500",
      currency: "USD",
      memo: "Sheet goods for Henderson kitchen",
      purchaserRef: null,
      paymentType: null,
      ext: { qbo: { entity: "Bill", id: "145", syncToken: "0", docNumber: "INV-20931" } },
    });
    expect(t.lines).toEqual([
      {
        lineNo: 1,
        detailType: "account",
        externalLineId: "1",
        accountRef: "Job Materials",
        accountId: "80",
        itemRef: null,
        itemId: null,
        description: "Northwest Plywood invoice INV-20931",
        qty: null,
        unitPrice: null,
        amount: "1352.7500",
      },
    ]);
  });

  it("maps both line detail types, and the lines add up to the total in decimal", () => {
    const t = mapQboTransaction("Bill", bill("146"));
    expect(
      t.lines?.map((l) => [l.detailType, l.itemRef ?? l.accountRef, l.qty, l.unitPrice, l.amount]),
    ).toEqual([
      ["item", "White oak 4/4 FAS", "95.0000", "8.7500", "831.2500"],
      ["account", "Freight In", null, null, "130.0000"],
    ]);
    const sum = (t.lines ?? []).reduce((s, l) => s.plus(dec(l.amount)), dec("0"));
    expect(sum.equals(dec(t.total))).toBe(true);
    expect(
      dec(t.lines?.[0]?.qty ?? "0")
        .times(dec(t.lines?.[0]?.unitPrice ?? "0"))
        .toFixed(4),
    ).toBe(t.lines?.[0]?.amount);
  });

  it("maps card and check purchases, and a card refund as a vendor credit", () => {
    expect(mapQboTransaction("Purchase", purchase("201"))).toMatchObject({
      kind: "purchase",
      externalId: "Purchase:201",
      vendorName: "Pacific Hardware & Finishes",
      total: "214.6000",
      paymentType: "CreditCard",
      purchaserRef: "Chase Ink 4421",
    });
    expect(mapQboTransaction("Purchase", purchase("202"))).toMatchObject({
      kind: "purchase",
      paymentType: "Check",
      total: "48.1000",
    });
    expect(mapQboTransaction("Purchase", purchase("203"))).toMatchObject({
      kind: "vendor_credit",
      total: "32.0000",
      memo: "Returned 10 hinges",
    });
  });

  it("maps a vendor credit", () => {
    const t = mapQboTransaction("VendorCredit", credits.QueryResponse.VendorCredit[0]);
    expect(t).toMatchObject({
      kind: "vendor_credit",
      externalId: "VendorCredit:301",
      vendorName: "Cascade Hardwoods",
      total: "45.0000",
    });
  });

  it("maps the CDC's new bill, and gives no vendor for a payee that isn't one", () => {
    const first = cdc.CDCResponse[0]?.QueryResponse[0] as { Bill: unknown[] };
    expect(mapQboTransaction("Bill", first.Bill[0])).toMatchObject({
      externalId: "Bill:147",
      total: "704.0000",
    });
    const paidToEmployee = {
      ...purchase("201"),
      EntityRef: { value: "9", name: "Ana Ruiz", type: "Employee" },
    };
    expect(mapQboTransaction("Purchase", paidToEmployee).vendorName).toBeNull();
  });

  it("refuses other entity types and broken payloads", () => {
    expect(() => mapQboTransaction("Invoice", bill("145"))).toThrow(MapperError);
    expect(() => mapQboTransaction("Bill", { Id: "1" })).toThrow(MapperError);
    expect(() =>
      mapQboTransaction("Bill", { ...bill("145"), CurrencyRef: { value: "dollars" } }),
    ).toThrow(MapperError);
  });

  it("names transactions per entity type", () => {
    expect(qboTransactionExternalId("Purchase", "145")).not.toBe(
      qboTransactionExternalId("Bill", "145"),
    );
  });
});

describe("mapQboVendor and mapQboAttachable", () => {
  it("maps a vendor with its other names as aliases", () => {
    expect(mapQboVendor(vendors.QueryResponse.Vendor[0])).toEqual({
      externalId: "56",
      name: "Northwest Plywood Supply",
      aliases: ["Northwest Plywood Supply, Inc.", "Northwest Plywood Supply Inc"],
      active: true,
      email: "ar@nwplywood.example",
    });
    expect(mapQboVendor(vendors.QueryResponse.Vendor[2]).aliases).toEqual([]);
  });

  it("maps a file attachment and a note", () => {
    const [file, note] = attachables.QueryResponse.Attachable;
    expect(mapQboAttachable(file)).toEqual({
      externalId: "5000000000000401",
      fileName: "cascade-77812.pdf",
      contentType: "application/pdf",
      size: 1180,
      note: null,
      refs: [{ entity: "Bill", id: "146" }],
    });
    expect(mapQboAttachable(note)).toMatchObject({
      fileName: null,
      note: "Paper receipt lost; card statement only",
      refs: [{ entity: "Purchase", id: "201" }],
    });
  });
});

describe("mapQboInvoice (accounts receivable, v0.12)", () => {
  const invoice = (id: string) => invoices.QueryResponse.Invoice.find((i) => i.Id === id);

  it("maps an open invoice with its customer, dates, total and balance in decimal", () => {
    expect(mapQboInvoice(invoice("130"))).toMatchObject({
      connector: "qbo",
      externalId: "130",
      docNumber: "1041",
      customerExternalId: "8",
      customerName: "Lakeside Builders",
      txnDate: "2026-07-15",
      dueDate: "2026-08-14",
      total: "5100.0000",
      balance: "5100.0000",
      currency: "USD",
      status: "open",
      privateNote: null,
    });
  });

  it("reads a zero balance as paid and a voided invoice as void", () => {
    expect(mapQboInvoice(invoice("131"))).toMatchObject({ balance: "0.0000", status: "paid" });
    expect(mapQboInvoice(invoice("134"))).toMatchObject({ status: "void" });
    expect(isVoidedQboInvoice({ TotalAmt: 0, Balance: 0, PrivateNote: "Paid in cash" })).toBe(
      false,
    );
  });

  it("refuses what is not an invoice", () => {
    expect(() => mapQboInvoice({ Id: "1", TotalAmt: 5 })).toThrow(MapperError);
  });
});
