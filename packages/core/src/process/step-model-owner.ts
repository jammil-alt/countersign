// The owner (the supervisor) on a v5 workflow, for the builder (owner, 2026-11-27: "show the
// supervisor agent on the steps"): which steps it watches, which are checkpoints, and which it will
// review after they succeed at a given level. Checkpoints are v4's rule (`processCheckpoints`), run
// over each v5 step as the engine step it runs as (the shape `loadStepModel` in packages/workflows
// gives it: a Do by `doEngine`, a Loop as a skill), so the rule has one copy. Pure.

import {
  type OversightReview,
  type OwnerReviewDue,
  ownerWatches,
  successReviewDue,
} from "../oversight/decision";
import type { ToolSpec } from "../schemas/tool";
import type { ActionKind } from "../steps/catalog";
import { type DoEngine, DoEngineError, doEngine, ENGINE_OUTCOMES } from "../steps/engine";
import type { Step, Workflow } from "../steps/schema";
import { eachStep } from "../steps/walk";
import type { TypingContext } from "../template/typer";
import { type ProcessCheckpointContext, processCheckpoints } from "./owner";
import type { Process } from "./schema";

/** What the helpers read: each action's kind (the catalog's), and the skills when known. */
export interface StepModelOwnerContext extends Pick<TypingContext, "skills"> {
  kindOf(action: string): ActionKind | undefined;
}

/** A Do step's engine, or null where a draft has none yet (it runs nothing, so nothing is watched). */
function engineOf(
  step: Extract<Step, { kind: "do" }>,
  ctx: StepModelOwnerContext,
): DoEngine | null {
  try {
    return doEngine(step, ctx.kindOf);
  } catch (error) {
    if (error instanceof DoEngineError) return null;
    throw error;
  }
}

/** The engine step kind a v5 step runs as (`ENGINE_OUTCOMES`; a Loop is a skill). */
function engineKind(step: Step, ctx: StepModelOwnerContext): string {
  switch (step.kind) {
    case "do": {
      const e = engineOf(step, ctx);
      return e ? ENGINE_OUTCOMES[e.engine] : "missing";
    }
    case "loop":
      return "skill";
    default:
      return step.kind;
  }
}

/** Whether the owner watches a v5 step: one that runs as a read, a skill, a write or a conversation. */
export function stepModelWatched(step: Step, ctx: StepModelOwnerContext): boolean {
  return (
    (step.kind === "do" || step.kind === "loop") && ownerWatches({ kind: engineKind(step, ctx) })
  );
}

// The skill refs `loadStepModel` gives a step written in the step, a Match and a Loop. Only their
// kind matters to the rule (none of them is a Library skill that reaches people).
const WRITTEN = "steps.written";
const MATCH = "steps.match";
const LOOP = "steps.loop";

/**
 * A v5 step as the engine step the checkpoint rule reads: its kind, id, `review`, what it calls
 * and the templates it hands on (`input`, a conversation's `with` and `goal`).
 */
function asEngineStep(
  step: Step,
  ctx: StepModelOwnerContext,
  tools: Record<string, ToolSpec>,
): unknown {
  const base = { id: step.id, name: step.name, ...(step.review ? { review: step.review } : {}) };
  const list = (steps: readonly Step[]) => steps.map((s) => asEngineStep(s, ctx, tools));
  switch (step.kind) {
    case "do": {
      const e = engineOf(step, ctx);
      const input = step.input;
      if (!e) return { ...base, kind: "missing" };
      switch (e.engine) {
        case "read":
          return { ...base, kind: "read", tool: e.action, input };
        case "write": {
          // A write's tool by its catalog kind: a Save is to our own records (internal), a Change
          // or a Send to the client's tools or people (external), as `steps.actionKind` reads it.
          // DECISION: an action the catalog doesn't know gets no spec here, so it makes no
          // checkpoint, as a tool the run's catalog doesn't know makes none (`processCheckpoints`).
          const kind = ctx.kindOf(e.action);
          if (kind && kind !== "get") {
            tools[e.action] = {
              id: e.action,
              sideEffect: kind === "save" ? "internal" : "external",
            } as ToolSpec;
          }
          return { ...base, kind: "write", tool: e.action, input };
        }
        case "rules":
        case "ai":
          return { ...base, kind: "skill", skill: e.skill ?? WRITTEN, input };
        case "match":
          return { ...base, kind: "skill", skill: MATCH, input };
        case "contact":
          return {
            ...base,
            kind: "conversation",
            with: step.contact?.with ?? "",
            goal: step.contact?.goal ?? "",
          };
        case "automation":
          return { ...base, kind: "process", process: e.automation, input };
        default:
          return { ...base, kind: ENGINE_OUTCOMES[e.engine] };
      }
    }
    case "loop":
      return { ...base, kind: "skill", skill: step.skill ?? LOOP, input: step.input };
    case "fork":
      return {
        ...base,
        kind: "if",
        paths: step.paths.map((p) => ({ id: p.id, name: p.name, steps: list(p.steps) })),
        otherwise: { id: step.otherwise.id, steps: list(step.otherwise.steps) },
      };
    case "for_each":
      return { ...base, kind: "for_each", steps: list(step.steps) };
    case "repeat":
      return { ...base, kind: "repeat", steps: list(step.steps) };
    case "wait":
      return { ...base, kind: "wait" };
    case "handoff":
      return { ...base, kind: "handoff" };
    case "end":
      return { ...base, kind: "stop" };
  }
}

/**
 * A v5 workflow's checkpoints (v4's `processCheckpoints` over its engine steps): every watched step
 * whose output feeds a step that writes to a client's tool or reaches people, and every watched
 * step set to `always`. An automation's inner steps aren't listed (the builder doesn't show them).
 */
export function stepModelCheckpoints(
  workflow: Pick<Workflow, "steps">,
  ctx: StepModelOwnerContext,
): string[] {
  const tools: Record<string, ToolSpec> = {};
  const steps = workflow.steps.map((s) => asEngineStep(s, ctx, tools));
  const typing: ProcessCheckpointContext = { tools, ...(ctx.skills ? { skills: ctx.skills } : {}) };
  return processCheckpoints({ steps } as unknown as Pick<Process, "steps">, typing);
}

/**
 * The steps the owner reviews after they succeed, by id, with why (`successReviewDue`): `always`
 * on the step, `all` on the agent, or a checkpoint under `checkpoints`. A failure is reviewed on
 * every watched step under any level but `off` (or the step's own `off`), so it isn't listed.
 */
export function supervisedSteps(
  workflow: Pick<Workflow, "steps">,
  review: OversightReview,
  ctx: StepModelOwnerContext,
): Map<string, OwnerReviewDue> {
  const checkpoints = new Set(stepModelCheckpoints(workflow, ctx));
  const out = new Map<string, OwnerReviewDue>();
  eachStep(workflow.steps, ({ step }) => {
    if (!stepModelWatched(step, ctx)) return;
    const due = successReviewDue({ review }, step, checkpoints.has(step.id));
    if (due) out.set(step.id, due);
  });
  return out;
}
