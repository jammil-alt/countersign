// How the chart draws a step-model workflow (docs/step-model-plan.md §4; stream B). The chart,
// its layout and the dragging of boxes are the builder's (`../../flow`), written over the v4 process
// and used as they are (plan §2, principle 6: same screens). They read a step's shape (a decision's
// paths, a loop's block, a Stop's pill) and ask the host for each box's words (`label`), so this file
// hands them the nearest v4 shape for each v5 kind and the words from the v5 step.
//
// DECISION: a display adapter, not a port of the chart. The step ids, names, paths and nesting are
// the workflow's own, so a click on a box finds its v5 step by id and nothing is converted back.
// Wave 4 deletes v4 and moves `layout` and `Chart` onto `steps.Step`; then this file goes.

import type { processes, steps } from "@countersign/core";
import { actionPath, type UsesContext, usesLabel } from "./options";
import type { Step, Workflow } from "./types";

type V4 = processes.Step;
type V4Process = processes.Process;

const HERE = "";

/** A v5 step as the chart's layout reads it: the nearest v4 kind, the ids and nesting as they are. */
export function displayStep(step: Step, ctx: UsesContext): V4 {
  const base = {
    id: step.id,
    name: step.name,
    ...(step.client ? { client: step.client } : {}),
    ...(step.purpose ? { purpose: step.purpose } : {}),
  };
  switch (step.kind) {
    case "fork":
      return {
        ...base,
        kind: "if",
        paths: step.paths.map((p) => ({ ...p, steps: p.steps.map((s) => displayStep(s, ctx)) })),
        otherwise: {
          id: step.otherwise.id,
          steps: step.otherwise.steps.map((s) => displayStep(s, ctx)),
        },
      } as V4;
    case "for_each":
      return {
        ...base,
        kind: "for_each",
        over: step.over,
        concurrency: step.concurrency,
        steps: step.steps.map((s) => displayStep(s, ctx)),
      } as V4;
    case "repeat":
      return {
        ...base,
        kind: "repeat",
        until: step.until,
        maxTimes: step.maxTimes,
        onLimit: step.onLimit,
        steps: step.steps.map((s) => displayStep(s, ctx)),
      } as V4;
    case "wait":
      return { ...base, kind: "wait", for: step.for } as V4;
    case "handoff":
      return { ...base, kind: "handoff", to: step.to, input: step.input } as V4;
    case "end":
      return { ...base, kind: "stop", status: step.status } as V4;
    case "loop":
      return {
        ...base,
        kind: "skill",
        skill: step.skill ?? "",
        input: step.input,
      } as unknown as V4;
    case "do":
      return { ...base, ...doShape(step, ctx) } as V4;
  }
}

/** The v4 kind a Do step is drawn as, with the few fields the chart reads off it. */
function doShape(step: Extract<Step, { kind: "do" }>, ctx: UsesContext): Record<string, unknown> {
  const uses = step.uses;
  if (uses?.type === "missing") return { kind: "missing", need: uses.need };
  if (uses?.type === "automation") return { kind: "process", process: uses.automation, input: {} };
  if (uses?.type === "collect" || (step.doneBy === "person" && step.collect)) {
    return { kind: "collect", channel: "inbox" };
  }
  if (step.doneBy === "person") {
    return {
      kind: "person",
      mode: step.person?.mode ?? "ask",
      channel: step.person?.channel ?? "inbox",
    };
  }
  if (step.doneBy === "contact") {
    return { kind: "conversation", channel: step.contact?.channel ?? "email" };
  }
  if (uses?.type === "tell") return { kind: "notify" };
  if (uses?.type === "action") {
    const kind = ctx.actions.get(uses.action)?.kind ?? "change";
    return { kind: kind === "get" ? "read" : "write", tool: uses.action, input: {} };
  }
  return { kind: "skill", skill: uses?.type === "skill" ? uses.skill : HERE, input: {} };
}

/** The chart's process: the triggers as they are and every step drawn. */
export function displayProcess(workflow: Workflow, ctx: UsesContext): V4Process {
  return {
    schemaVersion: 4,
    triggers: workflow.triggers,
    steps: workflow.steps.map((s) => displayStep(s, ctx)),
  } as V4Process;
}

/** The words on a box: its goal, its kind, and what it uses, as the chart's `label` takes them. */
export interface BoxWords {
  title: string;
  kind: string;
  detail: string | null;
  skillKind?: string;
  model?: string;
  connector?: { id: string; name: string };
  does?: string;
  purpose?: string;
}

const KIND_WORDS: Record<steps.StepKind, string> = {
  do: "Do",
  loop: "Loop",
  fork: "Fork",
  for_each: "For each",
  repeat: "Repeat",
  wait: "Wait",
  handoff: "Hand off",
  end: "End",
};

const DONE_BY_WORDS = { rules: "Rules", ai: "AI", person: "Person", contact: "Outside contact" };

/** The words for a v5 step's box, from the step and what it uses. */
export function boxWords(
  step: Step,
  ctx: UsesContext,
  workflow?: Pick<Workflow, "outputs">,
): BoxWords {
  const kind = KIND_WORDS[step.kind];
  const title = step.name.trim() || `New ${kind.toLowerCase()}`;
  const purpose = step.purpose ? { purpose: step.purpose } : {};
  switch (step.kind) {
    case "do": {
      const a = step.uses?.type === "action" ? ctx.actions.get(step.uses.action) : undefined;
      const detail = step.uses
        ? usesLabel(step, ctx)
        : step.doneBy
          ? `Done by ${DONE_BY_WORDS[step.doneBy].toLowerCase()}`
          : "Not chosen yet";
      return {
        title,
        kind: step.doneBy ? `Do · ${DONE_BY_WORDS[step.doneBy]}` : kind,
        detail,
        ...(step.doneBy === "ai" ? { skillKind: "AI" } : {}),
        ...(step.ai?.model ? { model: step.ai.model.id } : {}),
        ...(a ? { connector: { id: a.groupId, name: a.groupName }, does: actionPath(a) } : {}),
        ...purpose,
      };
    }
    case "loop":
      return { title, kind, detail: step.goal || null, skillKind: "AI", ...purpose };
    case "end": {
      const names = step.outputs
        .map((id) => workflow?.outputs.find((o) => o.id === id)?.name)
        .filter((n): n is string => !!n);
      return {
        title: step.name.trim() || "End",
        kind,
        detail:
          names.length > 0
            ? names.join(", ")
            : step.nothingToDo
              ? `Nothing to do: ${step.nothingToDo}`
              : "Not filled in yet",
        ...purpose,
      };
    }
    default:
      return { title, kind, detail: null, ...purpose };
  }
}
