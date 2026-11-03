// The run view's "What it did" checklist (design screen 6; ARCHITECTURE §10.5): the trigger, then
// one row per step the run reached, in order, named from the workflow that ran; while the run is
// going, the top-level steps it has not reached yet follow as not started.
import {
  allSteps,
  isClientVisible,
  type Step,
  type StepLocation,
  type Workflow,
} from "@countersign/core";
import { KIND_LABEL, triggerTitle } from "../workflow/describe";

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

/** `loop:2:child` → the child step's id and the item index (0-based). */
export function parseNodeId(nodeId: string): { stepId: string; index: number | null } {
  const parts = nodeId.split(":");
  if (parts.length >= 3) {
    const index = Number(parts[parts.length - 2]);
    return {
      stepId: parts[parts.length - 1] ?? nodeId,
      index: Number.isInteger(index) ? index : null,
    };
  }
  return { stepId: nodeId, index: null };
}

function waitingText(step: Step | undefined, nodeType: string): string {
  if (step?.kind === "person" || nodeType === "person") {
    return step?.kind === "person" && step.mode === "ask"
      ? "Waiting for an answer"
      : "Waiting for approval";
  }
  return "Waiting for approval";
}

export function checklistRows(input: {
  workflow: Workflow | null;
  steps: readonly StepRunLike[];
  runStartedAt: string | null;
  runCreatedAt: string;
  going: boolean;
}): RunStepRow[] {
  const { workflow, steps } = input;
  const locations = new Map<string, StepLocation>(
    workflow ? allSteps(workflow).map((l) => [l.step.id, l]) : [],
  );
  const rows: RunStepRow[] = [
    {
      key: "trigger",
      kind: KIND_LABEL.trigger,
      title: workflow ? triggerTitle(workflow.trigger) : "Started",
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
    const loc = locations.get(stepId);
    const step = loc?.step;
    const top = loc?.pointer[1];
    if (typeof top === "number") reached = Math.max(reached, top);
    const kind = (step?.kind ?? s.nodeType) as keyof typeof KIND_LABEL;
    rows.push({
      key: s.id,
      kind: KIND_LABEL[kind] ?? s.nodeType,
      title: `${step?.name ?? stepId}${index === null ? "" : ` · item ${index + 1}`}`,
      detail: s.summary ?? (s.status === "waiting" ? waitingText(step, s.nodeType) : null),
      status: s.status,
      at: s.finishedAt ?? s.startedAt,
      costUsd: s.costUsd,
      stepRunId: s.id,
      internal: step ? !isClientVisible(step) : true,
    });
  }
  if (input.going && workflow) {
    workflow.steps.forEach((step, i) => {
      if (i <= reached) return;
      rows.push({
        key: `pending:${step.id}`,
        kind: KIND_LABEL[step.kind],
        title: step.name,
        detail: null,
        status: "pending",
        at: null,
        costUsd: null,
        stepRunId: null,
        internal: !isClientVisible(step),
      });
    });
  }
  return rows;
}
