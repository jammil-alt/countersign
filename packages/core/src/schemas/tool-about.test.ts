// What a tool's output is about (docs/plan.md §1.188): the declaration, read over an output, with
// its labels kept as plain data and its kinds from a change's entity.

import { describe, expect, it } from "vitest";
import { ToolSpec } from "./tool";
import { aboutOf, subjectKindOfEntity, subjectText, ToolAbout, ToolAboutEntry } from "./tool-about";

const REQ = "11111111-1111-4111-8111-111111111111";
const VENDOR = "22222222-2222-4222-8222-222222222222";

describe("a tool's about", () => {
  it("is declared on a tool spec and names its record by id, label or number", () => {
    const spec = ToolSpec.parse({
      id: "materials.po.document",
      description: "A PO",
      input: {},
      output: {},
      sideEffect: "internal",
      verb: "create",
      source: "materials",
      about: [{ kind: "document", id: "documentId", number: "reference" }],
    });
    expect(spec.about?.[0]?.kind).toBe("document");
    expect(ToolAboutEntry.safeParse({ kind: "vendor" }).success).toBe(false);
    expect(ToolAboutEntry.safeParse({ kind: "invoice", id: "id" }).success).toBe(false);
    expect(ToolAboutEntry.safeParse({ kind: "vendor", id: "a..b" }).success).toBe(false);
    expect(ToolAbout.safeParse([]).success).toBe(false);
  });

  it("reads each record the output names, with its role, number and money", () => {
    const spec = {
      sideEffect: "internal" as const,
      about: ToolAbout.parse([
        { kind: "record", id: "request.id" },
        { kind: "vendor", each: "quotes", id: "vendorId", label: "vendorName" },
        {
          kind: "document",
          number: "reference",
          amount: { path: "total", currencyPath: "currency" },
          role: "decided",
        },
      ]),
    };
    const out = aboutOf(spec, {
      request: { id: REQ.toUpperCase() },
      quotes: [
        { vendorId: VENDOR, vendorName: "Acme Supply" },
        { vendorId: "not-an-id", vendorName: "Northline" },
        { vendorId: null, vendorName: null },
      ],
      reference: "PO-1032",
      total: "1250.5",
      currency: "usd",
    });
    expect(out).toEqual([
      expect.objectContaining({ kind: "record", role: "changed", recordId: REQ, label: null }),
      expect.objectContaining({ kind: "vendor", recordId: VENDOR, label: "Acme Supply" }),
      // An id that isn't one of ours is left off; its name is kept.
      expect.objectContaining({ kind: "vendor", recordId: null, label: "Northline" }),
      expect.objectContaining({
        kind: "document",
        role: "decided",
        number: "PO-1032",
        amount: { value: "1250.5", currency: "USD" },
      }),
    ]);
    // A read tool's records were read.
    expect(aboutOf({ ...spec, sideEffect: "none" }, { request: { id: REQ } })[0]?.role).toBe(
      "read",
    );
    expect(aboutOf({ sideEffect: "none" }, { request: { id: REQ } })).toEqual([]);
  });

  it("keeps a label as one plain line, cut short, with card numbers redacted", () => {
    expect(subjectText("  Acme\n\tSupply\u0000 Co  ")).toBe("Acme Supply Co");
    expect(subjectText("Paid with 4111 1111 1111 1111")).toBe("Paid with [card ending 1111]");
    expect(subjectText("x".repeat(300))).toHaveLength(200);
    expect(subjectText({ name: "Dana Ruiz" })).toBe("Dana Ruiz");
    expect(subjectText(20418)).toBe("20418");
    expect(subjectText("   ")).toBeNull();
    expect(subjectText(["a"])).toBeNull();
  });

  it("places a change's entity among the kinds, and what it can't as a record", () => {
    expect(subjectKindOfEntity("bill")).toBe("transaction");
    expect(subjectKindOfEntity("vendor_credit")).toBe("transaction");
    expect(subjectKindOfEntity("purchase_order")).toBe("transaction");
    expect(subjectKindOfEntity("vendor")).toBe("vendor");
    expect(subjectKindOfEntity("customer")).toBe("customer");
    expect(subjectKindOfEntity("contact")).toBe("person");
    expect(subjectKindOfEntity("email")).toBe("message");
    expect(subjectKindOfEntity("file")).toBe("document");
    expect(subjectKindOfEntity("item")).toBe("item");
    expect(subjectKindOfEntity("account")).toBe("record");
    expect(subjectKindOfEntity(undefined)).toBe("record");
  });
});
