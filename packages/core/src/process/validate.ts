// R1 (docs/plan.md §1.86, §9): validation of a v4 process, the counterpart of `validateWorkflow`
// (workflow/validate.ts). Shared by the builder (in the browser, on every change) and the server
// (before test runs and publish). Each error names the step, path or trigger and the field inside
// it, so the builder can mark both. A process is valid with warnings: those are advice only (a
// process that might be better split).

import type { z } from "zod";
import { CONVERSE_SKILL, converseProblems, typedResultOutput } from "../converse";
import { localizedVersions } from "../i18n/locale";
import { isPlainObject } from "../json";
import { levelFor } from "../permissions/decide";
import { entityOffBy, publishEntity } from "../permissions/entities";
import { compileRule, RuleCompileError } from "../rules/compile";
import type { AgentDefinition } from "../schemas/agent";
import type { JsonSchema } from "../schemas/common";
import { parseSkillRef } from "../schemas/common";
import type { AgentMode, Verb } from "../schemas/permissions";
import type { Rules } from "../schemas/rules";
import { type SkillDefinition, skillTools } from "../schemas/skill";
import { isAlwaysSigned, type ToolSpec } from "../schemas/tool";
import type { Trigger, Step as V3Step } from "../schemas/workflow";
import { collectRefs, hasTemplate, singleRef } from "../template/template";
import {
  automationOutputSchema,
  FOR_EACH_OUTPUT,
  FORK_OUTPUT,
  lookupSkill,
  NO_OUTPUT,
  type PathType,
  PERSON_OUTPUT,
  schemaAtPath,
  schemaTypes,
  type TypingContext,
  triggerOnSchema,
} from "../template/typer";
import { mergeTriggerSchemas } from "../triggers/typing";
import {
  type ValidationCode,
  type ValidationContext,
  stepWrites as v3StepWrites,
} from "../workflow/validate";
import { walkSteps as walkV3Steps } from "../workflow/walk";
import {
  type ApprovalCheck,
  CONFER_VERDICTS,
  type Deadline,
  type DeadlineThen,
  type ForEachStep,
  type NotifyCheck,
  type Process,
  Process as ProcessSchema,
  type Step,
  type SubProcessStep,
} from "./schema";
import { stepCount, walkSteps } from "./walk";

// ── Results ──────────────────────────────────────────────────────────────────────────────────

/** v3's codes (same meaning, same names) plus what v4 adds. */
export type ProcessValidationCode =
  | ValidationCode
  // An `if` with no path (v3's `fork_no_paths`).
  | "if_no_paths"
  // A read step whose tool changes something, a write step whose tool only reads.
  | "read_not_read"
  | "write_not_write"
  // Something that waits (a person reviewer, a person step, a conversation) without a deadline.
  | "deadline_missing"
  // An urgent notice without the time it must be seen in.
  | "urgent_needs_ack"
  // Invariant 8: a loosened approval on a write whose agent doesn't act on its own.
  | "approval_needs_act";

export interface ProcessValidationError {
  /** The step, if path, otherwise branch or trigger id; null for process-level errors. */
  stepId: string | null;
  /** Dotted path inside that node (e.g. "input.vendor", "checks.approval.required"), or "". */
  field: string;
  message: string;
  code: ProcessValidationCode;
}

/** Advice, never an error: signs that the process does too much and could be split. */
export type ProcessWarningCode = "split_long" | "split_deep";

export interface ProcessWarning {
  stepId: string | null;
  field: string;
  message: string;
  code: ProcessWarningCode;
}

export interface ProcessValidationResult {
  valid: boolean;
  errors: ProcessValidationError[];
  /** Advice only: `valid` doesn't depend on it. */
  warnings: ProcessWarning[];
  /** The parsed process (defaults applied) when it passed the schema. */
  value?: Process;
}

// DECISION: the split signals are advice at more than 20 steps (nested ones counted) or logic
// (`if`, `for_each`) nested more than 3 deep (owner's doc "Mezonas process model").
export const SPLIT_MAX_STEPS = 20;
export const SPLIT_MAX_DEPTH = 3;

