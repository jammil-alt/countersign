// Reshape data (owner, 2026-11-11; ARCHITECTURE §10.14 "Reshape data") in the builder: a new
// Reshape step, the deterministic proposal (core's, the same the server makes first) applied to it
// with the next step wired to its output, the builder's offers ("Add a Reshape step" after a skill
// whose output fits a write only in part, or before a step whose inputs earlier steps can't fill),
// and a mapping's expressions in plain words for the inspector's table.
import {
  type JsonSchema,
  type PathOption,
  processes,
  type TypingContext,
  uuidv7,
} from "@countersign/core";
import {
  actionItem,
  createStep,
  insertStep,
  locate,
  type NewId,
  type Process,
  type Step,
  updateStep,
} from "./model";

export const RESHAPE_SKILL = processes.RESHAPE_SKILL;

/** A Reshape data step with no fields yet: the inspector proposes its mapping. */
export function newReshapeStep(newId: NewId = uuidv7): Step {
  return {
    id: newId(),
    kind: "skill",
    name: "Reshape data",
    skill: RESHAPE_SKILL,
    input: {},
    reshape: { fields: [] },
  };
}

export function isReshape(step: Step | undefined): boolean {
  return step !== undefined && step.kind === "skill" && processes.isReshapeStep(step);
}

/**
 * A proposal put into the Reshape step (its input and mapping) and the next step wired to its
 * output (each field the next step takes reads `{{steps.<reshape>.output.<field>}}`).
 */
export function applyProposal(
  process: Process,
  reshapeId: string,
  proposal: { input: Record<string, string>; mapping: processes.ReshapeMapping },
  ctx: TypingContext,
): Process {
  const next = processes.nextStepOf(process, reshapeId);
  let out = updateStep(process, reshapeId, (s) =>
    s.kind === "skill" ? { ...s, input: proposal.input, reshape: proposal.mapping } : s,
  );
  if (next && "input" in next) {
    const takes = processes.stepInputSchema(next, ctx);
    out = updateStep(out, next.id, (s) =>
      "input" in s
        ? ({
            ...s,
            input: processes.wireToReshape(
              s.input as Record<string, unknown>,
              reshapeId,
              proposal.mapping,
              takes,
            ),
          } as Step)
        : s,
    );
  }
  return out;
}

/** The deterministic proposal for the Reshape step, applied (or the process unchanged). */
export function proposeHere(process: Process, reshapeId: string, ctx: TypingContext): Process {
  const context = processes.reshapeContext(process, reshapeId, ctx);
  if (!context) return process;
  const p = processes.proposeReshape({ context });
  return applyProposal(process, reshapeId, p, ctx);
}

/**
 * "Add a Reshape step before this": a Reshape step right before `stepId`, its mapping proposed by
 * name and type from what runs before, and `stepId` wired to it. Null when the step isn't there.
 */
export function addReshapeBefore(
  process: Process,
  stepId: string,
  ctx: TypingContext,
  newId: NewId = uuidv7,
): { process: Process; stepId: string } | null {
  const loc = locate(process, stepId);
  if (!loc) return null;
  const step = newReshapeStep(newId);
  const placed = insertStep(process, loc.container, loc.index, step);
  return { process: proposeHere(placed, step.id, ctx), stepId: step.id };
}

/**
 * "Add a Reshape step" after a skill whose output fits a write only in part: a Reshape step, then
 * the write, its mapping proposed from everything before it and the write wired to it.
 */
export function addReshapeThenAction(
  process: Process,
  afterId: string,
  action: processes.WriteAction,
  ctx: TypingContext,
  newId: NewId = uuidv7,
): { process: Process; stepId: string } | null {
  const loc = locate(process, afterId);
  if (!loc) return null;
  const step = newReshapeStep(newId);
  const write = createStep(actionItem(action), ctx, newId);
  let out = insertStep(process, loc.container, loc.index + 1, step);
  out = insertStep(out, loc.container, loc.index + 2, write);
  return { process: proposeHere(out, step.id, ctx), stepId: step.id };
}

/** A write a step's output fits only in part: how many of the write's fields a Reshape would fill. */
export interface ReshapeOffer {
  action: processes.WriteAction;
  mapped: number;
  of: number;
}

/**
 * The writes a skill's output fits only in part (the full fits are `processes.actionFits`'): the
 * proposal from its output alone fills at least one required field but not all of them.
 */
// DECISION (web): offered when the proposal by name and type fills at least two of the action's
// fields, one of them required; fewer is no fit worth a step, and the operator can still add one
// from the palette.
export function reshapeOffers(stepId: string, output: JsonSchema | undefined): ReshapeOffer[] {
  const full = new Set(processes.actionFits(stepId, output).map((f) => f.action));
  const out: ReshapeOffer[] = [];
  for (const action of processes.WRITE_ACTIONS) {
    if (full.has(action)) continue;
    const schema = processes.actionInputSchema(action);
    const context: processes.ReshapeContext = {
      sources: [
        { key: "result", template: `{{steps.${stepId}.output}}`, schema: output, label: "" },
      ],
      next: { stepId: "next", name: "", schema },
      input: { type: "object", properties: { result: output ?? {} } },
    };
    const p = processes.proposeReshape({ context });
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    const mapped = p.mapping.fields.filter((f) => f.from).map((f) => f.name);
    if (mapped.length >= 2 && mapped.some((m) => required.includes(m))) {
      out.push({ action, mapped: mapped.length, of: p.mapping.fields.length });
    }
  }
  return out;
}

