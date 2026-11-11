// Reshape data (2026-11-11): the builder's offers and placements, with no screen.
import { processes, type SkillDefinition } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { addReshapeThenAction, exprText, inputsUnfilled, reshapeOffers } from "./reshape";

const io = (props: Record<string, unknown>) => ({ type: "object", properties: props });

const READ = {
  schemaVersion: 1,
  id: "docs.read-document",
  name: "Read document",
  description: "",
  category: "documents",
  mode: "task",
  model: { id: "claude-haiku-5-5" },
  tools: [],
  input: io({}),
  output: io({
    header: io({
      vendorName: { type: "string" },
      invoiceNumber: { type: "string" },
      invoiceDate: { type: "string" },
      currency: { type: "string" },
    }),
    lines: {
      type: "array",
      items: io({ description: { type: "string" }, extPrice: { type: "string" } }),
    },
    total: { type: "string" },
  }),
  settings: [],
  requiresConnectors: [],
  requiresPacks: [],
  producesAlerts: false,
} as SkillDefinition;

const ctx = { skills: { [READ.id]: READ } };

const process = processes.Process.parse({
  schemaVersion: 4,
  triggers: [{ id: "t", on: { type: "manual", input: io({}) } }],
  steps: [{ id: "read", kind: "skill", name: "Read document", skill: READ.id, input: {} }],
});

describe("the Reshape offers", () => {
  it("offers a Reshape step for a write the output fits only in part", () => {
    expect(processes.actionFits("read", READ.output)).toEqual([]);
    expect(reshapeOffers("read", READ.output)).toEqual([
      { action: "create_bill", mapped: 6, of: 9 },
    ]);
  });

  it("places the Reshape step and the write, the write wired to its output", () => {
    let n = 0;
    const r = addReshapeThenAction(process, "read", "create_bill", ctx, () => `s${++n}`);
    expect(r?.stepId).toBe("s1");
    const [, shape, bill] = r?.process.steps ?? [];
    expect(shape).toMatchObject({ id: "s1", skill: processes.RESHAPE_SKILL });
    expect(bill).toMatchObject({
      id: "s2",
      kind: "write",
      action: "create_bill",
      checks: { approval: { required: "required" } },
      input: {
        invoiceNumber: "{{steps.s1.output.invoiceNumber}}",
        total: "{{steps.s1.output.total}}",
      },
    });
    // It validates but for the vendor's id, the operator's to map (the Builder AI is asked next).
    const errors = processes.validateProcess(r?.process, ctx).errors;
    expect(errors.filter((e) => e.stepId === "s2")).toEqual([]);
    if (shape?.kind !== "skill") throw new Error("no Reshape step");
    const lines = shape.reshape?.fields.find((f) => f.name === "lines")?.from;
    expect(lines && exprText(lines)).toBe(
      "each of readDocument.lines: description ← item.description; amount ← item.extPrice",
    );
  });

  it("says a step's inputs are unfilled from its own input errors only", () => {
    const step = process.steps[0];
    if (!step) throw new Error("no step");
    expect(
      inputsUnfilled(step, [{ stepId: "read", field: "input.documentId", code: "input_missing" }]),
    ).toBe(true);
    expect(inputsUnfilled(step, [{ stepId: "read", field: "name", code: "input_missing" }])).toBe(
      false,
    );
  });
});
