// R1 (docs/plan.md §1.86, §9): validation of a v4 process, the counterpart of `validateWorkflow`
// (workflow/validate.ts). Shared by the builder (in the browser, on every change) and the server
// (before test runs and publish). Each error names the step, path or trigger and the field inside
// it, so the builder can mark both. A process is valid with warnings: those are advice only (a
// process that might be better split).

import type { z } from "zod";
import { CONVERSE_SKILL, converseProblems, typedResultOutput } from "../converse";
import { isUuid } from "../ids";
import { isPlainObject } from "../json";
import { levelFor } from "../permissions/decide";
import { bindingConnector } from "../permissions/grants";
import type { AgentDefinition } from "../schemas/agent";
import {
  type AnyAutomationDefinition,
  type ProcessAutomationDefinition,
  ProcessAutomationDefinition as ProcessAutomationDefinitionSchema,
} from "../schemas/automation";
import type { JsonSchema } from "../schemas/common";
import { parseSkillRef } from "../schemas/common";
import type { AgentMode } from "../schemas/permissions";
import type { Rules } from "../schemas/rules";
import { isAlwaysSigned, type ToolSpec } from "../schemas/tool";
import type { Trigger, Step as V3Step } from "../schemas/workflow";
import { retiredSkillReason, skillWriteTools, toolLookup } from "../skills/kind";
import { collectRefs, hasTemplate, singleRef } from "../template/template";
import {
  automationOutputSchema,
  FOR_EACH_OUTPUT,
  FORK_OUTPUT,
  lookupSkill,
  NO_OUTPUT,
  outputTemplateSchema,
  type PathType,
  PERSON_OUTPUT,
  schemaAtPath,
  type TypingContext,
  triggerOnSchema,
} from "../template/typer";
import { mergeTriggerSchemas } from "../triggers/typing";
// One copy of the checks v3 and v4 share (the v3 validator exports them).
import {
  allowedTools,
  checkChoices,
  checkEntityOff,
  checkFixed,
  checkInput,
  checkRefs,
  checkRules as checkRulesShared,
  checkSkillFixedWrites,
  checkStepModel,
  checkTrigger,
  typesCompatible as compatible,
  joinField as field,
  locateIssue,
  type RefChecker,
  skillWrites,
  type ValidationCode,
  type ValidationContext,
  VERB_NOUN,
  stepWrites as v3StepWrites,
  valueTypes,
} from "../workflow/validate";
import { walkSteps as walkV3Steps } from "../workflow/walk";
// Skill model (2026-11-10): action write steps, resolved from the agent's bindings.
import {
  ACCOUNTING_CONNECTORS,
  type ActionBindings,
  type ActionProblemCode,
  type ActionResolution,
  actionBindingsFromMatrices,
  actionInputSchema,
  isAccountingAction,
  resolveActionConnector,
} from "./actions";
// R7: the conversation step's own checks, output and send tools (one copy, invariant 4).
import {
  CONVERSATION_SEND_VERB,
  conversationOutputSchema,
  conversationProblems,
  conversationSendTools,
} from "./conversation";
// Wave 5: how each step ended, for an `if` to route on (`steps.<id>.outcome` and the rest).
import { outcomeVocabulary, stepRecordFields, stepRecordSchema } from "./outcomes";
// Reshape data (2026-11-11): its output, and the checks on its mapping.
import {
  isReshapeStep,
  nextStepOf,
  reshapeOutputSchema,
  reshapeProblems,
  schemaFitProblems,
  stepInputSchema,
} from "./reshape";
import {
  type ApprovalCheck,
  CONFER_VERDICTS,
  type ConversationStep,
  type Deadline,
  type DeadlineThen,
  type ForEachStep,
  type NotifyCheck,
  type Process,
  Process as ProcessSchema,
  type Step,
  type SubProcessStep,
  type WriteStep,
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
  | "approval_needs_act"
  // R7: what the schema can't check about a conversation step (`conversationProblems`).
  | ConversationProblemCode
  // Wave 5: `onError` on a step it means nothing for (`if`, `stop`, `wait`, `person`).
  | "on_error_not_here"
  // Wave 5: a condition comparing a step's outcome with a word not in its kind's vocabulary.
  | "outcome_unknown"
  // Wave 5 review: a step's error message where it would leave us (a write's input, a
  // conversation, an email or text): only its code goes there.
  | "error_message_not_here"
  // Skill model (2026-11-10): an action write step that doesn't resolve from the agent's bindings.
  | ActionProblemCode
  // Reshape data (2026-11-11): a mapping that doesn't type-check, or doesn't fit the next step.
  | "reshape_mapping";

/**
 * `conversationProblems`' codes. A templated goal is reported as `input_not_fixed`, as every other
 * text that becomes instructions is, so `conversation_goal_template` never appears here.
 */
export type ConversationProblemCode =
  | "conversation_goal_empty"
  | "conversation_with_team"
  | "conversation_find_type"
  | "conversation_find_too_many"
  | "conversation_too_many_turns"
  | "conversation_too_long"
  | "conversation_call_goal_long"
  | "conversation_call_opening_long";

export interface ProcessValidationError {
  /** The step, if path, otherwise branch or trigger id; null for process-level errors. */
  stepId: string | null;
  /** Dotted path inside that node (e.g. "input.vendor", "checks.approval.required"), or "". */
  field: string;
  message: string;
  code: ProcessValidationCode;
}

/** Advice, never an error: signs that the process does too much and could be split. */
export type ProcessWarningCode =
  | "split_long"
  | "split_deep"
  // Wave 5: a condition testing an outcome the step, as it is set up, never ends with (`failed`
  // on a step without `onError: continue`: the run has stopped before the condition is read).
  | "outcome_unreachable";

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
  /**
   * Skill model (2026-11-10): the step ids of the version this one was made from. A skill step
   * whose id isn't among them is new, and a new step may not use a retired kind of skill
   * (`rules_then_ai`, agent mode). Absent: no step counts as new (stored versions, templates).
   */
  existingStepIds?: ReadonlySet<string>;
  /**
   * Skill model (2026-11-10, review): the skill id (without its `@version`) of each skill step of
   * the version this one was made from. With `existingStepIds`, a step whose skill id changed
   * counts as new too, so swapping an existing step's skill can't get around the new-step checks.
   */
  existingStepSkills?: ReadonlyMap<string, string>;
  /**
   * Skill model (2026-11-10): what a client agent's action write steps resolve from at publish:
   * its bound connectors and the channels `channelFor` resolves for it (its own, else the
   * account's). Absent with `publish`: the bound connectors are the matrices' keys and channels
   * aren't known here. Absent without `publish` (templates, drafts): only the input is checked.
   */
  actions?: ActionBindings;
}

