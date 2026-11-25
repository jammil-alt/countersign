// What blocks publishing a workflow in the step model (docs/step-model-plan.md §13a, "Checked at
// publish"), each as a plain message on the step it is about. Pure: the builder shows these as
// they arise, and publishing refuses a workflow that has any.

import { type MatchProfile, matchSettingsProblems } from "./match-profile";
import type { DoneBy, DoStep, Step, Uses, Workflow } from "./schema";

export interface StepIssue {
  /** The step (or output) it is about; absent: the workflow as a whole. */
  at?: string | undefined;
  code: StepIssueCode;
  message: string;
}

export type StepIssueCode =
  | "duplicate_id"
  | "no_end"
  | "unknown_output"
  | "output_never_delivered"
  | "not_built_yet"
  | "done_by_required"
  | "done_by_with_automation"
  | "uses_not_allowed"
  | "instructions_missing"
  | "instructions_not_for_done_by"
  | "loop_writes"
  | "input_missing"
  | "unknown_profile"
  | "match_settings";

/** What the validator may know of the registries; each part optional. */
export interface StepContext {
  /** An action's kind: Get (`none`), Save (`internal`), Change or Send (`external`). */
  sideEffect?(action: string): "none" | "internal" | "external" | undefined;
  /** The input fields an action or a skill requires. */
  requiredInput?(uses: Uses): readonly string[] | undefined;
  /** A match profile by its id. */
  profile?(id: string): MatchProfile | undefined;
}

/** Which `uses` each `doneBy` allows (§4, "How a Do step runs"). */
const ALLOWED: Record<DoneBy, readonly (Uses["type"] | "none")[]> = {
  rules: ["action", "skill", "match", "tell", "none"],
  ai: ["skill", "none"],
  person: ["collect", "none"],
  contact: ["none"],
};

const INSTRUCTIONS = ["rules", "ai", "person", "collect", "contact", "tell"] as const;

export function validateWorkflow(workflow: Workflow, context: StepContext = {}): StepIssue[] {
  const issues: StepIssue[] = [];
  const seen = new Set<string>();
  const outputs = new Set(workflow.outputs.map((o) => o.id));
  const delivered = new Set<string>();

  for (const o of workflow.outputs) {
    if (seen.has(o.id)) {
      issues.push({ at: o.id, code: "duplicate_id", message: `"${o.id}" is used twice` });
    }
    seen.add(o.id);
  }

  const visit = (list: readonly Step[]) => {
    for (const step of list) {
      if (seen.has(step.id)) {
        issues.push({ at: step.id, code: "duplicate_id", message: `"${step.id}" is used twice` });
      }
      seen.add(step.id);
      switch (step.kind) {
        case "do":
          issues.push(...doIssues(step, context));
          break;
        case "loop":
          for (const action of step.reads) {
            const effect = context.sideEffect?.(action);
            if (effect !== undefined && effect !== "none") {
              issues.push({
                at: step.id,
                code: "loop_writes",
                message: `A Loop only reads: "${action}" changes something. Save what it decides in a step after it.`,
              });
            }
          }
          break;
        case "end":
          for (const id of step.outputs) {
            if (!outputs.has(id)) {
              issues.push({
                at: step.id,
                code: "unknown_output",
                message: `"${id}" isn't one of this workflow's outputs`,
              });
            } else {
              delivered.add(id);
            }
          }
          break;
        case "fork":
          for (const p of step.paths) {
            seen.add(p.id);
            visit(p.steps);
          }
          seen.add(step.otherwise.id);
          visit(step.otherwise.steps);
          break;
        case "for_each":
        case "repeat":
          visit(step.steps);
          break;
        case "wait":
        case "handoff":
          break;
      }
    }
  };
  visit(workflow.steps);

  if (!endsAlways(workflow.steps)) {
    issues.push({
      code: "no_end",
      message:
        "The workflow can finish without an End. Every path that doesn't rejoin ends on one.",
    });
  }
  for (const o of workflow.outputs) {
    if (!delivered.has(o.id)) {
      issues.push({
        at: o.id,
        code: "output_never_delivered",
        message: `No End delivers "${o.name}". Deliver it, or take it off the list.`,
      });
    }
  }
  return issues;
}

