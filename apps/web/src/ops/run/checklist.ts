// The run view's "What it did" checklist (design screen 6; ARCHITECTURE §10.5): the trigger, then
// one row per step the run reached, in order, named from the workflow that ran; while the run is
// going, the top-level steps it has not reached yet follow as not started.
// R8 (ARCHITECTURE §10.14): the workflow may be a v4 process (its steps in the builder's words),
// and a step's confer and notify checks are rows of their own (`<step>:confer:<n>`), named for the
// step they check.
import {
  allSteps,
  checkKindOf,
  processes,
  type Step,
  shownOnTimeline,
  stepNodeOf,
  Workflow,
} from "@countersign/core";
import { KIND_LABEL, PROCESS_KIND_LABEL, triggerTitle } from "../workflow/describe";

/** The workflow that ran: a stored v3 workflow or a v4 process. */
export type RanWorkflow = Workflow | processes.Process;

/** A v3 or a v4 step, as the checklist reads it. */
type AnyStep = Step | processes.Step;

/** The workflow definition a run names, as v3 or v4; null when it reads as neither. */
export function ranWorkflow(definition: unknown): RanWorkflow | null {
  const v4 = processes.Process.safeParse(definition);
  if (v4.success) return v4.data;
  const v3 = Workflow.safeParse(definition);
  return v3.success ? v3.data : null;
}

export interface RunStepRow {
  /** A step_run id, `trigger`, or `pending:<step id>`. */
  key: string;
  kind: string;
  title: string;
  detail: string | null;
  status: string;
  at: string | null;
  costUsd: string | null;
  /** The step_run id, for the log. */
  stepRunId: string | null;
  /** Hidden from the client's timeline. */
  internal: boolean;
  /** R8: the check this row is (`confer`, `notify`), or null for the step itself. */
  check?: string | null;
}

interface StepRunLike {
  id: string;
  nodeId: string;
  nodeType: string;
  status: string;
  summary: string | null;
  costUsd: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** `loop:2:child` → the child step's id and the item index (0-based); a check's suffix ignored. */
export function parseNodeId(nodeId: string): { stepId: string; index: number | null } {
  const parts = stepNodeOf(nodeId).node.split(":");
  if (parts.length >= 3) {
    const index = Number(parts[parts.length - 2]);
    return {
      stepId: parts[parts.length - 1] ?? nodeId,
      index: Number.isInteger(index) ? index : null,
    };
  }
  return { stepId: parts[0] ?? nodeId, index: null };
}

function waitingText(step: AnyStep | undefined, nodeType: string): string {
  if (nodeType === "confer") return "Waiting for an answer";
  if (step?.kind === "person" || nodeType === "person") {
    return step?.kind === "person" && step.mode === "ask"
      ? "Waiting for an answer"
      : "Waiting for approval";
  }
  if (step?.kind === "conversation") return "Waiting for a reply";
  return "Waiting for approval";
}

/** A write step that waits for approval (the default; only the operator turns it off). */
function needsApproval(step: AnyStep): boolean {
  if (step.kind === "action") return (step.approval?.required ?? "required") !== "not_required";
  if (step.kind === "write") return step.checks?.approval?.required !== "not_required";
  return false;
}

/** A step's kind in a word, in the schema's own words (v4: the builder's). */
function kindWord(step: AnyStep | undefined, nodeType: string, v4: boolean): string {
  const kind = step?.kind ?? nodeType;
  if (v4) return PROCESS_KIND_LABEL[kind as keyof typeof PROCESS_KIND_LABEL] ?? nodeType;
  return KIND_LABEL[kind as keyof typeof KIND_LABEL] ?? nodeType;
}

const CHECK_WORD: Record<string, string> = { confer: "Confer", notify: "Notify" };

export function checklistRows(input: {
  workflow: RanWorkflow | null;
  steps: readonly StepRunLike[];
  runStartedAt: string | null;
  runCreatedAt: string;
  going: boolean;
}): RunStepRow[] {
  const { workflow, steps } = input;
  const v4 = workflow?.schemaVersion === 4;
  const locations = new Map<string, { step: AnyStep; pointer: (string | number)[] }>(
    !workflow
      ? []
      : workflow.schemaVersion === 4
        ? processes.allSteps(workflow).map((l) => [l.step.id, l])
        : allSteps(workflow).map((l) => [l.step.id, l]),
  );
  const firstTrigger = workflow
    ? workflow.schemaVersion === 4
      ? workflow.triggers[0]
      : workflow.trigger
    : undefined;
  const rows: RunStepRow[] = [
    {
      key: "trigger",
      kind: KIND_LABEL.trigger,
      title: firstTrigger ? triggerTitle(firstTrigger) : "Started",
      detail: null,
      status: input.runStartedAt ? "succeeded" : "pending",
      at: input.runStartedAt ?? input.runCreatedAt,
      costUsd: null,
      stepRunId: null,
      internal: false,
    },
  ];
  let reached = -1;
  for (const s of steps) {
    const { stepId, index } = parseNodeId(s.nodeId);
    const check = checkKindOf(s.nodeId);
    const loc = locations.get(stepId);
    const step = loc?.step;
    const top = loc?.pointer[1];
    if (typeof top === "number") reached = Math.max(reached, top);
    rows.push({
      key: s.id,
      kind: check ? (CHECK_WORD[check] ?? check) : kindWord(step, s.nodeType, v4),
      title: `${step?.name ?? stepId}${index === null ? "" : ` · item ${index + 1}`}`,
      // A waiting step says what it waits for, not its stored line: lines written before steps
      // read by their state carried the done label ("Itemized the bill: waiting for approval").
      detail: s.status === "waiting" ? waitingText(step, s.nodeType) : s.summary,
      status: s.status,
      at: s.finishedAt ?? s.startedAt,
      costUsd: s.costUsd,
      stepRunId: s.id,
      // A confer shows on the client's timeline with its step; other check rows don't.
      internal: step ? !shownOnTimeline(step) || (!!check && check !== "confer") : true,
      check,
    });
  }
  if (input.going && workflow) {
    const top: readonly AnyStep[] = workflow.steps;
    top.forEach((step, i) => {
      if (i <= reached) return;
      rows.push({
        key: `pending:${step.id}`,
        kind: kindWord(step, step.kind, v4),
        title: step.name,
        // A write that will wait for a person says so before it runs.
        detail: needsApproval(step) ? "Needs approval" : null,
        status: "pending",
        at: null,
        costUsd: null,
        stepRunId: null,
        internal: !shownOnTimeline(step),
      });
    });
  }
  return rows;
}
