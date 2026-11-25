import type { steps } from "@countersign/core";
import { describe, expect, it } from "vitest";
import {
  addOutput,
  canRemove,
  ensureEnd,
  findStep,
  getContainer,
  insertStep,
  moveStep,
  newOutput,
  newStep,
  ROOT,
  removeOutput,
  removeStep,
  setEndOutputs,
  stepsBefore,
  updateStep,
  type Workflow,
} from "./model";

let n = 0;
const id = () => `n${++n}`;

const base = (list: Workflow["steps"] = []): Workflow => ({
  schemaVersion: 5,
  triggers: [{ id: "t1", on: { type: "manual" } } as never],
  outputs: [{ id: "o1", name: "Report", kind: "nothing", fields: [] } as never],
  steps: list,
});

describe("the step model's edits", () => {
  it("adds an End at the end of the main line, and keeps one there", () => {
    const w = ensureEnd(base([newStep("do", id)]), id);
    expect(w.steps.map((s) => s.kind)).toEqual(["do", "end"]);
    expect(ensureEnd(w, id)).toBe(w);
    // A fork whose every path ends already ends the line.
    const fork = newStep("fork", id);
    if (fork.kind !== "fork") throw new Error("fork");
    fork.paths[0]?.steps.push(newStep("end", id));
    fork.otherwise.steps.push(newStep("end", id));
    expect(ensureEnd(base([fork]), id).steps).toHaveLength(1);
  });

  it("inserts at a place, into a path or a loop, and keeps the End last", () => {
    let w = ensureEnd(base(), id);
    const a = newStep("do", id);
    w = insertStep(w, { container: ROOT, index: 0 }, a);
    const fork = newStep("fork", id);
    w = insertStep(w, { container: ROOT, index: 1 }, fork);
    if (fork.kind !== "fork") throw new Error("fork");
    const inPath = newStep("do", id);
    w = insertStep(w, { container: `path:${fork.paths[0]?.id}`, index: 0 }, inPath);
    expect(findStep(w, inPath.id)?.container).toBe(`path:${fork.paths[0]?.id}`);
    expect(w.steps.at(-1)?.kind).toBe("end");
    expect(getContainer(w, `otherwise:${fork.otherwise.id}`)).toEqual([]);
  });

  it("keeps an End that closes the line, and takes out one that doesn't", () => {
    let w = ensureEnd(base([newStep("do", id)]), id);
    const last = w.steps.at(-1);
    expect(last && canRemove(w, last.id)).toBe(false);
    expect(removeStep(w, last?.id ?? "")).toBe(w);
    const extra = newStep("end", id);
    w = insertStep(w, { container: ROOT, index: 0 }, extra);
    // Now an End sits first and one last; the first can't go either way round: the last would end it.
    expect(canRemove(w, extra.id)).toBe(true);
    expect(removeStep(w, extra.id).steps).toHaveLength(2);
  });

  it("moves a step, not into itself, and counts the place without the step", () => {
    const a = newStep("do", id);
    const b = newStep("do", id);
    const c = newStep("for_each", id);
    let w = ensureEnd(base([a, b, c]), id);
    w = moveStep(w, a.id, { container: ROOT, index: 3 });
    expect(w.steps.map((s) => s.id).slice(0, 3)).toEqual([b.id, c.id, a.id]);
    expect(moveStep(w, c.id, { container: `loop:${c.id}`, index: 0 })).toBe(w);
  });

  it("changes a step by its id, wherever it is", () => {
    const inner = newStep("do", id);
    const loop = newStep("for_each", id);
    if (loop.kind !== "for_each") throw new Error("loop");
    loop.steps.push(inner);
    const w = updateStep(ensureEnd(base([loop]), id), inner.id, (s) => ({ ...s, name: "Read" }));
    expect(findStep(w, inner.id)?.step.name).toBe("Read");
  });

  it("takes a removed output out of every End that picked it", () => {
    let w = ensureEnd(base([newStep("do", id)]), id);
    const end = w.steps.at(-1);
    w = addOutput(w, { ...newOutput("Second", id), id: "o2" });
    w = setEndOutputs(w, end?.id ?? "", { outputs: ["o1", "o2"] });
    w = removeOutput(w, "o1");
    expect((w.steps.at(-1) as steps.EndStep).outputs).toEqual(["o2"]);
    w = setEndOutputs(w, end?.id ?? "", { nothingToDo: "no bill" });
    const last = w.steps.at(-1) as steps.EndStep;
    expect(last.outputs).toEqual([]);
    expect(last.nothingToDo).toBe("no bill");
    expect(addOutput(w, newOutput("Exceptions", id)).outputs).toHaveLength(2);
  });

  it("offers an Input the steps before it on the way in, not another path's", () => {
    const first = newStep("do", id);
    const fork = newStep("fork", id);
    if (fork.kind !== "fork") throw new Error("fork");
    const left = newStep("do", id);
    const right = newStep("do", id);
    fork.paths[0]?.steps.push(left);
    fork.otherwise.steps.push(right);
    const after = newStep("do", id);
    const w = ensureEnd(base([first, fork, after]), id);
    expect(stepsBefore(w, right.id).map((s) => s.id)).toEqual([first.id, fork.id]);
    expect(stepsBefore(w, after.id).map((s) => s.id)).toEqual([first.id, fork.id]);
    expect(stepsBefore(w, left.id).map((s) => s.id)).toEqual([first.id, fork.id]);
  });
});
