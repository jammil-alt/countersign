import { checkKindOf, steps as stepModel, stepNodeOf } from "@countersign/core";
import { KIND_LABEL, triggerTitle } from "../workflow/describe";

/** The workflow that ran: a stored step-model workflow (`schemaVersion: 5`). */
export type RanWorkflow = stepModel.Workflow;

type AnyStep = stepModel.Step;

/** The workflow definition a run names; null when it doesn't read as one. */
export function ranWorkflow(definition: unknown): RanWorkflow | null {
  const parsed = stepModel.Workflow.safeParse(definition);
  return parsed.success ? parsed.data : null;
}

/**
 * Whether the client's timeline shows a step: its `client` setting, else the work and the people
 * (a Do or a hand-off), never the logic.
 */
function shownOnTimeline(step: AnyStep): boolean {
  if (step.client) return step.client.visible;
  return step.kind === "do" || step.kind === "handoff";
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

/**
 * `loop:2:child` → the child step's id and the item index (0-based); v0.17's `repeat:r2:child` →
 * the child and its pass (from 1). A check's suffix ignored.
 */
export function parseNodeId(nodeId: string): {
  stepId: string;
  index: number | null;
  pass?: number;
} {
  const parts = stepNodeOf(nodeId).node.split(":");
  if (parts.length >= 3) {
    const stepId = parts[parts.length - 1] ?? nodeId;
    const seg = parts[parts.length - 2] ?? "";
    if (/^r\d+$/.test(seg)) return { stepId, index: null, pass: Number(seg.slice(1)) };
    const index = Number(seg);
    return { stepId, index: Number.isInteger(index) ? index : null };
  }
  return { stepId: parts[0] ?? nodeId, index: null };
}

function waitingText(step: AnyStep | undefined, nodeType: string): string {
  if (nodeType === "confer") return "Waiting for an answer";
  if (step?.kind === "do" && step.doneBy === "person") {
    return step.person?.mode === "ask" ? "Waiting for an answer" : "Waiting for approval";
  }
  if (step?.kind === "do" && step.doneBy === "contact") return "Waiting for a reply";
  return "Waiting for approval";
}

/** A step whose settings say it waits for approval. */
function needsApproval(step: AnyStep): boolean {
  return step.kind === "do" && step.checks?.approval?.required === "required";
}

/** A step's kind in a word, in the builder's words. */
function kindWord(step: AnyStep | undefined, nodeType: string): string {
  const kind = step?.kind ?? nodeType;
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
  // Each step by id, with the index of the top-level step it sits in.
  const locations = new Map<string, { step: AnyStep; top: number }>();
  workflow?.steps.forEach((top, i) => {
    stepModel.eachStep([top], ({ step }) => locations.set(step.id, { step, top: i }));
  });
  const firstTrigger = workflow?.triggers[0];
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
    const { stepId, index, pass } = parseNodeId(s.nodeId);
    const check = checkKindOf(s.nodeId);
    const loc = locations.get(stepId);
    const step = loc?.step;
    if (loc) reached = Math.max(reached, loc.top);
    rows.push({
      key: s.id,
      kind: check ? (CHECK_WORD[check] ?? check) : kindWord(step, s.nodeType),
      title: `${step?.name ?? stepId}${index === null ? "" : ` · item ${index + 1}`}${pass === undefined ? "" : ` · pass ${pass}`}`,
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
        kind: kindWord(step, step.kind),
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
