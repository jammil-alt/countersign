import { describe, expect, it } from "vitest";
import { changedSteps } from "./StepsBuilder";
import type { Workflow } from "./types";

const wf = (steps: unknown[]) =>
  ({ schemaVersion: 5, triggers: [], outputs: [], steps }) as unknown as Workflow;

describe("changedSteps", () => {
  it("marks a step whose own settings changed, or that was added, not the Fork holding it", () => {
    const inner = { id: "a", kind: "do", name: "Read" };
    const fork = (a: unknown, name = "If big") => ({
      id: "f",
      kind: "fork",
      name: "Big?",
      paths: [{ id: "p", name, when: { match: "all", rules: [] }, steps: [a] }],
      otherwise: { id: "o", steps: [] },
    });
    const before = wf([fork(inner)]);
    expect([...changedSteps(before, wf([fork({ ...inner, name: "Read it" })]))]).toEqual(["a"]);
    expect([...changedSteps(before, wf([fork(inner, "If large")]))]).toEqual(["f"]);
    expect([
      ...changedSteps(before, wf([fork(inner), { id: "b", kind: "do", name: "New" }])),
    ]).toEqual(["b"]);
  });
});
