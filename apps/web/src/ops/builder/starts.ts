// Each way a workflow starts with its own first steps (owner, 2026-11-22: "the other way to start
// would have different steps upfront… it would get a receipt and then it would store it and then
// try to match it; the matching step is the first step where they collide"; docs/plan.md §1.184).
// No new format: a decision as the first step with a path per start, each taken when the run
// carries what only that start brings (its rule is `exists` on a field of the trigger's own
// data). The paths come back together at the step after the decision, as any decision's do.
import { type processes, type TypingContext, triggerOnSchema, uuidv7 } from "@countersign/core";
import { triggerTitle } from "../workflow/describe";
import { insertStep, type Process, ROOT, type Step } from "./model";

type Trigger = processes.Process["triggers"][number];

/** The decision's name, and how an existing one is known. */
export const STARTS_DECISION = "How did it start?";

/** The names of what a trigger's run carries: its payload's fields, those always there first. */
function fieldsOf(trigger: Trigger, ctx: TypingContext): string[] {
  const schema = triggerOnSchema(trigger.on, ctx) as
    | { properties?: Record<string, unknown>; required?: string[] }
    | undefined;
  const all = Object.keys(schema?.properties ?? {});
  const required = (schema?.required ?? []).filter((f) => all.includes(f));
  return [...required, ...all.filter((f) => !required.includes(f))];
}

/** A rule that holds only for runs a trigger started: one of its fields no other start has. */
function ownField(trigger: Trigger, others: readonly Trigger[], ctx: TypingContext): string | null {
  const theirs = new Set(others.flatMap((t) => fieldsOf(t, ctx)));
  return fieldsOf(trigger, ctx).find((f) => !theirs.has(f)) ?? null;
}

/** Whether the workflow already opens with this decision. */
export function hasStartsDecision(process: Process): boolean {
  const first = process.steps[0];
  return (
    first?.kind === "if" &&
    first.paths.length > 0 &&
    first.paths.every(
      (p) =>
        p.when.rules.length === 1 &&
        p.when.rules[0]?.op === "exists" &&
        p.when.rules[0].field.startsWith("{{trigger."),
    )
  );
}

export type StartsSplit =
  | { ok: true; process: Process; stepId: string }
  /** Why not, in words for the panel. */
  | { ok: false; why: string };

/**
 * The workflow with a decision as its first step and a path for each way it starts. A start whose
 * data no rule can tell from the others' (one started by hand with no fields, say) takes the
 * Otherwise path; two such starts can't be told apart, so nothing is added.
 */
// DECISION: the paths start empty. Which of today's steps belong to one start is the operator's
// to say: they drag those onto its path, and what is left under the decision is shared.
export function splitStarts(
  process: Process,
  ctx: TypingContext,
  newId: () => string = uuidv7,
): StartsSplit {
  if (process.triggers.length < 2) {
    return { ok: false, why: "It has one way to start. Add another first." };
  }
  if (hasStartsDecision(process)) {
    return { ok: false, why: "It already opens with a path for each start." };
  }
  const named: { trigger: Trigger; field: string }[] = [];
  const unnamed: Trigger[] = [];
  for (const trigger of process.triggers) {
    const field = ownField(
      trigger,
      process.triggers.filter((t) => t.id !== trigger.id),
      ctx,
    );
    if (field) named.push({ trigger, field });
    else unnamed.push(trigger);
  }
  if (unnamed.length > 1) {
    return {
      ok: false,
      why: `${unnamed.length} of these starts carry the same data, so a rule can't tell them apart: ${unnamed.map(triggerTitle).join(", ")}.`,
    };
  }
  const stepId = newId();
  const decision = {
    id: stepId,
    kind: "if",
    name: STARTS_DECISION,
    paths: named.map(({ trigger, field }) => ({
      id: newId(),
      name: triggerTitle(trigger),
      when: { match: "all", rules: [{ field: `{{trigger.${field}}}`, op: "exists" }] },
      steps: [],
    })),
    otherwise: { id: newId(), steps: [] },
  } as unknown as Step;
  return { ok: true, process: insertStep(process, ROOT, 0, decision), stepId };
}

/** What the Otherwise path is for, once split: the start no rule names, or nothing. */
export function otherwiseStart(process: Process, ctx: TypingContext): string | null {
  const unnamed = process.triggers.filter(
    (t) =>
      ownField(
        t,
        process.triggers.filter((o) => o.id !== t.id),
        ctx,
      ) === null,
  );
  return unnamed.length === 1 ? triggerTitle(unnamed[0] as Trigger) : null;
}
