import type { z } from "zod";
import { localizedVersions } from "../i18n/locale";
import { isUuid } from "../ids";
import { isPlainObject } from "../json";
// v0.12 W2-G
import { validateClientView } from "../kpi/validate";
import { levelFor } from "../permissions/decide";
// v0.14 W4-B
import { type EntityGrant, entityOffBy, publishEntity } from "../permissions/entities";
import { compileRule, RuleCompileError } from "../rules/compile";
import {
  type AgentBundle,
  AgentBundle as AgentBundleSchema,
  type AgentDefinition,
} from "../schemas/agent";
import {
  type AutomationDefinition,
  AutomationDefinition as AutomationDefinitionSchema,
} from "../schemas/automation";
import type { JsonSchema } from "../schemas/common";
import { parseSkillRef } from "../schemas/common";
import type { PermissionEntity, PermissionMatrix, Verb } from "../schemas/permissions";
import type { Rules } from "../schemas/rules";
import { type SkillDefinition, skillTools } from "../schemas/skill";
import type { ToolSpec } from "../schemas/tool";
import {
  type Step,
  type Trigger,
  type UseAutomationStep,
  type Workflow,
  Workflow as WorkflowSchema,
} from "../schemas/workflow";
import { collectRefs, hasTemplate, singleRef } from "../template/template";
import {
  automationEndScope,
  automationScopes,
  lookupSkill,
  outputSchemaOf,
  type Scope,
  schemaTypes,
  scopes,
  type TypingContext,
  triggerOnSchema,
  triggerSchema,
  typeTemplatePath,
} from "../template/typer";
import { allTriggers } from "../triggers/kinds";
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
  | "approval_required_by_connection"
  // v0.12 W1-D
  | "choices_not_ask"
  | "duplicate_choice"
  // v0.12 W2-G: the client view (kpi/validate.ts)
  | "duplicate_kpi"
  | "kpi_ratio_depth"
  | "kpi_unknown_step"
  | "kpi_unknown_workflow"
  | "kpi_unknown"
  | "kpi_pack_missing"
  // v0.12 W2-B
  | "unknown_automation"
  | "automation_nested"
  | "automation_named_person"
  | "automation_agent"
  | "approvals_not_client"
  | "approval_unknown_step"
  // v0.12 W2-E: triggers
  | "duplicate_channel"
  | "people_empty"
  | "reply_not_fixed"
  // v0.13 W2-H: a step's model (ARCHITECTURE §10.11).
  | "unknown_model"
  | "model_not_allowed"
  // v0.14 W4-B: an entity the client's connection or the agent's grant turned off.
  | "entity_off";

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
  publish?: {
    matrices: Record<string, Partial<PermissionMatrix> | undefined>;
    // v0.14 W4-B (docs/plan.md §1.44 "Off at publish"): the agent's grants on those connections
    // (null: no narrowing) and each connector's declared entities, for scopes. Both optional: what
    // isn't passed isn't checked here, and the gate checks it at the call.
    grants?: Record<string, EntityGrant | null | undefined>;
    entities?: Record<string, readonly PermissionEntity[] | undefined>;
  };
  // v0.12 W2-G: the packs installed where the bundle runs (pack panels of the client view).
  packs?: readonly string[];
  // v0.12 W2-B
  /**
   * Whether the bundle is a client agent's: a use step's `approvals` are for client agents only.
   * Absent: not checked (a draft the builder can't place yet).
   */
  clientAgent?: boolean;
  /**
   * v0.13 W2-H: the model ids the platform knows and prices (`packages/llm`). Core can't import
   * `llm`, so the caller passes them; when absent, a step's model id isn't checked.
   */
  models?: readonly string[];
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
        (typeof seg === "number" &&
          (prev === "steps" || prev === "paths" || prev === "moreTriggers")) ||
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
        // v0.12 W2-B: an automation reads its input, never a trigger.
        (root === "trigger" && !scope.input) ||
        (root === "input" && scope.input !== undefined) ||
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
      checkStepModel(c, step, skill);
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
      // v0.12 W1-D: quick answers are for questions, one button per value.
      if (step.choices && step.mode !== "ask") {
        c.add(step.id, "choices", "choices_not_ask", "quick answers are only for questions");
      }
      if (step.choices && new Set(step.choices.map((ch) => ch.value)).size < step.choices.length) {
        c.add(step.id, "choices", "duplicate_choice", "each quick answer needs its own value");
      }
      break;
    case "notify":
      checkRefs(c, step.id, step.message, ["message"], scope);
      if (step.to !== undefined) checkRefs(c, step.id, step.to, ["to"], scope);
      if (step.sources !== undefined) checkRefs(c, step.id, step.sources, ["sources"], scope);
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
    // v0.12 W2-B
    case "use_automation":
      checkUseStep(c, step, scope);
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
      } else if (checkEntityOff(c, step, tool, connector)) {
        // v0.14 W4-B: reported there.
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

// v0.14 W4-B (docs/plan.md §1.44 "Off at publish"): an entity turned off on the client's connection
// or in the agent's grant is refused at publish, as a verb turned off is. Returns whether it was.
function checkEntityOff(c: Checker, step: Step, tool: ToolSpec, connector: string): boolean {
  const publish = c.ctx.publish;
  if (!publish) return false;
  // A skill's model chooses its tools' input, so only an action step's own input names an entity.
  const entity = publishEntity(tool, step.kind === "action" ? step.input : undefined);
  if (entity === undefined) return false;
  const at = step.kind === "action" ? "tool" : "skill";
  if (entity === "") {
    const f = tool.entityInput?.field ?? "";
    c.add(step.id, `input.${f}`, "entity_off", `"${tool.id}" can't work on that ${f}`);
    return true;
  }
  const grants = publish.grants ?? {};
  const declared = publish.entities ?? {};
  const by = entityOffBy({
    tool,
    entity,
    matrix: publish.matrices[connector],
    grant: Object.hasOwn(grants, connector) ? grants[connector] : null,
    declared: Object.hasOwn(declared, connector) ? declared[connector] : undefined,
  });
  if (by === null) return false;
  const who = by === "matrix" ? "this connection" : "this agent's access";
  c.add(
    step.id,
    at,
    "entity_off",
    `${who} doesn't allow ${VERB_NOUN[tool.verb]} of ${entity} records ("${tool.id}")`,
  );
  return true;
}

const CRON_FIELD = /^[0-9A-Za-z*/,?#LW-]+$/;

// v0.13 W2-H: a skill step's model override (ARCHITECTURE §10.11, docs/plan.md §1.53).
/** A step may override the model of a `task` or `agent` skill, with an id the platform knows. */
function checkStepModel(
  c: Checker,
  step: Extract<Step, { kind: "skill" }>,
  skill: SkillDefinition | undefined,
) {
  if (step.model === undefined) return;
  if (skill?.mode === "tool") {
    c.add(
      step.id,
      "model",
      "model_not_allowed",
      `"${skill.id}" runs as code, so it has no model to choose`,
    );
    return;
  }
  const known = c.ctx.models;
  if (known && !known.includes(step.model.id)) {
    c.add(step.id, "model.id", "unknown_model", `no model "${step.model.id}"`);
  }
}

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// v0.12 W2-E: every trigger of the workflow (`moreTriggers` too) is checked; a trigger's filter and
// dedupe key read that trigger's own payload.
function checkTrigger(c: Checker, trigger: Trigger) {
  const { id, on } = trigger;
  const own: Scope = { trigger: triggerOnSchema(on, c.ctx), steps: {} };
  if (on.type === "event") {
    if (c.ctx.events && !c.ctx.events[on.event]) {
      c.add(id, "on.event", "unknown_event", `no event type "${on.event}"`);
    }
    if (on.filter) checkRules(c, id, on.filter, ["on", "filter"], own, false);
  } else if (on.type === "webhook" || on.type === "handoff") {
    if (on.filter) checkRules(c, id, on.filter, ["on", "filter"], own, false);
    if (on.type === "webhook" && on.dedupeKey !== undefined) {
      checkRefs(c, id, on.dedupeKey, ["on", "dedupeKey"], own);
    }
  } else if (on.type === "message") {
    if (new Set(on.channels).size < on.channels.length) {
      c.add(id, "on.channels", "duplicate_channel", "each channel once");
    }
    const f = on.from;
    const listed =
      (f.relationships?.length ?? 0) +
      (f.tags?.length ?? 0) +
      (f.contactIds?.length ?? 0) +
      (f.clientRoles?.length ?? 0);
    if (listed === 0) {
      c.add(id, "on.from", "people_empty", "say who may send it: people, tags or client roles");
    }
    for (const text of on.reply ? localizedVersions(on.reply.confirm) : []) {
      if (text.includes("{{")) {
        c.add(id, "on.reply.confirm", "reply_not_fixed", "the confirmation is fixed words");
      }
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

// v0.12 W2-E: `handoff.output` and `sources` are read when the run has finished, so they see the
// trigger and every top-level step (outputs inside a fork path or a loop stay inside it).
function checkHandoff(c: Checker, workflow: Workflow) {
  if (!workflow.handoff) return;
  const all = scopes(workflow, c.ctx);
  const scope: Scope = { trigger: triggerSchema(workflow, c.ctx), steps: {} };
  for (const s of workflow.steps) {
    const at = all.get(s.id);
    if (at) Object.assign(scope.steps, at.steps);
    scope.steps[s.id] = { step: s, output: outputSchemaOf(s, c.ctx) };
  }
  checkRefs(c, workflow.trigger.id, workflow.handoff.output, ["handoff", "output"], scope);
  if (workflow.handoff.sources !== undefined) {
    checkRefs(c, workflow.trigger.id, workflow.handoff.sources, ["handoff", "sources"], scope);
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
    // v0.12 W2-E
    for (const t of workflow.moreTriggers ?? []) note(t.id, slug, "id");
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
  // v0.12 W2-E: every trigger, and what a successful run hands off.
  for (const t of allTriggers(workflow)) checkTrigger(c, t);
  checkHandoff(c, workflow);
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
  // v0.12 W2-G: the client view's KPIs and panels (ARCHITECTURE §9.9).
  errors.push(...validateClientView(bundle, ctx.packs ? { packs: ctx.packs } : {}));
  return { valid: errors.length === 0, errors, value: bundle };
}

// ── v0.12 W2-B: automations (ARCHITECTURE §10.7; docs/plan.md §1.45) ───────────────────────────

/** Every step of a list, nested ones included, in run order. */
function stepsOf(steps: readonly Step[]): Step[] {
  const out: Step[] = [];
  walkSteps({ steps: [...steps] }, ({ step }) => out.push(step));
  return out;
}

/** An inner step's approval as the use step runs it: the use step's override, else its own. */
function innerApproval(use: UseAutomationStep, inner: Step) {
  const own = inner.kind === "skill" || inner.kind === "action" ? inner.approval : undefined;
  return use.approvals?.[inner.id] ?? own;
}

/**
 * A use step: its automation exists (when the context lists automations), its input against the
 * automation's input schema, `approvals` only on client agents and only for inner write steps,
 * and at publish the agent's bindings cover the automation's connectors, with the same connection
 * rules as any write step for the inner ones.
 */
function checkUseStep(c: Checker, step: UseAutomationStep, scope: Scope) {
  const { ctx } = c;
  checkRefs(c, step.id, step.input, ["input"], scope);
  const def = ctx.automations?.[step.automation];
  if (ctx.automations && !def) {
    c.add(step.id, "automation", "unknown_automation", `no automation "${step.automation}"`);
  }
  const approvals = Object.entries(step.approvals ?? {});
  if (approvals.length > 0 && ctx.clientAgent === false) {
    c.add(
      step.id,
      "approvals",
      "approvals_not_client",
      "only a client agent's use step can change an inner step's approval",
    );
  }
  if (!def) return;
  checkInput(c, step.id, step.input, def.input, scope);

  const inner = new Map(stepsOf(def.steps).map((s) => [s.id, s]));
  for (const [innerId, approval] of approvals) {
    const target = inner.get(innerId);
    if (!target) {
      c.add(
        step.id,
        `approvals.${innerId}`,
        "approval_unknown_step",
        `the automation has no step "${innerId}"`,
      );
      continue;
    }
    const writes = stepWrites(target, ctx);
    const reaches =
      target.kind === "skill" && lookupSkill(target.skill, ctx)?.reachesPeople === true;
    if (
      approval.required === "not_required" &&
      ((writes !== undefined && writes.length === 0 && !reaches) ||
        (target.kind !== "skill" && target.kind !== "action"))
    ) {
      c.add(
        step.id,
        `approvals.${innerId}.required`,
        "approval_not_write",
        "only steps that change a client's tool have an approval setting",
      );
    }
  }

  if (!ctx.publish) return;
  const { matrices } = ctx.publish;
  for (const connector of def.requires.connectors) {
    if (!(connector in matrices) || matrices[connector] === undefined) {
      c.add(
        step.id,
        "automation",
        "connection_missing",
        `no ${connector} connection is bound for "${def.name}"`,
      );
    }
  }
  for (const target of inner.values()) {
    const approval = innerApproval(step, target);
    for (const tool of stepWrites(target, ctx) ?? []) {
      const connector = tool.connector ?? tool.source;
      const matrix = matrices[connector];
      if (matrix === undefined) continue; // reported above, or by requires
      const level = levelFor(matrix, tool.verb);
      if (level === "off") {
        c.add(
          step.id,
          "automation",
          "verb_off",
          `this connection doesn't allow ${VERB_NOUN[tool.verb]} ("${tool.id}", in ${def.name})`,
        );
      } else if (approval?.required === "not_required" && level !== "auto") {
        c.add(
          step.id,
          `approvals.${target.id}.required`,
          "approval_required_by_connection",
          `this connection requires approval for ${VERB_NOUN[tool.verb]}`,
        );
      }
    }
  }
}

/** Checks that apply to an automation's steps only: no nesting, no named people, no other agent. */
function automationRules(c: Checker, steps: readonly Step[]) {
  for (const step of stepsOf(steps)) {
    if (step.kind === "use_automation") {
      c.add(step.id, "", "automation_nested", "an automation can't use another automation");
    }
    // DECISION: an automation never names a person (a user id is one client's); a person step
    // in it is assigned to a role or the lead, resolved in the client that uses it.
    if (step.kind === "person" && isUuid(step.assignee)) {
      c.add(
        step.id,
        "assignee",
        "automation_named_person",
        "an automation assigns people by role, not by name",
      );
    }
    // DECISION: an automation's skill steps run as the agent that uses it; asking another agent
    // depends on that agent's `canCommand`, which an automation can't know.
    if (step.kind === "skill" && step.agent !== undefined) {
      c.add(
        step.id,
        "agent",
        "automation_agent",
        "an automation's steps run as the agent using it",
      );
    }
  }
}

function automationIds(steps: readonly Step[]): ValidationError[] {
  const seen = new Set<string>();
  const errors: ValidationError[] = [];
  const note = (id: string, f: string) => {
    if (seen.has(id)) {
      errors.push({
        stepId: id,
        field: f,
        code: "duplicate_id",
        message: `id "${id}" is used more than once`,
      });
    } else seen.add(id);
  };
  walkSteps({ steps: [...steps] }, ({ step }) => {
    note(step.id, "id");
    if (step.kind === "fork") {
      for (const p of step.paths) note(p.id, "id");
      note(step.otherwise.id, "otherwise.id");
    }
  });
  return errors;
}

/**
 * Validates one automation version on its own (ARCHITECTURE §10.7): as a workflow with `input` in
 * place of the trigger. Skills and tools are checked against the context, not an agent: an agent
 * that uses the automation brings them in. Its `output` may read its input and its top-level steps.
 */
export function validateAutomation(
  input: unknown,
  ctx: Omit<ValidationContext, "agent" | "publish" | "clientAgent"> = {},
): ValidationResult<AutomationDefinition> {
  const parsed = AutomationDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return { valid: false, errors: schemaErrors(parsed.error.issues, input) };
  }
  const def = parsed.data;
  const errors: ValidationError[] = [...automationIds(def.steps)];
  const c: Checker = {
    ctx,
    errors,
    add(stepId, f, code, message) {
      errors.push({ stepId, field: f, code, message });
    },
  };
  automationRules(c, def.steps);
  const byStep = automationScopes(def, ctx);
  walkSteps(def, ({ step }) => {
    checkStep(c, step, byStep.get(step.id) as Scope, undefined);
  });
  checkRefs(c, "", def.output, ["output"], automationEndScope(def, ctx));
  for (const e of errors) if (e.stepId === "") e.stepId = null;
  return { valid: errors.length === 0, errors, value: def };
}

// ── v0.13 W2-I: checkpoints (ARCHITECTURE §10.11; docs/plan.md §1.54, M32) ─────────────────────

/** What checkpoint computation reads: skills and tools, and the automations use steps pin. */
export interface CheckpointContext extends Pick<TypingContext, "skills" | "tools"> {
  /** Automation versions by pinned reference (`slug@version`): their steps are enough. */
  automations?: Readonly<Record<string, { steps: readonly Step[] }>>;
}

/**
 * Whether a step can write to a client's tool: an action with an external tool, a skill whose tools
 * write (or that reaches people), or a use step whose automation has such a step.
 */
function writesForCheckpoints(step: Step, ctx: CheckpointContext): boolean {
  if (step.kind === "use_automation") {
    const def = Object.hasOwn(ctx.automations ?? {}, step.automation)
      ? ctx.automations?.[step.automation]
      : undefined;
    return def !== undefined && stepsOf(def.steps).some((s) => writesForCheckpoints(s, ctx));
  }
  const typing: TypingContext = {
    ...(ctx.skills ? { skills: ctx.skills } : {}),
    ...(ctx.tools ? { tools: ctx.tools } : {}),
  };
  if (step.kind === "skill" && lookupSkill(step.skill, typing)?.reachesPeople === true) return true;
  // DECISION: a step whose skill or tool the context doesn't know counts as not writing: it makes
  // no checkpoint, so its run behaves as with `failures` (never less safe than without oversight).
  return (stepWrites(step, typing)?.length ?? 0) > 0;
}

/**
 * The checkpoints of one step list (forks and loops included, not inside automations): every skill
 * or action step whose output a write step's input references (`{{steps.<id>…}}`), and every
 * skill or action step with `review: 'always'`. Computed from the definition, never guessed by the
 * model (ARCHITECTURE §10.11). A write's input can only reference steps that ran before it.
 */
export function checkpointSteps(steps: readonly Step[], ctx: CheckpointContext): Set<string> {
  const all = stepsOf(steps);
  const fed = new Set<string>();
  for (const step of all) {
    if (step.kind !== "skill" && step.kind !== "action" && step.kind !== "use_automation") {
      continue;
    }
    if (!writesForCheckpoints(step, ctx)) continue;
    for (const r of collectRefs(step.input).refs) {
      const [root, id] = r.path;
      if (root === "steps" && id !== undefined) fed.add(id);
    }
  }
  const out = new Set<string>();
  for (const step of all) {
    if (step.kind !== "skill" && step.kind !== "action") continue;
    if (step.review === "always" || fed.has(step.id)) out.add(step.id);
  }
  return out;
}

/**
 * Every checkpoint of a workflow, with its automations' expanded steps: a step in the workflow (in
 * a fork or a loop too) by its id, an automation's inner step as `${useStepId}/${innerId}` (inner
 * steps read only the automation's input and each other, so their checkpoints are the
 * automation's own).
 */
// DECISION: computed when a run starts (and wherever the builder wants to label steps), not stored
// on the version and not a validation error: it follows from the steps, and a version's bundle
// stays as the operator wrote it (docs/plan.md §1.54).
export function workflowCheckpoints(
  workflow: Pick<Workflow, "steps">,
  ctx: CheckpointContext,
): string[] {
  const out = [...checkpointSteps(workflow.steps, ctx)];
  for (const use of stepsOf(workflow.steps)) {
    if (use.kind !== "use_automation") continue;
    const def = Object.hasOwn(ctx.automations ?? {}, use.automation)
      ? ctx.automations?.[use.automation]
      : undefined;
    if (!def) continue;
    for (const id of checkpointSteps(def.steps, ctx)) out.push(`${use.id}/${id}`);
  }
  return out;
}
