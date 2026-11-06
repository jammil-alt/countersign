// v0.12 W2-B: automations (ARCHITECTURE §10.7; docs/plan.md §1.45). What an automation requires,
// and "Save as automation": selected steps of a workflow copied into a new automation, with a use
// step in their place. Pure, so the server and (later) the Builder share it.

import { isUuid } from "../ids";
import { isPlainObject } from "../json";
import type { Approval } from "../schemas/approval";
import {
  type AutomationDefinition,
  type AutomationRequires,
  automationRef,
} from "../schemas/automation";
import type { JsonSchema } from "../schemas/common";
import { skillTools } from "../schemas/skill";
import type { Step, UseAutomationStep, Workflow } from "../schemas/workflow";
import { parseTemplate } from "../template/template";
import { lookupSkill, scopeAt, type TypingContext, typeTemplatePath } from "../template/typer";
import { walkSteps } from "./walk";

/**
 * What an automation needs from an agent that uses it: the skills its steps name, the tools they
 * call (actions, and the skills' tools), and the connectors behind them. `connectorIds` names the
 * registered connectors, so a read tool whose source is a connector counts too.
 */
export function automationRequires(
  automation: Pick<AutomationDefinition, "steps">,
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
    } else if (step.kind === "action") tools.add(step.tool);
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

// ── Save as automation ──────────────────────────────────────────────────────────────────────────

export type FromStepsRefusal =
  | "empty"
  | "not_top_level"
  | "not_contiguous"
  | "named_person"
  | "nested";

export type FromStepsResult =
  | {
      ok: true;
      /** The new automation's v1 (requires left empty: the server computes it on save). */
      automation: AutomationDefinition;
      /** The step that takes the selection's place. */
      useStep: UseAutomationStep;
      /** The workflow with the use step in place of the selection and later references moved. */
      workflow: Workflow;
    }
  | { ok: false; code: FromStepsRefusal; message: string };

export interface FromStepsInput {
  workflow: Workflow;
  /** Top-level steps of `workflow`, one contiguous run of them. */
  stepIds: readonly string[];
  slug: string;
  name: string;
  description?: string;
  /** Makes each new id (the server's uuid v7). */
  newId: () => string;
  /** Types the inferred input fields; unknown fields are left open. */
  ctx?: TypingContext;
  /**
   * The workflow is a client agent's: an inner write step the operator had set to not required
   * keeps that setting through the use step's `approvals`.
   */
  clientAgent?: boolean;
}

/** Rewrites every `{{...}}` reference in a templated JSON value; other values are copied. */
function mapRefs(value: unknown, fn: (path: string[]) => string[]): unknown {
  if (typeof value === "string") {
    if (!value.includes("{{")) return value;
    let parts: ReturnType<typeof parseTemplate>;
    try {
      parts = parseTemplate(value);
    } catch {
      return value;
    }
    return parts.map((p) => (p.type === "text" ? p.text : `{{${fn(p.path).join(".")}}}`)).join("");
  }
  if (Array.isArray(value)) return value.map((v) => mapRefs(v, fn));
  if (isPlainObject(value)) {
    // fromEntries defines own properties, so a `__proto__` key stays a plain key.
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapRefs(v, fn)]));
  }
  return value;
}

/** A field name from words: lowercase letters, digits and `_`. */
function fieldName(words: string, taken: Set<string>): string {
  const base =
    words
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .split("_")
      .filter(Boolean)
      .join("_")
      .slice(0, 40) || "value";
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
  taken.add(name);
  return name;
}

/** Copies a step with new ids for it and everything inside it (ids are made once, here). */
function renumber(step: Step, ids: Map<string, string>): Step {
  const id = (old: string) => ids.get(old) ?? old;
  const copy = { ...step, id: id(step.id) } as Step;
  if (copy.kind === "fork" && step.kind === "fork") {
    copy.paths = step.paths.map((p) => ({
      ...p,
      id: id(p.id),
      steps: p.steps.map((s) => renumber(s, ids)),
    }));
    copy.otherwise = {
      ...step.otherwise,
      id: id(step.otherwise.id),
      steps: step.otherwise.steps.map((s) => renumber(s, ids)),
    };
  } else if (copy.kind === "for_each" && step.kind === "for_each") {
    copy.steps = step.steps.map((s) => renumber(s, ids));
  }
  return copy;
}

