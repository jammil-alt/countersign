import type { z } from "zod";
import { isPlainObject } from "../json";
import { levelFor } from "../permissions/decide";
import { compileRule, RuleCompileError } from "../rules/compile";
import {
  type AgentBundle,
  AgentBundle as AgentBundleSchema,
  type AgentDefinition,
} from "../schemas/agent";
import type { JsonSchema } from "../schemas/common";
import { parseSkillRef } from "../schemas/common";
import type { PermissionMatrix, Verb } from "../schemas/permissions";
import type { Rules } from "../schemas/rules";
import { skillTools } from "../schemas/skill";
import type { ToolSpec } from "../schemas/tool";
import { type Step, type Workflow, Workflow as WorkflowSchema } from "../schemas/workflow";
import { collectRefs, hasTemplate, singleRef } from "../template/template";
import {
  lookupSkill,
  type Scope,
  schemaTypes,
  scopes,
  type TypingContext,
  triggerSchema,
  typeTemplatePath,
} from "../template/typer";
import { walkSteps } from "./walk";

/**
 * Workflow validation (ARCHITECTURE §10.2), shared by the builder (in the browser, on every
 * change) and the server (before test runs and publish). A draft may be saved with errors; only a
 * valid workflow can be test-run or published. Each error names the step and the field so the
 * builder can mark both.
 */

export type ValidationCode =
  | "schema"
  | "duplicate_id"
  | "duplicate_slug"
  | "duplicate_skill"
  | "duplicate_role"
  | "fork_no_paths"
  | "for_each_empty"
  | "for_each_not_array"
  | "template_syntax"
  | "template_scope"
  | "template_path"
  | "rule_invalid"
  | "rules_empty"
  | "unknown_event"
  | "invalid_cron"
  | "invalid_timezone"
  | "unknown_skill"
  | "skill_not_allowed"
  | "agent_not_commandable"
  | "unknown_tool"
  | "tool_not_allowed"
  | "action_not_external"
  | "input_missing"
  | "input_type"
  | "input_unknown"
  | "input_not_fixed"
  | "approval_not_write"
  | "connection_missing"
  | "verb_off"
  | "approval_required_by_connection";

export interface ValidationError {
  /** The step, fork path or trigger id; null for workflow- or bundle-level errors. */
  stepId: string | null;
  /** Dotted path inside that node (e.g. "input.vendor", "approval.required"), or "" for the node. */
  field: string;
  message: string;
  code: ValidationCode;
  /** The workflow's slug, when validating a bundle. */
  workflow?: string;
}

export interface ValidationContext extends TypingContext {
  /** The owning agent: skills and tools must be among what it allows. */
  agent?: Pick<AgentDefinition, "skills" | "extraTools" | "canCommand">;
  /**
   * Publish-time checks for a client agent: the client's connection matrices by connector id
   * (from its bindings). When absent, connection checks are skipped (templates, drafts).
   */
  publish?: { matrices: Record<string, Partial<PermissionMatrix> | undefined> };
}

export interface ValidationResult<T> {
  valid: boolean;
  errors: ValidationError[];
  /** The parsed value (defaults applied) when it passed the schema. */
  value?: T;
}

const VERB_NOUN: Record<Verb, string> = {
  read: "reads",
  create: "creates",
  update: "updates",
  delete: "deletes",
};

function field(segments: readonly (string | number)[]): string {
  return segments.join(".");
}

