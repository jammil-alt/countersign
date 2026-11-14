// Wave 3b (docs/plan.md §1.86): automations whose steps are v4 process steps (`schemaVersion: 2`):
// what one requires, how a stored automation of either schema is validated and read, and "Save as
// automation" from a v4 process: v3's `stepsToAutomation` (workflow/automation.ts) for processes.
// Pure, so the server, the Builder and the workflow builder share it.

import { isUuid } from "../ids";
import {
  type AnyAutomationDefinition,
  type AutomationRequires,
  automationRef,
  type ProcessAutomationDefinition,
} from "../schemas/automation";
import type { JsonSchema } from "../schemas/common";
import { skillTools } from "../schemas/skill";
import { lookupSkill, type TypingContext } from "../template/typer";
import {
  type FromStepsRefusal,
  inputFieldName,
  mapTemplateRefs,
  automationRequires as v3AutomationRequires,
} from "../workflow/automation";
import {
  type ValidationError,
  validateAutomation as validateV3Automation,
} from "../workflow/validate";
import type { ApprovalCheck, Process, Step, SubProcessStep } from "./schema";
import {
  approvalLoosenings,
  conversationLoosenings,
  type ProcessValidationContext,
  processScopes,
  tightenedApproval,
  typeProcessPath,
  validateProcessAutomation,
} from "./validate";
import { walkSteps } from "./walk";

/**
 * What a v4 automation needs from an agent that uses it: the skills its steps name, the tools its
 * read and write steps call and its skills' tools, and the connectors behind them. A
 * conversation's channel connection is chosen at run time, so it adds none.
 */
export function processAutomationRequires(
  automation: Pick<ProcessAutomationDefinition, "steps">,
  ctx: TypingContext,
  connectorIds?: ReadonlySet<string>,
): AutomationRequires {
  const skills = new Set<string>();
  const tools = new Set<string>();
  const connectors = new Set<string>();
  walkSteps(automation, ({ step }) => {
    if (step.kind === "skill") {
      skills.add(step.skill);
      const def = lookupSkill(step.skill, ctx);
      if (def) {
        for (const t of skillTools(def)) tools.add(t);
        for (const c of def.requiresConnectors) connectors.add(c);
      }
    } else if (step.kind === "read" || (step.kind === "write" && step.tool !== undefined)) {
      tools.add(step.tool as string);
    }
    // DECISION (skill model): an action write step requires no tool or connector here: it resolves
    // from the using agent's bindings when it runs, and publish checks those (`checkWriteAction`).
  });
  for (const id of tools) {
    const spec = ctx.tools?.[id];
    if (spec?.connector) connectors.add(spec.connector);
    else if (spec && connectorIds?.has(spec.source)) connectors.add(spec.source);
  }
  return {
    skills: [...skills].sort(),
    tools: [...tools].sort(),
    connectors: [...connectors].sort(),
  };
}

/** What a stored automation of either schema requires (v1: v3's `automationRequires`). */
export function anyAutomationRequires(
  automation: AnyAutomationDefinition,
  ctx: TypingContext,
  connectorIds?: ReadonlySet<string>,
): AutomationRequires {
  return automation.schemaVersion === 2
    ? processAutomationRequires(automation, ctx, connectorIds)
    : v3AutomationRequires(automation, ctx, connectorIds);
}

/**
 * Validates an automation version of either schema: v1 exactly as `validateAutomation` always
 * has, v2 with `validateProcessAutomation`. Errors keep v3's shape (v4's codes are v3's and more).
 */
export function validateAnyAutomation(
  input: unknown,
  ctx: Omit<ProcessValidationContext, "agent" | "publish" | "clientAgent"> = {},
): { valid: boolean; errors: ValidationError[] } {
  const v2 =
    typeof input === "object" &&
    input !== null &&
    (input as { schemaVersion?: unknown }).schemaVersion === 2;
  const r = v2 ? validateProcessAutomation(input, ctx) : validateV3Automation(input, ctx);
  return { valid: r.valid, errors: r.errors as ValidationError[] };
}

// ── Save as automation, from a v4 process ─────────────────────────────────────────────────────

export type ProcessFromStepsResult =
  | {
      ok: true;
      /** The new automation's v1 (requires left empty: the server computes it on save). */
      automation: ProcessAutomationDefinition;
      /** The process step that takes the selection's place. */
      step: SubProcessStep;
      /** The process with that step in place of the selection and later references moved. */
      process: Process;
    }
  | { ok: false; code: FromStepsRefusal; message: string };