/**
 * "Save as automation" (docs/plan.md §1.45): copies the selected top-level steps into a new
 * automation (new ids), infers its input from the references that cross into the selection,
 * exposes as its output what later steps read from the selection, and puts one use step in their
 * place. Refused when the selection isn't one contiguous run of top-level steps, or holds a person
 * step assigned to a named person, or a use step.
 */
export function stepsToAutomation(input: FromStepsInput): FromStepsResult {
  const { workflow, ctx = {} } = input;
  const wanted = [...new Set(input.stepIds)];
  if (wanted.length === 0) return { ok: false, code: "empty", message: "select at least one step" };
  const indexes = wanted.map((id) => workflow.steps.findIndex((s) => s.id === id));
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
  const selected = workflow.steps.slice(first, last + 1);

  const inside = new Set<string>();
  let refusal: FromStepsResult | null = null;
  walkSteps({ steps: selected }, ({ step }) => {
    inside.add(step.id);
    if (step.kind === "fork") {
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
    if (step.kind === "use_automation") {
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
  const useId = input.newId();

  // Input: each reference from inside the selection to something before it (the trigger, an
  // earlier step) becomes one input field, given by the use step.
  const scope = scopeAt(workflow, selected[0]?.id as string, ctx);
  const stepName = (id: string) => workflow.steps.find((s) => s.id === id)?.name ?? id;
  const inputKeys = new Map<string, string>();
  const inputTaken = new Set<string>();
  const inputValues: Record<string, unknown> = {};
  const inputProps: Record<string, JsonSchema> = {};
  const intoInput = (path: string[]): string[] => {
    const [root, id, output] = path;
    if (root === "steps" && id !== undefined && inside.has(id)) {
      return ["steps", ids.get(id) as string, ...path.slice(2)];
    }
    if (root !== "trigger" && !(root === "steps" && output === "output")) return path;
    const expr = path.join(".");
    let key = inputKeys.get(expr);
    if (!key) {
      const words =
        root === "trigger"
          ? path.slice(1).join(" ") || "trigger"
          : `${stepName(id as string)} ${path.slice(3).join(" ")}`;
      key = fieldName(words, inputTaken);
      inputKeys.set(expr, key);
      inputValues[key] = `{{${expr}}}`;
      const t = scope ? typeTemplatePath(scope, path) : undefined;
      inputProps[key] = t?.ok && t.schema ? t.schema : {};
    }
    return ["input", key];
  };

  const keptApprovals: Record<string, Approval> = {};
  const copied = selected.map((s) => {
    const moved = mapRefs(renumber(s, ids), intoInput) as Step;
    // DECISION: new steps start with approval on (invariant 8). A client agent keeps a setting the operator
    // loosened through the use step's `approvals`, so its runs behave as before.
    walkSteps({ steps: [moved] }, ({ step }) => {
      if ((step.kind === "skill" || step.kind === "action") && step.approval) {
        if (step.approval.required === "not_required" && input.clientAgent) {
          keptApprovals[step.id] = step.approval;
        }
        step.approval = { ...step.approval, required: "required" };
      }
    });
    return moved;
  });

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
      key = fieldName(stepName(id), outputTaken);
      outputKeys.set(id, key);
      output[key] = `{{steps.${ids.get(id)}.output}}`;
    }
    return ["steps", useId, "output", key, ...rest];
  };
  const after = workflow.steps.slice(last + 1).map((s) => mapRefs(s, fromOutput) as Step);

  const automation: AutomationDefinition = {
    schemaVersion: 1,
    slug: input.slug,
    name: input.name,
    description: input.description ?? "",
    input: {
      type: "object",
      properties: inputProps,
      required: Object.keys(inputProps),
    },
    output,
    steps: copied,
    requires: { skills: [], tools: [], connectors: [] },
  };
  const useStep: UseAutomationStep = {
    id: useId,
    kind: "use_automation",
    name: input.name,
    automation: automationRef(input.slug, 1),
    input: inputValues,
    ...(Object.keys(keptApprovals).length > 0 ? { approvals: keptApprovals } : {}),
  };
  return {
    ok: true,
    automation,
    useStep,
    workflow: {
      ...workflow,
      steps: [...workflow.steps.slice(0, first), useStep, ...after],
    },
  };
}