export interface ProcessValidationContext extends TypingContext {
  /**
   * The owning agent: skills and tools must be among what it allows. Its mode, when given, is
   * checked at publish: a write runs without approval only for an agent that acts (invariant 8).
   */
  agent?: Pick<AgentDefinition, "skills" | "extraTools" | "canCommand"> & {
    permissions?: { mode?: AgentMode | undefined } | undefined;
  };
  /**
   * Publish-time checks for a client agent: the client's connection matrices by connector id (from
   * its bindings), and optionally the agent's grants and the connectors' entities. Absent: the
   * connection checks are skipped (templates, drafts), as for v3.
   */
  publish?: ValidationContext["publish"];
  /** Whether the process is a client agent's (a sub-process step's `approvals` are theirs only). */
  clientAgent?: boolean;
  /** The model ids the platform knows (`packages/llm`); absent, a step's model isn't checked. */
  models?: readonly string[];
  /**
   * What `{{settings.…}}` reads: the schema of the agent's settings for this process.
   */
  // DECISION: v4 has no settings schema of its own yet (R2 and R8 define where a process's settings
  // live). Until a caller passes one, `{{settings.…}}` is in scope and untyped, like an unknown
  // trigger payload: any path reads.
  settings?: JsonSchema;
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

// ── Schema errors, located ───────────────────────────────────────────────────────────────────

type NodeKind = "root" | "step" | "branch" | "trigger";

/** Which keys of a node lead to child nodes: a list of them, or one. */
const CHILDREN: Record<NodeKind, Record<string, { kind: NodeKind; many: boolean }>> = {
  root: { triggers: { kind: "trigger", many: true }, steps: { kind: "step", many: true } },
  step: {
    paths: { kind: "branch", many: true },
    otherwise: { kind: "branch", many: false },
    steps: { kind: "step", many: true },
  },
  branch: { steps: { kind: "step", many: true } },
  trigger: {},
};

function at(value: unknown, seg: string | number): unknown {
  return isPlainObject(value) || Array.isArray(value)
    ? (value as Record<string | number, unknown>)[seg]
    : undefined;
}

/** The node (step, path, otherwise or trigger) an issue path points into, along the raw input. */
function locate(raw: unknown, path: readonly (string | number)[]) {
  let cur: unknown = raw;
  let level: NodeKind | null = "root";
  let pending: NodeKind | null = null;
  let stepId: string | null = null;
  let node: Record<string, unknown> | undefined;
  let start = 0;
  path.forEach((seg, i) => {
    cur = at(cur, seg);
    const enter = (kind: NodeKind) => {
      if (isPlainObject(cur) && typeof cur.id === "string") {
        stepId = cur.id;
        node = cur;
        start = i + 1;
        level = kind;
      } else level = null;
    };
    if (pending) {
      const kind: NodeKind = pending;
      pending = null;
      if (typeof seg === "number") enter(kind);
      else level = null;
      return;
    }
    const child = level ? CHILDREN[level][String(seg)] : undefined;
    if (!child) {
      level = null;
      return;
    }
    if (child.many) {
      pending = child.kind;
      level = null;
    } else enter(child.kind);
  });
  return {
    stepId: stepId as string | null,
    node: node as Record<string, unknown> | undefined,
    start,
  };
}

/**
 * A union that failed is reported by its one branch that had the right shape (a person reviewer
 * missing its deadline is about the deadline, not about not being an AI reviewer).
 */
function expandUnion(issue: z.core.$ZodIssue): z.core.$ZodIssue[] {
  if (issue.code !== "invalid_union" || !Array.isArray(issue.errors)) return [issue];
  const shaped = issue.errors.filter((b) => b.length > 0 && b.every((e) => e.path.length > 0));
  if (shaped.length !== 1) return [issue];
  return (shaped[0] as z.core.$ZodIssue[]).flatMap((e) =>
    expandUnion({ ...e, path: [...issue.path, ...e.path] } as z.core.$ZodIssue),
  );
}

function schemaErrors(issues: z.core.$ZodIssue[], raw: unknown): ProcessValidationError[] {
  return issues.flatMap(expandUnion).map((issue) => {
    const path = issue.path as (string | number)[];
    const { stepId, node, start } = locate(raw, path);
    const err: ProcessValidationError = {
      stepId,
      field: field(path.slice(start)),
      message: issue.message,
      code: "schema",
    };
    const last = path.at(-1);
    const parent = path.slice(0, -1).reduce<unknown>((v, s) => at(v, s), raw);
    const missing =
      issue.code === "invalid_type" &&
      typeof last === "string" &&
      isPlainObject(parent) &&
      !Object.hasOwn(parent, last);
    if (issue.code === "too_small" && start === path.length - 1 && node) {
      if (last === "paths" && node.kind === "if") {
        err.code = "if_no_paths";
        err.message = "an if needs at least one path";
      } else if (last === "steps" && node.kind === "for_each") {
        err.code = "for_each_empty";
        err.message = "a for each needs at least one step";
      }
    } else if (missing && last === "deadline") {
      err.code = "deadline_missing";
      err.message = "say how long to wait, and what happens if nobody answers";
    } else if (missing && last === "ackWithin") {
      err.code = "urgent_needs_ack";
      err.message = "an urgent notice needs the time it must be seen in";
    }
    return err;
  });
}

// ── Template typing for v4 ───────────────────────────────────────────────────────────────────

/** One confer reviewer's answer, as a check's conditions read it: `{{confer.<n>.verdict}}`. */
// DECISION: reviewers have no ids, so a verdict is read by the reviewer's place in `with` (from 0).
// Readable in the step's own checks only: a reviewer's `when` sees the reviewers before it; the
// approval and notify conditions see them all.
export const CONFER_RESULT: JsonSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: [...CONFER_VERDICTS] },
    note: { type: "string" },
    by: { type: "string" },
  },
  required: ["verdict"],
  additionalProperties: false,
};

/** What references are in scope at a v4 step (or in one of its checks). */
export interface ProcessScope {
  trigger: JsonSchema | undefined;
  settings: JsonSchema | undefined;
  /** Upstream steps visible here, by id, with their output schemas. */
  steps: Record<string, { step: Step; output: JsonSchema | undefined }>;
  /** Inside a for_each: the item schema (undefined when unknown). */
  loop?: { item: JsonSchema | undefined; step: ForEachStep };
  /** In a step's checks: how many of its confer reviewers' verdicts are readable. */
  confer?: number;
}

