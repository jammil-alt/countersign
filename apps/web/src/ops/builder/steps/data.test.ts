import { describe, expect, it } from "vitest";
import { changed, comingIn, goingOut, sampleFields, sampleFor, valueAt } from "./data";
import { ensureEnd, insertStep, newStep, ROOT } from "./model";
import { indexCatalog, NO_USES_CONTEXT, type UsesContext } from "./options";
import type { DoStep, Field, Workflow } from "./types";

const uses: UsesContext = {
  ...NO_USES_CONTEXT,
  actions: indexCatalog([
    {
      type: "connector",
      id: "qbo",
      name: "QuickBooks",
      actions: [
        {
          id: "qbo.bill.create",
          label: "Create bill",
          description: "",
          kind: "change",
          input: [{ name: "vendorId", type: "text", required: true }],
          output: [{ name: "billId", type: "text", required: true }],
        },
      ],
    },
  ]),
};

describe("sample data", () => {
  it("makes a value of each type", () => {
    const f = (type: Field["type"], more: Partial<Field> = {}): Field => ({
      name: "x",
      type,
      required: false,
      ...more,
    });
    expect(sampleFor(f("number"))).toBe(12);
    expect(sampleFor(f("money"))).toBe("125.00");
    expect(sampleFor(f("yes_no"))).toBe(true);
    expect(sampleFor(f("record", { record: "vendor" }))).toBe("vendor id");
    expect(sampleFor(f("list", { of: [f("text", { name: "sku" })] }))).toEqual([
      { sku: "Sample text" },
    ]);
    expect(
      sampleFields([f("group", { name: "header", of: [f("date", { name: "due" })] })]),
    ).toEqual({ header: { due: "2026-01-15" } });
    expect(valueAt({ header: { due: 1 } }, ["header", "due"])).toBe(1);
  });
});

describe("a step's data", () => {
  const first = {
    ...(newStep("do", () => "a") as DoStep),
    name: "Make bill",
    doneBy: "rules" as const,
    uses: { type: "action" as const, action: "qbo.bill.create" },
  };
  const second = {
    ...(newStep("do", () => "b") as DoStep),
    name: "Tell",
    input: { id: "{{steps.a.output.billId}}", note: "fixed", who: "{{trigger.name}}" },
  };
  const wf = ensureEnd(
    insertStep(
      insertStep(
        { schemaVersion: 5, triggers: [], outputs: [], steps: [] } as unknown as Workflow,
        { container: ROOT, index: 0 },
        first,
      ),
      { container: ROOT, index: 1 },
      second,
    ),
  );

  it("resolves references from sample data, keeps fixed values", () => {
    const r = comingIn(second, wf, uses, {}, undefined, [
      { name: "name", type: "text", required: false },
    ]);
    expect(r.value).toEqual({ id: "Sample text", note: "fixed", who: "Sample text" });
    expect(r.sample).toBe(true);
  });

  it("prefers the last test run", () => {
    const runs = { a: { output: { billId: "B-1" } } };
    const r = comingIn(second, wf, uses, runs);
    expect((r.value as Record<string, unknown>).id).toBe("B-1");
    expect(goingOut(first, uses, runs)).toEqual({ value: { billId: "B-1" }, sample: false });
    expect(goingOut(first, uses).value).toEqual({ billId: "Sample text" });
    expect(comingIn(second, wf, uses, { b: { input: { z: 1 } } }).value).toEqual({ z: 1 });
  });

  it("says what the step did", () => {
    expect(changed(first, uses).did).toBe("Changes the client's tool: QuickBooks › Create bill.");
    expect(changed(second, uses).translated).toEqual([]);
  });
});