/** Codes that say a step's inputs can't be filled from what runs before it. */
const INPUT_CODES = new Set(["input_missing", "input_type", "template_path"]);

/** Whether a step's own problems say its inputs can't be filled from earlier outputs. */
export function inputsUnfilled(
  step: Step,
  errors: readonly { stepId: string | null; field: string; code: string }[],
): boolean {
  if (isReshape(step)) return false;
  if (step.kind !== "read" && step.kind !== "write" && step.kind !== "skill") return false;
  return errors.some(
    (e) => e.stepId === step.id && INPUT_CODES.has(e.code) && e.field.startsWith("input"),
  );
}

// ── Plain words ──────────────────────────────────────────────────────────────────────────────

function operandText(o: processes.ReshapeOperand): string {
  if ("input" in o) return o.input;
  if ("item" in o) return o.item === "" ? "the item" : `item.${o.item}`;
  if ("today" in o) return "today";
  return JSON.stringify(o.value);
}

/** An expression in a few words: "readDocument.total as money", "each of lines: …". */
export function exprText(e: processes.ReshapeExpr): string {
  if ("input" in e || "item" in e || "value" in e || "today" in e) {
    return operandText(e as processes.ReshapeOperand);
  }
  if ("daysBetween" in e) {
    return `days from ${operandText(e.daysBetween.from)} to ${operandText(e.daysBetween.to)}`;
  }
  if ("sum" in e) return e.sum.map(operandText).join(" + ");
  if ("difference" in e) return `${operandText(e.difference[0])} − ${operandText(e.difference[1])}`;
  if ("percentChange" in e) {
    return `% change from ${operandText(e.percentChange.from)} to ${operandText(e.percentChange.to)}`;
  }
  if ("bucket" in e) {
    return `bucket of ${operandText(e.bucket.value)} (${e.bucket.buckets.map((b) => b.label).join(", ")})`;
  }
  if ("formatDate" in e) return `${operandText(e.formatDate.value)} as a date (${e.formatDate.to})`;
  if ("formatNumber" in e) {
    const places = e.formatNumber.places;
    return `${operandText(e.formatNumber.value)} as a number${places !== undefined ? `, ${places} places` : ""}`;
  }
  if ("formatMoney" in e) {
    return `${operandText(e.formatMoney.value)} as money${e.formatMoney.currency ? ` in ${operandText(e.formatMoney.currency)}` : ""}`;
  }
  if ("join" in e) {
    return `${e.join.values.map(operandText).join(", ")} joined with "${e.join.separator ?? " "}"`;
  }
  if ("split" in e) return `${operandText(e.split.value)} split at "${e.split.separator}"`;
  if ("pick" in e) {
    const which = e.pick.where
      ? `where ${e.pick.where.field} is ${operandText(e.pick.where.equals)}`
      : `number ${(e.pick.index ?? 0) + 1}`;
    return `from ${operandText(e.pick.list)}, the one ${which}${e.pick.field ? `: ${e.pick.field}` : ""}`;
  }
  if ("pluck" in e) return `${e.pluck.field} of each in ${operandText(e.pluck.list)}`;
  if ("mapList" in e) {
    const fields = Object.entries(e.mapList.fields)
      .map(([k, v]) => `${k} ← ${exprText(v)}`)
      .join("; ");
    return `each of ${operandText(e.mapList.list)}: ${fields}`;
  }
  return `${operandText(e.convertUnit.value)} from ${e.convertUnit.from} to ${e.convertUnit.to}`;
}

/** The fields a Copy can read: every path of every source, by input key. */
export function copyPaths(context: processes.ReshapeContext | null): PathOption[] {
  if (!context) return [];
  const out: PathOption[] = [];
  const visit = (schema: JsonSchema | undefined, base: string, depth: number) => {
    if (!schema || typeof schema !== "object" || depth > 4) return;
    for (const k of ["anyOf", "oneOf"] as const) {
      const alts = schema[k];
      if (Array.isArray(alts)) {
        const alt = alts.find(
          (a) =>
            a &&
            typeof a === "object" &&
            processes.schemaTypeNames(a as JsonSchema).join() !== "null",
        );
        visit(alt as JsonSchema | undefined, base, depth);
        return;
      }
    }
    const props =
      schema.properties && typeof schema.properties === "object"
        ? (schema.properties as Record<string, JsonSchema>)
        : {};
    for (const [k, s] of Object.entries(props)) {
      const path = `${base}.${k}`;
      out.push({ path, schema: s });
      if (processes.schemaTypeNames(s).includes("object")) visit(s, path, depth + 1);
    }
  };
  for (const s of context.sources) visit(s.schema, s.key, 0);
  return out;
}

/** The value a field shows: text as is, anything else as compact JSON. */
export function sampleText(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}
