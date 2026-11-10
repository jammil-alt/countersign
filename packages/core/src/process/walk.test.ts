import { describe, expect, it } from "vitest";
import { Process } from "./schema";
import {
  allSteps,
  findStep,
  logicDepth,
  nodeIds,
  stepCount,
  subProcessRefs,
  subProcessSteps,
  visibleBefore,
} from "./walk";

const note = (id: string) => ({
  id,
  name: id,
  kind: "notify",
  notify: { to: ["client_admin"], message: id },
});

const p = Process.parse({
  schemaVersion: 4,
  triggers: [
    { id: "t1", on: { type: "manual", input: {} } },
    { id: "t2", on: { type: "schedule", cron: "0 7 * * 1-5" } },
  ],
  steps: [
    note("a"),
    {
      id: "if1",
      name: "Big?",
      kind: "if",
      paths: [
        {
          id: "p1",
          name: "Big",
          when: { rules: [{ field: "{{trigger.total}}", op: ">", value: 1 }] },
          steps: [note("b"), note("c")],
        },
      ],
      otherwise: { id: "o1", steps: [note("d")] },
    },
    {
      id: "loop",
      name: "Each",
      kind: "for_each",
      over: "{{trigger.lines}}",
      steps: [note("e"), { id: "sub", name: "Sub", kind: "process", process: "follow-up@2" }],
    },
    { id: "sub2", name: "Sub", kind: "process", process: "follow-up@2" },
    note("f"),
  ],
});

describe("walking a process", () => {
  it("visits every step depth-first, in run order, with pointers", () => {
    const locs = allSteps(p);
    expect(locs.map((l) => l.step.id)).toEqual([
      "a",
      "if1",
      "b",
      "c",
      "d",
      "loop",
      "e",
      "sub",
      "sub2",
      "f",
    ]);
    expect(findStep(p, "c")?.pointer).toEqual(["steps", 1, "paths", 0, "steps", 1]);
    expect(findStep(p, "d")?.pointer).toEqual(["steps", 1, "otherwise", "steps", 0]);
    expect(findStep(p, "sub")?.pointer).toEqual(["steps", 2, "steps", 1]);
    expect(findStep(p, "nope")).toBeUndefined();
  });

  it("knows the enclosing ifs and loops, and the depth", () => {
    const c = findStep(p, "c");
    expect(c?.ifs.map((i) => [i.step.id, i.branchId])).toEqual([["if1", "p1"]]);
    expect(c?.depth).toBe(1);
    expect(findStep(p, "d")?.ifs.map((i) => i.branchId)).toEqual(["o1"]);
    expect(findStep(p, "e")?.loops.map((l) => l.id)).toEqual(["loop"]);
    expect(findStep(p, "f")?.depth).toBe(0);
  });

  it("sees what ran before on its own path, never inside an earlier path or loop", () => {
    expect(findStep(p, "c")?.before).toEqual(["a", "b"]);
    // The otherwise branch doesn't see the path's steps.
    expect(findStep(p, "d")?.before).toEqual(["a"]);
    expect(findStep(p, "e")?.before).toEqual(["a", "if1"]);
    // After the if and the loop: their own outputs, not their insides.
    expect(visibleBefore(p, "f")?.map((s) => s.id)).toEqual(["a", "if1", "loop", "sub2"]);
    expect(visibleBefore(p, "a")).toEqual([]);
    expect(visibleBefore(p, "nope")).toBeUndefined();
  });

  it("lists every id a merge lines up by: triggers, steps, paths and otherwise", () => {
    expect(nodeIds(p)).toEqual([
      "t1",
      "t2",
      "a",
      "if1",
      "p1",
      "o1",
      "b",
      "c",
      "d",
      "loop",
      "e",
      "sub",
      "sub2",
      "f",
    ]);
  });

  it("counts steps and logic depth, and finds the sub-processes", () => {
    expect(stepCount(p)).toBe(10);
    expect(logicDepth(p)).toBe(1);
    expect(logicDepth({ steps: [] })).toBe(0);
    expect(subProcessSteps([p]).map((s) => s.id)).toEqual(["sub", "sub2"]);
    expect(subProcessRefs([p])).toEqual(["follow-up@2"]);
  });

  it("measures nested logic", () => {
    const nested = Process.parse({
      schemaVersion: 4,
      triggers: [{ id: "t", on: { type: "manual", input: {} } }],
      steps: [
        {
          id: "l1",
          name: "L1",
          kind: "for_each",
          over: "{{trigger.x}}",
          steps: [
            {
              id: "i2",
              name: "I2",
              kind: "if",
              paths: [
                {
                  id: "p2",
                  name: "P",
                  when: { rules: [{ field: "{{item.x}}", op: "exists" }] },
                  steps: [note("deep")],
                },
              ],
              otherwise: { id: "o2", steps: [] },
            },
          ],
        },
      ],
    });
    expect(logicDepth(nested)).toBe(2);
    expect(findStep(nested, "deep")?.depth).toBe(2);
  });
});
