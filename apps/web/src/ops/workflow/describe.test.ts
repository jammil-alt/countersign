import type { processes } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { failureText } from "../screens/RunView";
import { fieldText, processStepDetail, rulesText, workflowStats } from "./describe";

const names = new Map([["0193-step", "Review the record"]]);

describe("rule and failure text", () => {
  it("names the step a rule's field comes from instead of its id", () => {
    expect(fieldText("{{steps.0193-step.output.needsFix}}", names)).toBe(
      "Review the record · needsFix",
    );
    expect(fieldText("{{steps.0193-step.output}}", names)).toBe("Review the record output");
    expect(fieldText("{{trigger.amount}}", names)).toBe("trigger · amount");
    // An unknown step keeps its path.
    expect(fieldText("{{steps.other.output.x}}", names)).toBe("steps.other.output.x");
    expect(
      rulesText(
        {
          match: "any",
          rules: [
            { field: "{{steps.0193-step.output.needsFix}}", op: "=", value: true },
            { field: "{{trigger.total}}", op: "exists" },
          ],
        },
        names,
      ),
    ).toBe("Review the record · needsFix = true or trigger · total exists");
  });

  it("says which step failed and why, not the stored JSON", () => {
    expect(failureText({ nodeId: "0193-step", reason: "no model is configured" }, names)).toBe(
      "Review the record failed: no model is configured",
    );
    expect(failureText({ nodeId: "loop:2:0193-step", reason: "x" }, names)).toBe(
      "Review the record failed: x",
    );
    expect(failureText({ message: "boom" }, names)).toBe("boom");
    expect(failureText({ other: 1 }, names)).toBe('{"other":1}');
    expect(failureText(null, names)).toBeNull();
  });
});

// Wave 3b (web): a v4 write with no approval check waits for the default approver (invariant 8).
describe("a v4 step's detail line", () => {
  const write = (checks?: processes.Checks): processes.Step => ({
    id: "w",
    kind: "write",
    name: "Update the bill",
    tool: "qbo.bill.update",
    input: {},
    ...(checks ? { checks } : {}),
  });
  const approval = (required: "required" | "not_required"): processes.Checks => ({
    approval: { required, mode: "in_turn", ifNoAnswer: "stop", onReject: "stop" },
  });

  it("says a write with no approval check needs approval", () => {
    expect(processStepDetail(write())).toContain("needs approval");
    expect(processStepDetail(write(approval("required")))).toContain("needs approval");
    expect(processStepDetail(write(approval("not_required")))).toContain("on its own");
    // Where the registry says the tool writes only our own records, the gate doesn't ask.
    expect(processStepDetail(write(), { changesClientTool: () => false })).not.toContain(
      "approval",
    );
    expect(processStepDetail(write(), { changesClientTool: () => true })).toContain(
      "needs approval",
    );
  });

  it("counts a v4 if as a fork and its nested steps", () => {
    const process = {
      schemaVersion: 4,
      triggers: [{ id: "t", on: { type: "manual", input: { type: "object" } } }],
      steps: [
        {
          id: "i",
          kind: "if",
          name: "Big?",
          paths: [{ id: "p", name: "Big", when: { match: "all", rules: [] }, steps: [write()] }],
          otherwise: { id: "o", steps: [] },
        },
      ],
    } as processes.Process;
    const workflows = [{ slug: "a", name: "A", enabled: true, workflow: process }];
    expect(workflowStats({ workflows })).toEqual({ steps: 2, forks: 1 });
  });
});
