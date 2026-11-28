// Validating a whole bundle (docs/step-model-plan.md §13a): its schema, the agent's definition, ids
// and slugs unique across the workflows, and each workflow's publish checks. Shared by the builder
// (in the browser) and the server's save and publish checks, so both say the same thing.

import { validateClientView } from "../kpi/validate";
import { AgentBundle } from "../schemas/agent";
import { parseSkillRef } from "../schemas/common";
import { retiredSkillReason, skillWriteTools, toolLookup } from "../skills/kind";
import { mergedAction } from "../steps/catalog";
import { Workflow as StepWorkflow } from "../steps/schema";
import {
  type StepContext,
  type StepIssueCode,
  validateWorkflow as validateStepWorkflow,
} from "../steps/validate";
import { eachStep, stepModelIds } from "../steps/walk";
import { lookupSkill } from "../template/typer";
import { actionInputSchema, type WriteAction } from "./actions";
import {
  definitionModelErrors,
  definitionSkillErrors,
  type ValidationContext,
  type ValidationError,
} from "./checks";
import { stepModelSeatProblems } from "./seats";
import { type HandoffKnown, stepModelHandoffErrors } from "./step-model-handoff";
import {
  stepModelFixedInputErrors,
  stepModelFormErrors,
  stepModelPublishErrors,
  stepModelScheduleErrors,
} from "./step-model-publish";
import { stepModelRefErrors } from "./step-model-refs";
import type { ProcessValidationCode, ProcessValidationContext } from "./validate";

/**
 * A bundle error: the shared shape, with the engines' codes; a v5 workflow's publish check (the step model) is
 * `step_model`, with the check's own code in `stepCode`.
 */
export type BundleValidationError = Omit<ValidationError, "code"> & {
  code: ProcessValidationCode;
  stepCode?: StepIssueCode | undefined;
};

/**
 * What the step model's publish checks know of the registries, from a bundle's validation context:
 * an action's side effect (a merged action's, from the first of its tools there is), and the input
 * an action requires.
 */
// DECISION (step model, wave 1): match profiles are left to stream D; a Match step's settings are
// checked against its profile once the areas declare them.
export function stepContext(ctx: Pick<ValidationContext, "tools">): StepContext {
  const spec = (action: string) => {
    const own = ctx.tools?.[action];
    if (own) return own;
    const merged = mergedAction(action);
    if (!merged) return undefined;
    for (const tool of Object.values(merged.tools)) {
      const s = ctx.tools?.[tool];
      if (s) return s;
    }
    return undefined;
  };
  return {
    sideEffect: (action) => spec(action)?.sideEffect,
    requiredInput: (uses) => {
      if (uses.type !== "action") return undefined;
      const write = MERGED_WRITE_ACTIONS[uses.action];
      const input = write ? actionInputSchema(write) : spec(uses.action)?.input;
      const required = (input as { required?: unknown } | undefined)?.required;
      return Array.isArray(required) ? required.filter((r) => typeof r === "string") : undefined;
    },
  };
}

/**
 * The Accounting, Email and Text actions stand for a write action (`process/actions.ts`): they
 * take its own input, translated to each tool's when they run (`toToolInput`), not their first
 * tool's: what the run refuses an input for is what publishing asks for.
 */
// DECISION (step model, stream J): Email and Text too, as the run's `STEP_MODEL_WRITE_ACTIONS`
// has them; Team chat and Spreadsheets keep their tools' inputs.
const MERGED_WRITE_ACTIONS: Readonly<Record<string, WriteAction>> = {
  "email.send": "send_email",
  "sms.send": "send_text",
  "accounting.bill.create": "create_bill",
  "accounting.vendor.create": "create_vendor",
};

/** Each Do and Loop step's skill ref by step id, in a v5 workflow. */
function stepModelSkillsById(workflow: StepWorkflow): [string, string][] {
  const out: [string, string][] = [];
  eachStep(workflow.steps, ({ step }) => {
    if (step.kind === "do" && step.uses?.type === "skill") out.push([step.id, step.uses.skill]);
    if (step.kind === "loop" && step.skill) out.push([step.id, step.skill]);
  });
  return out;
}

/**
 * Skill model (2026-11-10): a step new in this version (`existingStepIds`: not in the version it
 * was made from, or there with another skill) uses a skill that doesn't write and isn't a retired
 * kind. DECISION: the retired kinds are held to operator-written skills (`custom:`) only, as the
 * engine's check was; the platform's own built-ins are installed from code with their steps.
 * Stored versions and the steps already using a skill keep running (invariant 3).
 */
