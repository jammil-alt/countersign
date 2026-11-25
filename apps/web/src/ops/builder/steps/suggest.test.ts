import { describe, expect, it } from "vitest";
import { guardedSuggestion, refuseSuggestion, suggestBody } from "./suggest";
import type { Step, Workflow } from "./types";

const approval = {
  required: "required",
  mode: "in_turn",
  ifNoAnswer: "stop",
  onReject: "stop",
} as const;
const step = {
  kind: "do",
  id: "s1",
  name: "Enter the bill",
  input: {},
  checks: { approval },
} as Step;

describe("what Suggest may change", () => {
  it("never loosens an approval, and never changes which step it is", () => {
    expect(refuseSuggestion(step, { ...step, name: "Enter it" })).toBeNull();
    expect(refuseSuggestion(step, { ...step, checks: {} })).toMatch(/loosen an approval/);
    expect(
      refuseSuggestion(step, {
        ...step,
        checks: { approval: { ...approval, required: "not_required" } },
      }),
    ).toMatch(/loosen an approval/);
    expect(
      refuseSuggestion(step, {
        ...step,
        checks: { approval: { ...approval, when: { match: "all", rules: [] } } },
      }),
    ).toMatch(/loosen an approval/);
    expect(refuseSuggestion(step, { ...step, id: "s2" })).toMatch(/which step/);
  });

  it("applies a fair answer and leaves the step alone on a refused one", () => {
    const fair = { step: { ...step, name: "Enter it" }, summary: "Renamed.", applied: true };
    expect(guardedSuggestion(fair, step)).toMatchObject({
      applied: true,
      step: { name: "Enter it" },
    });
    const loose = { step: { ...step, checks: {} }, summary: "Dropped it.", applied: true };
    expect(guardedSuggestion(loose, step)).toMatchObject({ applied: false, step });
  });

  it("sends the workflow with the step the form holds in its place", () => {
    const wf = {
      schemaVersion: 5,
      triggers: [],
      outputs: [],
      steps: [{ ...step, name: "Old" }],
    } as unknown as Workflow;
    const body = suggestBody(wf, { step, how: "tell", text: "only over $500", field: "input" });
    expect((body.workflow as Workflow).steps[0]?.name).toBe("Enter the bill");
    expect(body).toMatchObject({
      stepId: "s1",
      how: "tell",
      text: "only over $500",
      field: "input",
    });
  });
});