export interface ProcessFromStepsInput {
  process: Process;
  /** Top-level steps of `process`, one contiguous run of them. */
  stepIds: readonly string[];
  slug: string;
  name: string;
  description?: string;
  /** Makes each new id (the server's uuid v7). */
  newId: () => string;
  /** Types the inferred input fields; unknown fields are left open. */
  ctx?: ProcessValidationContext;
  /**
   * The process is a client agent's: an inner step's approval the operator had loosened keeps
   * that setting through the process step's `approvals`.
   */
  clientAgent?: boolean;
}

/** Copies a step with new ids for it and everything inside it (ids are made once, here). */
function renumber(step: Step, ids: ReadonlyMap<string, string>): Step {
  const id = (old: string) => ids.get(old) ?? old;
  if (step.kind === "if") {
    return {
      ...step,
      id: id(step.id),
      paths: step.paths.map((p) => ({
        ...p,
        id: id(p.id),
        steps: p.steps.map((s) => renumber(s, ids)),
      })),
      otherwise: {
        ...step.otherwise,
        id: id(step.otherwise.id),
        steps: step.otherwise.steps.map((s) => renumber(s, ids)),
      },
    };
  }
  if (step.kind === "for_each" || step.kind === "repeat") {
    return { ...step, id: id(step.id), steps: step.steps.map((s) => renumber(s, ids)) };
  }
  return { ...step, id: id(step.id) };
}

/**
 * "Save as automation" on a v4 process (docs/plan.md §1.45, §1.86), as v3's `stepsToAutomation`:
 * the selected top-level steps are copied into a new v4 automation (new ids), its input inferred
 * from the references that cross into the selection (the trigger, settings, earlier steps), its
 * output what later steps read from the selection, and one `process` step put in their place.
 * Refused when the selection isn't one contiguous run of top-level steps, or holds a person step
 * assigned to a named person, or a process step.
 */
