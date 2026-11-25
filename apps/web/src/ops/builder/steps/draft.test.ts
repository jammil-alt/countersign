import { steps } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { fromStored, toStored, UNFILLED } from "./draft";
import { ensureEnd, insertStep, newOutput, newStep, ROOT, removeOutput } from "./model";
import type { StepKind, Workflow } from "./types";

let n = 0;
const id = () => `x${++n}`;
const base = (): Workflow => ({
  schemaVersion: 5,
  triggers: [
    { id: "t", on: { type: "manual", input: { type: "object", properties: {} } } } as never,
  ],
  outputs: [{ ...newOutput("Report", id), id: "o1" }],
  steps: [],
});

const KINDS: StepKind[] = ["do", "loop", "fork", "for_each", "repeat", "wait", "handoff", "end"];

describe("a draft in the stored format", () => {
  it("stores every kind the palette adds, so a draft can always be saved", () => {
    for (const kind of KINDS) {
      const w = ensureEnd(insertStep(base(), { container: ROOT, index: 0 }, newStep(kind, id)), id);
      const parsed = steps.Workflow.safeParse(toStored(w));
      expect(parsed.success, `${kind}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });

  it("reads back what it stored, without the markers", () => {
    let w = ensureEnd(base(), id);
    w = insertStep(w, { container: ROOT, index: 0 }, newStep("for_each", id));
    w = insertStep(w, { container: ROOT, index: 0 }, newStep("loop", id));
    const s = toStored(w);
    expect(JSON.stringify(s)).toContain(UNFILLED);
    expect(fromStored(s)).toEqual(w);
  });

  it("leaves a finished workflow exactly as it is", () => {
    const done: Workflow = {
      ...base(),
      steps: [
        { kind: "do", id: "a", name: "Read it", doneBy: "rules", input: {} } as never,
        { kind: "end", id: "e", name: "Done", outputs: ["o1"], status: "succeeded" },
      ],
    };
    expect(toStored(done)).toEqual(done);
    expect(fromStored(done)).toEqual(done);
  });

  it("keeps the last output: a workflow needs one", () => {
    const w = base();
    expect(removeOutput(w, "o1").outputs).toHaveLength(1);
  });
});