/** What a v4 step outputs, for later steps' templates. Unknown (any path reads) when unknown. */
export function stepOutputSchema(step: Step, ctx: TypingContext): JsonSchema | undefined {
  switch (step.kind) {
    case "read":
    case "write":
      return ctx.tools?.[step.tool]?.output;
    case "skill": {
      const def = lookupSkill(step.skill, ctx);
      if (def?.resultFromInput)
        return typedResultOutput(def.output, def.resultFromInput, step.input);
      return def?.output;
    }
    case "person":
      return PERSON_OUTPUT;
    case "if":
      return FORK_OUTPUT;
    case "for_each":
      return FOR_EACH_OUTPUT;
    case "process": {
      const def = ctx.automations?.[step.process];
      return def ? automationOutputSchema(def, ctx) : undefined;
    }
    // DECISION: a conversation's output is typed when R7 builds the step (what `find` returns);
    // until then it is unknown, so later steps may read any field of it.
    case "conversation":
      return undefined;
    default:
      return NO_OUTPUT;
  }
}

/** One `{{trigger.…}}` schema for every trigger of the process (a field some lack is optional). */
export function processTriggerSchema(
  process: Pick<Process, "triggers">,
  ctx: TypingContext,
): JsonSchema | undefined {
  return mergeTriggerSchemas(process.triggers.map((t) => triggerOnSchema(t.on, ctx)));
}

/** The type of a reference at a v4 step, or why it isn't readable there. */
export function typeProcessPath(scope: ProcessScope, path: readonly string[]): PathType {
  const [root, ...rest] = path;
  switch (root) {
    case "trigger":
      return schemaAtPath(scope.trigger, rest);
    case "settings":
      return schemaAtPath(scope.settings, rest);
    case "steps": {
      const [id, output, ...tail] = rest;
      if (id === undefined) return { ok: false, message: "steps.<id>.output... needs a step id" };
      const s = scope.steps[id];
      if (!s)
        return { ok: false, message: `step "${id}" does not run before this one on its path` };
      if (output !== "output") return { ok: false, message: `use steps.${id}.output.<field>` };
      return schemaAtPath(s.output, tail);
    }
    case "item":
      if (!scope.loop)
        return { ok: false, message: "{{item}} is only available inside a for_each" };
      return schemaAtPath(scope.loop.item, rest);
    case "index":
      if (!scope.loop)
        return { ok: false, message: "{{index}} is only available inside a for_each" };
      if (rest.length > 0) return { ok: false, message: "{{index}} is a number" };
      return { ok: true, schema: { type: "integer" } };
    case "confer": {
      if (scope.confer === undefined) {
        return {
          ok: false,
          message: "{{confer}} is only readable in the checks of a step that confers",
        };
      }
      const [n, ...tail] = rest;
      if (n === undefined || !/^\d+$/.test(n)) {
        return { ok: false, message: "use confer.<n>.verdict, counting reviewers from 0" };
      }
      if (Number(n) >= scope.confer) {
        return {
          ok: false,
          message: `reviewer ${n} hasn't answered here: a reviewer's condition reads only the reviewers before it`,
        };
      }
      return schemaAtPath(CONFER_RESULT, tail);
    }
    default:
      return {
        ok: false,
        message: `unknown reference "${root}": use trigger, settings, steps, item or index`,
      };
  }
}

/** Whether the reference's root is readable here (so a failure is a bad path, not a bad scope). */
function rootInScope(scope: ProcessScope, path: readonly string[]): boolean {
  const [root, id, third] = path;
  if (root === "trigger" || root === "settings") return true;
  if (root === "item") return scope.loop !== undefined;
  if (root === "steps")
    return id !== undefined && scope.steps[id] !== undefined && third === "output";
  if (root === "confer") {
    return (
      scope.confer !== undefined &&
      id !== undefined &&
      /^\d+$/.test(id) &&
      Number(id) < scope.confer
    );
  }
  return false;
}

function itemSchemaOf(over: string, scope: ProcessScope): JsonSchema | undefined {
  let path: string[] | null;
  try {
    path = singleRef(over);
  } catch {
    return undefined;
  }
  if (!path) return undefined;
  const t = typeProcessPath(scope, path);
  if (!t.ok || !t.schema) return undefined;
  return isPlainObject(t.schema.items) ? (t.schema.items as JsonSchema) : undefined;
}

/** The scope of every step, in walk order (one per place, so a duplicated id gets its own). */
function scopeList(
  process: Pick<Process, "triggers" | "steps">,
  ctx: ProcessValidationContext,
): { step: Step; scope: ProcessScope }[] {
  const trigger = processTriggerSchema(process, ctx);
  // A duplicated id (an error anyway) reads as its last step, as v3 does.
  const byId = new Map<string, Step>();
  const locs: { step: Step; before: string[]; loop: ForEachStep | undefined }[] = [];
  walkSteps(process, (loc) => {
    byId.set(loc.step.id, loc.step);
    locs.push({ step: loc.step, before: loc.before, loop: loc.loops.at(-1) });
  });
  return locs.map((l) => {
    const scope: ProcessScope = { trigger, settings: ctx.settings, steps: {} };
    for (const id of l.before) {
      const s = byId.get(id);
      if (s) scope.steps[id] = { step: s, output: stepOutputSchema(s, ctx) };
    }
    if (l.loop) scope.loop = { step: l.loop, item: itemSchemaOf(l.loop.over, scope) };
    return { step: l.step, scope };
  });
}

