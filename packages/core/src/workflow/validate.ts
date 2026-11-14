import type { z } from "zod";
import { modelProvider } from "../api/models";
// P-4
import { CONVERSE_SKILL, converseProblems } from "../converse";
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
import { isAlwaysSigned, type ToolSpec } from "../schemas/tool";
import {
  type Step,
  type Trigger,
  type UseAutomationStep,
  type Workflow,
  Workflow as WorkflowSchema,
} from "../schemas/workflow";
// Skill model (2026-11-10): parameters and models per agent per skill.
import { parameterValueProblems } from "../skills/parameters";
import { collectRefs, hasTemplate, singleRef } from "../template/template";
import {
  automationEndScope,
  automationScopes,
  jsonTypeOf,
  lookupSkill,
  outputSchemaOf,
  type PathType,
  type Scope,
  schemaTypes,
  scopes,
  type TypingContext,
  triggerOnSchema,
  triggerSchema,
  typesCompatible,
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
  // §1.73: a step can't run a verb a person always signs without approval.
  | "approval_always"
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
  | "entity_off"
  // P-4: a conversation step's settings (docs/plan.md §1.66).
  | "converse_invalid"
  // Skill model (2026-11-10): an agent's parameter values for a skill, and a retired kind of
  // skill (`rules_then_ai`, agent mode) placed in a new step.
  | "parameter_invalid"
  | "skill_retired";

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

// ── Shared with the v4 validator (process/validate.ts) ──────────────────────────────────────
// R1 (docs/plan.md §1.86): the v3 checks below are exported so `validateProcess` runs the same
// code. Each takes a `RefChecker`: where errors go, and how a reference types in the caller's
// scope (v3's `Scope`, v4's `ProcessScope`).

export const VERB_NOUN: Record<Verb, string> = {
  read: "reads",
  create: "creates",
  update: "updates",
  delete: "deletes",
};

/** A dotted field path ("input.vendor") from path segments. */
export function joinField(segments: readonly (string | number)[]): string {
  return segments.join(".");
}
const field = joinField;

/** Where errors go. A v4 checker's codes are a superset of these. */
export interface CheckSink {
  add(stepId: string | null, f: string, code: ValidationCode, message: string): void;
}

/** A sink that also knows how a reference types in its scopes (`S`). */
export interface RefChecker<S> extends CheckSink {
  typePath(scope: S, path: readonly string[]): PathType;
  /** The reference's root is readable here, so a failure is a bad path rather than a bad scope. */
  inScope(scope: S, path: readonly string[]): boolean;
}

/**
 * The node (step, path, otherwise or trigger) a schema issue's path points into, along the raw
 * input: `isNode(path, i, start)` says whether segment `i` enters a node (`start` is where the
 * current node's own fields begin), and an entered value counts only when it has a string `id`.
 */
export function locateIssue(
  raw: unknown,
  path: readonly (string | number)[],
  isNode: (path: readonly (string | number)[], i: number, start: number) => boolean,
): { stepId: string | null; node: Record<string, unknown> | undefined; start: number } {
  let cur: unknown = raw;
  let stepId: string | null = null;
  let node: Record<string, unknown> | undefined;
  let start = 0;
  path.forEach((seg, i) => {
    cur =
      isPlainObject(cur) || Array.isArray(cur)
        ? (cur as Record<string | number, unknown>)[seg]
        : undefined;
    if (isNode(path, i, start) && isPlainObject(cur) && typeof cur.id === "string") {
      stepId = cur.id;
      node = cur;
      start = i + 1;
    }
  });
  return { stepId, node, start };
}

/** v3: a step, fork path or extra trigger in a list, or the trigger or an otherwise branch. */
function isV3Node(path: readonly (string | number)[], i: number): boolean {
  const seg = path[i];
  const prev = path[i - 1];
  return (
    (typeof seg === "number" &&
      (prev === "steps" || prev === "paths" || prev === "moreTriggers")) ||
    seg === "trigger" ||
    seg === "otherwise"
  );
}

/** Maps Zod issues to step-located errors by walking the raw input along each issue path. */
function schemaErrors(
  issues: z.core.$ZodIssue[],
  raw: unknown,
  workflow?: string,
): ValidationError[] {
  return issues.map((issue) => {
    const path = issue.path as (string | number)[];
    const { stepId, start } = locateIssue(raw, path, isV3Node);
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

// The JSON type helpers live with the template typer (template/typer.ts), which the skill
// customization (process/customize.ts) imports too; re-exported here for the v3 checks' callers.
export { jsonTypeOf, typesCompatible };

const compatible = typesCompatible;

interface Checker extends RefChecker<Scope> {
  ctx: ValidationContext;
  errors: ValidationError[];
}

/** v3's reading of a reference's root: in scope, so a failure is a bad path. */
function v3InScope(scope: Scope, path: readonly string[]): boolean {
  const [root, id] = path;
  return (
    // v0.12 W2-B: an automation reads its input, never a trigger.
    (root === "trigger" && !scope.input) ||
    (root === "input" && scope.input !== undefined) ||
    (root === "steps" && id !== undefined && scope.steps[id] !== undefined && path[2] === "output")
  );
}

function checker(ctx: ValidationContext, errors: ValidationError[], slug?: string): Checker {
  return {
    ctx,
    errors,
    typePath: typeTemplatePath,
    inScope: v3InScope,
    add(stepId, f, code, message) {
      const e: ValidationError = { stepId, field: f, code, message };
      if (slug !== undefined) e.workflow = slug;
      errors.push(e);
    },
  };
}

/** Every template reference in `value` parses and reads something readable in `scope`. */
export function checkRefs<S>(
  c: RefChecker<S>,
  stepId: string,
  value: unknown,
  at: (string | number)[],
  scope: S,
) {
  const { refs, errors } = collectRefs(value, at);
  for (const e of errors) c.add(stepId, field(e.at), "template_syntax", e.message);
  for (const r of refs) {
    const t = c.typePath(scope, r.path);
    if (t.ok) continue;
    // Scope: the reference names something not available here. Path: it names a field the
    // referenced output doesn't have.
    c.add(
      stepId,
      field(r.at),
      c.inScope(scope, r.path) ? "template_path" : "template_scope",
      `{{${r.expr}}}: ${t.message}`,
    );
  }
}

/** The type a templated value will have, when it can be known. */
export function valueTypes<S>(c: RefChecker<S>, value: unknown, scope: S): string[] {
  if (typeof value === "string" && value.includes("{{")) {
    let path: string[] | null = null;
    try {
      path = singleRef(value);
    } catch {
      return [];
    }
    if (!path) return ["string"];
    const t = c.typePath(scope, path);
    return t.ok ? schemaTypes(t.schema) : [];
  }
  return [jsonTypeOf(value)];
}

/** A step's input against its tool's or skill's input schema: required, known, typed. */
export function checkInput<S>(
  c: RefChecker<S>,
  stepId: string,
  input: Record<string, unknown>,
  schema: JsonSchema | undefined,
  scope: S,
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
    const actual = valueTypes(c, value, scope);
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

/** Input fields that become instructions must be written in the step, never templated (inv. 9). */
export function checkFixed(
  c: CheckSink,
  stepId: string,
  input: Record<string, unknown>,
  fixed: readonly string[] | undefined,
) {
  for (const f of fixed ?? []) {
    if (isPlainObject(input) && hasTemplate(input[f])) {
      c.add(
        stepId,
        `input.${f}`,
        "input_not_fixed",
        `write ${f} in the step: it becomes instructions, so it can't come from a template`,
      );
    }
  }
}

/** One rule list: each rule compiles, has its value, and reads what is in scope. */
export function checkRules<S>(
  c: RefChecker<S>,
  nodeId: string,
  rules: Rules,
  at: (string | number)[],
  scope: S,
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

/** v0.12 W1-D: quick answers are for questions, one button per value. */
export function checkChoices(
  c: CheckSink,
  step: { id: string; mode: string; choices?: readonly { value: string }[] | undefined },
) {
  if (step.choices && step.mode !== "ask") {
    c.add(step.id, "choices", "choices_not_ask", "quick answers are only for questions");
  }
  if (step.choices && new Set(step.choices.map((ch) => ch.value)).size < step.choices.length) {
    c.add(step.id, "choices", "duplicate_choice", "each quick answer needs its own value");
  }
}

/** The external tools a step can call: what makes it a "write step" needing approval. */
export function stepWrites(step: Step, ctx: TypingContext): ToolSpec[] | undefined {
  if (step.kind === "action") {
    const tool = ctx.tools?.[step.tool];
    if (!tool) return undefined;
    return tool.sideEffect === "external" ? [tool] : [];
  }
  if (step.kind === "skill") return skillWrites(step.skill, ctx);
  return [];
}

/** The external tools a skill (by reference) may call; undefined when the registries don't know. */
export function skillWrites(ref: string, ctx: TypingContext): ToolSpec[] | undefined {
  const skill = lookupSkill(ref, ctx);
  if (!skill || !ctx.tools) return undefined;
  return skillTools(skill)
    .map((id) => ctx.tools?.[id])
    .filter((t): t is ToolSpec => t?.sideEffect === "external");
}

/** The tools the agent may use (its extra tools and its skills' tools); undefined when unknown. */
export function allowedTools(
  ctx: Pick<TypingContext, "skills"> & {
    agent?: Pick<AgentDefinition, "skills" | "extraTools"> | undefined;
  },
): Set<string> | undefined {
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
      checkFixed(c, step.id, step.input, tool?.fixedInputs);
      break;
    }
    case "person":
      checkRefs(c, step.id, step.title, ["title"], scope);
      checkRefs(c, step.id, step.payload, ["payload"], scope);
      checkChoices(c, step);
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
      const types = valueTypes(c, step.over, scope);
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
  // §1.73: a verb a person always signs can't be set to run without approval, whatever the
  // connection allows.
  if (approval?.required === "not_required") {
    const always = (writes ?? []).find((t) => isAlwaysSigned(t));
    if (always) {
      c.add(
        step.id,
        "approval.required",
        "approval_always",
        `"${always.id}" always needs a person to sign it`,
      );
    }
  }
  if (step.kind === "skill") {
    // A built-in skill with its own fixed inputs (comms.reach-out's purpose) writes only from them:
    // those fields must be the step's own text, like an action step's.
    const def = lookupSkill(step.skill, ctx);
    checkFixed(c, step.id, step.input, def?.fixedInputs);
    checkSkillFixedWrites(c, step.id, def, writes, "an action step");
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
      } else if (
        checkEntityOff(
          c,
          step.id,
          tool,
          connector,
          step.kind === "action" ? step.input : undefined,
          step.kind === "action" ? "tool" : "skill",
        )
      ) {
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

/**
 * A skill whose model could call a tool that runs only from fixed text (until R2 retires such
 * skills): refused, since the model would write that text. `where` names the step kind that can
 * run the tool ("an action step" in v3, "a write step" in v4).
 */
export function checkSkillFixedWrites(
  c: CheckSink,
  stepId: string,
  def: Pick<SkillDefinition, "fixedInputs"> | undefined,
  writes: readonly ToolSpec[] | undefined,
  where: string,
) {
  for (const tool of def?.fixedInputs?.length ? [] : (writes ?? [])) {
    if (!tool.fixedInputs?.length) continue;
    c.add(
      stepId,
      "skill",
      "input_not_fixed",
      `"${tool.id}" runs only from ${where} with its ${tool.fixedInputs.join(" and ")} written in it, not from a skill`,
    );
  }
}

// v0.14 W4-B (docs/plan.md §1.44 "Off at publish"): an entity turned off on the client's connection
// or in the agent's grant is refused at publish, as a verb turned off is. Returns whether it was.
/**
 * `input` is the step's own input when it names the entity (an action or write step); a skill's
 * model chooses its tools' input, so a skill step passes undefined. `at` is the field the error
 * sits on ("tool" or "skill").
 */
export function checkEntityOff(
  c: CheckSink & { ctx: { publish?: ValidationContext["publish"] | undefined } },
  stepId: string,
  tool: ToolSpec,
  connector: string,
  input: Record<string, unknown> | undefined,
  at: string,
): boolean {
  const publish = c.ctx.publish;
  if (!publish) return false;
  const entity = publishEntity(tool, input);
  if (entity === undefined) return false;
  if (entity === "") {
    const f = tool.entityInput?.field ?? "";
    c.add(stepId, `input.${f}`, "entity_off", `"${tool.id}" can't work on that ${f}`);
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
    stepId,
    at,
    "entity_off",
    `${who} doesn't allow ${VERB_NOUN[tool.verb]} of ${entity} records ("${tool.id}")`,
  );
  return true;
}

const CRON_FIELD = /^[0-9A-Za-z*/,?#LW-]+$/;

// v0.13 W2-H: a skill step's model override (ARCHITECTURE §10.11, docs/plan.md §1.53).
/** A step may override the model of a `task` or `agent` skill, with an id the platform knows. */
export function checkStepModel(
  c: CheckSink & { ctx: { models?: readonly string[] | undefined } },
  step: { id: string; model?: { id: string } | undefined },
  skill: SkillDefinition | undefined,
) {
  if (step.model === undefined) return;
  // P-4: a conversation runs as code, but each of its turns is a model call in the agent's voice,
  // which the step's model may choose (docs/plan.md §1.66).
  if (skill?.mode === "tool" && skill.id !== CONVERSE_SKILL) {
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

/** Whether `tz` is an IANA zone the runtime knows. */
export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// v0.12 W2-E: every trigger of the workflow (`moreTriggers` too) is checked; a trigger's filter and
// dedupe key read that trigger's own payload.
/** One trigger; `own` is the scope its filter and dedupe key read (that trigger's own payload). */
export function checkTrigger<S>(
  c: RefChecker<S> & { ctx: { events?: TypingContext["events"] | undefined } },
  trigger: Trigger,
  own: S,
) {
  const { id, on } = trigger;
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
  const c = checker(ctx, errors, slug);
  // v0.12 W2-E: every trigger, and what a successful run hands off.
  for (const t of allTriggers(workflow)) {
    checkTrigger(c, t, { trigger: triggerOnSchema(t.on, ctx), steps: {} });
  }
  checkHandoff(c, workflow);
  const allowed = allowedTools(ctx);
  const byStep = scopes(workflow, ctx);
  walkSteps(workflow, ({ step }) => {
    checkStep(c, step, byStep.get(step.id) as Scope, allowed);
    // P-4
    checkConverse(c, step);
  });
  return errors;
}

// P-4: conversations (ARCHITECTURE §10.12; docs/plan.md §1.66). What the input schema can't say:
// the goal's result is an object with fields, the channel fits who it is with, limits within caps.
function checkConverse(c: Checker, step: Step) {
  if (step.kind !== "skill" || parseSkillRef(step.skill).id !== CONVERSE_SKILL) return;
  for (const p of converseProblems(step.input)) {
    c.add(step.id, `input.${p.field}`, "converse_invalid", p.message);
  }
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
 * The agent's own models, its definition's and its oversight's: when the caller lists the priced
 * models, an id whose prefix names a provider other than Anthropic (`openai:`, `xai:`,
 * `google:`) must be one of them.
 */
// DECISION (Models: xAI and Gemini): a call to a model with no price is recorded at no cost, so
// the run's and the owner's cost limits would never stop it. Step, skill and reviewer models are
// already checked against the priced list; the agent's own model was not, so a provider-prefixed
// id with no price is refused here too (and by packages/llm's client before it calls). Anthropic
// ids without a price are left as they were (older bundles and tests name such ids).
export function definitionModelErrors(
  definition: Pick<AgentDefinition, "model" | "oversight"> & {
    skills?: readonly { model?: { id: string } | undefined }[] | undefined;
  },
  models: readonly string[] | undefined,
): ValidationError[] {
  if (!models) return [];
  const errors: ValidationError[] = [];
  const check = (id: string | undefined, at: string) => {
    if (!id || modelProvider(id) === "anthropic" || models.includes(id)) return;
    errors.push({
      stepId: null,
      field: at,
      code: "unknown_model",
      message: `no priced model "${id}": its cost could not be counted against the limits`,
    });
  };
  check(definition.model.id, "definition.model.id");
  check(definition.oversight?.model?.id, "definition.oversight.model.id");
  // Skill model (2026-11-10): the model the agent sets per skill is held to the same list.
  (definition.skills ?? []).forEach((s, i) => {
    check(s.model?.id, `definition.skills.${i}.model.id`);
  });
  return errors;
}

/**
 * Skill model (2026-11-10): the agent's settings per skill (`definition.skills[]`). Its
 * parameter values fit the skill's declared parameters (and, at publish, every parameter without
 * a default has one); its model is one the platform knows, and only for a skill that runs a model.
 * A skill the context doesn't know is skipped (`unknown_skill` is reported elsewhere).
 */
export function definitionSkillErrors(
  definition: Pick<AgentDefinition, "skills">,
  ctx: Pick<ValidationContext, "skills" | "models">,
  options: { complete?: boolean } = {},
): ValidationError[] {
  const errors: ValidationError[] = [];
  definition.skills.forEach((entry, i) => {
    const skill = lookupSkill(entry.skill, ctx);
    if (!skill) return;
    const at = `definition.skills.${i}`;
    // Only a skill that declares parameters needs them set; one with none takes none.
    const values = entry.parameters;
    if (values !== undefined || (skill.parameters?.length ?? 0) > 0) {
      for (const p of parameterValueProblems(skill, values, options)) {
        errors.push({
          stepId: null,
          field: p.name ? `${at}.parameters.${p.name}` : `${at}.parameters`,
          code: "parameter_invalid",
          message: p.message,
        });
      }
    }
    if (entry.model !== undefined) {
      if (skill.mode === "tool") {
        errors.push({
          stepId: null,
          field: `${at}.model`,
          code: "model_not_allowed",
          message: `"${skill.id}" runs as code, so it has no model to choose`,
        });
      } else if (ctx.models && !ctx.models.includes(entry.model.id)) {
        errors.push({
          stepId: null,
          field: `${at}.model.id`,
          code: "unknown_model",
          message: `no model "${entry.model.id}"`,
        });
      }
    }
  });
  return errors;
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
  errors.push(...definitionModelErrors(bundle.definition, ctx.models));
  errors.push(
    ...definitionSkillErrors(bundle.definition, ctx, { complete: ctx.publish !== undefined }),
  );
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
  // Wave 3b: a v4 automation (process steps) runs only inside a v4 process; a v3 workflow's use
  // step expands v3 steps.
  if (def.schemaVersion !== 1) {
    c.add(
      step.id,
      "automation",
      "unknown_automation",
      `"${step.automation}" holds steps in the new format: only a workflow in the new format can use it (open this workflow in the builder to move it)`,
    );
    return;
  }
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
    // §1.73: as for a step of the agent's own.
    const always =
      approval.required === "not_required"
        ? (writes ?? []).find((t) => isAlwaysSigned(t))
        : undefined;
    if (always) {
      c.add(
        step.id,
        `approvals.${innerId}.required`,
        "approval_always",
        `"${always.id}" always needs a person to sign it`,
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
  const c = checker(ctx, errors);
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
  /**
   * Automation versions by pinned reference (`slug@version`): their steps are enough. Wave 3b: a
   * v4 automation (`schemaVersion: 2`) may be listed; a v3 use step never runs one.
   */
  automations?: Readonly<
    Record<string, { schemaVersion?: 1; steps: readonly Step[] } | { schemaVersion: 2 }>
  >;
}

/** The v3 automation a use step pins, from the checkpoint context (a v4 one is not its). */
function v3Automation(ctx: CheckpointContext, ref: string): { steps: readonly Step[] } | undefined {
  const def = Object.hasOwn(ctx.automations ?? {}, ref) ? ctx.automations?.[ref] : undefined;
  return def && def.schemaVersion !== 2 && "steps" in def ? def : undefined;
}

/**
 * Whether a step can write to a client's tool: an action with an external tool, a skill whose tools
 * write (or that reaches people), or a use step whose automation has such a step.
 */
function writesForCheckpoints(step: Step, ctx: CheckpointContext): boolean {
  if (step.kind === "use_automation") {
    const def = v3Automation(ctx, step.automation);
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
    const def = v3Automation(ctx, use.automation);
    if (!def) continue;
    for (const id of checkpointSteps(def.steps, ctx)) out.push(`${use.id}/${id}`);
  }
  return out;
}