/** Maps Zod issues to step-located errors by walking the raw input along each issue path. */
function schemaErrors(
  issues: z.core.$ZodIssue[],
  raw: unknown,
  workflow?: string,
): ValidationError[] {
  return issues.map((issue) => {
    let cur: unknown = raw;
    let stepId: string | null = null;
    let start = 0;
    const path = issue.path as (string | number)[];
    path.forEach((seg, i) => {
      cur =
        isPlainObject(cur) || Array.isArray(cur)
          ? (cur as Record<string | number, unknown>)[seg]
          : undefined;
      const prev = path[i - 1];
      const isNode =
        (typeof seg === "number" && (prev === "steps" || prev === "paths")) ||
        seg === "trigger" ||
        seg === "otherwise";
      if (isNode && isPlainObject(cur) && typeof cur.id === "string") {
        stepId = cur.id;
        start = i + 1;
      }
    });
    const err: ValidationError = {
      stepId,
      field: field(path.slice(start)),
      message: issue.message,
      code: "schema",
    };
    if (workflow !== undefined) err.workflow = workflow;
    return err;
  });
}

function literalType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function compatible(accepted: string[], actual: string[]): boolean {
  if (accepted.length === 0 || actual.length === 0) return true;
  return actual.some(
    (t) => accepted.includes(t) || (t === "integer" && accepted.includes("number")),
  );
}

interface Checker {
  ctx: ValidationContext;
  errors: ValidationError[];
  add(stepId: string | null, f: string, code: ValidationCode, message: string): void;
}

function checkRefs(
  c: Checker,
  stepId: string,
  value: unknown,
  at: (string | number)[],
  scope: Scope,
) {
  const { refs, errors } = collectRefs(value, at);
  for (const e of errors) c.add(stepId, field(e.at), "template_syntax", e.message);
  for (const r of refs) {
    const t = typeTemplatePath(scope, r.path);
    if (!t.ok) {
      // Scope: the reference names something not available here. Path: it names a field the
      // referenced output doesn't have.
      const [root, id] = r.path;
      const inScope =
        root === "trigger" ||
        (root === "steps" &&
          id !== undefined &&
          scope.steps[id] !== undefined &&
          r.path[2] === "output");
      c.add(
        stepId,
        field(r.at),
        inScope ? "template_path" : "template_scope",
        `{{${r.expr}}}: ${t.message}`,
      );
    }
  }
}

/** The type a templated value will have, when it can be known. */
function valueTypes(value: unknown, scope: Scope): string[] {
  if (typeof value === "string" && value.includes("{{")) {
    let path: string[] | null = null;
    try {
      path = singleRef(value);
    } catch {
      return [];
    }
    if (!path) return ["string"];
    const t = typeTemplatePath(scope, path);
    return t.ok ? schemaTypes(t.schema) : [];
  }
  return [literalType(value)];
}

function checkInput(
  c: Checker,
  stepId: string,
  input: Record<string, unknown>,
  schema: JsonSchema | undefined,
  scope: Scope,
) {
  if (!schema) return;
  const props = isPlainObject(schema.properties)
    ? (schema.properties as Record<string, JsonSchema>)
    : undefined;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  for (const key of required) {
    if (input[key] === undefined)
      c.add(stepId, `input.${key}`, "input_missing", `"${key}" is required`);
  }
  if (!props) return;
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    const prop = props[key];
    if (!prop) {
      if (schema.additionalProperties === false) {
        c.add(stepId, `input.${key}`, "input_unknown", `"${key}" is not an input of this step`);
      }
      continue;
    }
    const accepted = schemaTypes(prop);
    const actual = valueTypes(value, scope);
    if (!compatible(accepted, actual)) {
      c.add(
        stepId,
        `input.${key}`,
        "input_type",
        `"${key}" expects ${accepted.join(" or ")}, got ${actual.join(" or ")}`,
      );
    }
  }
}

function checkRules(
  c: Checker,
  nodeId: string,
  rules: Rules,
  at: (string | number)[],
  scope: Scope,
  requireRules: boolean,
) {
  if (requireRules && rules.rules.length === 0) {
    c.add(nodeId, field([...at, "rules"]), "rules_empty", "add a condition, or use otherwise");
  }
  rules.rules.forEach((rule, i) => {
    const here = [...at, "rules", i];
    try {
      compileRule(rule, i);
    } catch (e) {
      if (e instanceof RuleCompileError) {
        c.add(nodeId, field([...here, e.field]), "rule_invalid", e.message);
        return;
      }
      throw e;
    }
    if (rule.op !== "exists" && rule.value === undefined) {
      c.add(nodeId, field([...here, "value"]), "rule_invalid", `'${rule.op}' needs a value`);
    }
    checkRefs(c, nodeId, rule.field, [...here, "field"], scope);
    checkRefs(c, nodeId, rule.value, [...here, "value"], scope);
  });
}

