import { describe, expect, it } from "vitest";
import { ToolSpec } from "./tool";
import { ChangePath, changeValue, ToolDisplay } from "./tool-display";

const DISPLAY = {
  name: { en: "QuickBooks bill", es: "Factura de QuickBooks" },
  number: "before.docNumber",
  fields: [{ label: "Memo", kind: "text", now: "before.memo", after: "input.memo" }],
};

const write = {
  id: "qbo.bill.update_memo",
  description: "Set the memo of a QuickBooks bill.",
  input: {},
  output: {},
  sideEffect: "external",
  verb: "update",
  source: "qbo",
  connector: "qbo",
};

describe("tool display", () => {
  it("is declared on writes only, with paths into the before state or the input", () => {
    expect(ToolSpec.safeParse({ ...write, display: DISPLAY }).success).toBe(true);
    const read = { ...write, sideEffect: "none", verb: "read", display: DISPLAY };
    expect(ToolSpec.safeParse(read).success).toBe(false);
    expect(ChangePath.safeParse("before.vendor.name").success).toBe(true);
    expect(ChangePath.safeParse("output.total").success).toBe(false);
    expect(ChangePath.safeParse("before").success).toBe(false);
    expect(ToolDisplay.safeParse({ ...DISPLAY, fields: [] }).success).toBe(false);
    expect(
      ToolDisplay.safeParse({ ...DISPLAY, fields: [{ ...DISPLAY.fields[0], kind: "json" }] })
        .success,
    ).toBe(false);
  });

  it("reads a value at a path, and nothing past a missing or non-object step", () => {
    const change = { before: { vendor: { name: "Northline" }, lines: [1] }, input: { memo: "PO" } };
    expect(changeValue(change, "before.vendor.name")).toBe("Northline");
    expect(changeValue(change, "input.memo")).toBe("PO");
    expect(changeValue(change, "before.lines.length")).toBeUndefined();
    expect(changeValue(change, "before.missing.name")).toBeUndefined();
    expect(changeValue({ before: null, input: {} }, "before.total")).toBeUndefined();
    expect(changeValue(change, undefined)).toBeUndefined();
  });
});
