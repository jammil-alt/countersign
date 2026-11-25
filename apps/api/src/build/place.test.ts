// A draft's problem by name (feedback, 2026-11-16): "In Ask Jammil", and the workflow's name only
// where the agent has more than one.
import { describe, expect, it } from "vitest";
import { v5Workflow } from "../api.test-helper";
import { problemPlace } from "./store";

type Bundle = Parameters<typeof problemPlace>[0];

const flow = (slug: string, name: string, steps: unknown[]) => ({
  slug,
  name,
  enabled: true,
  workflow: v5Workflow(steps, { triggers: [] }),
});

const ask = { id: "ask", kind: "person", name: "Ask Jammil" };
const fork = {
  id: "confidence",
  kind: "if",
  name: "Match confidence",
  paths: [{ id: "low", name: "Low", when: { match: "any", rules: [] }, steps: [ask] }],
  otherwise: { id: "else", steps: [] },
};

describe("problemPlace", () => {
  it("names a step anywhere in the workflow, and the workflow only when there are several", () => {
    const one = { workflows: [flow("main", "Main", [fork])] } as unknown as Bundle;
    expect(problemPlace(one, "main", "ask")).toEqual({
      stepName: "Ask Jammil",
      workflowName: null,
    });
    const two = {
      workflows: [flow("main", "Main", [fork]), flow("vendor", "Vendor flow", [])],
    } as unknown as Bundle;
    expect(problemPlace(two, "main", "confidence")).toEqual({
      stepName: "Match confidence",
      workflowName: "Main",
    });
    expect(problemPlace(two, "vendor", null)).toEqual({
      stepName: null,
      workflowName: "Vendor flow",
    });
    expect(problemPlace(two, "main", "gone")).toEqual({ stepName: null, workflowName: null });
    expect(problemPlace(null, "main", "ask")).toEqual({ stepName: null, workflowName: null });
  });
});
