// What stops a workflow being published, each on the step it is about, in plain words (§13a,
// "Checked at publish").
// - The step builder shows the server's answer (`issuesFromServer`, from `opsWorkflowCheck`): the
//   same check a save and a publish run, with everything the server knows (one checker, staging
//   2026-11-28: the page's own copy, with what the browser had loaded, flagged issues the server
//   didn't have and blocked Try it).
// - `workflowIssues` is core's `validateWorkflow` with what a screen loaded put in, plus a few the
//   form itself leaves open; only Check the steps still reads it. Pure.

import { steps } from "@countersign/core";
import { walk } from "./model";
import { requiredInput, type UsesContext } from "./options";
import type { StepIssue, Workflow } from "./types";

/**
 * An issue's code: core's step check's (`steps.StepIssueCode`), the publish check's own
 * (`ProcessValidationCode`: `handoff_unknown_agent`, `invalid_cron`, …) or the form's.
 */
export type BuilderIssueCode =
  | steps.StepIssueCode
  | "fork_path_unnamed"
  | "for_each_list_missing"
  | "repeat_goal_missing"
  | "handoff_target_missing"
  | (string & {});

export interface BuilderIssue extends Omit<StepIssue, "code"> {
  code: BuilderIssueCode;
}

/** A publish error as the server sends it (`ValidationErrorSchema`). */
export interface ServerError {
  stepId: string | null;
  field: string;
  code: string;
  message: string;
  workflow?: string | undefined;
  stepCode?: string | undefined;
}

/**
 * The server's publish errors for a bundle as the issues of one of its workflows: that workflow's
 * own and the bundle's (they stop its publish too), each on its step, with the step check's code
 * where it has one.
 */
export function issuesFromServer(errors: readonly ServerError[], slug: string): BuilderIssue[] {
  return errors
    .filter((e) => e.workflow === undefined || e.workflow === slug)
    .map((e) => ({
      ...(e.stepId ? { at: e.stepId } : {}),
      code: (e.code === "step_model" && e.stepCode) || e.code,
      message: e.message,
    }));
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
  for (const { step } of walk(workflow)) {
    const at = step.id;
    switch (step.kind) {
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
