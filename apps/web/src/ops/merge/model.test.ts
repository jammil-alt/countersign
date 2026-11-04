import { AgentBundle, cloneJson, diffBundles, type MergeConflict } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { FORK_BUNDLE } from "../../test/fixtures";
import {
  activeResolutions,
  conflictChoices,
  conflictText,
  conflictValue,
  removedSteps,
  sideMarks,
} from "./model";

const labels = { "step:ask": "Ask Jammil", "workflow:new-bill": "New bill", "path:low": "Low" };

const conflict = (c: Partial<MergeConflict>): MergeConflict => ({
  path: "step:ask#/timeout",
  kind: "field",
  entity: "step:ask",
  base: "2 days",
  ours: "1 day",
  theirs: "3 days",
  ...c,
});

describe("merge model", () => {
  it("words each kind of conflict", () => {
    expect(conflictText(conflict({}), labels)).toBe("Step “Ask Jammil”: timeout");
    expect(conflictText(conflict({ kind: "exists", path: "step:ask#@exists" }), labels)).toBe(
      "Step “Ask Jammil” was removed on one side and changed on the other",
    );
    expect(
      conflictText(
        conflict({
          kind: "order",
          entity: "workflow:new-bill>steps",
          path: "workflow:new-bill>steps#@order",
        }),
        labels,
      ),
    ).toBe("The steps in workflow “New bill” were reordered on both sides");
    expect(conflictValue(conflict({ kind: "exists" }), undefined, labels)).toBe("Removed");
    expect(conflictValue(conflict({ kind: "order" }), ["step:ask"], labels)).toBe("Ask Jammil");
  });

  it("offers the original only when it differs from both sides", () => {
    expect(conflictChoices(conflict({}))).toEqual(["ours", "theirs", "base"]);
    expect(conflictChoices(conflict({ kind: "exists" }))).toEqual(["ours", "theirs"]);
  });

  it("drops resolutions that settle no conflict", () => {
    const c = conflict({});
    expect(
      activeResolutions([c], {
        [c.path]: { path: c.path, choice: "ours" },
        stale: { path: "stale", choice: "theirs" },
      }),
    ).toEqual([{ path: c.path, choice: "ours" }]);
  });

  it("marks steps per side and lists removed ones", () => {
    const after = AgentBundle.parse(
      (() => {
        const b = cloneJson(FORK_BUNDLE);
        const steps = b.workflows[0]?.workflow.steps ?? [];
        steps.splice(0, 1); // remove "find"
        const read = steps[0];
        if (read) read.name = "Read it";
        return b;
      })(),
    );
    const changes = diffBundles(FORK_BUNDLE, after);
    const marks = sideMarks(changes, after);
    expect(marks.get("find")).toBe("removed");
    expect(marks.get("read")).toBe("changed");
    expect(removedSteps(changes, after, {}).map((r) => r.key)).toEqual(["step:find"]);
  });
});
