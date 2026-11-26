// Testing some of a step-model workflow's steps (owner, 2026-11-22, docs/plan.md §1.185; for the
// step model on 2026-11-26: "allow me to select what steps we want to test, the whole flow, or from
// step x to y"). The executor already runs a range of top-level steps (`RunRange` in
// packages/workflows); this says what a range needs and why one can't run, in words.
// DECISION: as before, top-level steps only: a Fork or a loop is tested whole, and a read of a step
// nested inside an earlier one can't be given (start the test at or before the step that holds
// it). A step before the range that a picked step reads is given its output by the tester.
import type { Step, Workflow } from "./schema";
import { eachStep } from "./walk";

/** The range as the test-run route takes it and the run keeps it. */
export interface StepRange {
  /** The first top-level step run. Absent: from the top. */
  from?: string | undefined;
  /** The last top-level step run. Absent: to the end. */
  to?: string | undefined;
  /** What steps before `from` are taken to have produced, by step id. */
  given?: Record<string, unknown> | undefined;
}

export interface StepRangeNeeds {
  /** The picked top-level steps, in order. */
  picked: { id: string; name: string }[];
  /** Top-level steps before the range whose outputs the picked steps read: to be given. */
  earlier: { id: string; name: string; readBy: string[] }[];
  /** Why the range can't be tested as picked, in words. Empty: it can. */
  problems: string[];
}

const READ = /steps\.([A-Za-z0-9_-]+)\.output/g;

/** The step ids a step (and the steps inside it) read the output of. */
function readsOf(step: Step): Set<string> {
  return new Set([...JSON.stringify(step).matchAll(READ)].map((m) => m[1] as string));
}

/** A step's own id and those of the steps inside it. */
function idsOf(step: Step): string[] {
  const out: string[] = [];
  eachStep([step], ({ step: s }) => out.push(s.id));
  return out;
}

const nameOf = (s: Step) => s.name.trim() || "A step";

export function stepRangeNeeds(
  workflow: Pick<Workflow, "steps">,
  range: Pick<StepRange, "from" | "to">,
): StepRangeNeeds {
  const top = workflow.steps;
  const problems: string[] = [];
  const at = (id: string | undefined, what: string, fallback: number): number => {
    if (id === undefined) return fallback;
    const i = top.findIndex((s) => s.id === id);
    if (i < 0) problems.push(`the ${what} step isn't one of the workflow's top-level steps`);
    return i < 0 ? fallback : i;
  };
  const first = at(range.from, "first", 0);
  const last = at(range.to, "last", top.length - 1);
  if (top.length === 0) problems.push("the workflow has no steps to test");
  if (last < first) problems.push("the last step comes before the first");
  const picked = top.slice(first, last + 1);
  const before = top.slice(0, first).map((s) => ({ step: s, ids: idsOf(s) }));
  const own = new Set(picked.flatMap(idsOf));
  const earlier = new Map<string, { id: string; name: string; readBy: string[] }>();
  for (const step of picked) {
    for (const id of readsOf(step)) {
      if (own.has(id)) continue;
      const holder = before.find((b) => b.ids.includes(id));
      if (!holder) continue;
      if (holder.step.id !== id) {
        problems.push(
          `“${nameOf(step)}” reads a step inside “${nameOf(holder.step)}”: start the test at or before “${nameOf(holder.step)}”`,
        );
        continue;
      }
      const entry = earlier.get(id) ?? { id, name: nameOf(holder.step), readBy: [] };
      if (!entry.readBy.includes(nameOf(step))) entry.readBy.push(nameOf(step));
      earlier.set(id, entry);
    }
  }
  return {
    picked: picked.map((s) => ({ id: s.id, name: nameOf(s) })),
    earlier: before.flatMap((b) => {
      const e = earlier.get(b.step.id);
      return e ? [e] : [];
    }),
    problems: [...new Set(problems)],
  };
}

/** Why a range, with what was given, can't run: its own problems, then what is missing. */
export function stepRangeProblems(workflow: Pick<Workflow, "steps">, range: StepRange): string[] {
  const needs = stepRangeNeeds(workflow, range);
  const given = range.given ?? {};
  const top = new Set(workflow.steps.map((s) => s.id));
  const out = [...needs.problems];
  for (const e of needs.earlier) {
    if (!Object.hasOwn(given, e.id)) {
      out.push(`“${e.readBy[0]}” reads “${e.name}”, which isn't run: give its output`);
    }
  }
  for (const id of Object.keys(given)) {
    if (!top.has(id))
      out.push(`an output was given for a step the workflow doesn't have ("${id}")`);
    else if (needs.picked.some((p) => p.id === id)) {
      out.push("an output was given for a step the test runs");
    }
  }
  return out;
}
