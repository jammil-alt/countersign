import { describe, expect, it } from "vitest";
import type { Step } from "../schemas/workflow";
import { bundle, edit } from "../testing/fixtures";
import { diffBundles, lcs } from "./diff";

describe("diffBundles", () => {
  it("is empty for equal bundles", () => {
    expect(diffBundles(bundle(), bundle())).toEqual([]);
  });

  it("reports field changes, added, removed, moved and reordered items", () => {
    const a = bundle();
    const b = edit(a, (d) => {
      d.definition.identity.name = "Clerk 2";
      const steps = d.workflows[0]?.workflow.steps as Step[];
      const loop = steps[2] as Extract<Step, { kind: "for_each" }>;
      // s7 moves into the for_each; s1 goes to the end; s4 is removed; n1 added.
      const s7 = steps.pop() as Step;
      loop.steps.push(s7);
      steps.push(steps.shift() as Step);
      (steps.find((s) => s.id === "s2") as Extract<Step, { kind: "fork" }>).otherwise.steps = [];
      steps.push({ id: "n1", name: "N", kind: "wait", for: "1 day" });
      (loop.steps[0] as Step).name = "Summarise";
    });
    const changes = diffBundles(a, b);
    const brief = changes.map((c) => [c.kind, c.path]);
    expect(brief).toEqual(
      expect.arrayContaining([
        ["changed", "bundle#/definition/identity/name"],
        ["changed", "step:s6#/name"],
        ["removed", "step:s4"],
        ["added", "step:n1"],
        ["moved", "step:s7#@location"],
        ["reordered", "workflow:intake>steps#@order"],
        ["moved", "step:s1#@position"],
      ]),
    );
    expect(changes.find((c) => c.path === "step:s7#@location")).toMatchObject({
      before: "workflow:intake>steps",
      after: "step:s5>steps",
    });
    expect(changes.find((c) => c.kind === "removed")?.before).toMatchObject({
      id: "s4",
      kind: "notify",
    });
  });
});

describe("lcs", () => {
  it("finds the longest common subsequence", () => {
    expect(lcs(["a", "b", "c", "d"], ["b", "a", "c", "d"])).toHaveLength(3);
    expect(lcs([], ["a"])).toEqual([]);
  });
});
