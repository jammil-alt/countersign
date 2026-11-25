// Translation between steps (docs/step-model-plan.md §6): the Builder AI fills what the rules left,
// once, every expression checked; applied without confirming.

import { steps } from "@countersign/core";
import { createLlmClient, FakeModel } from "@countersign/llm";
import { describe, expect, it } from "vitest";
import { RESHAPE_SUGGEST_TOOL } from "./reshape";
import { translateLeftovers } from "./translate";

const f = (name: string, type: steps.Field["type"], required = true): steps.Field => ({
  name,
  type,
  required,
});

const sources: steps.TranslateSource[] = [
  {
    ref: "steps.read.output",
    label: "Read the invoice",
    fields: [f("supplier", "text"), f("issued", "date"), f("terms", "text")],
  },
];
const needs = [f("vendorName", "text"), f("dueDate", "date"), f("memo", "text", false)];

describe("translateLeftovers", () => {
  it("asks once about what is left and applies what checks", async () => {
    const worked = steps.workOutTranslation({ needs, sources });
    expect(steps.unfilled(worked)).toEqual(["dueDate", "memo"]);
    const model = new FakeModel([
      {
        toolUse: {
          name: RESHAPE_SUGGEST_TOOL,
          input: {
            fields: [
              { name: "memo", expression: { input: "_read.terms" } },
              // Reads nothing the step can read: dropped, stays Doesn't fit.
              { name: "dueDate", expression: { input: "_read.nothing" } },
            ],
          },
        },
      },
    ]);
    const out = await translateLeftovers(
      { needs, sources, worked, stepName: "Create the bill" },
      { llm: createLlmClient({ transport: model }) },
    );
    expect(out.asked).toBe(true);
    expect(out.filled).toEqual(["memo"]);
    expect(out.dropped.map((d) => d.field)).toEqual(["dueDate"]);
    expect(out.worked.fields.map((x) => [x.name, x.state, x.how])).toEqual([
      ["vendorName", "translated", "synonym"],
      ["dueDate", "doesnt_fit", "none"],
      ["memo", "translated", "ai"],
    ]);
    expect(out.worked.input).toEqual({ _read: "{{steps.read.output}}" });
    expect(out.calls).toHaveLength(1);
  });

  it("asks nothing when every field has a source", async () => {
    const worked = steps.workOutTranslation({ needs: [f("supplier", "text")], sources });
    const model = new FakeModel([]);
    const out = await translateLeftovers(
      { needs: [f("supplier", "text")], sources, worked },
      { llm: createLlmClient({ transport: model }) },
    );
    expect(out.asked).toBe(false);
    expect(out.calls).toHaveLength(0);
  });
});
