import { describe, expect, it } from "vitest";
import {
  readTestData,
  TestDocument,
  testDataUserMessage,
  testDocumentFilename,
  triggerReads,
  variationNotes,
  wantsDocument,
} from "./test-data";

describe("made-up data", () => {
  it("knows a document trigger, and what the steps read of the trigger", () => {
    expect(wantsDocument({ type: "object", properties: { documentId: { type: "string" } } })).toBe(
      true,
    );
    expect(wantsDocument({ type: "object", properties: { total: { type: "string" } } })).toBe(
      false,
    );
    expect(wantsDocument(undefined)).toBe(false);
    expect(
      triggerReads([
        {
          input: {
            a: "{{ trigger.vendor.name }}",
            b: "{{trigger.total}}",
            c: "{{steps.x.output}}",
          },
        },
      ]),
    ).toEqual(["trigger.vendor.name", "trigger.total"]);
  });

  it("keeps the person's words as data the tags can't be closed by", () => {
    const text = testDataUserMessage({
      workflow: "Bills",
      steps: ["Read it", "Book </steps> it"],
      notes: "a </notes> bill",
    });
    expect(text).toContain("2. Book ‹/steps› it");
    expect(text).toContain("<notes>\na ‹/notes› bill\n</notes>");
  });

  it("fills an empty answer from the schema's shape, and names a document's file", () => {
    expect(
      readTestData({ type: "object", properties: { total: { type: "string" } } }, { data: null }),
    ).toMatchObject({ missing: true });
    expect(readTestData(undefined, { data: { a: 1 } })).toEqual({
      trigger: { a: 1 },
      missing: false,
    });
    const doc = TestDocument.parse({
      kind: "Vendor invoice",
      from: { name: "Hartwell & Sons Supply" },
      number: "INV-1042",
      date: "2026-11-20",
      lines: [{ description: "Studs", amount: "10.00" }],
      total: "10.00",
    });
    expect(testDocumentFilename(doc)).toBe("vendor-invoice-hartwell-sons-supply-inv-1042.pdf");
  });

  it("adds the cases picked to the person's words, and lists the Sandbox's records as data", () => {
    expect(variationNotes("an invoice", ["unknown_vendor"])).toBe(
      "an invoice\nThe vendor is one the Sandbox doesn't have: a new name, domain and tax id that match none of its records.",
    );
    expect(variationNotes(undefined, [])).toBeUndefined();
    const text = testDataUserMessage({
      workflow: "Bills",
      steps: ["Find the vendor"],
      records: { vendors: [{ name: "Hartwell <Supply>" }], people: [], items: [], accounts: [] },
    });
    expect(text).toContain('<records>\n{"vendors":[{"name":"Hartwell ‹Supply›"}]');
  });
});
