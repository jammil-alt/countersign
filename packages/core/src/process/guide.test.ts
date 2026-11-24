import { describe, expect, it } from "vitest";
import { TriggerOn } from "../schemas/workflow";
import { CHECK_GUIDE, STEP_GUIDE, stepGuideText, TRIGGER_GUIDE, triggerGuideText } from "./guide";
import { Checks, STEP_KINDS, Step } from "./schema";

describe("the Builder's guide to step kinds", () => {
  it("has an entry for every step kind, and no other", () => {
    expect(Object.keys(STEP_GUIDE).sort()).toEqual([...STEP_KINDS].sort());
  });

  it("gives an example of each kind that parses as that step", () => {
    for (const [kind, entry] of Object.entries(STEP_GUIDE)) {
      const parsed = Step.safeParse(entry.example);
      expect(parsed.success, `${kind}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      expect(parsed.data?.kind).toBe(kind);
    }
  });

  it("writes one line a kind for the rules", () => {
    const text = stepGuideText();
    expect(text.split("\n")).toHaveLength(STEP_KINDS.length);
    expect(text).toContain("- collect: Wait for files (reports)");
  });

  it("covers every way in, each example parsing as that trigger", () => {
    const kinds = TriggerOn.options.map((o) => o.shape.type.value).sort();
    expect(Object.keys(TRIGGER_GUIDE).sort()).toEqual(kinds);
    for (const [kind, entry] of Object.entries(TRIGGER_GUIDE)) {
      const parsed = TriggerOn.safeParse(entry.example);
      expect(parsed.success, `${kind}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      expect(parsed.data?.type).toBe(kind);
    }
    expect(triggerGuideText()).toContain("- message: A message arrives");
  });

  it("covers every check on a step, each example parsing", () => {
    expect(Object.keys(CHECK_GUIDE).sort()).toEqual(Object.keys(Checks.shape).sort());
    for (const [kind, entry] of Object.entries(CHECK_GUIDE)) {
      const parsed = Checks.safeParse(entry.example);
      expect(parsed.success, `${kind}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });
});
