// Each step's status on the one-screen builder (docs/builder-plan.md §12, docs/plan.md §1.170):
// what is left to settle on it (the validator's problems, a missing step, the build's items and
// decisions), what the Builder decided for it, how it differs from the template, and what it did in
// the last try. The chart, the side panel, the List and the bar all read the same map.
import { processes } from "@countersign/core";
import type { BuilderProblem } from "../builder/catalog";
import { ifOfBranch, type Process } from "../builder/model";
import type { DecidedNote, SettleItem, StatusMap, StepStatus, TryMark } from "./types";

/** What a missing step says on it: the library has nothing that does it. */
export const MISSING_TITLE = "Nothing in the library does this yet";

/**
 * A settle item the host already settled: `settled` is the answer it runs on now. Shown with
 * Change; it no longer counts as open.
 */
// DECISION (F2): "settled" lives here, not on the shared SettleItem, so the parts built side by
// side don't all edit types.ts; a SettleItem without it is open.
export type SettleEntry = SettleItem & { settled?: string | undefined };

/** Whether an item is still open (not settled). */
export function isOpen(item: SettleItem): boolean {
  return !(item as SettleEntry).settled;
}

/** A step's open items, issues first. */
export function openItems(status: StepStatus | undefined): SettleItem[] {
  if (!status) return [];
  return status.items
    .filter(isOpen)
    .sort((a, b) => (a.level === b.level ? 0 : a.level === "issue" ? -1 : 1));
}

/**
 * What a decision's path with no condition yet asks. It is a question, not an issue: a path just
 * added has nothing wrong with it, it hasn't been said yet when a run takes it. The validator
 * still holds the workflow from being published until it is.
 */
// DECISION (owner, 2026-11-21: "I added a path and… it starts as an issue… make it ask what it
// is first"): the validator's `rules_empty` on a decision's path reads as this question, in gold,
// with the validator's own words under it.
export function pathQuestion(name: string): string {
  const n = name.trim();
  return n ? `When does a run take “${n}”?` : "When does a run take this path?";
}

/** A decision's path by its id. */
function pathOf(process: Process, pathId: string) {
  const owner = ifOfBranch(process, pathId);
  return owner?.kind === "if" ? (owner.paths.find((p) => p.id === pathId) ?? null) : null;
}

export interface StatusInput {
  process: Process;
  /** The validator's errors (pass `readableErrors` from ../builder/problems for plain words). */
  problems?: readonly BuilderProblem[] | undefined;
  /** Only the problems of this workflow (by slug), when the list holds several. */
  workflow?: string | undefined;
  /** The build's items and decisions to settle, already on their step. */
  items?: readonly SettleEntry[] | undefined;
  decided?: readonly DecidedNote[] | undefined;
  /** A client agent's steps against its template (`customizedSteps` in ../builder/model). */
  customized?: ReadonlyMap<string, "changed" | "added"> | undefined;
  /** The last try's steps. */
  tried?: readonly TryMark[] | undefined;
}

function levelOf(items: readonly SettleItem[]): StepStatus["level"] {
  const open = items.filter(isOpen);
  if (open.some((i) => i.level === "issue")) return "issue";
  return open.length > 0 ? "question" : "ok";
}

/**
 * Statuses by step id (and trigger id, for a problem on a trigger). A problem on a path belongs
 * to its decision; a problem that names no step, or one no longer in the process, is left out.
 */
