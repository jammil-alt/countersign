import { describe, expect, it } from "vitest";
import { PROCESS_BUNDLE } from "../../test/fixtures";
import { type TryRun, tryEnded, tryMarks, tryOutcome } from "./tryMarks";
import type { Process } from "./types";

// find (skill) → confidence (if: low → ask, a person who answers) → update (a write).
const PROCESS = PROCESS_BUNDLE.workflows[0]?.workflow as Process;

const row = (id: string, nodeId: string, nodeType: string, status: string, extra = {}) => ({
  id,
  nodeId,
  nodeType,
  skillRef: null,
  status,
  input: null,
  output: null,
  summary: null,
  costUsd: "0",
  tokensIn: 0,
  tokensOut: 0,
  startedAt: "2026-11-21T10:00:00.000Z",
  finishedAt: null,
  ...extra,
});

function run(
  status: TryRun["run"]["status"],
  steps: ReturnType<typeof row>[],
  more: Partial<TryRun> & { error?: unknown } = {},
): TryRun {
  const { error = null, ...rest } = more;
  return {
    run: {
      id: "run",
      tenantId: "t",
      agentId: "a",
      agentVersionId: "v",
      workflowSlug: "new-bill",
      mode: "test",
      status,
      trigger: {},
      costUsd: "0",
      error,
      startedAt: null,
      finishedAt: null,
      createdAt: "2026-11-21T10:00:00.000Z",
    },
    steps,
    toolCalls: [],
    actions: [],
    inbox: [],
    agent: null,
    version: 2,
    workflow: null,
    ...rest,
  } as TryRun;
}

describe("tryMarks", () => {
  it("marks what each step did, the write it would have made, and the path not taken", () => {
    const r = run("succeeded", [
      row("1", "find", "skill", "succeeded", { summary: "Found 1 document" }),
      row("2", "confidence", "if", "succeeded", { summary: "Took Otherwise" }),
      row("3", "update", "action", "succeeded", {
        output: { wouldHaveDone: true, actionId: "x", before: null },
        summary: "Would update bill (test run, not written)",
      }),
      // A check's own row is not a step of its own.
      row("4", "update:notify:0", "notify", "succeeded"),
    ]);
    const marks = tryMarks(r, PROCESS);
    expect(marks).toEqual([
      { stepId: "find", status: "did", summary: "Found 1 document" },
      { stepId: "confidence", status: "did", summary: "Took Otherwise" },
      { stepId: "ask", status: "skipped", summary: "Not on the path this example took" },
      { stepId: "update", status: "would", summary: "Would update bill (test run, not written)" },
    ]);
    expect(tryEnded(r.run)).toBe(true);
    expect(tryOutcome(r, marks)).toBe(
      "It ran to the end. 1 change would have been made; nothing was written.",
    );
  });

  it("reads a skill's proposed change as would, by its row", () => {
    const r = run("succeeded", [row("s1", "find", "skill", "succeeded")], {
      actions: [{ id: "a1", stepRunId: "s1", status: "proposed" }] as TryRun["actions"],
    });
    expect(tryMarks(r, PROCESS)[0]).toEqual({
      stepId: "find",
      status: "would",
      summary: "Would have done this. Nothing was written.",
    });
  });

  it("shows a person's turn as waiting, and marks nothing it hasn't reached while it goes", () => {
    const r = run("waiting", [
      row("1", "find", "skill", "succeeded"),
      row("2", "confidence", "if", "succeeded"),
      row("3", "ask", "person", "waiting"),
    ]);
    const marks = tryMarks(r, PROCESS);
    expect(marks.map((m) => [m.stepId, m.status, m.summary])).toEqual([
      ["find", "did", "Done"],
      ["confidence", "did", "Done"],
      ["ask", "waiting", "Waiting for an answer"],
    ]);
    expect(tryEnded(r.run)).toBe(false);
    expect(tryOutcome(r, marks)).toBe(
      "It waits for a person. Answer it in the inbox and the chart follows.",
    );
  });

  it("says where it failed, in the run's words, and that the rest wasn't reached", () => {
    const r = run("failed", [row("1", "find", "skill", "failed")], {
      error: { nodeId: "find", reason: "the document can't be read" },
    });
    const marks = tryMarks(r, PROCESS);
    expect(marks[0]).toEqual({
      stepId: "find",
      status: "failed",
      summary: "the document can't be read",
    });
    expect(marks.slice(1).map((m) => [m.status, m.summary])).toEqual([
      ["skipped", "Not reached: the run stopped before it"],
      ["skipped", "Not reached: the run stopped before it"],
      ["skipped", "Not reached: the run stopped before it"],
    ]);
    expect(tryOutcome(r, marks)).toBe("It stopped at a step: the document can't be read");
  });

  it("shows a step that ran for each item by its worst run, and how many times", () => {
    const loop = {
      steps: [
        {
          id: "each",
          kind: "for_each",
          name: "Each line",
          over: "{{steps.find.output.lines}}",
          concurrency: 1,
          steps: [{ id: "code", kind: "skill", name: "Code it", skill: "x.code", input: {} }],
        },
      ],
    } as unknown as Process;
    const r = run("running", [
      row("1", "each", "for_each", "running"),
      row("2", "each:0:code", "skill", "succeeded", { summary: "Coded to job 12" }),
      row("3", "each:1:code", "skill", "failed", { summary: "No job fits" }),
    ]);
    expect(tryMarks(r, loop)).toEqual([
      { stepId: "code", status: "failed", summary: "2 times. No job fits" },
    ]);
  });
});
