// What stops a workflow being published, each on the step it is about, in plain words (§13a,
// "Checked at publish"): core's `validateWorkflow`, with the parts the builder knows (the action
// catalog, the skills, the match profiles) put in, plus what the form itself leaves open: a step with
// no goal, an End that delivers nothing, a Loop with no goal. Pure.

import { steps } from "@countersign/core";
import { walk } from "./model";
import { requiredInput, type UsesContext } from "./options";
import type { StepIssue, Workflow } from "./types";

/** The builder's own codes, beside core's. */
export type BuilderIssueCode =
  | steps.StepIssueCode
  | "goal_missing"
  | "end_empty"
  | "end_reason_missing"
  | "fork_path_unnamed"
  | "for_each_list_missing"
  | "repeat_goal_missing"
  | "handoff_target_missing"
  | "output_unnamed"
  | "output_incomplete";

export interface BuilderIssue extends Omit<StepIssue, "code"> {
  code: BuilderIssueCode;
}

/** The registries core's validator reads, from what the builder was given. */
export function stepContext(ctx: UsesContext): steps.StepContext {
  return {
    sideEffect(action) {
      const kind = ctx.actions.get(action)?.kind;
      if (kind === undefined) return undefined;
      return kind === "get" ? "none" : kind === "save" ? "internal" : "external";
    },
    requiredInput: (uses) => requiredInput(uses, ctx),
    profile: (id) => ctx.profiles.find((p) => p.id === id),
  };
}

export function workflowIssues(workflow: Workflow, ctx: UsesContext): BuilderIssue[] {
  const issues: BuilderIssue[] = [...steps.validateWorkflow(workflow, stepContext(ctx))];
  for (const o of workflow.outputs) {
    if (!o.name.trim()) {
      issues.push({ at: o.id, code: "output_unnamed", message: "Name this output." });
    }
    const incomplete =
      o.kind === "report"
        ? !o.report || o.report.to.length === 0
          ? "Say who gets this report."
          : null
        : o.kind === "write" || o.kind === "save"
          ? !o.action?.action
            ? `Pick what it ${o.kind === "write" ? "writes" : "saves"}.`
            : null
          : o.kind === "handoff"
            ? !o.handoff?.step
              ? "Pick where it hands off to."
              : null
            : null;
    if (incomplete) issues.push({ at: o.id, code: "output_incomplete", message: incomplete });
  }
  for (const { step } of walk(workflow)) {
    const at = step.id;
    switch (step.kind) {
      case "do":
        // A step with nothing chosen yet says so once, on "Who does it", not here too.
        if (!step.name.trim() && step.uses?.type !== "missing") {
          issues.push({ at, code: "goal_missing", message: "Say what this step does: its goal." });
        }
        break;
      case "loop":
        if (!step.goal.trim()) {
          issues.push({
            at,
            code: "goal_missing",
            message: "Say what the Loop is working toward.",
          });
        }
        break;
      case "end":
        if (step.outputs.length === 0 && step.nothingToDo === undefined) {
          issues.push({
            at,
            code: "end_empty",
            message: "Pick what this End delivers, or say why there is nothing to do.",
          });
        } else if (step.nothingToDo !== undefined && !step.nothingToDo.trim()) {
          issues.push({
            at,
            code: "end_reason_missing",
            message: "Say why there is nothing to do.",
          });
        }
        break;
      case "fork":
        for (const p of step.paths) {
          if (!p.name.trim()) {
            issues.push({ at, code: "fork_path_unnamed", message: "Name each path of this Fork." });
            break;
          }
        }
        break;
      case "for_each":
        if (!step.over.trim()) {
          issues.push({
            at,
            code: "for_each_list_missing",
            message: "Pick the list to go through.",
          });
        }
        break;
      case "repeat":
        if ("agent" in step.until && !step.until.agent.goal.trim()) {
          issues.push({ at, code: "repeat_goal_missing", message: "Say when to stop repeating." });
        }
        break;
      case "handoff":
        if (!step.to.agent) {
          issues.push({
            at,
            code: "handoff_target_missing",
            message: "Pick who this hands off to.",
          });
        }
        break;
      case "wait":
        break;
    }
  }
  return issues;
}

/** Issues by the step (or output) they are about; the workflow's own under `""`. */
export function issuesByStep(issues: readonly BuilderIssue[]): Map<string, BuilderIssue[]> {
  const out = new Map<string, BuilderIssue[]>();
  for (const i of issues) {
    const key = i.at ?? "";
    out.set(key, [...(out.get(key) ?? []), i]);
  }
  return out;
}

/** Publishing is refused while any issue remains. */
export const canPublish = (issues: readonly BuilderIssue[]): boolean => issues.length === 0;

/** "3 things to settle before this can be published." */
export function publishSummary(issues: readonly BuilderIssue[]): string {
  if (issues.length === 0) return "Nothing is left to settle.";
  return `${issues.length} ${issues.length === 1 ? "thing" : "things"} to settle before this can be published.`;
}