/** The external tools a step can call: what makes it a "write step" needing approval. */
export function stepWrites(step: Step, ctx: TypingContext): ToolSpec[] | undefined {
  if (step.kind === "action") {
    const tool = ctx.tools?.[step.tool];
    if (!tool) return undefined;
    return tool.sideEffect === "external" ? [tool] : [];
  }
  if (step.kind === "skill") {
    const skill = lookupSkill(step.skill, ctx);
    if (!skill || !ctx.tools) return undefined;
    return skillTools(skill)
      .map((id) => ctx.tools?.[id])
      .filter((t): t is ToolSpec => t?.sideEffect === "external");
  }
  return [];
}

function allowedTools(ctx: ValidationContext): Set<string> | undefined {
  if (!ctx.agent || !ctx.skills) return undefined;
  const ids = new Set(ctx.agent.extraTools ?? []);
  for (const s of ctx.agent.skills) {
    const def = lookupSkill(s.skill, ctx);
    if (def) for (const t of skillTools(def)) ids.add(t);
  }
  return ids;
}

function checkStep(c: Checker, step: Step, scope: Scope, allowed: Set<string> | undefined) {
  const { ctx } = c;
  switch (step.kind) {
    case "skill": {
      checkRefs(c, step.id, step.input, ["input"], scope);
      const skill = lookupSkill(step.skill, ctx);
      if (ctx.skills && !skill) {
        c.add(step.id, "skill", "unknown_skill", `no skill "${step.skill}"`);
      }
      if (ctx.agent && step.agent === undefined) {
        const id = parseSkillRef(step.skill).id;
        const has = ctx.agent.skills.some((s) => parseSkillRef(s.skill).id === id);
        if (!has) c.add(step.id, "skill", "skill_not_allowed", `the agent has no skill "${id}"`);
      }
      if (
        ctx.agent &&
        step.agent !== undefined &&
        !(ctx.agent.canCommand ?? []).includes(step.agent)
      ) {
        c.add(step.id, "agent", "agent_not_commandable", `the agent may not ask "${step.agent}"`);
      }
      if (skill) checkInput(c, step.id, step.input, skill.input, scope);
      break;
    }
    case "action": {
      checkRefs(c, step.id, step.input, ["input"], scope);
      const tool = ctx.tools?.[step.tool];
      if (ctx.tools && !tool) c.add(step.id, "tool", "unknown_tool", `no tool "${step.tool}"`);
      if (tool && tool.sideEffect !== "external") {
        c.add(
          step.id,
          "tool",
          "action_not_external",
          `"${step.tool}" doesn't change a client tool; use a skill step`,
        );
      }
      if (tool && allowed && !allowed.has(step.tool)) {
        c.add(
          step.id,
          "tool",
          "tool_not_allowed",
          `the agent can't use "${step.tool}": add it to its tools or skills`,
        );
      }
      if (tool) checkInput(c, step.id, step.input, tool.input, scope);
      for (const f of tool?.fixedInputs ?? []) {
        if (isPlainObject(step.input) && hasTemplate(step.input[f])) {
          c.add(
            step.id,
            `input.${f}`,
            "input_not_fixed",
            `write ${f} in the step: it becomes instructions, so it can't come from a template`,
          );
        }
      }
      break;
    }
    case "person":
      checkRefs(c, step.id, step.title, ["title"], scope);
      checkRefs(c, step.id, step.payload, ["payload"], scope);
      break;
    case "notify":
      checkRefs(c, step.id, step.message, ["message"], scope);
      if (step.to !== undefined) checkRefs(c, step.id, step.to, ["to"], scope);
      break;
    case "for_each": {
      checkRefs(c, step.id, step.over, ["over"], scope);
      if (step.steps.length === 0) {
        c.add(step.id, "steps", "for_each_empty", "a for each needs at least one step");
      }
      const types = valueTypes(step.over, scope);
      if (!compatible(["array"], types)) {
        c.add(step.id, "over", "for_each_not_array", "for each needs a list to go over");
      }
      break;
    }
    case "fork":
      if (step.paths.length === 0) {
        c.add(step.id, "paths", "fork_no_paths", "a fork needs at least one path");
      }
      // Paths are evaluated at the fork, so their rules see what the fork itself sees.
      for (const p of step.paths) checkRules(c, p.id, p.when, ["when"], scope, true);
      break;
    default:
      break;
  }

  const approval = step.kind === "skill" || step.kind === "action" ? step.approval : undefined;
  const writes = stepWrites(step, ctx);
  const reaches = step.kind === "skill" && lookupSkill(step.skill, ctx)?.reachesPeople === true;
  if (
    approval?.required === "not_required" &&
    writes !== undefined &&
    writes.length === 0 &&
    !reaches
  ) {
    c.add(
      step.id,
      "approval.required",
      "approval_not_write",
      "only steps that change a client's tool have an approval setting",
    );
  }
  if (step.kind === "skill") {
    // A built-in skill with its own fixed inputs (comms.reach-out's purpose) writes only from them:
    // those fields must be the step's own text, like an action step's.
    const def = lookupSkill(step.skill, ctx);
    for (const f of def?.fixedInputs ?? []) {
      if (isPlainObject(step.input) && hasTemplate(step.input[f])) {
        c.add(
          step.id,
          `input.${f}`,
          "input_not_fixed",
          `write ${f} in the step: it becomes instructions, so it can't come from a template`,
        );
      }
    }
    for (const tool of def?.fixedInputs?.length ? [] : (writes ?? [])) {
      if (!tool.fixedInputs?.length) continue;
      c.add(
        step.id,
        "skill",
        "input_not_fixed",
        `"${tool.id}" runs only from an action step with its ${tool.fixedInputs.join(" and ")} written in it, not from a skill`,
      );
    }
  }
  if (ctx.publish && writes) {
    for (const tool of writes) {
      const connector = tool.connector ?? tool.source;
      if (!(connector in ctx.publish.matrices) || ctx.publish.matrices[connector] === undefined) {
        c.add(
          step.id,
          "",
          "connection_missing",
          `no ${connector} connection is bound for "${tool.id}"`,
        );
        continue;
      }
      const level = levelFor(ctx.publish.matrices[connector], tool.verb);
      if (level === "off") {
        c.add(
          step.id,
          step.kind === "action" ? "tool" : "skill",
          "verb_off",
          `this connection doesn't allow ${VERB_NOUN[tool.verb]} ("${tool.id}")`,
        );
      } else if (approval?.required === "not_required" && level !== "auto") {
        c.add(
          step.id,
          "approval.required",
          "approval_required_by_connection",
          `this connection requires approval for ${VERB_NOUN[tool.verb]}`,
        );
      }
    }
  }
}

