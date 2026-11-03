import { describe, expect, it } from "vitest";
import { failureText } from "../screens/RunView";
import { fieldText, rulesText } from "./describe";

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
