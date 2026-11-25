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
  jsonTypeOf,
  lookupSkill,
  type PathType,
  type Scope,
  schemaTypes,
  type TypingContext,
  triggerOnSchema,
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
  // Collect reports (owner, 2026-11-24): a report trigger, which only a v4 process takes, naming
  // its first step, a collect step, once.
  | "report_trigger"
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
  // Step model §8: a Loop step publishes only as a saved, tested Loop skill.
  | "loop_unsaved"
  | "loop_not_a_loop"
  // Step model §10f: a grant on a record type nobody declares, or a write it doesn't allow.
  | "record_grant_invalid"
  | "loop_untested"
  | "skill_not_allowed"
  | "agent_not_commandable"
  // PLATFORM_QA CONS-1: a skill step runs as the agent that owns the workflow.
  | "step_agent_unsupported"
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

// DECISION (PLATFORM_QA CONS-1): a skill step's `agent` (ARCHITECTURE §10.1, "another agent of the
// same client") is refused, not run: the executor runs every skill step as the agent that owns the
// workflow, so a step naming another agent would run as the owner or fail. Running a step as
// another agent would need that agent's live version, bindings and approver on the run; until
// then, a hand off step starts the other agent's own run. The schema keeps the field, so stored
// versions still parse.
export const STEP_AGENT_UNSUPPORTED =
  "a skill step runs as this agent; to have another agent do the work, hand off to it";

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

// The JSON type helpers live with the template typer (template/typer.ts).
export { jsonTypeOf, typesCompatible };

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
    if (!typesCompatible(accepted, actual)) {
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

// QA (2026-11-14): "99 99 99 99 99" passed the characters check and was saved. Each field's
// numbers are now held to its range (minute, hour, day of month, month, day of week; 7 is Sunday
// too, as the scheduler's cron-parser reads it) and a step must be 1 or more. Names (MON, JAN)
// and the specials L, W, # and ? are left to the scheduler, as before.
const CRON_RANGES: readonly (readonly [number, number])[] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

/** Whether `cron` is five fields whose numbers are in range and whose steps are 1 or more. */
export function validCron(cron: string): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field, i) => {
    if (!CRON_FIELD.test(field)) return false;
    const [lo, hi] = CRON_RANGES[i] as readonly [number, number];
    return field.split(",").every((part) => {
      const [range = "", step, extra] = part.split("/");
      if (extra !== undefined || range === "") return false;
      if (step !== undefined && !(/^\d+$/.test(step) && Number(step) >= 1)) return false;
      if (range === "*" || range === "?") return true;
      const bounds = range.split("-");
      if (bounds.length > 2) return false;
      const numbers = bounds.filter((b) => /^\d+$/.test(b)).map(Number);
      if (numbers.some((n) => n < lo || n > hi)) return false;
      return !(numbers.length === 2 && (numbers[0] as number) > (numbers[1] as number));
    });
  });
}

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
    if (!validCron(on.cron)) {
      c.add(id, "on.cron", "invalid_cron", "a schedule needs five cron fields, e.g. 0 7 * * 1-5");
    }
    if (on.tz !== undefined && !validTimezone(on.tz)) {
      c.add(id, "on.tz", "invalid_timezone", `unknown timezone "${on.tz}"`);
    }
  }
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
