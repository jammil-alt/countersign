// R8 (docs/plan.md §1.86, §9): validating a whole bundle whose workflows may be v4 processes, the
// counterpart of `validateBundle` (workflow/validate.ts) for what the builder saves from now on.
// A bundle of v3 workflows only is validated exactly as before. Otherwise each v4 process goes
// through `validateProcess`, each stored v3 workflow through `validateWorkflow`, with the agent's
// definition, and the bundle's own rules (unique slugs, skills, roles, ids across workflows, the
// client view) are checked once. Shared by the builder (in the browser) and the server's save
// and publish checks, so both say the same thing.

import { validateClientView } from "../kpi/validate";
import { AgentBundle, AnyAgentBundle, holdsProcess, holdsStepModel } from "../schemas/agent";
import { parseSkillRef } from "../schemas/common";
import { mergedAction } from "../steps/catalog";
import { Workflow as StepWorkflow } from "../steps/schema";
import {
  type StepContext,
  type StepIssueCode,
  validateWorkflow as validateStepWorkflow,
} from "../steps/validate";
import { eachStep, stepModelIds } from "../steps/walk";
import {
  definitionModelErrors,
  definitionSkillErrors,
  type ValidationContext,
  type ValidationError,
  validateBundle as validateV3Bundle,
  validateWorkflow,
} from "../workflow/validate";
import { walkSteps as walkV3Steps } from "../workflow/walk";
import { fromWorkflowV3 } from "./convert";
import { copiedSteps, copiedStepsMessage } from "./copies";
import { handoffWorkflows, selfHandoffLoops, selfHandoffSteps } from "./handoff";
import { seatProblems } from "./seats";
import {
  type ProcessValidationCode,
  type ProcessValidationContext,
  type ProcessWarning,
  type ProcessWarningCode,
  validateProcess,
} from "./validate";
import { nodeIds, walkSteps } from "./walk";