const CRON_FIELD = /^[0-9A-Za-z*/,?#LW-]+$/;

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function checkTrigger(c: Checker, workflow: Workflow) {
  const { id, on } = workflow.trigger;
  if (on.type === "event") {
    if (c.ctx.events && !c.ctx.events[on.event]) {
      c.add(id, "on.event", "unknown_event", `no event type "${on.event}"`);
    }
    if (on.filter) {
      const scope: Scope = { trigger: triggerSchema(workflow, c.ctx), steps: {} };
      checkRules(c, id, on.filter, ["on", "filter"], scope, false);
    }
  } else if (on.type === "schedule") {
    const fields = on.cron.trim().split(/\s+/);
    if (fields.length !== 5 || !fields.every((f) => CRON_FIELD.test(f))) {
      c.add(id, "on.cron", "invalid_cron", "a schedule needs five cron fields, e.g. 0 7 * * 1-5");
    }
    if (on.tz !== undefined && !validTimezone(on.tz)) {
      c.add(id, "on.tz", "invalid_timezone", `unknown timezone "${on.tz}"`);
    }
  }
}

function duplicateIds(workflows: { slug?: string; workflow: Workflow }[]): ValidationError[] {
  const seen = new Map<string, string | undefined>();
  const errors: ValidationError[] = [];
  const note = (id: string, slug: string | undefined, f: string) => {
    if (seen.has(id)) {
      const err: ValidationError = {
        stepId: id,
        field: f,
        code: "duplicate_id",
        message: `id "${id}" is used more than once`,
      };
      if (slug !== undefined) err.workflow = slug;
      errors.push(err);
    } else seen.set(id, slug);
  };
  for (const { slug, workflow } of workflows) {
    note(workflow.trigger.id, slug, "id");
    walkSteps(workflow, ({ step }) => {
      note(step.id, slug, "id");
      if (step.kind === "fork") {
        for (const p of step.paths) note(p.id, slug, "id");
        note(step.otherwise.id, slug, "otherwise.id");
      }
    });
  }
  return errors;
}

function semantic(workflow: Workflow, ctx: ValidationContext, slug?: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const c: Checker = {
    ctx,
    errors,
    add(stepId, f, code, message) {
      const e: ValidationError = { stepId, field: f, code, message };
      if (slug !== undefined) e.workflow = slug;
      errors.push(e);
    },
  };
  checkTrigger(c, workflow);
  const allowed = allowedTools(ctx);
  const byStep = scopes(workflow, ctx);
  walkSteps(workflow, ({ step }) => {
    checkStep(c, step, byStep.get(step.id) as Scope, allowed);
  });
  return errors;
}

/** Validates one workflow. Schema errors stop semantic checks (they need a typed tree). */
export function validateWorkflow(
  input: unknown,
  ctx: ValidationContext = {},
): ValidationResult<Workflow> {
  const parsed = WorkflowSchema.safeParse(input);
  if (!parsed.success) {
    return { valid: false, errors: schemaErrors(parsed.error.issues, input) };
  }
  const errors = [...duplicateIds([{ workflow: parsed.data }]), ...semantic(parsed.data, ctx)];
  return { valid: errors.length === 0, errors, value: parsed.data };
}

/**
 * Validates a whole bundle: its schema, ids unique across every workflow, unique workflow slugs and
 * skills, and each workflow against the bundle's own agent definition.
 */
export function validateBundle(
  input: unknown,
  ctx: Omit<ValidationContext, "agent"> = {},
): ValidationResult<AgentBundle> {
  const parsed = AgentBundleSchema.safeParse(input);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((issue) => {
      const path = issue.path as (string | number)[];
      if (path[0] === "workflows" && typeof path[1] === "number" && path[2] === "workflow") {
        const raw = (input as { workflows?: { slug?: unknown; workflow?: unknown }[] }).workflows?.[
          path[1]
        ];
        const slug = typeof raw?.slug === "string" ? raw.slug : undefined;
        return schemaErrors(
          [{ ...issue, path: path.slice(3) } as z.core.$ZodIssue],
          raw?.workflow,
          slug,
        )[0] as ValidationError;
      }
      return {
        stepId: null,
        field: field(path),
        message: issue.message,
        code: "schema",
      } as ValidationError;
    });
    return { valid: false, errors };
  }
  const bundle = parsed.data;
  const errors: ValidationError[] = [];
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
  errors.push(...duplicateIds(bundle.workflows));
  const full: ValidationContext = { ...ctx, agent: bundle.definition };
  for (const w of bundle.workflows) errors.push(...semantic(w.workflow, full, w.slug));
  return { valid: errors.length === 0, errors, value: bundle };
}
