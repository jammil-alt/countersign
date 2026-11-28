import { AgentBundle, cloneJson, diffBundles, type MergeConflict } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { FORK_BUNDLE } from "../../test/fixtures";
import {
  activeResolutions,
  conflictChoices,
  conflictTarget,
  conflictText,
  conflictValue,
  removedSteps,
  sideMarks,
  triggerLabels,
} from "./model";

const edit = (b: AgentBundle, fn: (d: AgentBundle) => void): AgentBundle => {
  const d = cloneJson(b);
  fn(d);
  return d;
};

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
    const marks = sideMarks(changes);
    expect(marks.get("find")).toBe("removed");
    expect(marks.get("read")).toBe("changed");
    expect(removedSteps(changes, after, {}).map((r) => r.key)).toEqual(["step:find"]);
  });
});

// Triggers and Fork paths in the merge view.
describe("merge model: triggers and paths", () => {
  const base = FORK_BUNDLE;
  const withTriggers = (order: string[]) =>
    edit(base, (b) => {
      const p = b.workflows[0]?.workflow;
      if (!p) throw new Error("fixture");
      const t1 = p.triggers[0];
      if (!t1) throw new Error("fixture");
      const t2 = { id: "t2", on: { type: "manual" as const, input: { type: "object" } } };
      p.triggers = order.map((id) => (id === "t2" ? t2 : t1));
    });

  it("labels the trigger order and words a reorder conflict", () => {
    const names: Record<string, string> = {
      ...triggerLabels(withTriggers(["t1", "t2"])),
      "workflow:new-bill": "New bill",
    };
    const c = conflict({
      kind: "order",
      entity: "workflow:new-bill",
      path: "workflow:new-bill#/workflow/triggerOrder",
      base: ["t1", "t2"],
      ours: ["t2", "t1"],
      theirs: ["t1", "t2"],
    });
    expect(conflictText(c, names)).toBe(
      "Workflow “New bill”: its triggers were reordered on both sides",
    );
    expect(conflictValue(c, ["t2", "t1"], names)).toBe(
      `${names["trigger:t2"]} → ${names["trigger:t1"]}`,
    );
    expect(names["trigger:t1"]).toBe("When bill created");
    expect(conflictTarget(c)).toBeNull();
    // A changed-path line names it too.
    expect(
      conflictText(
        conflict({ entity: "workflow:new-bill", path: "workflow:new-bill#/workflow/triggerOrder" }),
        names,
      ),
    ).toBe("Workflow “New bill”: order of its triggers");
  });

  it("marks the trigger a side added and those a reorder moved", () => {
    const a = withTriggers(["t1", "t2"]);
    const b = withTriggers(["t2", "t1"]);
    const marks = sideMarks(diffBundles(a, b));
    expect(marks.get("t1")).toBe("moved");
    expect(marks.get("t2")).toBe("moved");
    const added = sideMarks(diffBundles(base, a));
    expect(added.get("t2")).toBe("changed");
  });

  it("words checks and deadlines in conflicts", () => {
    const c = conflict({
      entity: "step:update",
      path: "step:update#/checks/approval/approvers",
    });
    const value = [
      { who: "client_admin", deadline: { after: "2 days", hours: "business", ifNoAnswer: "stop" } },
      { who: "lead" },
    ];
    expect(conflictText(c, { "step:update": "Update the bill" })).toBe(
      "Step “Update the bill”: approval: approver",
    );
    expect(conflictValue(c, value, {})).toMatch(/^client admin · 2 days in business hours, then /);
    const deadline = conflict({
      entity: "step:update",
      path: "step:update#/checks/approval/approvers/0/deadline/ifNoAnswer",
    });
    expect(conflictText(deadline, { "step:update": "Update" })).toBe(
      "Step “Update”: approval: approver 1: deadline: if nobody answers",
    );
    expect(conflictValue(deadline, "proceed", {})).toBe("it goes ahead");
    expect(
      conflictValue(
        deadline,
        { escalate: { to: "client_admin", deadline: { after: "1 day", hours: "clock" } } },
        {},
      ),
    ).toBe("asks client admin (1 day)");
  });

  it("lists a removed step inside a Fork path", () => {
    const after = edit(base, (b) => {
      const p = b.workflows[0]?.workflow;
      const fork = p?.steps.find((s) => s.kind === "fork");
      if (fork?.kind !== "fork") throw new Error("fixture");
      if (fork.paths[0]) fork.paths[0].steps = [];
    });
    const changes = diffBundles(base, after);
    expect(removedSteps(changes, after, {}).map((r) => r.key)).toEqual(["step:ask"]);
  });
});
