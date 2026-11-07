// The words a duplicate is found by (the invoice number on letters and digits) and the mark it
// carries (`document.meta.duplicateOf`). The database side runs end to end in apps/api's Bill clerk
// test: a saved-again copy is marked, emits no `document.extracted` and starts no run.
import { describe, expect, it } from "vitest";
import { duplicateOfMeta, invoiceKey } from "./duplicates";

describe("invoiceKey", () => {
  it("reads an invoice number on its letters and digits", () => {
    expect(invoiceKey("INV-20418")).toBe("INV20418");
    expect(invoiceKey("inv 20418")).toBe("INV20418");
    expect(invoiceKey("20418")).toBe("20418");
    expect(invoiceKey("")).toBe("");
    expect(invoiceKey(null)).toBe("");
  });
});

describe("duplicateOfMeta", () => {
  it("reads the mark, and nothing else as one", () => {
    const of = { documentId: "d1", filename: "northline-20418.pdf" };
    expect(duplicateOfMeta({ uploadedBy: "u1", duplicateOf: of })).toEqual(of);
    expect(duplicateOfMeta({ uploadedBy: "u1" })).toBeNull();
    expect(duplicateOfMeta({ duplicateOf: "d1" })).toBeNull();
    expect(duplicateOfMeta(null)).toBeNull();
  });
});