export function stepsToProcessAutomation(input: ProcessFromStepsInput): ProcessFromStepsResult {
  const { process, ctx = {} } = input;
  const wanted = [...new Set(input.stepIds)];
  if (wanted.length === 0) return { ok: false, code: "empty", message: "select at least one step" };
  const indexes = wanted.map((id) => process.steps.findIndex((s) => s.id === id));
  if (indexes.some((i) => i < 0)) {
    return {
      ok: false,
      code: "not_top_level",
      message: "only steps at the top of the workflow can become an automation",
    };
  }
  indexes.sort((a, b) => a - b);
  const first = indexes[0] as number;
  const last = indexes[indexes.length - 1] as number;
  if (last - first + 1 !== indexes.length) {
    return { ok: false, code: "not_contiguous", message: "select steps that follow one another" };
  }
  const selected = process.steps.slice(first, last + 1);

  const inside = new Set<string>();
  let refusal: ProcessFromStepsResult | null = null;
  walkSteps({ steps: selected }, ({ step }) => {
    inside.add(step.id);
    if (step.kind === "if") {
      for (const p of step.paths) inside.add(p.id);
      inside.add(step.otherwise.id);
    }
    if (step.kind === "person" && isUuid(step.assignee)) {
      refusal ??= {
        ok: false,
        code: "named_person",
        message: `"${step.name}" is assigned to a named person: assign it to a role first`,
      };
    }
    if (step.kind === "process") {
      refusal ??= {
        ok: false,
        code: "nested",
        message: `"${step.name}" already uses an automation: an automation can't hold another`,
      };
    }
  });
  if (refusal) return refusal;

  const ids = new Map<string, string>();
  for (const id of inside) ids.set(id, input.newId());
  const stepId = input.newId();

  // Input: each reference from inside the selection to something outside it (the trigger, the
  // agent's settings, an earlier step) becomes one input field, given by the process step.
  const scope = processScopes(process, ctx).get(selected[0]?.id as string);
  const stepName = (id: string) => process.steps.find((s) => s.id === id)?.name ?? id;
  const inputKeys = new Map<string, string>();
  const inputTaken = new Set<string>();
  const inputValues: Record<string, unknown> = {};
  const inputProps: Record<string, JsonSchema> = {};
  const intoInput = (path: string[]): string[] => {
    const [root, id, output] = path;
    if (root === "steps" && id !== undefined && inside.has(id)) {
      return ["steps", ids.get(id) as string, ...path.slice(2)];
    }
    // v0.17: a repeat's previous pass, `loop.previous.<id>…`, names a step inside the repeat.
    if (root === "loop" && id === "previous" && output !== undefined && inside.has(output)) {
      return ["loop", "previous", ids.get(output) as string, ...path.slice(3)];
    }
    const outside =
      root === "trigger" || root === "settings" || (root === "steps" && output === "output");
    if (!outside) return path;
    const expr = path.join(".");
    let key = inputKeys.get(expr);
    if (!key) {
      const words =
        root === "steps"
          ? `${stepName(id as string)} ${path.slice(3).join(" ")}`
          : path.slice(1).join(" ") || root;
      key = inputFieldName(words, inputTaken);
      inputKeys.set(expr, key);
      inputValues[key] = `{{${expr}}}`;
      const t = scope ? typeProcessPath(scope, path) : undefined;
      inputProps[key] = t?.ok && t.schema ? t.schema : {};
    }
    return ["input", key];
  };

  // DECISION: new steps start with approval on (invariant 8): every loosened approval inside the
  // selection is tightened in the automation. A client agent keeps an approval the operator
  // loosened on a skill, read or write step through the process step's `approvals`, so its runs
  // behave as before. A conversation's message settings have no override there, so they start
  // with a person's yes in the automation; the operator loosens them in the automation itself.
  const keptApprovals: Record<string, ApprovalCheck> = {};
  const tighten = (step: Step): Step => {
    let next = step;
    const approval = step.checks?.approval;
    if (approval && approvalLoosenings(approval, "a").length > 0) {
      if (
        input.clientAgent &&
        (step.kind === "skill" || step.kind === "write" || step.kind === "read")
      ) {
        keptApprovals[step.id] = approval;
      }
      next = { ...next, checks: { ...step.checks, approval: tightenedApproval(approval) } };
    }
    if (next.kind === "conversation" && conversationLoosenings(next).length > 0) {
      next = { ...next, messages: { first: "required", later: "required" } };
    }
    if (next.kind === "if") {
      return {
        ...next,
        paths: next.paths.map((p) => ({ ...p, steps: p.steps.map(tighten) })),
        otherwise: { ...next.otherwise, steps: next.otherwise.steps.map(tighten) },
      };
    }
    if (next.kind === "for_each" || next.kind === "repeat") {
      return { ...next, steps: next.steps.map(tighten) };
    }
    return next;
  };
  const copied = selected.map((s) => tighten(mapTemplateRefs(renumber(s, ids), intoInput) as Step));

  // Output: what later steps read from the selection's top-level steps, one field per step.
  const topSelected = new Set(selected.map((s) => s.id));
  const outputKeys = new Map<string, string>();
  const outputTaken = new Set<string>();
  const output: Record<string, unknown> = {};
  const fromOutput = (path: string[]): string[] => {
    const [root, id, out, ...rest] = path;
    if (root !== "steps" || id === undefined || out !== "output" || !topSelected.has(id)) {
      return path;
    }
    let key = outputKeys.get(id);
    if (!key) {
      key = inputFieldName(stepName(id), outputTaken);
      outputKeys.set(id, key);
      output[key] = `{{steps.${ids.get(id)}.output}}`;
    }
    return ["steps", stepId, "output", key, ...rest];
  };
  const after = process.steps.slice(last + 1).map((s) => mapTemplateRefs(s, fromOutput) as Step);
  // The process's handoff reads top-level steps too.
  const handoff = process.handoff
    ? (mapTemplateRefs(process.handoff, fromOutput) as Process["handoff"])
    : undefined;

  const automation: ProcessAutomationDefinition = {
    schemaVersion: 2,
    slug: input.slug,
    name: input.name,
    description: input.description ?? "",
    input: { type: "object", properties: inputProps, required: Object.keys(inputProps) },
    output,
    steps: copied,
    requires: { skills: [], tools: [], connectors: [] },
  };
  const step: SubProcessStep = {
    id: stepId,
    kind: "process",
    name: input.name,
    process: automationRef(input.slug, 1),
    input: inputValues,
    ...(Object.keys(keptApprovals).length > 0 ? { approvals: keptApprovals } : {}),
  };
  return {
    ok: true,
    automation,
    step,
    process: {
      ...process,
      steps: [...process.steps.slice(0, first), step, ...after],
      ...(handoff ? { handoff } : {}),
    },
  };
}
