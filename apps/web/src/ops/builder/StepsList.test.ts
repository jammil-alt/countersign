// The Steps tab's numbers (docs/plan.md §1.108): as the canvas gives them, a fork's paths by letter
// with otherwise after the last path, and a loop's steps under it.
import type { processes } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { stepNumbers } from "./StepsList";

describe("stepNumbers", () => {
  it("numbers the top level, fork paths by letter and loops under their step", () => {
    const workflow = {
      schemaVersion: 4,
      triggers: [],
      steps: [
        { id: "a", kind: "wait", name: "A" },
        {
          id: "fork",
          kind: "if",
          name: "Fork",
          paths: [
            {
              id: "p1",
              name: "One",
              when: { match: "all", rules: [] },
              steps: [{ id: "b", kind: "stop", name: "B" }],
            },
            {
              id: "p2",
              name: "Two",
              when: { match: "all", rules: [] },
              steps: [
                { id: "c", kind: "stop", name: "C" },
                { id: "d", kind: "stop", name: "D" },
              ],
            },
          ],
          otherwise: { id: "o", steps: [{ id: "e", kind: "stop", name: "E" }] },
        },
        {
          id: "loop",
          kind: "for_each",
          name: "Each",
          items: "{{trigger.items}}",
          steps: [{ id: "f", kind: "wait", name: "F" }],
        },
      ],
    } as unknown as processes.Process;
    expect(Object.fromEntries(stepNumbers(workflow))).toEqual({
      a: "1",
      fork: "2",
      b: "2 A1",
      c: "2 B1",
      d: "2 B2",
      e: "2 C1",
      loop: "3",
      f: "3.1",
    });
  });
});
