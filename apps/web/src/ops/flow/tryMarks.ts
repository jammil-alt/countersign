// Try it on the chart (docs/builder-plan.md §12.4, F3): a test run's steps (`GET /api/ops/runs/:id`)
// read back onto the process, one mark per step: what it did, the write it would have made, where
// it failed, a person's turn it waits on, or that it was not on the path this example took.
// Nothing here changes the run or its routes.
import { checkKindOf, isPlainObject, processes } from "@countersign/core";
import type { ResponseOf } from "../../api/client";
import type { apiRoutes } from "../../api/routes";
import { parseNodeId } from "../run/checklist";
import type { Process, Step, TryMark } from "./types";

export type TryRun = ResponseOf<typeof apiRoutes.opsRun>;
type Row = TryRun["steps"][number];

/** A run that has finished one way or another: nothing more will change on the chart. */
export function tryEnded(run: Pick<TryRun["run"], "status">): boolean {
  return run.status === "succeeded" || run.status === "failed" || run.status === "cancelled";
}

/**
 * A write the test run recorded and never made (the runtime's `would_have_done`, ARCHITECTURE
 * §10.4): an action step's proposed change, a skill's proposed changes, a notice not sent, a hand
 * off not started. The run view calls these "Would have done".
 */
function wouldHave(row: Row, run: TryRun): boolean {
  if (run.run.mode !== "test" || row.status !== "succeeded") return false;
  const out = isPlainObject(row.output) ? row.output : {};
  if (out.wouldHaveDone === true) return true;
  if (row.nodeType === "notify" && out.sent === false) return true;
  if (row.nodeType === "handoff") return true;
  return run.actions.some((a) => a.stepRunId === row.id && a.status === "proposed");
}

function waitingWords(step: Step): string {
  if (step.kind === "person") {
    return step.mode === "ask" ? "Waiting for an answer" : "Waiting for approval";
  }
  if (step.kind === "conversation") return "Waiting for a reply";
  if (step.kind === "wait") return "Waiting";
  return "Waiting for a person";
}

/** The run's error in words, when it names this step's row. */
function errorFor(run: TryRun, row: Row): string | null {
  const e = run.run.error;
  if (typeof e === "string") return e;
  if (!isPlainObject(e)) return null;
  if (typeof e.nodeId === "string" && e.nodeId !== row.nodeId) return null;
  const said = e.reason ?? e.message;
  return typeof said === "string" && said ? said : null;
}

function rowMark(step: Step, row: Row, run: TryRun): TryMark | null {
  const said = row.summary?.trim() || null;
  switch (row.status) {
    case "succeeded":
      return wouldHave(row, run)
        ? {
            stepId: step.id,
            status: "would",
            summary: said ?? "Would have done this. Nothing was written.",
          }
        : { stepId: step.id, status: "did", summary: said ?? "Done" };
    case "failed":
      return {
        stepId: step.id,
        status: "failed",
        summary: said ?? errorFor(run, row) ?? "It failed here",
      };
    case "waiting":
      return { stepId: step.id, status: "waiting", summary: said ?? waitingWords(step) };
    case "skipped":
      return { stepId: step.id, status: "skipped", summary: said ?? "Skipped" };
    case "cancelled":
      return { stepId: step.id, status: "skipped", summary: said ?? "Cancelled" };
    default:
      // Pending or running: no mark until it ends.
      return null;
  }
}

/** Which of a step's marks wins when it ran more than once (a loop's steps): the worst. */
const RANK: Record<TryMark["status"], number> = {
  failed: 4,
  waiting: 3,
  would: 2,
  did: 1,
  skipped: 0,
};

/**
 * One mark per step of the process the run reached, in the process's order; once the run has
 * ended, every other step is marked skipped (not on the path this example took, or after where it
 * stopped). A step that ran more than once (in a loop) shows its worst mark and how many times.
 */
export function tryMarks(run: TryRun, process: Pick<Process, "steps">): TryMark[] {
  const byStep = new Map<string, Row[]>();
  const waitingChecks = new Set<string>();
  for (const row of run.steps) {
    const { stepId } = parseNodeId(row.nodeId);
    if (checkKindOf(row.nodeId)) {
      // A check that waits on a person (a confer by a person) holds its step.
      if (row.status === "waiting") waitingChecks.add(stepId);
      continue;
    }
    const rows = byStep.get(stepId) ?? [];
    rows.push(row);
    byStep.set(stepId, rows);
  }
  const ended = tryEnded(run.run);
  const stopped = run.run.status === "failed" || run.run.status === "cancelled";
  const out: TryMark[] = [];
  for (const { step } of processes.allSteps(process)) {
    const rows = byStep.get(step.id) ?? [];
    const marks = rows.flatMap((r) => {
      const m = rowMark(step, r, run);
      return m ? [m] : [];
    });
    if (waitingChecks.has(step.id) && !marks.some((m) => m.status === "waiting")) {
      marks.push({ stepId: step.id, status: "waiting", summary: "Waiting for a person" });
    }
    if (marks.length === 0) {
      if (ended && rows.length === 0) {
        out.push({
          stepId: step.id,
          status: "skipped",
          summary: stopped
            ? "Not reached: the run stopped before it"
            : "Not on the path this example took",
        });
      }
      continue;
    }
    let worst = marks[0] as TryMark;
    for (const m of marks) if (RANK[m.status] >= RANK[worst.status]) worst = m;
    out.push(
      marks.length > 1 && worst.summary
        ? { ...worst, summary: `${marks.length} times. ${worst.summary}` }
        : worst,
    );
  }
  return out;
}

/** The run in one line, for the try's panel once it has ended or while it waits. */
export function tryOutcome(run: TryRun, marks: readonly TryMark[]): string | null {
  const count = (s: TryMark["status"]) => marks.filter((m) => m.status === s).length;
  switch (run.run.status) {
    case "succeeded": {
      const would = count("would");
      return would > 0
        ? `It ran to the end. ${would === 1 ? "1 change" : `${would} changes`} would have been made; nothing was written.`
        : "It ran to the end. Nothing was written.";
    }
    case "failed": {
      const at = marks.find((m) => m.status === "failed");
      return at?.summary ? `It stopped at a step: ${at.summary}` : "It stopped before the end.";
    }
    case "cancelled":
      return "The try was cancelled.";
    case "waiting":
      return count("waiting") > 0
        ? "It waits for a person. Answer it in the inbox and the chart follows."
        : null;
    default:
      return null;
  }
}
