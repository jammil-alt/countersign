import { describe, expect, it } from "vitest";
import { type TryRun, tryEnded, tryMarks } from "./TryPanel";
import type { Workflow } from "./types";

const workflow = {
  schemaVersion: 5,
  triggers: [],
  outputs: [{ id: "o", name: "Done", kind: "nothing", fields: [] }],
  steps: [
    { id: "read", kind: "do", name: "Read it", goal: "Read it", doneBy: "rules", input: {} },
    { id: "book", kind: "do", name: "Book it", goal: "Book it", doneBy: "rules", input: {} },
    { id: "end", kind: "end", name: "", outputs: ["o"] },
  ],
} as unknown as Workflow;

function row(id: string, nodeId: string, status: string, summary: string | null = null) {
  return { id, nodeId, nodeType: "do", status, summary, output: null };
}

describe("tryMarks", () => {
  it("marks each step by its rows: done, would have written, the worst of a loop's", () => {
    const run = {
      run: { status: "succeeded", error: null },
      steps: [
        row("r1", "read", "succeeded", "Read 3 lines"),
        row("r2", "book", "succeeded"),
        row("r3", "unknown", "succeeded"),
      ],
      actions: [{ stepRunId: "r2", status: "proposed" }],
    } as unknown as TryRun;
    expect(tryMarks(run, workflow)).toEqual([
      { stepId: "read", status: "did", summary: "Read 3 lines" },
      {
        stepId: "book",
        status: "would",
        summary: "Would have done this. Nothing was written.",
      },
    ]);
    expect(tryEnded("succeeded")).toBe(true);
    expect(tryEnded("running")).toBe(false);
  });

  it("says where it failed", () => {
    const run = {
      run: { status: "failed", error: { message: "No vendor" } },
      steps: [row("r1", "read", "succeeded"), row("r2", "read", "failed")],
      actions: [],
    } as unknown as TryRun;
    expect(tryMarks(run, workflow)).toEqual([
      { stepId: "read", status: "failed", summary: "No vendor" },
    ]);
  });
});
