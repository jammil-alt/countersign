// A test of some of a process's top-level steps (docs/plan.md §1.185): which steps a picked range
// reads from before it, so the builder can ask for their outputs and the API can refuse a range
// that would read nothing where a step expects something. Pure; shared by both.
import { collectRefs } from "../template/template";
import type { TypingContext } from "../template/typer";
import { handoffTargetSteps } from "./handoff";
import type { Process } from "./schema";

/** The range as the test-run route takes it and the run keeps it. */
export interface TestRange {
  /** The first top-level step run. Absent: from the top. */
  from?: string | undefined;
  /** The last top-level step run. Absent: to the end. */
  to?: string | undefined;
  /** What steps before `from` are taken to have produced, by step id. */
  given?: Record<string, unknown> | undefined;
}

export interface RangeNeeds {
  /** The picked steps, in order. */
  picked: { id: string; name: string }[];
  /** Steps before the range that the picked steps read: their outputs are to be given. */
  earlier: { id: string; name: string; readBy: string[] }[];
  /** Whether a picked step reads what the trigger brought. */
  trigger: boolean;
  /** Why the range can't be tested as picked, in words. Empty: it can. */
  problems: string[];
}

/**
 * What a range of top-level steps needs from before it. A read of a step nested inside an
 * earlier decision or loop can't be given (only a top-level step's output can), which is a
 * problem: start the test at or before the step that holds it.
 */
export function rangeNeeds(
  process: Pick<Process, "steps">,
  ctx: TypingContext,
  range: Pick<TestRange, "from" | "to">,
): RangeNeeds {
  const top = handoffTargetSteps(process, ctx);
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
  const before = top.slice(0, first);
  const own = new Set(picked.flatMap((s) => s.ids));
  const earlier = new Map<string, { id: string; name: string; readBy: string[] }>();
  let trigger = false;
  for (const step of picked) {
    const whole = process.steps.find((s) => s.id === step.id);
    if (whole && collectRefs(whole).refs.some((r) => r.path[0] === "trigger")) trigger = true;
    for (const id of step.reads) {
      if (own.has(id)) continue;
      const holder = before.find((b) => b.ids.includes(id));
      if (!holder) continue;
      if (holder.id !== id) {
        problems.push(
          `“${step.name}” reads a step inside “${holder.name}”: start the test at or before “${holder.name}”`,
        );
        continue;
      }
      const entry = earlier.get(id) ?? { id, name: holder.name, readBy: [] };
      if (!entry.readBy.includes(step.name)) entry.readBy.push(step.name);
      earlier.set(id, entry);
    }
  }
  return {
    picked: picked.map((s) => ({ id: s.id, name: s.name })),
    // In the workflow's order.
    earlier: before.flatMap((b) => {
      const e = earlier.get(b.id);
      return e ? [e] : [];
    }),
    trigger,
    problems: [...new Set(problems)],
  };
}

/** Why a range with what was given can't run, in words: the range's own problems, then what is missing. */
export function rangeProblems(
  process: Pick<Process, "steps">,
  ctx: TypingContext,
  range: TestRange,
): string[] {
  const needs = rangeNeeds(process, ctx, range);
  const given = range.given ?? {};
  const top = new Set(process.steps.map((s) => s.id));
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