function newSkillStepErrors(
  workflow: StepWorkflow,
  ctx: Pick<ValidationContext, "skills" | "tools"> & {
    existingStepIds?: ReadonlySet<string> | undefined;
    existingStepSkills?: ReadonlyMap<string, string> | undefined;
  },
): ValidationError[] {
  const { existingStepIds: existing, existingStepSkills: skillsBefore } = ctx;
  if (!existing) return [];
  const errors: ValidationError[] = [];
  for (const [id, ref] of stepModelSkillsById(workflow)) {
    const skillId = parseSkillRef(ref).id;
    const isNew =
      !existing.has(id) || (skillsBefore !== undefined && skillsBefore.get(id) !== skillId);
    const skill = lookupSkill(ref, ctx);
    if (!isNew || !skill) continue;
    const retired = retiredSkillReason(skill);
    if (retired && skillId.startsWith("custom:")) {
      errors.push({ stepId: id, field: "skill", code: "skill_retired", message: retired });
      continue;
    }
    const writes = retired || !ctx.tools ? [] : skillWriteTools(skill, toolLookup(ctx.tools));
    if (writes.length > 0) {
      errors.push({
        stepId: id,
        field: "skill",
        code: "skill_retired",
        message: `Skills never write: "${writes[0]}" changes something. Use the skill that only reads, then a write step.`,
      });
    }
  }
  return errors;
}

export interface BundleValidationResult {
  valid: boolean;
  errors: BundleValidationError[];
  value?: AgentBundle;
}

/**
 * Every trigger, step and path id in a bundle's workflows: what a version made from it
 * already has, so a step not among them is new (`ProcessValidationContext.existingStepIds`).
 */
export function bundleNodeIds(bundle: Pick<AgentBundle, "workflows">): Set<string> {
  const out = new Set<string>();
  for (const w of bundle.workflows) {
    for (const id of stepModelIds(w.workflow)) out.add(id);
  }
  return out;
}

/**
 * Skill model (2026-11-10, review): each skill step's skill id (no `@version`) by step id, in a
 * bundle's workflows: with `bundleNodeIds`, a step that kept its id but changed its
 * skill counts as new (`ProcessValidationContext.existingStepSkills`).
 */
export function bundleStepSkills(bundle: Pick<AgentBundle, "workflows">): Map<string, string> {
  const out = new Map<string, string>();
  for (const w of bundle.workflows) {
    for (const [id, ref] of stepModelSkillsById(w.workflow)) out.set(id, parseSkillRef(ref).id);
  }
  return out;
}

/**
 * Validates a bundle: its schema (errors inside one workflow are named by step and field), then
 * the checks that need a parsed bundle.
 */