/**
 * A bundle error: v3's shape, with v4's codes; a v5 workflow's publish check (the step model) is
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
      const required = (spec(uses.action)?.input as { required?: unknown } | undefined)?.required;
      return Array.isArray(required) ? required.filter((r) => typeof r === "string") : undefined;
    },
  };
}

/** A workflow entry holding a v3 workflow or a v4 process (not the step model). */
type OlderBundleWorkflow = AnyAgentBundle["workflows"][number] & {
  workflow: { schemaVersion: 3 | 4 };
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

/** Advice about the bundle as a whole: a workflow that repeats another's steps (`copiedSteps`). */
export type BundleWarningCode = ProcessWarningCode | "copied_steps";

/** A process's advice (split signals), or the bundle's, with the workflow it is about. */
export type BundleWarning = Omit<ProcessWarning, "code"> & {
  code: BundleWarningCode;
  workflow: string;
};

export interface AnyBundleValidationResult {
  valid: boolean;
  errors: BundleValidationError[];
  /** Advice only: `valid` doesn't depend on it. */
  warnings: BundleWarning[];
  value?: AnyAgentBundle;
}

/** Ids a stored v3 workflow uses: its triggers, steps, fork paths and otherwise. */
function v3Ids(
  workflow: Extract<AnyAgentBundle["workflows"][number]["workflow"], { schemaVersion: 3 }>,
) {
  const ids = [workflow.trigger.id, ...(workflow.moreTriggers ?? []).map((t) => t.id)];
  walkV3Steps(workflow, ({ step }) => {
    ids.push(step.id);
    if (step.kind === "fork") {
      for (const p of step.paths) ids.push(p.id);
      ids.push(step.otherwise.id);
    }
  });
  return ids;
}

/**
 * Every trigger, step and path id in a bundle's workflows (v3 or v4): what a version made from it
 * already has, so a step not among them is new (`ProcessValidationContext.existingStepIds`).
 */
export function bundleNodeIds(bundle: Pick<AnyAgentBundle, "workflows">): Set<string> {
  const out = new Set<string>();
  for (const w of bundle.workflows) {
    const ids =
      w.workflow.schemaVersion === 5
        ? stepModelIds(w.workflow)
        : w.workflow.schemaVersion === 4
          ? nodeIds(w.workflow)
          : v3Ids(w.workflow);
    for (const id of ids) out.add(id);
  }
  return out;
}

/**
 * Skill model (2026-11-10, review): each skill step's skill id (no `@version`) by step id, in a
 * bundle's workflows (v3 or v4): with `bundleNodeIds`, a step that kept its id but changed its
 * skill counts as new (`ProcessValidationContext.existingStepSkills`).
 */
export function bundleStepSkills(bundle: Pick<AnyAgentBundle, "workflows">): Map<string, string> {
  const out = new Map<string, string>();
  for (const w of bundle.workflows) {
    if (w.workflow.schemaVersion === 5) {
      for (const [id, ref] of stepModelSkillsById(w.workflow)) out.set(id, parseSkillRef(ref).id);
    } else if (w.workflow.schemaVersion === 4) {
      walkSteps(w.workflow, ({ step }) => {
        if (step.kind === "skill") out.set(step.id, parseSkillRef(step.skill).id);
      });
    } else {
      walkV3Steps(w.workflow, ({ step }) => {
        if (step.kind === "skill") out.set(step.id, parseSkillRef(step.skill).id);
      });
    }
  }
  return out;
}

/**
 * Ways in, ways out (2026-11-23): one error on each self hand-off step that closes a loop between
 * the bundle's workflows (A hands to B, B hands back to A), naming the loop by workflow name.
 */
export function handoffLoopErrors(
  bundle: Pick<AnyAgentBundle, "workflows">,
): BundleValidationError[] {
  const errors: BundleValidationError[] = [];
  const nameOf = (slug: string) => bundle.workflows.find((w) => w.slug === slug)?.name ?? slug;
  const reported = new Set<string>();
  for (const loop of selfHandoffLoops(bundle.workflows)) {
    const words = loop.map((s) => `"${nameOf(s)}"`).join(" → ");
    for (let i = 0; i < loop.length - 1; i++) {
      const from = bundle.workflows.find((w) => w.slug === loop[i]);
      if (!from || from.workflow.schemaVersion !== 4) continue;
      for (const step of selfHandoffSteps(from.workflow)) {
        if (step.to.workflow !== loop[i + 1]) continue;
        const key = `${from.slug}:${step.id}`;
        if (reported.has(key)) continue;
        reported.add(key);
        errors.push({
          stepId: step.id,
          field: "to.workflow",
          code: "handoff_loop",
          message: `these hand-offs go round in a loop: ${words}`,
          workflow: from.slug,
        });
      }
    }
  }
  return errors;
}

/**
 * Validates a bundle that may hold v4 processes. All v3: `validateBundle`, unchanged. Schema
 * errors inside one workflow are reported by that workflow's own validator (so they name its
 * step and field); the other checks need a parsed bundle.
 */
export function validateAnyBundle(
  input: unknown,
  // Skill model (2026-11-10): what a client agent's action write steps resolve from at publish.
  ctx: Omit<ValidationContext, "agent"> &
    Pick<ProcessValidationContext, "actions"> & {
      /** Skill model (2026-11-10): the node ids of the version this one was made from. */
      existingStepIds?: ReadonlySet<string>;
      /** Skill model (2026-11-10, review): each skill step's skill id in that version. */
      existingStepSkills?: ReadonlyMap<string, string>;
    } = {},
): AnyBundleValidationResult {
  const v3 = AgentBundle.safeParse(input);
  if (v3.success && !holdsProcess(v3.data) && !holdsStepModel(v3.data)) {
    const r = validateV3Bundle(input, ctx);
    return {
      valid: r.valid,
      errors: r.errors,
      warnings: copyWarnings(v3.data),
      ...(r.value ? { value: r.value } : {}),
    };
  }
  const parsed = AnyAgentBundle.safeParse(input);
  if (!parsed.success)
    return { valid: false, errors: schemaErrors(input, parsed.error.issues), warnings: [] };
  const bundle = parsed.data;
  const errors: BundleValidationError[] = [];
  const warnings: BundleWarning[] = [];

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
    const ids = new Set(
      w.workflow.schemaVersion === 5
        ? stepModelIds(w.workflow)
        : w.workflow.schemaVersion === 4
          ? nodeIds(w.workflow)
          : v3Ids(w.workflow),
    );
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

  // Ways in, ways out (2026-11-23): what a hand-off to this agent's own workflow can start, and
  // the loops such hand-offs would make (A hands to B and B back to A), refused here.
  const typing = { ...ctx, agent: bundle.definition };
  const own = handoffWorkflows(bundle.workflows, typing);
  errors.push(...handoffLoopErrors(bundle));

  for (const w of bundle.workflows) {
    if (w.workflow.schemaVersion === 5) {
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
    } else if (w.workflow.schemaVersion === 4) {
      const r = validateProcess(w.workflow, {
        ...typing,
        ownWorkflows: { workflow: w.slug, workflows: own },
      });
      for (const e of r.errors) errors.push({ ...e, workflow: w.slug });
      for (const warning of r.warnings) warnings.push({ ...warning, workflow: w.slug });
      // Setup-plan §4.1: every seat a step names is one the bundle declares, of a kind that fits.
      for (const e of seatProblems(w.workflow, bundle.people ?? [])) {
        errors.push({ ...e, workflow: w.slug });
      }
    } else {
      const r = validateWorkflow(w.workflow, { ...ctx, agent: bundle.definition });
      for (const e of r.errors) errors.push({ ...e, workflow: w.slug });
    }
  }
  errors.push(...validateClientView(bundle, ctx.packs ? { packs: ctx.packs } : {}));
  warnings.push(...copyWarnings(bundle));
  return { valid: errors.length === 0, errors, warnings, value: bundle };
}

/** A v3 workflow read only for its shape: every skill stays a skill. */
const SHAPE_ONLY = { wrappedTool: () => null, sideEffect: () => null };

/**
 * Ways in, ways out (owner, 2026-11-23): each run of steps an enabled workflow repeats from
 * another (`copiedSteps`), as advice on the workflow that repeats them. v3 workflows are read as
 * processes for this.
 */
// DECISION: advice, never an error, so every stored agent keeps saving and publishing as before;
// the Builder's guard asks the model to fix a copy it makes, and the chart shows one already saved.
export function copyWarnings(bundle: Pick<AnyAgentBundle, "workflows">): BundleWarning[] {
  const enabled = bundle.workflows
    .filter((w) => w.enabled !== false)
    .filter((w): w is OlderBundleWorkflow => w.workflow.schemaVersion !== 5)
    .map((w) => ({
      slug: w.slug,
      workflow:
        w.workflow.schemaVersion === 4 ? w.workflow : fromWorkflowV3(w.workflow, SHAPE_ONLY),
    }));
  return copiedSteps(enabled).map((run) => ({
    stepId: run.stepIds[0] ?? null,
    field: "",
    code: "copied_steps",
    message: copiedStepsMessage(run),
    workflow: run.in,
  }));
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
      const wf = entry?.workflow as { schemaVersion?: unknown } | undefined;
      if (wf?.schemaVersion === 5) {
        const r = StepWorkflow.safeParse(wf);
        for (const e of r.error?.issues ?? []) {
          const field = e.path.map(String).join(".");
          errors.push({
            stepId: null,
            field,
            message: e.message,
            code: "schema",
            ...(slug === undefined ? {} : { workflow: slug }),
          });
        }
        continue;
      }
      const r = wf?.schemaVersion === 4 ? validateProcess(wf) : validateWorkflow(wf);
      for (const e of r.errors) errors.push(slug === undefined ? e : { ...e, workflow: slug });
      continue;
    }
    errors.push({ stepId: null, field: path.join("."), message: issue.message, code: "schema" });
  }
  return errors;
}
