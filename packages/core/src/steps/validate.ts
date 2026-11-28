// What blocks publishing a workflow in the step model (docs/step-model-plan.md §13a, "Checked at
// publish"), each as a plain message on the step it is about. Pure: the builder shows these as
// they arise, and publishing refuses a workflow that has any.

import { type MatchProfile, matchSettingsProblems } from "./match-profile";
import type { DoneBy, DoStep, Step, Uses, Workflow, WorkflowOutput } from "./schema";
import { type ShapeContext, workflowWiring } from "./wiring";

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
  | "match_settings"
  | "goal_missing"
  | "end_empty"
  | "empty_container"
  | "no_outputs"
  | "output_incomplete"
  // The wiring between steps (`./wiring`): a reference to something its source doesn't hand on,
  // a value that doesn't fit the field it fills, a Match's items without a field it needs.
  | "reference_unknown"
  | "reference_type"
  | "match_item_missing";

/**
 * What the validator may know of the registries; each part optional. The shapes (`ShapeContext`:
 * what actions, skills and triggers take and hand on) are what the wiring checks follow
 * references into; what isn't given isn't known, and a reference into it passes.
 */
export interface StepContext extends ShapeContext {
  /** An action's kind: Get (`none`), Save (`internal`), Change or Send (`external`). */
  sideEffect?(action: string): "none" | "internal" | "external" | undefined;
  /** The input fields an action or a skill requires. */
  requiredInput?(uses: Uses): readonly string[] | undefined;
  /** A match profile by its id. */
  profile?(id: string): MatchProfile | undefined;
  /**
   * Whether the wiring between steps is checked (default: yes). The run's load leaves it out: a
   * version published before a check existed still loads, and what it reads is the run's to find.
   */
  wiring?: boolean;
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

  // DECISION (wave 1, stream B): the schema parses a draft as it is being built (an End not filled
  // in, a step with no goal yet, an empty For each); what a published workflow must have is held
  // here, so a draft saves and publishing refuses it.
  if (workflow.outputs.length === 0) {
    issues.push({ code: "no_outputs", message: "Say what this workflow produces: add an output." });
  }
  for (const o of workflow.outputs) {
    if (seen.has(o.id)) {
      issues.push({ at: o.id, code: "duplicate_id", message: `"${o.id}" is used twice` });
    }
    seen.add(o.id);
    const missing = outputMissing(o);
    if (missing) issues.push({ at: o.id, code: "output_incomplete", message: missing });
  }

  const visit = (list: readonly Step[]) => {
    for (const step of list) {
      if (seen.has(step.id)) {
        issues.push({ at: step.id, code: "duplicate_id", message: `"${step.id}" is used twice` });
      }
      seen.add(step.id);
      if (!step.name.trim()) {
        issues.push({ at: step.id, code: "goal_missing", message: "Say what this step does." });
      }
      switch (step.kind) {
        case "do":
          issues.push(...doIssues(step, context));
          break;
        case "loop":
          if (!step.goal.trim()) {
            issues.push({
              at: step.id,
              code: "goal_missing",
              message: "Say what 'done' means for this Loop.",
            });
          }
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
          if (step.outputs.length === 0 && !step.nothingToDo?.trim()) {
            issues.push({
              at: step.id,
              code: "end_empty",
              message: "Pick what this End delivers, or say why there is nothing to do.",
            });
          }
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
          if (step.steps.length === 0) {
            issues.push({
              at: step.id,
              code: "empty_container",
              message: "Add the steps it runs.",
            });
          }
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
  if (context.wiring !== false) issues.push(...workflowWiring(workflow, context).issues);
  return issues;
}

/** What an output still needs before it can be delivered, in plain words; null when complete. */
function outputMissing(o: WorkflowOutput): string | null {
  if (!o.name.trim()) return "Name this output.";
  switch (o.kind) {
    case "report":
      if (!o.report) return "Say who gets this report and what it says.";
      if (o.report.to.length === 0) return "Say who gets this report.";
      return o.report.message.trim() ? null : "Say what this report says.";
    case "write":
    case "save":
      return o.action ? null : "Pick the action that delivers this output.";
    case "handoff":
      return o.handoff ? null : "Pick the agent or workflow this hands off to.";
    case "pass_on":
      return o.passOn ? null : "Say what is passed on.";
    case "nothing":
      return null;
  }
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
    const mapped = new Set([
      ...Object.keys(step.input),
      ...(step.translation?.fields ?? []).map((f) => f.name),
    ]);
    // A Match given a list (`items`) matches each item: the profile's fields are each item's, or
    // given beside the list for every item (`vendorId`), so they aren't asked for here (staging,
    // 2026-11-28: a SKU match on an invoice's lines read "nothing gives sku").
    const perItem = step.uses.type === "match" && mapped.has("items");
    const required = perItem ? [] : (context.requiredInput?.(step.uses) ?? []);
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