// ── Schema errors, located ───────────────────────────────────────────────────────────────────

function at(value: unknown, seg: string | number): unknown {
  return isPlainObject(value) || Array.isArray(value)
    ? (value as Record<string | number, unknown>)[seg]
    : undefined;
}

/**
 * v4's nodes, for `locateIssue`: a trigger or a step listed at the root, a step or an if path
 * listed directly under the node before it, and an if's otherwise. A list must be a field of the
 * node it follows (`start`), so a step-shaped value inside an input is never taken for a step.
 */
function isProcessNode(path: readonly (string | number)[], i: number, start: number): boolean {
  const seg = path[i];
  const key = path[i - 1];
  if (typeof seg === "number") {
    if (i - 1 !== start) return false;
    return key === "steps" || key === "paths" || (key === "triggers" && start === 0);
  }
  return seg === "otherwise" && i === start && start > 0;
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
    const { stepId, node, start } = locateIssue(raw, path, isProcessNode);
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
  /**
   * Upstream steps visible here, by id, with their output schemas. Wave 5: `self` marks the step
   * itself in its own checks (its output is readable there, its outcome is not: it hasn't ended);
   * `outputOnly` a step the hand-off reads (from the stored rows: outputs only).
   */
  steps: Record<
    string,
    { step: Step; output: JsonSchema | undefined; self?: boolean; outputOnly?: boolean }
  >;
  /** Inside a for_each: the item schema (undefined when unknown). */
  loop?: { item: JsonSchema | undefined; step: ForEachStep };
  /** In a step's checks: how many of its confer reviewers' verdicts are readable. */
  confer?: number;
  /**
   * Wave 3b: in a v4 automation's steps, what `{{input…}}` reads; there is no trigger there. Absent
   * in a process.
   */
  input?: { schema: JsonSchema | undefined };
}