/** Whether a list can't run past its last step: it ends on an End, or on a Fork whose every path does. */
export function endsAlways(list: readonly Step[]): boolean {
  const last = list.at(-1);
  if (!last) return false;
  if (last.kind === "end") return true;
  if (last.kind === "fork") {
    return last.paths.every((p) => endsAlways(p.steps)) && endsAlways(last.otherwise.steps);
  }
  return false;
}

function doIssues(step: DoStep, context: StepContext): StepIssue[] {
  const out: StepIssue[] = [];
  const at = step.id;
  const uses = step.uses?.type ?? "none";
  if (step.uses?.type === "missing") {
    out.push({ at, code: "not_built_yet", message: `Not built yet: ${step.uses.need}` });
    return out;
  }
  if (step.uses?.type === "automation") {
    if (step.doneBy !== undefined) {
      out.push({
        at,
        code: "done_by_with_automation",
        message: "An automation's own steps say who does each; this step doesn't.",
      });
    }
    return out;
  }
  if (step.doneBy === undefined) {
    out.push({ at, code: "done_by_required", message: "Say who does it: rules, AI or a person." });
    return out;
  }
  if (!ALLOWED[step.doneBy].includes(uses)) {
    out.push({
      at,
      code: "uses_not_allowed",
      message: usesMessage(step.doneBy, uses),
    });
  }
  // The instructions it carries must be its own done-by's.
  const own =
    step.doneBy === "person" && uses === "collect"
      ? "collect"
      : step.doneBy === "rules" && uses === "tell"
        ? "tell"
        : step.doneBy === "contact"
          ? "contact"
          : step.doneBy;
  for (const key of INSTRUCTIONS) {
    if (key !== own && step[key] !== undefined) {
      out.push({
        at,
        code: "instructions_not_for_done_by",
        message: `This step is done by ${words(step.doneBy)}; it can't carry ${key} instructions.`,
      });
    }
  }
  // Written in the step, the instructions are the work: they can't be left out.
  const needs =
    (own === "rules" && uses === "none" && !step.rules?.rows?.length) ||
    (own === "ai" && uses === "none" && !step.ai?.text?.trim()) ||
    (own === "person" && !step.person) ||
    (own === "collect" && !step.collect) ||
    (own === "contact" && !step.contact) ||
    (own === "tell" && !step.tell);
  if (needs) {
    out.push({
      at,
      code: "instructions_missing",
      message:
        own === "rules"
          ? "Add the rule rows, or pick what it uses."
          : own === "ai"
            ? "Say what the AI does, or pick a skill."
            : "Fill in who is asked and what.",
    });
  }
  if (step.uses?.type === "match" && context.profile) {
    const profile = context.profile(step.uses.match.to);
    if (!profile) {
      out.push({
        at,
        code: "unknown_profile",
        message: `Nothing can be matched to "${step.uses.match.to}"`,
      });
    } else {
      for (const problem of matchSettingsProblems(step.uses.match, profile)) {
        out.push({ at, code: "match_settings", message: `${problem}.` });
      }
    }
  }
  if (step.uses) {
    const required = context.requiredInput?.(step.uses) ?? [];
    const mapped = new Set([
      ...Object.keys(step.input),
      ...(step.translation?.fields ?? []).map((f) => f.name),
    ]);
    for (const field of required) {
      if (!mapped.has(field)) {
        out.push({
          at,
          code: "input_missing",
          message: `Doesn't fit: nothing gives "${field}", which this step needs.`,
        });
      }
    }
  }
  return out;
}

function words(doneBy: DoneBy): string {
  return { rules: "rules", ai: "AI", person: "a person", contact: "an outside contact" }[doneBy];
}

function usesMessage(doneBy: DoneBy, uses: string): string {
  if (uses === "action") {
    return `${doneBy === "ai" ? "AI" : "A person"} doesn't use actions: a Rules step after it does the saving or sending.`;
  }
  if (uses === "match") return "A Match is done by rules (with AI inside where it is semantic).";
  if (uses === "collect") return "Collect reports is done by people.";
  return `${words(doneBy)} can't use a ${uses}.`;
}