/** Scopes for every step of a process at once, by step id (the builder's field picker). */
export function processScopes(
  process: Pick<Process, "triggers" | "steps">,
  ctx: ProcessValidationContext = {},
): Map<string, ProcessScope> {
  const out = new Map<string, ProcessScope>();
  for (const { step, scope } of scopeList(process, ctx)) {
    if (!out.has(step.id)) out.set(step.id, scope);
  }
  return out;
}

// ── Checker ──────────────────────────────────────────────────────────────────────────────────

interface Checker {
  ctx: ProcessValidationContext;
  add(stepId: string | null, f: string, code: ProcessValidationCode, message: string): void;
}

function checkRefs(
  c: Checker,
  nodeId: string,
  value: unknown,
  where: (string | number)[],
  scope: ProcessScope,
) {
  const { refs, errors } = collectRefs(value, where);
  for (const e of errors) c.add(nodeId, field(e.at), "template_syntax", e.message);
  for (const r of refs) {
    const t = typeProcessPath(scope, r.path);
    if (t.ok) continue;
    c.add(
      nodeId,
      field(r.at),
      rootInScope(scope, r.path) ? "template_path" : "template_scope",
      `{{${r.expr}}}: ${t.message}`,
    );
  }
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

/** The type a templated value will have, when it can be known. */
function valueTypes(value: unknown, scope: ProcessScope): string[] {
  if (typeof value === "string" && value.includes("{{")) {
    let path: string[] | null = null;
    try {
      path = singleRef(value);
    } catch {
      return [];
    }
    if (!path) return ["string"];
    const t = typeProcessPath(scope, path);
    return t.ok ? schemaTypes(t.schema) : [];
  }
  return [literalType(value)];
}

function checkInput(
  c: Checker,
  stepId: string,
  input: Record<string, unknown>,
  schema: JsonSchema | undefined,
  scope: ProcessScope,
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

/** Input fields that become instructions must be written in the step, never templated. */
function checkFixed(
  c: Checker,
  stepId: string,
  input: Record<string, unknown>,
  fixed: readonly string[] | undefined,
) {
  for (const f of fixed ?? []) {
    if (hasTemplate(input[f])) {
      c.add(
        stepId,
        `input.${f}`,
        "input_not_fixed",
        `write ${f} in the step: it becomes instructions, so it can't come from a template`,
      );
    }
  }
}

function checkRules(
  c: Checker,
  nodeId: string,
  rules: Rules,
  where: (string | number)[],
  scope: ProcessScope,
  requireRules: boolean,
) {
  if (requireRules && rules.rules.length === 0) {
    c.add(nodeId, field([...where, "rules"]), "rules_empty", "add a condition, or use otherwise");
  }
  rules.rules.forEach((rule, i) => {
    const here = [...where, "rules", i];
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

// ── Writes and approval (invariant 8) ────────────────────────────────────────────────────────

/**
 * The external tools a step can call: what makes it a write that needs approval. A write step's
 * tool when external; a skill whose tools write (v3 skills, until R2 retires them); a skill that
 * reaches people counts through `reachesPeople`. Undefined when the registries don't know.
 */
export function stepWrites(step: Step, ctx: TypingContext): ToolSpec[] | undefined {
  if (step.kind === "write") {
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

/** One way an approval can let a write through without a person's yes. */
export interface Loosening {
  /** Where, in the step (e.g. "checks.approval.when"). */
  field: string;
  what: "not_required" | "when" | "proceed";
}

function proceedsIn(then: DeadlineThen, f: string, out: Loosening[]) {
  if (then === "proceed") out.push({ field: f, what: "proceed" });
  else if (typeof then === "object") {
    proceedsInDeadline(then.escalate.deadline, `${f}.escalate.deadline`, out);
  }
}

function proceedsInDeadline(d: Deadline, f: string, out: Loosening[]) {
  proceedsIn(d.ifNoAnswer, `${f}.ifNoAnswer`, out);
}

/**
 * Every loosening in an approval: switched off (`not_required`), limited to some runs (`when`),
 * or going ahead when nobody answers (`proceed`, the approval's own or any approver's deadline or
 * escalation). On a write each is loosening (invariant 8), allowed only where the connection
 * allows `auto` for the verb and the agent acts.
 */
export function approvalLoosenings(
  approval: ApprovalCheck | undefined,
  prefix: string,
): Loosening[] {
  if (!approval) return [];
  const out: Loosening[] = [];
  if (approval.required === "not_required") {
    out.push({ field: `${prefix}.required`, what: "not_required" });
  }
  if (approval.when) out.push({ field: `${prefix}.when`, what: "when" });
  proceedsIn(approval.ifNoAnswer, `${prefix}.ifNoAnswer`, out);
  (approval.approvers ?? []).forEach((a, i) => {
    if (a.deadline) proceedsInDeadline(a.deadline, `${prefix}.approvers.${i}.deadline`, out);
  });
  return out;
}

const LOOSENED: Record<Loosening["what"], string> = {
  not_required: "",
  when: ": on every run, not only when conditions hold",
  proceed: ": a write can't go ahead without an answer",
};

function allowedTools(ctx: ProcessValidationContext): Set<string> | undefined {
  if (!ctx.agent || !ctx.skills) return undefined;
  const ids = new Set(ctx.agent.extraTools ?? []);
  for (const s of ctx.agent.skills) {
    const def = lookupSkill(s.skill, ctx);
    if (def) for (const t of skillTools(def)) ids.add(t);
  }
  return ids;
}

/**
 * The approval rules of a step: `not_required` only where something is written (v3's rule), no
 * loosening of a verb a person always signs (§1.73), and at publish the connection's matrix, the
 * agent's grant and mode (invariant 8; v3 checked `not_required`, v4 also `when` and `proceed`).
 */
function checkApproval(c: Checker, step: Step) {
  const { ctx } = c;
  const loose = approvalLoosenings(step.checks?.approval, "checks.approval");
  const writes = stepWrites(step, ctx);
  const reaches = step.kind === "skill" && lookupSkill(step.skill, ctx)?.reachesPeople === true;
  const off = loose.find((l) => l.what === "not_required");
  if (off && writes !== undefined && writes.length === 0 && !reaches) {
    c.add(
      step.id,
      off.field,
      "approval_not_write",
      "only steps that change a client's tool have an approval setting",
    );
  }
  const always = (writes ?? []).find((t) => isAlwaysSigned(t));
  if (always) {
    for (const l of loose) {
      c.add(step.id, l.field, "approval_always", `"${always.id}" always needs a person to sign it`);
    }
  }
  if (!ctx.publish || !writes) return;
  const matrices = ctx.publish.matrices;
  const at = step.kind === "write" ? "tool" : "skill";
  for (const tool of writes) {
    const connector = tool.connector ?? tool.source;
    if (!(connector in matrices) || matrices[connector] === undefined) {
      c.add(
        step.id,
        "",
        "connection_missing",
        `no ${connector} connection is bound for "${tool.id}"`,
      );
      continue;
    }
    const level = levelFor(matrices[connector], tool.verb);
    if (level === "off") {
      c.add(
        step.id,
        at,
        "verb_off",
        `this connection doesn't allow ${VERB_NOUN[tool.verb]} ("${tool.id}")`,
      );
    } else if (checkEntityOff(c, step, tool, connector)) {
      // Reported there.
    } else if (level !== "auto") {
      for (const l of loose) {
        c.add(
          step.id,
          l.field,
          "approval_required_by_connection",
          `this connection requires approval for ${VERB_NOUN[tool.verb]}${LOOSENED[l.what]}`,
        );
      }
    }
  }
  // DECISION: the agent's mode is checked at publish only, with the connection (as v3 checks the
  // matrix): a draft or a template may hold a loosened step that its client agent can't use yet.
  const mode = ctx.agent?.permissions?.mode;
  if (writes.length > 0 && mode !== undefined && mode !== "act") {
    for (const l of loose) {
      c.add(
        step.id,
        l.field,
        "approval_needs_act",
        "the agent only suggests: set its mode to act before a write runs without approval",
      );
    }
  }
}

// An entity turned off on the client's connection or in the agent's grant is refused at publish.
function checkEntityOff(c: Checker, step: Step, tool: ToolSpec, connector: string): boolean {
  const publish = c.ctx.publish;
  if (!publish) return false;
  // A skill's model chooses its tools' input, so only a write step's own input names an entity.
  const entity = publishEntity(tool, step.kind === "write" ? step.input : undefined);
  if (entity === undefined) return false;
  const at = step.kind === "write" ? "tool" : "skill";
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

// ── Steps ────────────────────────────────────────────────────────────────────────────────────

function checkToolStep(
  c: Checker,
  step: Extract<Step, { kind: "read" | "write" }>,
  scope: ProcessScope,
  allowed: Set<string> | undefined,
) {
  const { ctx } = c;
  checkRefs(c, step.id, step.input, ["input"], scope);
  const tool = ctx.tools?.[step.tool];
  if (ctx.tools && !tool) c.add(step.id, "tool", "unknown_tool", `no tool "${step.tool}"`);
  if (!tool) return;
  if (step.kind === "read" && tool.sideEffect !== "none") {
    c.add(step.id, "tool", "read_not_read", `"${step.tool}" changes something: use a write step`);
  }
  if (step.kind === "write" && tool.sideEffect === "none") {
    c.add(step.id, "tool", "write_not_write", `"${step.tool}" only reads: use a read step`);
  }
  if (allowed && !allowed.has(step.tool)) {
    c.add(
      step.id,
      "tool",
      "tool_not_allowed",
      `the agent can't use "${step.tool}": add it to its tools or skills`,
    );
  }
  checkInput(c, step.id, step.input, tool.input, scope);
  checkFixed(c, step.id, step.input, tool.fixedInputs);
}

function checkSkillStep(c: Checker, step: Extract<Step, { kind: "skill" }>, scope: ProcessScope) {
  const { ctx } = c;
  checkRefs(c, step.id, step.input, ["input"], scope);
  const skill = lookupSkill(step.skill, ctx);
  if (ctx.skills && !skill) c.add(step.id, "skill", "unknown_skill", `no skill "${step.skill}"`);
  if (ctx.agent && step.agent === undefined) {
    const id = parseSkillRef(step.skill).id;
    const has = ctx.agent.skills.some((s) => parseSkillRef(s.skill).id === id);
    if (!has) c.add(step.id, "skill", "skill_not_allowed", `the agent has no skill "${id}"`);
  }
  if (ctx.agent && step.agent !== undefined && !(ctx.agent.canCommand ?? []).includes(step.agent)) {
    c.add(step.id, "agent", "agent_not_commandable", `the agent may not ask "${step.agent}"`);
  }
  if (skill) checkInput(c, step.id, step.input, skill.input, scope);
  checkStepModel(c, step, skill);
  // A built-in skill's own fixed inputs, and (until R2) a skill whose model could call a tool that
  // runs only from fixed text.
  checkFixed(c, step.id, step.input, skill?.fixedInputs);
  if (!skill?.fixedInputs?.length) {
    for (const tool of stepWrites(step, ctx) ?? []) {
      if (!tool.fixedInputs?.length) continue;
      c.add(
        step.id,
        "skill",
        "input_not_fixed",
        `"${tool.id}" runs only from a write step with its ${tool.fixedInputs.join(" and ")} written in it, not from a skill`,
      );
    }
  }
  if (parseSkillRef(step.skill).id === CONVERSE_SKILL) {
    for (const p of converseProblems(step.input)) {
      c.add(step.id, `input.${p.field}`, "converse_invalid", p.message);
    }
  }
}

/** A step may override the model of a `task` or `agent` skill, with an id the platform knows. */
function checkStepModel(
  c: Checker,
  step: Extract<Step, { kind: "skill" }>,
  skill: SkillDefinition | undefined,
) {
  if (step.model === undefined) return;
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

function checkNotify(
  c: Checker,
  nodeId: string,
  n: NotifyCheck,
  where: (string | number)[],
  scope: ProcessScope,
) {
  if (n.when) checkRules(c, nodeId, n.when, [...where, "when"], scope, false);
  checkRefs(c, nodeId, n.to, [...where, "to"], scope);
  checkRefs(c, nodeId, n.message, [...where, "message"], scope);
  if (n.sources !== undefined) checkRefs(c, nodeId, n.sources, [...where, "sources"], scope);
  if (n.urgent?.when)
    checkRules(c, nodeId, n.urgent.when, [...where, "urgent", "when"], scope, false);
}

/** A v3 automation's steps, nested ones included (sub-process steps pin v3 automations today). */
function automationSteps(steps: readonly V3Step[]): V3Step[] {
  const out: V3Step[] = [];
  walkV3Steps({ steps: [...steps] }, ({ step }) => out.push(step));
  return out;
}

/**
 * A sub-process step (v3's use step): its process exists, its input against the process's input,
 * `approvals` only on client agents and only for inner write steps, never loosening a verb a
 * person always signs, and at publish the agent's bindings cover the process's connectors.
 */
function checkSubProcess(c: Checker, step: SubProcessStep, scope: ProcessScope) {
  const { ctx } = c;
  checkRefs(c, step.id, step.input, ["input"], scope);
  const def = ctx.automations?.[step.process];
  if (ctx.automations && !def) {
    c.add(step.id, "process", "unknown_automation", `no process "${step.process}"`);
  }
  const approvals = Object.entries(step.approvals ?? {});
  if (approvals.length > 0 && ctx.clientAgent === false) {
    c.add(
      step.id,
      "approvals",
      "approvals_not_client",
      "only a client agent's process step can change an inner step's approval",
    );
  }
  if (!def) return;
  checkInput(c, step.id, step.input, def.input, scope);

  const inner = new Map(automationSteps(def.steps).map((s) => [s.id, s]));
  for (const [innerId, approval] of approvals) {
    const target = inner.get(innerId);
    if (!target) {
      c.add(
        step.id,
        `approvals.${innerId}`,
        "approval_unknown_step",
        `the process has no step "${innerId}"`,
      );
      continue;
    }
    const writes = v3StepWrites(target, ctx);
    const reaches =
      target.kind === "skill" && lookupSkill(target.skill, ctx)?.reachesPeople === true;
    const loose = approvalLoosenings(approval, `approvals.${innerId}`);
    const off = loose.find((l) => l.what === "not_required");
    if (
      off &&
      ((writes !== undefined && writes.length === 0 && !reaches) ||
        (target.kind !== "skill" && target.kind !== "action"))
    ) {
      c.add(
        step.id,
        off.field,
        "approval_not_write",
        "only steps that change a client's tool have an approval setting",
      );
    }
    const always = (writes ?? []).find((t) => isAlwaysSigned(t));
    if (always) {
      for (const l of loose) {
        c.add(
          step.id,
          l.field,
          "approval_always",
          `"${always.id}" always needs a person to sign it`,
        );
      }
    }
  }

  if (!ctx.publish) return;
  const { matrices } = ctx.publish;
  for (const connector of def.requires.connectors) {
    if (!(connector in matrices) || matrices[connector] === undefined) {
      c.add(
        step.id,
        "process",
        "connection_missing",
        `no ${connector} connection is bound for "${def.name}"`,
      );
    }
  }
  const mode = ctx.agent?.permissions?.mode;
  for (const target of inner.values()) {
    const override = step.approvals?.[target.id];
    const own = target.kind === "skill" || target.kind === "action" ? target.approval : undefined;
    const loose: Loosening[] = override
      ? approvalLoosenings(override, `approvals.${target.id}`)
      : own?.required === "not_required"
        ? [{ field: `approvals.${target.id}.required`, what: "not_required" }]
        : [];
    const writes = v3StepWrites(target, ctx) ?? [];
    for (const tool of writes) {
      const connector = tool.connector ?? tool.source;
      const matrix = matrices[connector];
      if (matrix === undefined) continue; // reported above, or by requires
      const level = levelFor(matrix, tool.verb);
      if (level === "off") {
        c.add(
          step.id,
          "process",
          "verb_off",
          `this connection doesn't allow ${VERB_NOUN[tool.verb]} ("${tool.id}", in ${def.name})`,
        );
      } else if (level !== "auto") {
        for (const l of loose) {
          c.add(
            step.id,
            l.field,
            "approval_required_by_connection",
            `this connection requires approval for ${VERB_NOUN[tool.verb]}${LOOSENED[l.what]}`,
          );
        }
      }
    }
    if (writes.length > 0 && mode !== undefined && mode !== "act") {
      for (const l of loose) {
        c.add(
          step.id,
          l.field,
          "approval_needs_act",
          "the agent only suggests: set its mode to act before a write runs without approval",
        );
      }
    }
  }
}

/**
 * A step's checks. Confer and approval run before a write and after a read or a skill, so their
 * conditions see the step's own output only for a read or a skill; notify runs after the step and
 * always sees it. A reviewer's `when` reads the verdicts of the reviewers before it; approval and
 * notify conditions read them all.
 */
function checkChecks(c: Checker, step: Step, base: ProcessScope) {
  const checks = step.checks;
  if (!checks) return;
  const own: ProcessScope["steps"] = {
    ...base.steps,
    [step.id]: { step, output: stepOutputSchema(step, c.ctx) },
  };
  const before: ProcessScope = {
    ...base,
    steps: step.kind === "read" || step.kind === "skill" ? own : base.steps,
  };
  const after: ProcessScope = { ...base, steps: own };
  const conferred = checks.confer?.with.length;
  const withConfer = (s: ProcessScope): ProcessScope =>
    conferred === undefined ? s : { ...s, confer: conferred };

  if (checks.confer) {
    const where = ["checks", "confer"];
    if (checks.confer.when) {
      checkRules(c, step.id, checks.confer.when, [...where, "when"], before, false);
    }
    checks.confer.with.forEach((r, i) => {
      const at = [...where, "with", i];
      const scope: ProcessScope = { ...before, confer: i };
      if ("ai" in r) {
        checkRefs(c, step.id, r.ai.focus, [...at, "ai", "focus"], scope);
        const known = c.ctx.models;
        if (r.ai.model && known && !known.includes(r.ai.model.id)) {
          c.add(
            step.id,
            field([...at, "ai", "model", "id"]),
            "unknown_model",
            `no model "${r.ai.model.id}"`,
          );
        }
      } else if (r.show !== undefined) {
        checkRefs(c, step.id, r.show, [...at, "show"], scope);
      }
      if (r.when) checkRules(c, step.id, r.when, [...at, "when"], scope, false);
    });
  }
  if (checks.approval?.when) {
    checkRules(
      c,
      step.id,
      checks.approval.when,
      ["checks", "approval", "when"],
      withConfer(before),
      false,
    );
  }
  (checks.notify ?? []).forEach((n, i) => {
    checkNotify(c, step.id, n, ["checks", "notify", i], withConfer(after));
  });
}

function checkStep(c: Checker, step: Step, scope: ProcessScope, allowed: Set<string> | undefined) {
  switch (step.kind) {
    case "read":
    case "write":
      checkToolStep(c, step, scope, allowed);
      break;
    case "skill":
      checkSkillStep(c, step, scope);
      break;
    case "person":
      checkRefs(c, step.id, step.title, ["title"], scope);
      checkRefs(c, step.id, step.payload, ["payload"], scope);
      if (step.choices && step.mode !== "ask") {
        c.add(step.id, "choices", "choices_not_ask", "quick answers are only for questions");
      }
      if (step.choices && new Set(step.choices.map((ch) => ch.value)).size < step.choices.length) {
        c.add(step.id, "choices", "duplicate_choice", "each quick answer needs its own value");
      }
      break;
    // DECISION: a conversation's messages to its contact (`messages.first: not_required`,
    // `later: within_goal`) are held to invariant 8 when R7 builds the step and knows which
    // connection each channel sends through; here only its templates are checked.
    case "conversation":
      checkRefs(c, step.id, step.with, ["with"], scope);
      checkRefs(c, step.id, step.goal, ["goal"], scope);
      break;
    case "notify":
      checkNotify(c, step.id, step.notify, ["notify"], scope);
      break;
    case "if":
      // Paths are evaluated at the if, so their rules see what the if itself sees. (The schema
      // requires a path: `if_no_paths`.)
      for (const p of step.paths) checkRules(c, p.id, p.when, ["when"], scope, true);
      break;
    case "for_each":
      checkRefs(c, step.id, step.over, ["over"], scope);
      if (!compatible(["array"], valueTypes(step.over, scope))) {
        c.add(step.id, "over", "for_each_not_array", "for each needs a list to go over");
      }
      break;
    case "process":
      checkSubProcess(c, step, scope);
      break;
    default:
      break;
  }
  checkApproval(c, step);
  checkChecks(c, step, scope);
}

// ── Triggers and handoff ─────────────────────────────────────────────────────────────────────

const CRON_FIELD = /^[0-9A-Za-z*/,?#LW-]+$/;

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A trigger's filter and dedupe key read that trigger's own payload (as v3). */
function checkTrigger(c: Checker, trigger: Trigger) {
  const { id, on } = trigger;
  const own: ProcessScope = {
    trigger: triggerOnSchema(on, c.ctx),
    settings: c.ctx.settings,
    steps: {},
  };
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

/**
 * `handoff.output` and `sources` are read when the run has finished: the triggers and every
 * top-level step (outputs inside an if path or a loop stay inside it). Errors sit on the first
 * trigger, as v3's sit on its trigger.
 */
function checkHandoff(
  c: Checker,
  process: Process,
  list: readonly { step: Step; scope: ProcessScope }[],
) {
  if (!process.handoff) return;
  const scope: ProcessScope = {
    trigger: processTriggerSchema(process, c.ctx),
    settings: c.ctx.settings,
    steps: {},
  };
  const top = new Set<Step>(process.steps);
  for (const { step, scope: before } of list) {
    if (!top.has(step)) continue;
    Object.assign(scope.steps, before.steps);
    scope.steps[step.id] = { step, output: stepOutputSchema(step, c.ctx) };
  }
  const id = process.triggers[0]?.id ?? "";
  checkRefs(c, id, process.handoff.output, ["handoff", "output"], scope);
  if (process.handoff.sources !== undefined) {
    checkRefs(c, id, process.handoff.sources, ["handoff", "sources"], scope);
  }
}

// ── The process ──────────────────────────────────────────────────────────────────────────────

/** Trigger, step, if path and otherwise ids are unique across the process (merges line up by them). */
function duplicateIds(process: Process): ProcessValidationError[] {
  const seen = new Set<string>();
  const errors: ProcessValidationError[] = [];
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
  for (const t of process.triggers) note(t.id, "id");
  walkSteps(process, ({ step }) => {
    note(step.id, "id");
    if (step.kind === "if") {
      for (const p of step.paths) note(p.id, "id");
      note(step.otherwise.id, "otherwise.id");
    }
  });
  return errors;
}

function splitWarnings(process: Process): ProcessWarning[] {
  const warnings: ProcessWarning[] = [];
  const count = stepCount(process);
  if (count > SPLIT_MAX_STEPS) {
    warnings.push({
      stepId: null,
      field: "steps",
      code: "split_long",
      message: `${count} steps: a process of more than ${SPLIT_MAX_STEPS} is easier to follow split in two`,
    });
  }
  walkSteps(process, ({ step, depth }) => {
    // Once per too-deep branch: at the first level past the limit.
    if ((step.kind === "if" || step.kind === "for_each") && depth === SPLIT_MAX_DEPTH) {
      warnings.push({
        stepId: step.id,
        field: "",
        code: "split_deep",
        message: `logic nested more than ${SPLIT_MAX_DEPTH} deep: consider a separate process`,
      });
    }
  });
  return warnings;
}

/**
 * Validates one v4 process. Schema errors stop the other checks (they need a typed tree). One
 * agent owning exactly one process is checked where the agent is, not here.
 */
export function validateProcess(
  input: unknown,
  ctx: ProcessValidationContext = {},
): ProcessValidationResult {
  const parsed = ProcessSchema.safeParse(input);
  if (!parsed.success) {
    return { valid: false, errors: schemaErrors(parsed.error.issues, input), warnings: [] };
  }
  const process = parsed.data;
  const errors: ProcessValidationError[] = duplicateIds(process);
  const c: Checker = {
    ctx,
    add(stepId, f, code, message) {
      errors.push({ stepId, field: f, code, message });
    },
  };
  for (const t of process.triggers) checkTrigger(c, t);
  const list = scopeList(process, ctx);
  checkHandoff(c, process, list);
  const allowed = allowedTools(ctx);
  for (const { step, scope } of list) checkStep(c, step, scope, allowed);
  return { valid: errors.length === 0, errors, warnings: splitWarnings(process), value: process };
}