/** What a v4 step outputs, for later steps' templates. Unknown (any path reads) when unknown. */
export function stepOutputSchema(step: Step, ctx: TypingContext): JsonSchema | undefined {
  switch (step.kind) {
    case "read":
      return ctx.tools?.[step.tool]?.output;
    // DECISION (skill model): an action's output is its provider tool's, known only once it
    // resolves at run time, so later steps read it untyped (any path reads).
    case "write":
      return step.tool === undefined ? undefined : ctx.tools?.[step.tool]?.output;
    case "skill": {
      // Reshape data (2026-11-11): the output is the fields the step's mapping defines.
      if (isReshapeStep(step)) return reshapeOutputSchema(step.reshape);
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
      if (!def) return undefined;
      // Wave 3b: a process step pins a v3 automation or a v4 one.
      return def.schemaVersion === 2
        ? processAutomationOutputSchema(def, ctx)
        : automationOutputSchema(def, ctx);
    }
    // R7: `{ status, found, conversationId, summary }`, `found` typed by the step's `find`.
    case "conversation":
      return conversationOutputSchema(step);
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
      if (scope.input) {
        return { ok: false, message: "an automation has no trigger: read its {{input…}}" };
      }
      return schemaAtPath(scope.trigger, rest);
    case "input":
      if (!scope.input) {
        return { ok: false, message: "{{input}} is only available inside an automation" };
      }
      return schemaAtPath(scope.input.schema, rest);
    case "settings":
      return schemaAtPath(scope.settings, rest);
    case "steps": {
      const [id, field, ...tail] = rest;
      if (id === undefined) return { ok: false, message: "steps.<id>.output... needs a step id" };
      const s = scope.steps[id];
      if (!s)
        return { ok: false, message: `step "${id}" does not run before this one on its path` };
      if (field === "output") return schemaAtPath(s.output, tail);
      // Wave 5: how an earlier step ended (`steps.<id>.outcome`, `.approval…`, `.confer…`, …).
      const record = stepRecordSchema(s.step);
      if (field !== undefined && record && stepRecordFields(s.step).includes(field)) {
        if (s.self) {
          return {
            ok: false,
            message: `a step's ${field} is known only once it has ended: read it in a later step`,
          };
        }
        // DECISION (wave 5): the hand-off is resolved after the run from its stored rows, which
        // hold outputs; it reads no outcome (route with an `if` and put what it found in an output).
        if (s.outputOnly) {
          return { ok: false, message: "the hand-off reads step outputs only" };
        }
        return schemaAtPath(record, [field, ...tail]);
      }
      return {
        ok: false,
        message: record
          ? `use steps.${id}.output.<field>, or how it ended: steps.${id}.outcome`
          : `use steps.${id}.output.<field>`,
      };
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
  if (root === "trigger") return scope.input === undefined;
  if (root === "input") return scope.input !== undefined;
  if (root === "settings") return true;
  if (root === "item") return scope.loop !== undefined;
  if (root === "steps") {
    const s = id === undefined ? undefined : scope.steps[id];
    if (!s || third === undefined) return false;
    if (third === "output") return true;
    // Wave 5: a record field of an earlier step (never the step's own: it hasn't ended).
    return !s.self && !s.outputOnly && stepRecordFields(s.step).includes(third);
  }
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
  input?: ProcessScope["input"],
): { step: Step; scope: ProcessScope }[] {
  const trigger = input ? undefined : processTriggerSchema(process, ctx);
  // A duplicated id (an error anyway) reads as its last step, as v3 does.
  const byId = new Map<string, Step>();
  const locs: { step: Step; before: string[]; loop: ForEachStep | undefined }[] = [];
  walkSteps(process, (loc) => {
    byId.set(loc.step.id, loc.step);
    locs.push({ step: loc.step, before: loc.before, loop: loc.loops.at(-1) });
  });
  return locs.map((l) => {
    const scope: ProcessScope = {
      trigger,
      settings: ctx.settings,
      steps: {},
      ...(input ? { input } : {}),
    };
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

// The shared checks (workflow/validate.ts) type references through the checker: here in a v4
// scope. Codes are v3's plus v4's.
interface Checker extends RefChecker<ProcessScope> {
  ctx: ProcessValidationContext;
  add(stepId: string | null, f: string, code: ProcessValidationCode, message: string): void;
  /** Wave 5: advice that doesn't make the process invalid. Absent: none is kept. */
  warn?(stepId: string | null, f: string, code: ProcessWarningCode, message: string): void;
}

/** The literal words a rule compares its field with (`=`, `!=`, `in`); none for other ops. */
function comparedWords(rule: Rules["rules"][number]): string[] {
  const words = (v: unknown) => (typeof v === "string" && !hasTemplate(v) ? [v] : ([] as string[]));
  if (rule.op === "=" || rule.op === "!=") return words(rule.value);
  if (rule.op === "in" && Array.isArray(rule.value)) return rule.value.flatMap(words);
  return [];
}

/**
 * The shared checks of a condition (v3's `checkRules`), then wave 5's: a rule comparing an earlier
 * step's outcome (or approval, verdict, quick answer) with a word must use that kind's vocabulary
 * (`outcome_unknown`), and is advised when the step as set up never ends that way
 * (`outcome_unreachable`).
 */
function checkRules(
  c: Checker,
  nodeId: string,
  rules: Rules,
  at: (string | number)[],
  scope: ProcessScope,
  requireRules: boolean,
) {
  checkRulesShared(c, nodeId, rules, at, scope, requireRules);
  rules.rules.forEach((rule, i) => {
    let path: string[] | null;
    try {
      path = singleRef(rule.field);
    } catch {
      return;
    }
    if (path?.[0] !== "steps" || path[2] === "output") return;
    const s = path[1] === undefined ? undefined : scope.steps[path[1]];
    if (!s || s.self) return;
    const fieldPath = path.slice(2);
    const vocabulary = outcomeVocabulary(s.step, fieldPath);
    if (!vocabulary) return;
    const typed = typeProcessPath(scope, path);
    const reachable =
      typed.ok && Array.isArray(typed.schema?.enum) ? (typed.schema.enum as unknown[]) : null;
    const where = field([...at, "rules", i, "value"]);
    for (const word of comparedWords(rule)) {
      if (!vocabulary.includes(word)) {
        c.add(
          nodeId,
          where,
          "outcome_unknown",
          `"${word}" is not how a ${s.step.kind} step ends here: use ${vocabulary.join(", ")}`,
        );
      } else if (reachable && !reachable.includes(word)) {
        c.warn?.(
          nodeId,
          where,
          "outcome_unreachable",
          `step "${s.step.id}" never ends "${word}" as it is set up${
            word === "failed" || word === "needs_help" ? " (it needs onError: continue)" : ""
          }`,
        );
      }
    }
  });
}

/** Text that becomes a model's instructions is written in the step, never templated (inv. 9). */
function checkFixedText(c: Checker, nodeId: string, value: string, f: string, what: string) {
  if (!hasTemplate(value)) return;
  c.add(
    nodeId,
    f,
    "input_not_fixed",
    `write the ${what} in the step: it becomes instructions, so it can't come from a template`,
  );
}

// ── Writes and approval (invariant 8) ────────────────────────────────────────────────────────

/**
 * The external tools a step can call: what makes it a write that needs approval. A write step's
 * tool when external; a skill whose tools write (v3 skills, until R2 retires them); a skill that
 * reaches people counts through `reachesPeople`. Undefined when the registries don't know.
 */
export function stepWrites(
  step: Step,
  ctx: TypingContext & Pick<ProcessValidationContext, "actions" | "publish">,
): ToolSpec[] | undefined {
  if (step.kind === "write") {
    // An action: the tool it resolves to from the agent's bindings, when that is known here.
    if (step.action !== undefined) {
      const r = writeActionResolution(step, ctx);
      const tool = r?.ok ? ctx.tools?.[r.tool] : undefined;
      return tool ? [tool] : undefined;
    }
    const tool = step.tool === undefined ? undefined : ctx.tools?.[step.tool];
    if (!tool) return undefined;
    return tool.sideEffect === "external" ? [tool] : [];
  }
  if (step.kind === "skill") return skillWrites(step.skill, ctx);
  return [];
}

/**
 * Skill model (2026-11-10): the connector and tool an action write step resolves to here, from
 * `ctx.actions` (or, at publish, the bound connectors). Undefined when not known (a template, a
 * draft, or a channel the caller didn't resolve): the runtime resolves it.
 */
export function writeActionResolution(
  step: Pick<WriteStep, "action" | "via">,
  ctx: Pick<ProcessValidationContext, "actions" | "publish">,
): ActionResolution | undefined {
  if (step.action === undefined) return undefined;
  const bindings =
    ctx.actions ?? (ctx.publish ? actionBindingsFromMatrices(ctx.publish.matrices) : undefined);
  if (!bindings) return undefined;
  return resolveActionConnector(step.action, step.via, bindings);
}

/** Whether the step contacts people: a conversation, or a skill that reaches people. */
export function stepReaches(step: Step, ctx: TypingContext): boolean {
  if (step.kind === "conversation") return true;
  return step.kind === "skill" && lookupSkill(step.skill, ctx)?.reachesPeople === true;
}

/**
 * Whether the step's own output exists when its confer and approval run: a read step, or a skill
 * that writes nothing and contacts nobody. Before a write (a write step, a skill whose tools write
 * or that reaches people), confer and approval run first, so there is no output yet.
 */
// DECISION: a skill the registries don't know counts as writing (no output before its checks), the
// safe side, as the converter counts an unknown tool as an external write.
export function outputBeforeChecks(step: Step, ctx: TypingContext): boolean {
  if (step.kind === "read") return true;
  if (step.kind !== "skill") return false;
  const writes = stepWrites(step, ctx);
  return writes !== undefined && writes.length === 0 && !stepReaches(step, ctx);
}

/** One way an approval can let a write through without a person's yes. */
export interface Loosening {
  /** Where, in the step (e.g. "checks.approval.when"). */
  field: string;
  what: "not_required" | "when" | "proceed" | "within_goal";
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

/** A deadline whose "nobody answered" never goes ahead (escalations included). */
function holdDeadline(d: Deadline): Deadline {
  return { ...d, ifNoAnswer: holdThen(d.ifNoAnswer) };
}

function holdThen(then: DeadlineThen): DeadlineThen {
  if (then === "proceed") return "stop";
  if (typeof then === "object") {
    return {
      escalate: { ...then.escalate, deadline: holdDeadline(then.escalate.deadline) },
    };
  }
  return then;
}

/**
 * Wave 3b: the approval with every loosening taken out (`approvalLoosenings` empty after it):
 * required, on every run, and stopping where nobody answers instead of going ahead. Its approvers,
 * mode and reminders stay. Invariant 8: what new steps and the Builder's drafts start with.
 */
export function tightenedApproval(approval: ApprovalCheck): ApprovalCheck {
  const { when: _when, ...rest } = approval;
  const out: ApprovalCheck = {
    ...rest,
    required: "required",
    ifNoAnswer: holdThen(approval.ifNoAnswer),
  };
  if (approval.approvers) {
    out.approvers = approval.approvers.map((a) =>
      a.deadline ? { ...a, deadline: holdDeadline(a.deadline) } : a,
    );
  }
  return out;
}

/**
 * A conversation's messages sent without a person's yes: the first one (`messages.first:
 * not_required`), or the later ones while they stay within the goal (`messages.later:
 * within_goal`). Each is a write to a contact, so each is loosening (invariant 8).
 */
export function conversationLoosenings(step: Pick<ConversationStep, "messages">): Loosening[] {
  const out: Loosening[] = [];
  if (step.messages.first === "not_required") {
    out.push({ field: "messages.first", what: "not_required" });
  }
  if (step.messages.later === "within_goal") {
    out.push({ field: "messages.later", what: "within_goal" });
  }
  return out;
}

const LOOSENED: Record<Loosening["what"], string> = {
  not_required: "",
  when: ": on every run, not only when conditions hold",
  proceed: ": a write can't go ahead without an answer",
  within_goal: ": every message needs a person's yes",
};

/** At publish, a loosened step whose agent doesn't act on its own is refused (invariant 8). */
function needsAct(c: Checker, stepId: string, loose: readonly Loosening[]) {
  const mode = c.ctx.agent?.permissions?.mode;
  if (mode === undefined || mode === "act") return;
  for (const l of loose) {
    const messages = l.field.startsWith("messages.");
    c.add(
      stepId,
      l.field,
      "approval_needs_act",
      messages
        ? "the agent only suggests: set its mode to act before a message goes without a person's yes"
        : "the agent only suggests: set its mode to act before a write runs without approval",
    );
  }
}

/**
 * The approval rules of a step: `not_required` only where something is written or someone is
 * contacted (v3's rule), no loosening of a verb a person always signs (§1.73), and at publish the
 * connection's matrix, the agent's grant and mode (invariant 8; v3 checked `not_required`, v4 also
 * `when` and `proceed`, a reaching skill's `not_required` and a conversation's message settings).
 */
function checkApproval(c: Checker, step: Step) {
  const { ctx } = c;
  const loose = approvalLoosenings(step.checks?.approval, "checks.approval");
  if (step.kind === "write" && step.action !== undefined) {
    checkActionLoose(c, step.id, step, loose, "action", true);
    return;
  }
  const writes = stepWrites(step, ctx);
  const reaches = stepReaches(step, ctx);
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
  if (!ctx.publish) return;
  const matrices = ctx.publish.matrices;
  const at = step.kind === "write" ? "tool" : "skill";
  for (const tool of writes ?? []) {
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
    } else if (
      checkEntityOff(
        c,
        step.id,
        tool,
        connector,
        step.kind === "write" ? step.input : undefined,
        at,
      )
    ) {
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
  // A conversation's channel connection is the agent's bound number or address, picked at run
  // time: `messages.later: not_required` is checked against the mode only here, and
  // `messages.first: not_required` is also held to every bound send connection's matrix
  // (`checkFirstMessage`, below); the gate holds each message to its connection's matrix when it is
  // sent (invariant 8). A reaching skill's own tools, when they write, were held to their matrix
  // above.
  needsAct(c, step.id, [
    ...((writes?.length ?? 0) > 0 || reaches ? loose : []),
    ...(step.kind === "conversation" ? conversationLoosenings(step) : []),
  ]);
  if (step.kind === "conversation") checkFirstMessage(c, step);
}

/** The matrix of the connection an action resolved to (its channel's, or its bound connector's). */
function actionMatrix(
  ctx: ProcessValidationContext,
  r: Extract<ActionResolution, { ok: true }>,
): { found: boolean; matrix: Parameters<typeof levelFor>[0] } {
  if (r.channel) {
    const line = ctx.actions?.channels?.[r.channel];
    return { found: line != null, matrix: line?.matrix };
  }
  const matrices = ctx.publish?.matrices ?? {};
  const key = Object.keys(matrices).find((k) => bindingConnector(k) === r.connector);
  return { found: key !== undefined, matrix: key === undefined ? undefined : matrices[key] };
}

/**
 * Skill model (2026-11-10): an action write step's approval (or a sub-process override of it).
 * Every action is external, so any loosening is held to invariant 8: never for a tool a person
 * always signs, and at publish only where the connection it resolves to allows `auto` for the
 * verb and the agent acts. A loosening whose connection isn't known at publish is refused.
 */
// DECISION: at publish, an action whose connection can't be resolved here (the caller didn't pass
// the agent's channels) keeps its approval: a loosening is refused rather than checked at the call.
// Review: the step's own check (`own`) holds it to its connection at publish whatever its
// approval, as a tool write step is: a verb the matrix turns off, or a record type the matrix or
// the agent's grant turns off, is reported with approval on too (the gate would refuse every run).
// A sub-process override is held to it only when it loosens; the used process's own step reports.
function checkActionLoose(
  c: Checker,
  reportAt: string,
  step: Pick<WriteStep, "action" | "via">,
  loose: readonly Loosening[],
  at: string,
  own = false,
) {
  const { ctx } = c;
  const r = writeActionResolution(step, ctx);
  const tool = r?.ok ? ctx.tools?.[r.tool] : undefined;
  if (tool && isAlwaysSigned(tool)) {
    for (const l of loose) {
      c.add(reportAt, l.field, "approval_always", `"${tool.id}" always needs a person to sign it`);
    }
  }
  if (!ctx.publish || (loose.length === 0 && !own)) return;
  if (loose.length === 0 && !r?.ok) return;
  if (!r?.ok) {
    if (r === undefined) {
      for (const l of loose) {
        c.add(
          reportAt,
          l.field,
          "approval_required_by_connection",
          "which connection sends it is known only when it runs: approval stays on",
        );
      }
    }
    // A connection that doesn't resolve is reported by the step's own check.
    needsAct(c, reportAt, loose);
    return;
  }
  const { found, matrix } = actionMatrix(ctx, r);
  const verb = tool?.verb ?? "create";
  const level = found ? levelFor(matrix, verb) : "approval";
  if (level === "off") {
    c.add(
      reportAt,
      at,
      "verb_off",
      `this connection doesn't allow ${VERB_NOUN[verb]} ("${r.tool}")`,
    );
  } else if (own && tool && entityOffForAction(c, reportAt, r, tool, at)) {
    // Reported there.
  } else if (level !== "auto") {
    for (const l of loose) {
      c.add(
        reportAt,
        l.field,
        "approval_required_by_connection",
        `this connection requires approval for ${VERB_NOUN[verb]}${LOOSENED[l.what]}`,
      );
    }
  }
  needsAct(c, reportAt, loose);
}

/**
 * Review: the record type an accounting action's tool works on, held to the bound connection's
 * matrix and the agent's grant (`checkEntityOff`); a message action's channel has none.
 */
function entityOffForAction(
  c: Checker,
  reportAt: string,
  r: Extract<ActionResolution, { ok: true }>,
  tool: ToolSpec,
  at: string,
): boolean {
  if (r.channel) return false;
  const key = Object.keys(c.ctx.publish?.matrices ?? {}).find(
    (k) => bindingConnector(k) === r.connector,
  );
  // The action's input is provider-neutral, so only a tool's own entity is read here.
  return key !== undefined && checkEntityOff(c, reportAt, tool, key, undefined, at);
}

/**
 * Skill model (2026-11-10): an action write step. Its input against the action's provider-neutral
 * input; `via` only on an accounting action, naming QuickBooks or BILL; at publish it must resolve
 * from the agent's bindings (no accounting connection, or two without `via`, are errors), and the
 * tool it resolves to must be known.
 */
// DECISION: an action brings its resolved tool in, as a conversation's channel brings its send
// tool: the agent needn't list it in its tools or skills. The gate still holds the call to the
// connection's matrix, the agent's grant and its mode (invariant 13).
function checkWriteAction(
  c: Checker,
  step: WriteStep & { action: NonNullable<WriteStep["action"]> },
  scope: ProcessScope,
) {
  const { ctx } = c;
  checkRefs(c, step.id, step.input, ["input"], scope);
  checkErrorMessage(c, step.id, step.input, ["input"]);
  checkInput(c, step.id, step.input, actionInputSchema(step.action), scope);
  if (step.via !== undefined) {
    if (!isAccountingAction(step.action)) {
      c.add(
        step.id,
        "via",
        "action_via_not_here",
        "a message goes on the agent's channel, else the account's: it can't name a connection",
      );
      return;
    }
    if (!(ACCOUNTING_CONNECTORS as readonly string[]).includes(step.via)) {
      c.add(step.id, "via", "action_via_unknown", `"${step.via}" isn't QuickBooks or BILL`);
      return;
    }
  }
  const r = writeActionResolution(step, ctx);
  if (r && !r.ok) {
    c.add(step.id, r.code === "action_no_connection" ? "action" : "via", r.code, r.message);
    return;
  }
  if (r?.ok && ctx.tools && !ctx.tools[r.tool]) {
    c.add(step.id, "action", "unknown_tool", `no tool "${r.tool}"`);
  }
}

/**
 * A conversation's first message sent without a person's yes (`messages.first: not_required`) is a
 * write to a contact with no signature, so it is held to invariant 8 as a write's `not_required`
 * is: never for a send tool a person always signs, and at publish only where every bound
 * connection that can carry the channel allows `auto` for `create`.
 */
// DECISION: the agent's channel binding picks the one connection at run time, which core can't
// see, so the first message may go unsigned only if every bound connection able to carry the
// channel allows it; with none bound (the account's line, Mezonas' own sender) it may not. The gate
// still holds each message to its connection's matrix when it is sent.
function checkFirstMessage(c: Checker, step: ConversationStep) {
  if (step.messages.first !== "not_required") return;
  const f = "messages.first";
  const sends = conversationSendTools(step.channel);
  for (const s of sends) {
    const tool = c.ctx.tools?.[s.tool];
    if (tool && isAlwaysSigned(tool)) {
      c.add(step.id, f, "approval_always", `"${tool.id}" always needs a person to sign it`);
      return;
    }
  }
  const matrices = c.ctx.publish?.matrices;
  if (!matrices) return;
  const bound = sends.filter((s) => matrices[s.connector] !== undefined);
  if (bound.length === 0) {
    c.add(
      step.id,
      f,
      "approval_required_by_connection",
      "no connection bound for this channel allows it: the first message needs a person's yes",
    );
    return;
  }
  for (const s of bound) {
    if (levelFor(matrices[s.connector], CONVERSATION_SEND_VERB) !== "auto") {
      c.add(
        step.id,
        f,
        "approval_required_by_connection",
        `this connection requires approval for ${VERB_NOUN[CONVERSATION_SEND_VERB]} ("${s.tool}"): the first message needs a person's yes`,
      );
      return;
    }
  }
}

/** `conversationProblems` as validation errors (a templated goal is `checkFixedText`'s). */
function checkConversation(c: Checker, step: ConversationStep) {
  for (const p of conversationProblems(step)) {
    if (p.code === "conversation_goal_template") continue;
    c.add(step.id, p.field, p.code as ConversationProblemCode, p.message);
  }
}

// ── Steps ────────────────────────────────────────────────────────────────────────────────────

/**
 * Wave 5 review: a step's error message (`steps.<id>.error.message`, the whole `error`, or the
 * whole step `steps.<id>`, which holds it) read where it would leave us: a write's input, a
 * conversation, an email or a text, a skill's input (the model reads it, and the writes it
 * proposes carry it), and a sub-process's input or a loop's list (a write inside reads them as
 * `{{input...}}` or `{{item}}`). Its text is the row's error line, hidden only by a heuristic
 * (`processes.plainError`), so it may carry what the provider said back; only `error.code` goes
 * there.
 */
// DECISION (wave 5 review): `error.message` reads only in conditions and in notices to the inbox
// (people with a Mezonas account); `error.code` anywhere.
// DECISION (wave 5 re-review): the same places refuse a whole step (`{{steps.<id>}}`), whatever
// its onError, rather than following each value into the sub-process or the model: name the
// field it needs (`steps.<id>.output…`, `steps.<id>.outcome`).
function checkErrorMessage(c: Checker, nodeId: string, value: unknown, where: (string | number)[]) {
  for (const ref of collectRefs(value, where).refs) {
    const [head, id, f, sub] = ref.path;
    if (head !== "steps" || !id) continue;
    if (f === undefined) {
      c.add(
        nodeId,
        field(ref.at),
        "error_message_not_here",
        `the whole step can't go here: it holds its error message, which may hold what the provider said back. Name the field it needs, like {{steps.${id}.output}}`,
      );
      continue;
    }
    if (f !== "error" || (sub !== undefined && sub !== "message")) continue;
    c.add(
      nodeId,
      field(ref.at),
      "error_message_not_here",
      `a step's error message can't go here: it may hold what the provider said back. Use {{steps.${id}.error.code}}, or say it in a notice to the inbox`,
    );
  }
}

function checkToolStep(
  c: Checker,
  step: Extract<Step, { kind: "read" | "write" }>,
  scope: ProcessScope,
  allowed: Set<string> | undefined,
) {
  const { ctx } = c;
  if (step.kind === "write" && step.action !== undefined) {
    checkWriteAction(c, { ...step, action: step.action }, scope);
    return;
  }
  checkRefs(c, step.id, step.input, ["input"], scope);
  if (step.kind === "write") checkErrorMessage(c, step.id, step.input, ["input"]);
  const toolId = step.tool as string;
  const tool = ctx.tools?.[toolId];
  if (ctx.tools && !tool) c.add(step.id, "tool", "unknown_tool", `no tool "${toolId}"`);
  if (!tool) return;
  if (step.kind === "read" && tool.sideEffect !== "none") {
    c.add(step.id, "tool", "read_not_read", `"${toolId}" changes something: use a write step`);
  }
  if (step.kind === "write" && tool.sideEffect === "none") {
    c.add(step.id, "tool", "write_not_write", `"${toolId}" only reads: use a read step`);
  }
  if (allowed && !allowed.has(toolId)) {
    c.add(
      step.id,
      "tool",
      "tool_not_allowed",
      `the agent can't use "${toolId}": add it to its tools or skills`,
    );
  }
  checkInput(c, step.id, step.input, tool.input, scope);
  checkFixed(c, step.id, step.input, tool.fixedInputs);
}

/**
 * Whether a skill step is new in this version: its id isn't in the version it was made from, or
 * (when the caller passes each step's skill) it was there with another skill. Without
 * `existingStepIds` no step is new (stored versions, templates).
 */
function newSkillStep(ctx: ProcessValidationContext, stepId: string, skillId: string): boolean {
  if (!ctx.existingStepIds) return false;
  if (!ctx.existingStepIds.has(stepId)) return true;
  return ctx.existingStepSkills !== undefined && ctx.existingStepSkills.get(stepId) !== skillId;
}

function checkSkillStep(c: Checker, step: Extract<Step, { kind: "skill" }>, scope: ProcessScope) {
  const { ctx } = c;
  checkRefs(c, step.id, step.input, ["input"], scope);
  checkErrorMessage(c, step.id, step.input, ["input"]);
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
  // Skill model (2026-11-10): a new step uses a deterministic or an AI skill, never a retired kind.
  // DECISION: held to operator-written skills (`custom:`) only. The platform's own agent-mode
  // built-ins (Sloan's, the supervisor's, the packs' templates') are still installed from code,
  // with new steps in their seeded versions; they are left off the builder's palette instead, and
  // their split into AI skills and write steps is a later stream's.
  const retired = skill ? retiredSkillReason(skill) : null;
  const skillId = parseSkillRef(step.skill).id;
  const operatorSkill = skillId.startsWith("custom:");
  const isNew = newSkillStep(ctx, step.id, skillId);
  if (retired && operatorSkill && isNew) {
    c.add(step.id, "skill", "skill_retired", retired);
  }
  // Skill model (2026-11-10, review): skills never write, built-ins included. A skill whose own
  // tools or reads change something (`materials.read-quote` and `bookkeeping.read-statement` call
  // `docs.read`, which records a reading) is refused in a new step; steps already using it keep
  // running (invariant 3), and the split's replacement only reads.
  const writes = skill && isNew && ctx.tools ? skillWriteTools(skill, toolLookup(ctx.tools)) : [];
  if (!retired && writes.length > 0) {
    c.add(
      step.id,
      "skill",
      "skill_retired",
      `Skills never write: "${writes[0]}" changes something. Use the skill that only reads, then a write step.`,
    );
  }
  checkStepModel(c, step, skill);
  // A built-in skill's own fixed inputs, and (until R2) a skill whose model could call a tool that
  // runs only from fixed text.
  checkFixed(c, step.id, step.input, skill?.fixedInputs);
  checkSkillFixedWrites(c, step.id, skill, stepWrites(step, ctx), "a write step");
  if (parseSkillRef(step.skill).id === CONVERSE_SKILL) {
    for (const p of converseProblems(step.input)) {
      c.add(step.id, `input.${p.field}`, "converse_invalid", p.message);
    }
  }
  checkReshape(c, step, scope);
}

/**
 * Reshape data (2026-11-11): a Reshape step carries a mapping (only it does), and the mapping
 * type-checks against what the step's input brings in: every required field mapped, every field
 * read there, every value fitting its field. Errors name the fields, so a move of the step before
 * (a skill's new version, a tool's new output) flags the Reshape step itself.
 */
function checkReshape(c: Checker, step: Extract<Step, { kind: "skill" }>, scope: ProcessScope) {
  if (!isReshapeStep(step)) {
    if (step.reshape !== undefined) {
      c.add(step.id, "reshape", "reshape_mapping", "only a Reshape data step has a mapping");
    }
    return;
  }
  if (!step.reshape) {
    c.add(step.id, "reshape", "reshape_mapping", "Reshape data needs its output fields mapped");
    return;
  }
  const input = outputTemplateSchema(step.input, (path) => typeProcessPath(scope, path));
  for (const p of reshapeProblems(step.reshape, input)) {
    c.add(step.id, `reshape.${p.field}`, "reshape_mapping", p.message);
  }
}

/**
 * Reshape data (2026-11-11): the step after a Reshape step, when it reads the Reshape step's
 * output, gets what it takes from it: each field it reads is one the mapping gives, of a type it
 * takes, and nothing it requires is left out. Reported on the Reshape step, naming the fields, so
 * a change to the next step's input (a new version of its skill, another tool) says where to fix.
 */
function checkReshapeNext(c: Checker, process: Process) {
  walkSteps(process, ({ step }) => {
    if (step.kind !== "skill" || !isReshapeStep(step) || !step.reshape) return;
    const next = nextStepOf(process, step.id);
    if (!next) return;
    const takes = stepInputSchema(next, c.ctx);
    if (!takes || !("input" in next) || !isPlainObject(next.input)) return;
    const input = next.input as Record<string, unknown>;
    const prefix = ["steps", step.id, "output"];
    const fields = new Map(step.reshape.fields.map((f) => [f.name, f]));
    let reads = false;
    const props = isPlainObject(takes.properties)
      ? (takes.properties as Record<string, JsonSchema>)
      : {};
    for (const [key, value] of Object.entries(input)) {
      if (typeof value !== "string") continue;
      let path: string[] | null = null;
      try {
        path = singleRef(value);
      } catch {
        path = null;
      }
      if (!path || prefix.some((p, i) => path?.[i] !== p)) continue;
      reads = true;
      const name = path[3];
      if (name === undefined) continue;
      const f = fields.get(name);
      if (!f) {
        c.add(
          step.id,
          "reshape",
          "reshape_mapping",
          `${next.name || "the next step"} reads ${name}, which the mapping doesn't give`,
        );
        continue;
      }
      if (path.length > 4) continue;
      for (const p of schemaFitProblems(props[key], f.schema, name)) {
        c.add(
          step.id,
          `reshape.${name}`,
          "reshape_mapping",
          `${next.name || "the next step"}: ${p}`,
        );
      }
    }
    if (!reads) return;
    const required = Array.isArray(takes.required) ? (takes.required as string[]) : [];
    const missing = required.filter((r) => input[r] === undefined);
    if (missing.length > 0) {
      c.add(
        step.id,
        "reshape",
        "reshape_mapping",
        `${next.name || "the next step"} needs ${missing.join(", ")}, which the mapping doesn't give`,
      );
    }
  });
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
  // Wave 5 review: an email or a text leaves us; the inbox doesn't.
  if ((n.channel ?? "inbox") !== "inbox") {
    checkErrorMessage(c, nodeId, n.to, [...where, "to"]);
    checkErrorMessage(c, nodeId, n.message, [...where, "message"]);
  }
  if (n.urgent?.when)
    checkRules(c, nodeId, n.urgent.when, [...where, "urgent", "when"], scope, false);
}

/** A v3 automation's steps, nested ones included. */
function automationSteps(steps: readonly V3Step[]): V3Step[] {
  const out: V3Step[] = [];
  walkV3Steps({ steps: [...steps] }, ({ step }) => out.push(step));
  return out;
}

/** An automation's inner step as a process step's `approvals` reads it, whichever its schema. */
interface InnerStep {
  id: string;
  /** Its own approval's loosenings, as the override's fields name them (`approvals.<id>…`). */
  ownLoose: Loosening[];
  /** The external tools it calls (undefined: the registries don't know). */
  writes: ToolSpec[] | undefined;
  /** It contacts people (a skill that reaches people, a conversation). */
  reaches: boolean;
  /** Its kind has an approval an override can set (v3 skill or action; v4 skill, read or write). */
  approvable: boolean;
  /** Skill model: a v4 action write step (its connection resolves from the using agent). */
  action?: Pick<WriteStep, "action" | "via">;
}

/** Every inner step of a pinned automation by id: v3 steps (v1) or v4 process steps (v2). */
function innerSteps(
  def: AnyAutomationDefinition,
  ctx: TypingContext & Pick<ProcessValidationContext, "actions" | "publish">,
): Map<string, InnerStep> {
  const out = new Map<string, InnerStep>();
  if (def.schemaVersion === 2) {
    walkSteps(def, ({ step }) => {
      out.set(step.id, {
        id: step.id,
        ownLoose: approvalLoosenings(step.checks?.approval, `approvals.${step.id}`),
        writes: stepWrites(step, ctx),
        reaches: stepReaches(step, ctx),
        approvable: step.kind === "skill" || step.kind === "write" || step.kind === "read",
        ...(step.kind === "write" && step.action !== undefined
          ? { action: { action: step.action, ...(step.via ? { via: step.via } : {}) } }
          : {}),
      });
    });
    return out;
  }
  for (const s of automationSteps(def.steps)) {
    const own = s.kind === "skill" || s.kind === "action" ? s.approval : undefined;
    out.set(s.id, {
      id: s.id,
      ownLoose:
        own?.required === "not_required"
          ? [{ field: `approvals.${s.id}.required`, what: "not_required" }]
          : [],
      writes: v3StepWrites(s, ctx),
      reaches: s.kind === "skill" && lookupSkill(s.skill, ctx)?.reachesPeople === true,
      approvable: s.kind === "skill" || s.kind === "action",
    });
  }
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
  checkErrorMessage(c, step.id, step.input, ["input"]);
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

  // Wave 3b: the pinned automation holds v3 steps or v4 process steps.
  const inner = innerSteps(def, ctx);
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
    const { writes, reaches } = target;
    const loose = approvalLoosenings(approval, `approvals.${innerId}`);
    const off = loose.find((l) => l.what === "not_required");
    if (off && ((writes !== undefined && writes.length === 0 && !reaches) || !target.approvable)) {
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
    const loose: Loosening[] = override
      ? approvalLoosenings(override, `approvals.${target.id}`)
      : target.ownLoose;
    // Skill model: an inner action is held to the connection it resolves to for this agent.
    if (target.action) {
      checkActionLoose(c, step.id, target.action, loose, "process");
      continue;
    }
    const writes = target.writes ?? [];
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
 * A step's checks. Confer and approval run before a write and after a read or a skill that writes
 * nothing, so their conditions see the step's own output only there (`outputBeforeChecks`);
 * notify runs after the step and always sees it. A reviewer's `when` reads the verdicts of the reviewers before it; approval and
 * notify conditions read them all.
 */
function checkChecks(c: Checker, step: Step, base: ProcessScope) {
  const checks = step.checks;
  if (!checks) return;
  const own: ProcessScope["steps"] = {
    ...base.steps,
    [step.id]: { step, output: stepOutputSchema(step, c.ctx), self: true },
  };
  const before: ProcessScope = {
    ...base,
    steps: outputBeforeChecks(step, c.ctx) ? own : base.steps,
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
        // The focus becomes the reviewer's instructions: fixed text (invariant 9).
        checkFixedText(c, step.id, r.ai.focus, field([...at, "ai", "focus"]), "focus");
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

/**
 * Wave 5: the kinds `onError` means nothing for, and why. An `if` routes, a `stop` ends, a wait
 * only waits, and a person step's only failures are the platform's own, which end the run.
 */
const NO_ON_ERROR: Partial<Record<Step["kind"], string>> = {
  if: "an if can't fail by itself: set onError on the steps in its paths",
  stop: "a stop ends the run: it has no error to go on past",
  wait: "a wait can't fail",
  person: "a person step can't fail by itself: its deadline says what happens with no answer",
};

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
      checkChoices(c, step);
      break;
    // A conversation's messages without a person's yes (`messages.first: not_required`, `later:
    // within_goal`) are held to invariant 8 in checkApproval. Its goal becomes the model's
    // instructions, so it is fixed text (invariant 9); who it is with may be templated.
    case "conversation":
      checkRefs(c, step.id, step.with, ["with"], scope);
      checkErrorMessage(c, step.id, step.with, ["with"]);
      checkFixedText(c, step.id, step.goal, "goal", "goal");
      checkConversation(c, step);
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
      checkErrorMessage(c, step.id, step.over, ["over"]);
      if (!compatible(["array"], valueTypes(c, step.over, scope))) {
        c.add(step.id, "over", "for_each_not_array", "for each needs a list to go over");
      }
      break;
    case "process":
      checkSubProcess(c, step, scope);
      break;
    default:
      break;
  }
  // Wave 5: steps with no failure of their own to go on past.
  const noError = NO_ON_ERROR[step.kind];
  if (step.onError !== undefined && noError)
    c.add(step.id, "onError", "on_error_not_here", noError);
  checkApproval(c, step);
  checkChecks(c, step, scope);
}

// ── Triggers and handoff ─────────────────────────────────────────────────────────────────────

/** A trigger's filter and dedupe key read that trigger's own payload (v3's `checkTrigger`). */
function checkProcessTrigger(c: Checker, trigger: Trigger) {
  checkTrigger(c, trigger, {
    trigger: triggerOnSchema(trigger.on, c.ctx),
    settings: c.ctx.settings,
    steps: {},
  });
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
  for (const id of Object.keys(scope.steps)) {
    const s = scope.steps[id];
    if (s) scope.steps[id] = { ...s, outputOnly: true };
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

// ── Wave 3b: v4 automations (docs/plan.md §1.86) ─────────────────────────────────────────────

/** What an automation's `output` reads: its input and every top-level step. */
function automationEndScope(
  def: Pick<ProcessAutomationDefinition, "input" | "steps">,
  ctx: TypingContext,
): ProcessScope {
  const scope: ProcessScope = {
    trigger: undefined,
    settings: undefined,
    steps: {},
    input: { schema: def.input },
  };
  for (const s of def.steps) scope.steps[s.id] = { step: s, output: stepOutputSchema(s, ctx) };
  return scope;
}

/** The schema of a process step's output when it pins a v4 automation (as v3's use step's). */
export function processAutomationOutputSchema(
  def: Pick<ProcessAutomationDefinition, "input" | "steps" | "output">,
  ctx: TypingContext = {},
): JsonSchema {
  // No nesting (validation refuses it): an inner process step is typed as unknown.
  const scope = automationEndScope(def, { ...ctx, automations: {} });
  return outputTemplateSchema(def.output, (path) => typeProcessPath(scope, path));
}

/**
 * Validates one v4 automation version on its own, as v3's `validateAutomation` does: its steps as
 * a process's with `{{input…}}` in place of the trigger, skills and tools against the context (the
 * agent that uses it brings them in), no nesting, people by role, and an `output` over its input
 * and top-level steps.
 */
export function validateProcessAutomation(
  input: unknown,
  ctx: Omit<ProcessValidationContext, "agent" | "publish" | "clientAgent"> = {},
): {
  valid: boolean;
  errors: ProcessValidationError[];
  value?: ProcessAutomationDefinition;
} {
  const parsed = ProcessAutomationDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return { valid: false, errors: schemaErrors(parsed.error.issues, input) };
  }
  const def = parsed.data;
  const errors = duplicateIds({ schemaVersion: 4, triggers: [], steps: def.steps });
  const c: Checker = {
    ctx,
    typePath: typeProcessPath,
    inScope: rootInScope,
    add(stepId, f, code, message) {
      errors.push({ stepId, field: f, code, message });
    },
  };
  walkSteps(def, ({ step }) => {
    if (step.kind === "process") {
      c.add(step.id, "", "automation_nested", "an automation can't use another automation");
    }
    // As v3: an automation never names a person, and its skill steps run as the using agent.
    if (step.kind === "person" && isUuid(step.assignee)) {
      c.add(
        step.id,
        "assignee",
        "automation_named_person",
        "an automation assigns people by role, not by name",
      );
    }
    if (step.kind === "skill" && step.agent !== undefined) {
      c.add(
        step.id,
        "agent",
        "automation_agent",
        "an automation's steps run as the agent using it",
      );
    }
  });
  const list = scopeList({ triggers: [], steps: def.steps }, ctx, { schema: def.input });
  for (const { step, scope } of list) checkStep(c, step, scope, undefined);
  checkRefs(c, "", def.output, ["output"], automationEndScope(def, ctx));
  // DECISION (wave 5, fix 3): an automation's output is the using step's output, which a write's
  // input reads anywhere: it never carries a step's error message, as a process step's input.
  checkErrorMessage(c, "", def.output, ["output"]);
  for (const e of errors) if (e.stepId === "") e.stepId = null;
  return { valid: errors.length === 0, errors, value: def };
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
  const warnings: ProcessWarning[] = [];
  const c: Checker = {
    ctx,
    typePath: typeProcessPath,
    inScope: rootInScope,
    add(stepId, f, code, message) {
      errors.push({ stepId, field: f, code, message });
    },
    warn(stepId, f, code, message) {
      warnings.push({ stepId, field: f, code, message });
    },
  };
  for (const t of process.triggers) checkProcessTrigger(c, t);
  const list = scopeList(process, ctx);
  checkHandoff(c, process, list);
  const allowed = allowedTools(ctx);
  for (const { step, scope } of list) checkStep(c, step, scope, allowed);
  checkReshapeNext(c, process);
  return {
    valid: errors.length === 0,
    errors,
    warnings: [...splitWarnings(process), ...warnings],
    value: process,
  };
}
