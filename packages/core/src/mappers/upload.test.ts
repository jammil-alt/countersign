import { describe, expect, it } from "vitest";
import { z } from "zod";
import { InvoiceExtraction } from "../documents/extraction";
import {
  MapperError,
  mapUploadPurchase,
  missingPurchaseColumns,
  normalizeVendorName,
  parseCsvAmount,
  parseCsvDate,
} from "./upload";

const file = { sha256: "a".repeat(64), filename: "card.csv", row: 1 };

describe("mapUploadPurchase", () => {
  it("maps a purchase row to a transaction", () => {
    const t = mapUploadPurchase(
      {
        cells: {
          date: "11/02/2026",
          vendor: "Acme Lumber Co.",
          amount: "$1,250.40",
          memo: "Job 118",
          cardholder: "Dana",
        },
        file,
      },
      "x:1",
    );
    expect(t).toEqual({
      kind: "purchase",
      connector: "upload",
      externalId: "x:1",
      vendorName: "Acme Lumber Co.",
      txnDate: "2026-11-02",
      total: "1250.4000",
      currency: "USD",
      memo: "Job 118",
      purchaserRef: "Dana",
      paymentType: null,
    });
  });

  it("keeps a refund as a vendor credit with a positive total", () => {
    const t = mapUploadPurchase(
      { cells: { date: "2026-11-03", payee: "X", total: "(12.50)" }, file },
      "x:2",
    );
    expect(t.kind).toBe("vendor_credit");
    expect(t.total).toBe("12.5000");
  });

  it("refuses rows without a date or amount, and bad values", () => {
    expect(() => mapUploadPurchase({ cells: { vendor: "X", amount: "1" }, file }, "e")).toThrow(
      MapperError,
    );
    expect(() =>
      mapUploadPurchase({ cells: { date: "2026-11-03", vendor: "X" }, file }, "e"),
    ).toThrow(MapperError);
    expect(() => parseCsvDate("2026-02-30")).toThrow(MapperError);
    expect(() => parseCsvAmount("12.5.0")).toThrow(MapperError);
  });

  it("parses dates and amounts without floats", () => {
    expect(parseCsvDate("1/5/26")).toBe("2026-01-05");
    expect(parseCsvDate("2026/11/02")).toBe("2026-11-02");
    expect(parseCsvAmount("0.1")).toBe("0.1000");
    expect(parseCsvAmount("-$3.33")).toBe("-3.3300");
  });

  it("names the required columns a header row lacks", () => {
    expect(missingPurchaseColumns(["Date", "Payee", "Amount"])).toEqual([]);
    expect(missingPurchaseColumns(["Date", "Memo"])).toEqual(["vendor", "amount"]);
  });
});

describe("normalizeVendorName", () => {
  it("treats suffixes, case and punctuation as the same vendor", () => {
    expect(normalizeVendorName("Acme Lumber Co., Inc.")).toBe("acme lumber");
    expect(normalizeVendorName("ACME LUMBER")).toBe("acme lumber");
    expect(normalizeVendorName("Rockwood & Sons, LLC")).toBe("rockwood and sons");
  });
});

describe("InvoiceExtraction", () => {
  it("exports as a JSON Schema object for the forced tool", () => {
    const json = z.toJSONSchema(InvoiceExtraction, { io: "input" }) as { type: string };
    expect(json.type).toBe("object");
  });
});
