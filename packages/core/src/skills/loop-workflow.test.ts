// A saved Loop skill as a step, and as the whole workflow: a trigger, the Loop, then an End
// (docs/step-model-plan.md §8). The publish checks hold: a Loop only reads, and its End delivers a
// declared output.
import { describe, expect, it } from "vitest";
import { Workflow } from "../steps/schema";
import { validateWorkflow } from "../steps/validate";

const trigger = { id: "t1", on: { type: "manual", input: { type: "object", properties: {} } } };
const outputs = [
  {
    id: "o_report",
    name: "What it found",
    kind: "report",
    report: { to: [], message: "{{steps.s_loop.output.why}}" },
  },
];
const loop = {
  id: "s_loop",
  kind: "loop",
  name: "Look into the leftovers",
  skill: "custom:find-why",
  goal: "Say why the record is off.",
  reads: ["testkit.record.query"],
  maxTurns: 6,
  atLimit: "hand_back",
  output: [{ name: "why", type: "text", required: true }],
};
const end = { id: "s_end", kind: "end", name: "Report it", outputs: ["o_report"] };

const wf = (steps: unknown[]) =>
  Workflow.parse({ schemaVersion: 5, triggers: [trigger], outputs, steps });

describe("a saved Loop in a workflow", () => {
  it("is the whole workflow: trigger, the Loop, an End", () => {
    const w = wf([loop, end]);
    expect(w.steps.map((s) => s.kind)).toEqual(["loop", "end"]);
    const issues = validateWorkflow(w, { sideEffect: () => "none" });
    expect(issues.filter((i) => i.code.startsWith("loop"))).toEqual([]);
  });

  it("refuses a Loop that lists an action that changes something", () => {
    const issues = validateWorkflow(wf([loop, end]), {
      sideEffect: (a: string) => (a === "testkit.record.query" ? "external" : "none"),
    });
    expect(issues.map((i) => i.code)).toContain("loop_writes");
  });
});
