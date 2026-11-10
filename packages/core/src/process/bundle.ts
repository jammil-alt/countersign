// R8 (docs/plan.md §1.86, §9): validating a whole bundle whose workflows may be v4 processes, the
// counterpart of `validateBundle` (workflow/validate.ts) for what the builder saves from now on.
// A bundle of v3 workflows only is validated exactly as before. Otherwise each v4 process goes
// through `validateProcess`, each stored v3 workflow through `validateWorkflow`, with the agent's
// definition, and the bundle's own rules (unique slugs, skills, roles, ids across workflows, the
// client view) are checked once. Shared by the builder (in the browser) and the server's save
// and publish checks, so both say the same thing.

import { validateClientView } from "../kpi/validate";
import { AgentBundle, AnyAgentBundle, holdsProcess } from "../schemas/agent";
import { parseSkillRef } from "../schemas/common";
import {
  definitionModelErrors,
  definitionSkillErrors,
  type ValidationContext,
  type ValidationError,
  validateBundle as validateV3Bundle,
  validateWorkflow,
} from "../workflow/validate";
import { walkSteps as walkV3Steps } from "../workflow/walk";
import { type ProcessValidationCode, type ProcessWarning, validateProcess } from "./validate";
import { nodeIds } from "./walk";

/** A bundle error: v3's shape, with v4's codes. */
export type BundleValidationError = Omit<ValidationError, "code"> & {
  code: ProcessValidationCode;
};

/** A process's advice (split signals), with the workflow it is about. */
export type BundleWarning = ProcessWarning & { workflow: string };

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
 * Validates a bundle that may hold v4 processes. All v3: `validateBundle`, unchanged. Schema
 * errors inside one workflow are reported by that workflow's own validator (so they name its
 * step and field); the other checks need a parsed bundle.
 */
export function validateAnyBundle(
  input: unknown,
  ctx: Omit<ValidationContext, "agent"> = {},
): AnyBundleValidationResult {
  const v3 = AgentBundle.safeParse(input);
  if (v3.success && !holdsProcess(v3.data)) {
    const r = validateV3Bundle(input, ctx);
    return {
      valid: r.valid,
      errors: r.errors,
      warnings: [],
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
    const ids = new Set(w.workflow.schemaVersion === 4 ? nodeIds(w.workflow) : v3Ids(w.workflow));
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
    if (w.workflow.schemaVersion === 4) {
      const r = validateProcess(w.workflow, { ...ctx, agent: bundle.definition });
      for (const e of r.errors) errors.push({ ...e, workflow: w.slug });
      for (const warning of r.warnings) warnings.push({ ...warning, workflow: w.slug });
    } else {
      const r = validateWorkflow(w.workflow, { ...ctx, agent: bundle.definition });
      for (const e of r.errors) errors.push({ ...e, workflow: w.slug });
    }
  }
  errors.push(...validateClientView(bundle, ctx.packs ? { packs: ctx.packs } : {}));
  return { valid: errors.length === 0, errors, warnings, value: bundle };
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
      const r = wf?.schemaVersion === 4 ? validateProcess(wf) : validateWorkflow(wf);
      for (const e of r.errors) errors.push(slug === undefined ? e : { ...e, workflow: slug });
      continue;
    }
    errors.push({ stepId: null, field: path.join("."), message: issue.message, code: "schema" });
  }
  return errors;
}