export function validateBundle(
  input: unknown,
  // Skill model (2026-11-10): what a client agent's action write steps resolve from at publish.
  ctx: Omit<ValidationContext, "agent"> &
    Pick<ProcessValidationContext, "actions"> & {
      /** Skill model (2026-11-10): the node ids of the version this one was made from. */
      existingStepIds?: ReadonlySet<string>;
      /** Skill model (2026-11-10, review): each skill step's skill id in that version. */
      existingStepSkills?: ReadonlyMap<string, string>;
      /** Hand off: the client's other agents a hand-off can start, and this agent's own slug. */
      handoff?: HandoffKnown;
    } = {},
): BundleValidationResult {
  const parsed = AgentBundle.safeParse(input);
  if (!parsed.success) return { valid: false, errors: schemaErrors(input, parsed.error.issues) };
  const bundle = parsed.data;
  const errors: BundleValidationError[] = [];

  const slugs = new Set<string>();
  bundle.workflows.forEach((w, i) => {
    if (slugs.has(w.slug)) {
      errors.push({
        stepId: null,
        field: `workflows.${i}.slug`,
        code: "duplicate_slug",
        message: `workflow slug "${w.slug}" is used more than once`,
      });
    }
    slugs.add(w.slug);
  });
  const skillIds = new Set<string>();
  bundle.definition.skills.forEach((s, i) => {
    const id = parseSkillRef(s.skill).id;
    if (skillIds.has(id)) {
      errors.push({
        stepId: null,
        field: `definition.skills.${i}.skill`,
        code: "duplicate_skill",
        message: `skill "${id}" is listed more than once`,
      });
    }
    skillIds.add(id);
  });
  const roles = new Set<string>();
  (bundle.people ?? []).forEach((p, i) => {
    if (roles.has(p.role)) {
      errors.push({
        stepId: null,
        field: `people.${i}.role`,
        code: "duplicate_role",
        message: `role "${p.role}" is listed more than once`,
      });
    }
    roles.add(p.role);
  });

  errors.push(...definitionModelErrors(bundle.definition, ctx.models));
  errors.push(
    ...definitionSkillErrors(bundle.definition, ctx, { complete: ctx.publish !== undefined }),
  );

  // Ids unique across workflows (each workflow's own duplicates are its validator's).
  const seen = new Set<string>();
  for (const w of bundle.workflows) {
    const ids = new Set(stepModelIds(w.workflow));
    for (const id of ids) {
      if (seen.has(id)) {
        errors.push({
          stepId: id,
          field: "id",
          code: "duplicate_id",
          message: `id "${id}" is used more than once`,
          workflow: w.slug,
        });
      }
    }
    for (const id of ids) seen.add(id);
  }

  for (const w of bundle.workflows) {
    // The step model's publish checks (docs/step-model-plan.md §13a), each on its step.
    for (const issue of validateStepWorkflow(w.workflow, stepContext(ctx))) {
      errors.push({
        stepId: issue.at ?? null,
        field: "",
        code: "step_model",
        message: issue.message,
        workflow: w.slug,
        stepCode: issue.code,
      });
    }
    // What the builder's form leaves open (a Fork's unnamed path, a For each with no list).
    for (const e of stepModelFormErrors(w.workflow)) errors.push({ ...e, workflow: w.slug });
    // A schedule that can't start says so.
    for (const e of stepModelScheduleErrors(w.workflow)) errors.push({ ...e, workflow: w.slug });
    // Input that becomes instructions is written in the step, not filled from a template.
    for (const e of stepModelFixedInputErrors(w.workflow, ctx))
      errors.push({ ...e, workflow: w.slug });
    // At publish, its writes held to the client's connections.
    for (const e of stepModelPublishErrors(w.workflow, ctx, bundle.definition)) {
      errors.push({ ...e, workflow: w.slug });
    }
    // References to other steps name steps that run before the reader.
    for (const e of stepModelRefErrors(w.workflow)) errors.push({ ...e, workflow: w.slug });
    // Setup-plan §4.1: every seat a step names is one the bundle declares, of a kind that fits.
    for (const e of stepModelSeatProblems(w.workflow, bundle.people ?? [])) {
      errors.push({ ...e, workflow: w.slug });
    }
    // Skill model: a new step may not use a retired kind of skill or one that writes.
    for (const e of newSkillStepErrors(w.workflow, ctx)) errors.push({ ...e, workflow: w.slug });
  }
  // Ways in, ways out: hand-offs to another agent, to this agent's own workflows, and the loops.
  errors.push(...stepModelHandoffErrors(bundle.workflows, ctx.handoff));
  errors.push(...validateClientView(bundle, ctx.packs ? { packs: ctx.packs } : {}));
  return { valid: errors.length === 0, errors, value: bundle };
}

interface Issue {
  path: PropertyKey[];
  message: string;
}

function schemaErrors(input: unknown, issues: readonly Issue[]): BundleValidationError[] {
  const raw = (input ?? {}) as { workflows?: { slug?: unknown; workflow?: unknown }[] };
  const errors: BundleValidationError[] = [];
  const done = new Set<number>();
  for (const issue of issues) {
    const path = issue.path.map((p) => (typeof p === "symbol" ? String(p) : p)) as (
      | string
      | number
    )[];
    const at = path[1];
    if (path[0] === "workflows" && typeof at === "number" && path[2] === "workflow") {
      if (done.has(at)) continue;
      done.add(at);
      const entry = raw.workflows?.[at];
      const slug = typeof entry?.slug === "string" ? entry.slug : undefined;
      const r = StepWorkflow.safeParse(entry?.workflow);
      for (const e of r.error?.issues ?? []) {
        errors.push({
          stepId: null,
          field: e.path.map(String).join("."),
          message: e.message,
          code: "schema",
          ...(slug === undefined ? {} : { workflow: slug }),
        });
      }
      continue;
    }
    errors.push({ stepId: null, field: path.join("."), message: issue.message, code: "schema" });
  }
  return errors;
}