export function buildStatuses(input: StatusInput): StatusMap {
  const { process } = input;
  const out = new Map<string, StepStatus>();
  const entry = (stepId: string): StepStatus => {
    let s = out.get(stepId);
    if (!s) {
      s = { stepId, level: "ok", items: [], decided: [] };
      out.set(stepId, s);
    }
    return s;
  };
  const steps = new Map(processes.allSteps(process).map((l) => [l.step.id, l.step]));
  const triggers = new Set(process.triggers.map((t) => t.id));
  const missing = new Set<string>();

  for (const step of steps.values()) {
    if (step.kind !== "missing") continue;
    missing.add(step.id);
    entry(step.id).items.push({
      key: `missing:${step.id}`,
      stepId: step.id,
      level: "issue",
      title: MISSING_TITLE,
      detail: step.need,
      source: "missing",
    });
  }

  const seen = new Set<string>();
  for (const e of input.problems ?? []) {
    if (!e.stepId) continue;
    if (input.workflow && e.workflow && e.workflow !== input.workflow) continue;
    // A missing step already says so; the validator's "can't publish" adds nothing.
    if (e.code === "missing_step" && missing.has(e.stepId)) continue;
    const owner = steps.has(e.stepId)
      ? e.stepId
      : triggers.has(e.stepId)
        ? e.stepId
        : (ifOfBranch(process, e.stepId)?.id ?? null);
    if (!owner) continue;
    const key = `problem:${e.code}:${e.stepId}:${e.field}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const unsaid = e.code === "rules_empty" ? pathOf(process, e.stepId) : null;
    entry(owner).items.push(
      unsaid
        ? {
            key,
            stepId: owner,
            level: "question",
            title: pathQuestion(unsaid.name),
            detail: e.message,
            source: "problem",
          }
        : { key, stepId: owner, level: "issue", title: e.message, source: "problem" },
    );
  }

  for (const item of input.items ?? []) {
    if (!steps.has(item.stepId) && !triggers.has(item.stepId)) continue;
    const s = entry(item.stepId);
    if (!s.items.some((i) => i.key === item.key)) s.items.push(item);
  }
  for (const note of input.decided ?? []) {
    if (!steps.has(note.stepId) && !triggers.has(note.stepId)) continue;
    entry(note.stepId).decided.push(note);
  }
  for (const [id, how] of input.customized ?? []) {
    if (steps.has(id)) entry(id).customized = how;
  }
  for (const mark of input.tried ?? []) {
    if (steps.has(mark.stepId) || triggers.has(mark.stepId)) entry(mark.stepId).tried = mark;
  }

  for (const s of out.values()) s.level = levelOf(s.items);
  return out;
}

/** A try's mark in a word, and its tone: Did, Would, Failed, Skipped, Waiting. */
export const TRY_WORD: Record<
  TryMark["status"],
  { word: string; tone: "positive" | "warning" | "risk" | "neutral" }
> = {
  did: { word: "Did", tone: "positive" },
  would: { word: "Would", tone: "positive" },
  failed: { word: "Failed", tone: "risk" },
  skipped: { word: "Skipped", tone: "neutral" },
  waiting: { word: "Waiting", tone: "warning" },
};

/** "1 issue", "3 questions". */
export function plural(n: number, word: string): string {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

/** What the bar counts: steps with an issue, and steps with only questions. */
export function counts(statuses: StatusMap): { issues: number; questions: number } {
  let issues = 0;
  let questions = 0;
  for (const s of statuses.values()) {
    if (s.level === "issue") issues += 1;
    else if (s.level === "question") questions += 1;
  }
  return { issues, questions };
}

/**
 * The next step with something open after `afterId` (from the top when absent), going round to
 * the top: a step with an issue first, else one with a question. Null when nothing else is open.
 */
export function nextOpen(
  statuses: StatusMap,
  orderedStepIds: readonly string[],
  afterId?: string | null,
): string | null {
  const at = afterId ? orderedStepIds.indexOf(afterId) : -1;
  const round = [...orderedStepIds.slice(at + 1), ...orderedStepIds.slice(0, Math.max(at, 0))];
  const ids = round.filter((id) => id !== afterId);
  for (const level of ["issue", "question"] as const) {
    const hit = ids.find((id) => statuses.get(id)?.level === level);
    if (hit) return hit;
  }
  return null;
}

/**
 * Step ids in reading order: top to bottom, a decision's paths in order (then its otherwise), a
 * loop's own steps under it. With `triggers`, the triggers' ids come first.
 */
export function stepOrder(process: Process, options: { triggers?: boolean } = {}): string[] {
  const ids = processes.allSteps(process).map((l) => l.step.id);
  return options.triggers ? [...process.triggers.map((t) => t.id), ...ids] : ids;
}
