// A draft's problems, grouped as the build and the workflow builder count them (BUILDER_QA CONS-6).
import { describe, expect, it } from "vitest";
import { groupProblems, problemGroupKey } from "./problems";

const order = (stepId: string, expr: string, after: string) => ({
  workflow: "main",
  stepId,
  code: "bad_reference",
  message: `{{${expr}}}: step "${after}" does not run before this one on its path`,
});

describe("groupProblems", () => {
  it("joins one step's references to the same later step, and nothing else", () => {
    const a = order("tell", "steps.ask.output.vendor", "ask");
    const b = order("tell", "steps.ask.output.total", "ask");
    const c = order("tell", "steps.check.output.total", "check");
    const d = order("other", "steps.ask.output.vendor", "ask");
    const e = { workflow: "main", stepId: "tell", code: "required", message: '"to" is required' };
    expect(groupProblems([a, e, b, c, d])).toEqual([[a, b], [e], [c], [d]]);
  });

  it("leaves a Reshape mapping's problem a line of its own", () => {
    const r = { ...order("tell", "steps.ask.output.vendor", "ask"), code: "reshape_mapping" };
    expect(problemGroupKey(r)).toBeNull();
  });
});
